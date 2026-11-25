import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { AppError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { InstagramAttachmentService } from '@/domains/app/sub-domains/instagram-sending/instagram-attachment/instagram-attachment.service.js';
import type { InstagramTaskHandler } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import {
  type InstagramAttachmentUploadTaskInput,
  instagramAttachmentUploadTaskInputSchema,
} from '@/domains/app/sub-domains/instagram-sending/queues/instagram-attachment-upload.job.schema.js';

/** How long an upload waits, no try used, when Meta's usage gives no time (SN23). */
const ATTACHMENT_UPLOAD_USAGE_WAIT_MILLISECONDS = 15 * 60_000;

/**
 * The `attachment-upload` task (WC-32, SN20 — ROUTE row R46): one message file uploaded to Meta
 * once for the account, ahead of its sends.
 *
 * @remarks
 * - **Algorithm:** in the job's organization scope and a database slot,
 *   `InstagramAttachmentService.uploadAttachments` for the one file (a kept id → no Meta call); Meta's
 *   usage says wait → the ticket goes back until then (15 minutes when Meta gives no time), no try
 *   used; an unusable file, an account not connected or a refused upload ends the task — the send
 *   uploads it again just before its first send (3 tries, `attachment_failed`, R42).
 * - **Failure modes:** a revoked account (`404 channel_account_not_found`) ends it, logged; other
 *   errors propagate (one attempt, then the dead letter).
 * - **Side effects:** one Meta call and one `app.instagram_attachments` row at most.
 * - **Notes:** Meta-calling (`callsMeta: true`) — on `instagram-tasks`, behind the sending gate.
 */
export function createInstagramAttachmentUploadTaskHandler({
  attachmentService,
}: {
  attachmentService: Pick<InstagramAttachmentService, 'uploadAttachments'>;
}): InstagramTaskHandler {
  return {
    callsMeta: true,
    inputSchema: instagramAttachmentUploadTaskInputSchema,
    run: async ({ organizationPublicId, taskInput, context }) => {
      const { channelAccountPublicId, uploadPublicId } =
        taskInput as InstagramAttachmentUploadTaskInput;
      const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
      let outcomes: Awaited<ReturnType<InstagramAttachmentService['uploadAttachments']>>;
      try {
        outcomes = await context.runInDatabaseSlot(() =>
          attachmentService.uploadAttachments({
            scope,
            channelAccountPublicId,
            uploadPublicIds: [uploadPublicId],
          }),
        );
      } catch (error) {
        if (!(error instanceof AppError) || error.reason !== 'channel_account_not_found') {
          throw error;
        }
        logger.info(
          { organizationPublicId, channelAccountPublicId },
          'app.instagram_attachment.account_gone',
        );
        return;
      }
      const outcome = outcomes.get(uploadPublicId);
      if (outcome?.status === 'usage_wait') {
        const waitMilliseconds =
          outcome.waitUntil === null
            ? ATTACHMENT_UPLOAD_USAGE_WAIT_MILLISECONDS
            : Math.max(outcome.waitUntil.getTime() - Date.now(), 1000);
        await context.returnTicket(waitMilliseconds);
      }
      logger.info(
        {
          organizationPublicId,
          channelAccountPublicId,
          uploadPublicId,
          status: outcome?.status ?? null,
        },
        'app.instagram_attachment.upload_task_done',
      );
    },
  };
}
