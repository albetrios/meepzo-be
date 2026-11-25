import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { uploadInstagramMessageAttachment } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { InstagramSendAccessService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-access.service.js';
import type { InstagramSendAccess } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { INSTAGRAM_ATTACHMENT_TYPE_OF_CONTENT_TYPE } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  type InstagramAttachmentKey,
  InstagramAttachmentRepository,
} from './instagram-attachment.repository.js';
import type {
  InstagramAttachmentFilePort,
  InstagramAttachmentOutcome,
  InstagramAttachmentUploader,
  InstagramAttachmentUploadQueue,
} from './instagram-attachment.types.js';

/**
 * Instagram's message files (feat-instagram-dm-sending routes-final § 6.C, SN20, SN21; SNC15): a
 * file is uploaded to Meta **once per account** and Meta's id kept in `app.instagram_attachments`,
 * so every later message of that account with that file reuses it (AC-15.4).
 *
 * @remarks
 * - **Algorithm:** `findOrUploadAttachment` — (1) the account's row for the file, in its own unit →
 *   `ready` with no Meta call; (2) else the upload service's usable-file read (P25 — only a
 *   confirmed `message-media` upload of this organization of a type Instagram takes; otherwise
 *   `unusable`, never uploaded); (3) the account must be sendable and the connection's usage not at
 *   `wait` (SN23); (4) the Meta upload with the connection's usage recorder, **outside any unit of
 *   work**; (5) the row written `ON CONFLICT DO NOTHING` — the kept id wins. Callers in one process
 *   asking for the same account and file at once share one upload (an in-flight map); across
 *   processes the unique key keeps one id.
 * - **Failure modes:** Meta's refusal or failure → `upload_failed` with the `MetaGraphApiError` (the
 *   sender maps its group and counts the try, ROUTE row R42); an open circuit or a database failure
 *   propagates.
 * - **Side effects:** one Meta call per new file and account; writes and deletes
 *   `app.instagram_attachments`.
 * - **Notes:** the `attachment-upload` task (WC-32) is ROUTE row R46's — its job body is
 *   {@link InstagramAttachmentService.uploadAttachments} and its queue joins as
 *   `options.uploadQueue`; until then files go up just before their first send. No malware scan this
 *   iteration (P34, the D58 deviation): type and magic-byte checks at confirm only.
 */
export class InstagramAttachmentService {
  private readonly inFlight = new Map<string, Promise<InstagramAttachmentOutcome>>();

  constructor(
    private readonly options: {
      sendAccessService: Pick<
        InstagramSendAccessService,
        'readSendAccess' | 'readSendPace' | 'buildUsageRecorder'
      >;
      filePort: InstagramAttachmentFilePort;
      /** The Meta call; defaults to the client's `uploadInstagramMessageAttachment`. */
      uploadAttachment?: InstagramAttachmentUploader | undefined;
      /** WC-32's queue (ROUTE row R46); absent → files go up just before their first send. */
      uploadQueue?: InstagramAttachmentUploadQueue | undefined;
    },
  ) {}

  /**
   * Meta's id for one file of an account — kept, or uploaded now (SN20). See
   * {@link InstagramAttachmentOutcome} for every answer.
   *
   * @remarks
   * Algorithm: the class's steps (1)–(5). Failure modes: `upload_failed` on Meta's error; others
   * propagate. Side effects: at most one Meta call and one row.
   */
  async findOrUploadAttachment({
    scope,
    access,
    uploadPublicId,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    /** The account's send access, read once by the sender ({@link InstagramSendAccessService}). */
    access: InstagramSendAccess;
    uploadPublicId: string;
    requestId?: string | undefined;
  }): Promise<InstagramAttachmentOutcome> {
    const key: InstagramAttachmentKey = { ...access.channelAccount, uploadPublicId };
    const flightKey = `${key.organizationId}:${key.channelAccountId}:${uploadPublicId}`;
    const running = this.inFlight.get(flightKey);
    if (running !== undefined) return running;
    const flight = this.resolveAttachment({ scope, access, key, requestId }).finally(() => {
      this.inFlight.delete(flightKey);
    });
    this.inFlight.set(flightKey, flight);
    return flight;
  }

