import i18next from 'i18next';
import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { AutomationRepository } from '@/domains/app/sub-domains/automation/automation.repository.js';
import { AutomationRunRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js';
import { buildAutomationButtonPayload } from '@/domains/app/sub-domains/automation/automation-run/automation-run-button-payload.util.js';
import { ChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import {
  type InstagramMessageRecipient,
  type InstagramOutgoingMessage,
  type MetaGraphUsageRecorder,
  readInstagramComment,
  sendInstagramMessage,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { buildBroadcastButtonPayload } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient-button-payload.util.js';
import { BroadcastRecipientRepository } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.repository.js';
import { InstagramMediaRepository } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import { composeInstagramMessage } from './instagram-message/instagram-message-compose.util.js';
import type { InstagramMessageRow } from './instagram-message/instagram-message.repository.js';
import type { InstagramMessageReason } from './instagram-message/instagram-message.constants.js';
import type { InstagramSendAccess, InstagramSendComposition } from './instagram-sending.types.js';

/** Graph's invalid-parameter code and the two subcodes that may mean "the comment is gone" (§33.7). */
const INVALID_PARAMETER_CODE = 100;
const COMMENT_MAYBE_GONE_SUBCODES: ReadonlySet<number> = new Set([33, 2_534_025]);

/** The request id the lanes' Meta calls carry (no HTTP request behind a ticket). */
const SEND_REQUEST_ID = 'instagram-send';

/** The English default texts (`AUTOMATION_MESSAGE_KEYS`), translated by the worker's i18next. */
function translateDefault(key: string): string {
  return i18next.t(key, { lng: 'en' });
}

/**
 * Whether a Meta error may mean the comment is gone (100/33, 100/2534025 — plan §33.7 rule 1).
 *
 * @remarks
 * Pure.
 */
export function isCommentMaybeGoneError(error: unknown): error is MetaGraphApiError {
  return (
    error instanceof MetaGraphApiError &&
    error.instagramErrorCode === INVALID_PARAMETER_CODE &&
    error.instagramErrorSubcode !== null &&
    COMMENT_MAYBE_GONE_SUBCODES.has(error.instagramErrorSubcode)
  );
}

/**
 * The comment check before a `deleted_comment` (plan §33.7, R42's carry-over): on 100/33 or
 * 100/2534025 the comment is read once — gone or hidden, the error stays (`comment_gone` →
 * `skipped` · `deleted_comment`, never "in a row"); still there, the error becomes Graph's plain
 * 100 (`bad_text`). Any other error, or a read that fails some other way, is the call's as is.
 *
 * @remarks
 * Algorithm: runs `call`; on a maybe-gone error one `GET /{comment_id}`. Failure modes: rethrows
 * the call's error (or its bad-text form). Side effects: the call, and at most one read.
 */
export async function callWithCommentCheck<T>({
  access,
  instagramCommentId,
  recordUsage,
  call,
}: {
  access: InstagramSendAccess;
  instagramCommentId: string;
  recordUsage: MetaGraphUsageRecorder | undefined;
  call: () => Promise<T>;
}): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isCommentMaybeGoneError(error)) throw error;
    let isStillThere = false;
    try {
      const comment = await readInstagramComment({
        encryptedAccessToken: access.encryptedAccessToken ?? '',
        instagramCommentId,
        requestId: SEND_REQUEST_ID,
        recordUsage,
      });
      isStillThere = !comment.isHidden;
    } catch {
      isStillThere = false;
    }
    if (!isStillThere) throw error;
    throw new MetaGraphApiError({
      errorClass: error.errorClass,
      category: error.category,
      ...(error.status === undefined ? {} : { httpStatus: error.status }),
      details: {
        code: INVALID_PARAMETER_CODE,
        subcode: null,
        type: error.instagramErrorType,
        fbtraceId: error.fbtraceId,
      },
      cause: error,
      fallbackMessage: 'Instagram refused the text: the comment is still there',
    });
  }
}

