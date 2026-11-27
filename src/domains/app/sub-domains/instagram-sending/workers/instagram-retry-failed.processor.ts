import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { InstagramOutgoingMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/instagram-outgoing-message.service.js';
import type { InstagramSendLaneService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.service.js';
import type { InstagramTaskHandler } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import {
  type InstagramRetryFailedTaskInput,
  instagramRetryFailedTaskInputSchema,
} from '@/domains/app/sub-domains/instagram-sending/queues/instagram-retry-failed.job.schema.js';

/**
 * The `retry-failed` task (WC-42, SN18 — ROUTE row R46): the owner's allowed failed messages back
 * to `waiting`, 500 a piece, each at most once, their `failed` runs reopened; the touched accounts'
 * lanes woken after each piece.
 *
 * @remarks
 * - **Algorithm:** the owner resolved by public id in the job's organization scope (gone → nothing);
 *   `InstagramOutgoingMessageService.retryAllowedFailedMessages` with each piece in a database slot and,
 *   after each commit, `wakeLanes` per touched account (marked due; their tickets by the repair,
 *   R47 — the retry holds internal ids only).
 * - **Failure modes:** a database error propagates (one attempt, then the dead letter — committed
 *   pieces stay, `owner_retry_at` keeps a replay from retrying twice); a failed wake is logged.
 * - **Side effects:** messages, runs, open keys, lanes.
 * - **Notes:** database-heavy (`callsMeta: false`) — on `instagram-database-tasks` (S19).
 */
export function createInstagramRetryFailedTaskHandler({
  messageService,
  laneService,
}: {
  messageService: Pick<
    InstagramOutgoingMessageService,
    'resolveFailedMessagesTarget' | 'retryAllowedFailedMessages'
  >;
  laneService: Pick<InstagramSendLaneService, 'wakeLanes'>;
}): InstagramTaskHandler {
  return {
    callsMeta: false,
    inputSchema: instagramRetryFailedTaskInputSchema,
    run: async ({ organizationPublicId, taskInput, context }) => {
      const { by, ownerPublicId } = taskInput as InstagramRetryFailedTaskInput;
      const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
      const target = await context.runInDatabaseSlot(() =>
        messageService.resolveFailedMessagesTarget({ scope, by, ownerPublicId }),
      );
      if (target === null) return;
      const retriedCount = await messageService.retryAllowedFailedMessages({
        target,
        runInDatabaseSlot: (callback) => context.runInDatabaseSlot(callback),
        afterPiece: async ({ channelAccountIds }) => {
          for (const channelAccountId of channelAccountIds) {
            try {
              await context.runInDatabaseSlot(() =>
                laneService.wakeLanes({
                  scope,
                  organizationId: target.organizationId,
                  channelAccountId,
                }),
              );
            } catch (error) {
              logger.warn(
                { error_name: (error as Error | null)?.name, organizationPublicId },
                'app.instagram_message.retry_wake_failed',
              );
            }
          }
        },
      });
      logger.info(
        { organizationPublicId, by, ownerPublicId, retriedCount },
        'app.instagram_message.retried',
      );
    },
  };
}