  /** Steps (1)–(5) of {@link InstagramAttachmentService} for one account and file. */
  private async resolveAttachment({
    scope,
    access,
    key,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    access: InstagramSendAccess;
    key: InstagramAttachmentKey;
    requestId: string | undefined;
  }): Promise<InstagramAttachmentOutcome> {
    const kept = await withAppDatabaseContext({
      scope,
      callback: (databaseHandle) =>
        new InstagramAttachmentRepository(databaseHandle).findByKey(key),
    });
    if (kept !== null) {
      return { status: 'ready', attachmentId: kept.attachment_id, wasUploaded: false };
    }
    const file = await this.options.filePort.findUsableMessageFile({
      scope,
      uploadPublicId: key.uploadPublicId,
    });
    const type =
      file === null ? undefined : INSTAGRAM_ATTACHMENT_TYPE_OF_CONTENT_TYPE[file.content_type];
    if (file === null || type === undefined) return { status: 'unusable' };
    if (!access.isSendable || access.encryptedAccessToken === null) {
      return { status: 'not_sendable' };
    }
    const pace = await this.options.sendAccessService.readSendPace({ scope, access });
    if (pace.pace === 'wait') return { status: 'usage_wait', waitUntil: pace.waitUntil };
    const upload = this.options.uploadAttachment ?? uploadInstagramMessageAttachment;
    let attachmentId: string;
    try {
      ({ attachmentId } = await upload({
        encryptedAccessToken: access.encryptedAccessToken,
        instagramUserId: access.instagramUserId,
        type,
        url: file.download_url,
        requestId,
        recordUsage: this.options.sendAccessService.buildUsageRecorder({ scope, access }),
      }));
    } catch (error) {
      if (!(error instanceof MetaGraphApiError)) throw error;
      logger.warn(
        {
          event: 'instagram_attachment.upload_failed',
          channel_account_public_id: access.channelAccountPublicId,
          upload_public_id: key.uploadPublicId,
          error_class: error.errorClass,
          error_code: error.instagramErrorCode,
        },
        'Instagram refused or failed a message file upload',
      );
      return { status: 'upload_failed', error };
    }
    const row = await withAppDatabaseContext({
      scope,
      callback: (databaseHandle) =>
        new InstagramAttachmentRepository(databaseHandle).insertIfMissing({ ...key, attachmentId }),
    });
    return { status: 'ready', attachmentId: row.attachment_id, wasUploaded: true };
  }

  /**
   * Forgets an account's file — Meta said it is gone (the `attachment_failed` group, SN20), so the
   * next send uploads it again. Answers whether a row was deleted.
   *
   * @remarks
   * Algorithm: one delete in the scope's unit. Failure modes: none of its own. Side effects: the
   * row. The give-backs of counts and the message back to `waiting` are the send core's (R42).
   */
  async forgetAttachment({
    scope,
    key,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    key: InstagramAttachmentKey;
  }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: (databaseHandle) =>
        new InstagramAttachmentRepository(databaseHandle).deleteByKey(key),
    });
  }

  /**
   * The `attachment-upload` task's body (WC-32 — ROUTE row R46 runs it on `instagram-tasks`): every
   * file of the list uploaded once for the account, at go-live or a file change. Answers each
   * file's outcome by upload public id.
   *
   * @remarks
   * Algorithm: the account's send access once, then {@link findOrUploadAttachment} per file, one
   * after another (a `usage_wait` stops the rest — they go up at their send). Failure modes: as
   * {@link findOrUploadAttachment}; a revoked account → `404 channel_account_not_found`. Side
   * effects: Meta calls and rows.
   */
  async uploadAttachments({
    scope,
    channelAccountPublicId,
    uploadPublicIds,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
    uploadPublicIds: readonly string[];
  }): Promise<Map<string, InstagramAttachmentOutcome>> {
    const access = await this.options.sendAccessService.readSendAccess({
      scope,
      channelAccountPublicId,
    });
    const outcomes = new Map<string, InstagramAttachmentOutcome>();
    for (const uploadPublicId of new Set(uploadPublicIds)) {
      const outcome = await this.findOrUploadAttachment({ scope, access, uploadPublicId });
      outcomes.set(uploadPublicId, outcome);
      if (outcome.status === 'usage_wait' || outcome.status === 'not_sendable') break;
    }
    return outcomes;
  }

  /**
   * Asks for the account's files to go up ahead of their sends (go-live or a file change of a live
   * automation, WC-32) — through the task queue once ROUTE row R46 wires it; answers whether it was
   * queued (`false` until then: the files go up at their first send).
   *
   * @remarks
   * Algorithm: one enqueue after the caller's commit. Failure modes: an enqueue failure propagates
   * (the caller logs it — the send still uploads). Side effects: one job.
   */
  async requestAttachmentUploads(input: {
    organizationPublicId: string;
    channelAccountPublicId: string;
    uploadPublicIds: readonly string[];
  }): Promise<boolean> {
    if (this.options.uploadQueue === undefined || input.uploadPublicIds.length === 0) return false;
    await this.options.uploadQueue.enqueueAttachmentUpload(input);
    return true;
  }
}
