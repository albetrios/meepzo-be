import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type {
  InstagramAttachmentType,
  InstagramUploadedAttachment,
  MetaGraphUsageRecorder,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';

/**
 * The upload domain's usable-file read (`UploadService.findUsableMessageFile`, ROUTE row R12) — the
 * only way the attachment reaches a file (P25: the public id only, no key into `upload.uploads`).
 * Answers `null` for every file that may not be sent: another organization's, another purpose, not
 * confirmed, deleted (SN21).
 */
export interface InstagramAttachmentFilePort {
  findUsableMessageFile(input: {
    scope: OrganizationPrincipalDatabaseScope;
    uploadPublicId: string;
  }): Promise<{ upload_public_id: string; content_type: string; download_url: string } | null>;
}

/** The Meta call that uploads one file for an account (the client's `uploadInstagramMessageAttachment`). */
export type InstagramAttachmentUploader = (input: {
  encryptedAccessToken: string;
  instagramUserId: string;
  type: InstagramAttachmentType;
  url: string;
  requestId?: string | undefined;
  recordUsage?: MetaGraphUsageRecorder | undefined;
}) => Promise<InstagramUploadedAttachment>;

/**
 * The `attachment-upload` task on `instagram-tasks` (WC-32, ROUTE row R46): one job per account and
 * go-live or file change, added after the commit, whose body is
 * `InstagramAttachmentService.uploadAttachments`. Until R46 wires it, files are uploaded just before
 * their first send.
 */
export interface InstagramAttachmentUploadQueue {
  enqueueAttachmentUpload(input: {
    organizationPublicId: string;
    channelAccountPublicId: string;
    uploadPublicIds: readonly string[];
  }): Promise<void>;
}

/**
 * What became of one file of an account (SN20):
 * - `ready` — Meta's id, kept (`wasUploaded` false: reused, no Meta call) or just uploaded;
 * - `unusable` — the upload may not be sent (not confirmed, wrong purpose, deleted, another
 *   organization's, or a type Instagram does not take): never uploaded, never sent (SN21);
 * - `not_sendable` — the account or its connection is not connected, or has no token;
 * - `usage_wait` — the connection's Meta usage says wait until `waitUntil` (SN23): no call made;
 * - `upload_failed` — Meta refused or failed the upload; the caller maps the error's group (R42)
 *   and counts the try (`INSTAGRAM_ATTACHMENT_UPLOAD_MAX_TRIES`).
 */
export type InstagramAttachmentOutcome =
  | { status: 'ready'; attachmentId: string; wasUploaded: boolean }
  | { status: 'unusable' }
  | { status: 'not_sendable' }
  | { status: 'usage_wait'; waitUntil: Date | null }
  | { status: 'upload_failed'; error: MetaGraphApiError };
