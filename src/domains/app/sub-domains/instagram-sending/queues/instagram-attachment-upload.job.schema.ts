import { z } from 'zod';

/**
 * Job name of one message file's upload to Meta (WC-32, SN20 — ROUTE row R46) on the Meta-calling
 * task queue `instagram-tasks` (S19).
 *
 * @remarks
 * Notes: the key of `instagramSendWork.taskHandlers` the app container registers the handler under.
 */
export const INSTAGRAM_ATTACHMENT_UPLOAD_JOB_NAME = 'attachment-upload';

/** The `taskInput` of one upload (WC-32): the account and the file, by public id (K8). */
export const instagramAttachmentUploadTaskInputSchema = z
  .object({
    channelAccountPublicId: z.string().regex(/^cha_[a-z0-9]{21}$/),
    uploadPublicId: z.string().regex(/^upl_[a-z0-9]{21}$/),
  })
  .strict();

/** Type inferred from {@link instagramAttachmentUploadTaskInputSchema}. */
export type InstagramAttachmentUploadTaskInput = z.infer<
  typeof instagramAttachmentUploadTaskInputSchema
>;

/**
 * The job id of one upload: `attachment-upload-<cha_…>-<upl_…>` — one per account and file (SN20),
 * so a go-live and a file change asking for the same file add one job; once its row exists a later
 * job finds it and makes no Meta call.
 */
export function instagramAttachmentUploadJobId({
  channelAccountPublicId,
  uploadPublicId,
}: InstagramAttachmentUploadTaskInput): string {
  return `attachment-upload-${channelAccountPublicId}-${uploadPublicId}`;
}