/** A composition that never goes, with its reason. */
function skipOf(reason: InstagramMessageReason): InstagramSendComposition {
  return { kind: 'skip', reason };
}

/**
 * The Meta call of a run's DM — a private reply to her comment or a direct message — composed from
 * the automation, her and the account read at the last moment (feat-instagram-dm-sending routes-final
 * § 6.B.10, plan §24.4, §28.1 step 10; ROUTE row R43, the slow lane — the fast lane (R44) composes
 * its direct messages here too).
 *
 * @remarks
 * - **Algorithm:** one read unit — the automation (also deleted), the run (its comment and public
 *   id), her (name, Instagram id), the account's username, the account's newest post only for a
 *   `post` of `newest`; then {@link composeInstagramMessage}. The call sends it (an email or phone
 *   question is plain text — fix-meta-unified-login F2); a private reply's maybe-gone comment is
 *   checked ({@link callWithCommentCheck}).
 * - **Failure modes:** a read error propagates (the core retries it inside the send); the call
 *   throws Meta's error as is.
 * - **Side effects:** reads; the call's Meta requests.
 * - **Notes:** no text is ever stored (D53) — only Meta's message id comes back.
 */
export class InstagramSendComposeService {
  constructor(
    private readonly options: { translate?: ((key: string) => string) | undefined } = {},
  ) {}

  /**
   * One run DM's composition (see the class).
   *
   * @remarks
   * Algorithm: as the class says. Failure modes: as the class says. Side effects: reads only.
   */
  async composeDirectMessage({
    scope,
    message,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    message: InstagramMessageRow;
  }): Promise<InstagramSendComposition> {
    if (message.automation_id === null || message.automation_run_id === null) {
      return skipOf('automation_deleted');
    }
    const automationId = message.automation_id;
    const runId = message.automation_run_id;
    const read = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const key = { organizationId: message.organization_id };
        const automation = await new AutomationRepository().findByIdIncludingDeleted({
          ...key,
          automationId,
        });
        const run = await new AutomationRunRepository().findByKey({
          ...key,
          runId,
          runStartedAt: message.automation_run_started_at,
        });
        const contact = await new ContactRepository().findLiveById({
          ...key,
          contactId: message.contact_id,
        });
        const account = await new ChannelAccountRepository().findById({
          ...key,
          channelAccountId: message.channel_account_id,
        });
        const listMessage = automation?.steps.messages?.[(message.message_number ?? 1) - 1];
        const newestMediaId =
          message.message_type === 'message' &&
          listMessage?.kind === 'post' &&
          listMessage.media_id === 'newest'
            ? await new InstagramMediaRepository().findNewestInstagramMediaId({
                ...key,
                channelAccountId: message.channel_account_id,
              })
            : null;
        return { automation, run, contact, account, newestMediaId };
      },
    });
    const { automation, run, contact } = read;
    if (automation === null || automation.deleted_at !== null || run === null) {
      return skipOf('automation_deleted');
    }
    if (contact === null) return skipOf('contact_deleted');
    let recipient: InstagramMessageRecipient;
    if (message.channel === 'private_reply') {
      if (run.trigger_instagram_comment_id === null) return skipOf('deleted_comment');
      recipient = { comment_id: run.trigger_instagram_comment_id };
    } else {
      if (contact.instagram_user_id === null) return skipOf('contact_deleted');
      recipient = { id: contact.instagram_user_id };
    }
    const composed = composeInstagramMessage({
      message,
      steps: automation.steps,
      contactName: contact.full_name ?? contact.username,
      accountUsername: read.account?.display_name ?? null,
      buttonPayload: buildAutomationButtonPayload({
        automationPublicId: automation.public_id,
        runPublicId: run.public_id,
        messagePublicId: message.public_id,
      }),
      newestMediaId: read.newestMediaId,
      translate: this.options.translate ?? translateDefault,
    });
    if (composed.kind === 'skip') return skipOf(composed.reason);
    return this.sendComposed({
      composed,
      recipient,
      commentId: 'comment_id' in recipient ? recipient.comment_id : null,
    });
  }

  /**
   * One broadcast message's composition (plan §30.14 step 9, ROUTE row R45): a normal DM to her
   * Instagram id inside her window (no message tag), its content the broadcast's message N read at
   * the last moment (the automation's message-list shape, BC8), its buttons carrying
   * `<brc_…>::<igm_…>` (§ 7.A.10).
   *
   * @remarks
   * Algorithm: one read unit — the broadcast (deleted ones too), her, the account's username, the
   * newest post for a `post` of `newest` — then {@link composeInstagramMessage}. Failure modes: a
   * read error propagates; the call throws Meta's error as is. Side effects: reads; the call's Meta
   * request. Notes: a broadcast or message gone → `skipped` · `cancelled_by_owner`; she erased →
   * `contact_deleted`.
   */
  async composeBroadcastMessage({
    scope,
    message,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    message: InstagramMessageRow;
  }): Promise<InstagramSendComposition> {
    const broadcastId = message.broadcast_id;
    if (broadcastId === null) return skipOf('cancelled_by_owner');
    const read = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const key = { organizationId: message.organization_id };
        const broadcast = await new BroadcastRecipientRepository().findBroadcast({
          ...key,
          broadcastId,
        });
        const contact = await new ContactRepository().findLiveById({
          ...key,
          contactId: message.contact_id,
        });
        const account = await new ChannelAccountRepository().findById({
          ...key,
          channelAccountId: message.channel_account_id,
        });
        const listMessage = broadcast?.messages[(message.message_number ?? 1) - 1];
        const newestMediaId =
          listMessage?.kind === 'post' && listMessage.media_id === 'newest'
            ? await new InstagramMediaRepository().findNewestInstagramMediaId({
                ...key,
                channelAccountId: message.channel_account_id,
              })
            : null;
        return { broadcast, contact, account, newestMediaId };
      },
    });
    const { broadcast, contact } = read;
    if (broadcast === null) return skipOf('cancelled_by_owner');
    if (!contact?.instagram_user_id) return skipOf('contact_deleted');
    const composed = composeInstagramMessage({
      message,
      steps: { messages: broadcast.messages },
      contactName: contact.full_name ?? contact.username,
      accountUsername: read.account?.display_name ?? null,
      buttonPayload: buildBroadcastButtonPayload({
        broadcastPublicId: broadcast.public_id,
        messagePublicId: message.public_id,
      }),
      newestMediaId: read.newestMediaId,
      translate: this.options.translate ?? translateDefault,
    });
    if (composed.kind === 'skip') return skipOf(composed.reason);
    return this.sendComposed({
      composed,
      recipient: { id: contact.instagram_user_id },
      commentId: null,
    });
  }

  /** The call of a composed message: the send, its plain-text fallback, a private reply's comment check. */
  private sendComposed({
    composed,
    recipient,
    commentId,
  }: {
    composed: Extract<ReturnType<typeof composeInstagramMessage>, { kind: 'send' }>;
    recipient: InstagramMessageRecipient;
    commentId: string | null;
  }): InstagramSendComposition {
    return {
      kind: 'send',
      uploadPublicId: composed.uploadPublicId,
      call: async ({ access, attachmentId, recordUsage }) => {
        const send = (outgoing: InstagramOutgoingMessage) =>
          sendInstagramMessage({
            encryptedAccessToken: access.encryptedAccessToken ?? '',
            instagramUserId: access.instagramUserId,
            recipient,
            message: outgoing,
            requestId: SEND_REQUEST_ID,
            recordUsage,
          });
        const sendComposed = () => send(composed.build(attachmentId));
        const sent =
          commentId === null
            ? await sendComposed()
            : await callWithCommentCheck({
                access,
                instagramCommentId: commentId,
                recordUsage,
                call: sendComposed,
              });
        return { instagramMessageId: sent.messageId };
      },
    };
  }
}
