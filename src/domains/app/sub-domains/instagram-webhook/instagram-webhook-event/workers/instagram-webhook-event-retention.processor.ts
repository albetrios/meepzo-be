import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { INSTAGRAM_WEBHOOK_EVENT_RETENTION_DAYS } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.constants.js';
import { createRetentionInstagramWebhookEventRepository } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';

/**
 * Deletes every Instagram webhook event received more than
 * {@link INSTAGRAM_WEBHOOK_EVENT_RETENTION_DAYS} (30) days ago, whatever its status — `failed` ones
 * too (WH19, D8, D13).
 *
 * @remarks
 * - **Algorithm:** a cutoff `now - 30 days`, then one `runGlobalRetentionWorkerJob` that deletes
 *   the rows whose `created_at` (the received time) is before it, in capped batches
 *   (`deleteInBatchesByCondition`, through the retention-bound repository). The table's `USING`
 *   sweep arm lets the retention context see every organization's rows; it opens no
 *   organization's data otherwise (WH3).
 * - **Failure modes:** database errors propagate to BullMQ (retries, then the queue's DLQ). A run
 *   that stops at the batch cap leaves the rest to the next day (`hasMore`).
 * - **Side effects:** hard-deletes rows from `app.instagram_webhook_events`; `info` logs at the
 *   start and the end with counts only — never a payload.
 * - **Notes:** idempotent and safe to skip — the next day catches up, and deleting twice changes
 *   nothing (WC-8). There are no rows without an organization to delete (WH4). A contact erase
 *   leaves that person's events to this clean-up (WH18). `now` is injectable for tests.
 */
export async function runInstagramWebhookEventRetentionJob(now: Date = new Date()): Promise<{
  deletedCount: number;
  blockedCount: number;
  hasMore: boolean;
}> {
  const cutoff = new Date(
    now.getTime() - INSTAGRAM_WEBHOOK_EVENT_RETENTION_DAYS * MILLISECONDS_PER_DAY,
  );

  logger.info(
    { retentionDays: INSTAGRAM_WEBHOOK_EVENT_RETENTION_DAYS, cutoffDate: cutoff.toISOString() },
    'instagram-webhook-event-retention.starting',
  );

  const result = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionInstagramWebhookEventRepository(databaseHandle).deleteReceivedBefore(cutoff),
  );

  logger.info(
    {
      deletedCount: result.deletedCount,
      blockedCount: result.blockedCount,
      hasMore: result.hasMore,
      retentionDays: INSTAGRAM_WEBHOOK_EVENT_RETENTION_DAYS,
    },
    'instagram-webhook-event-retention.completed',
  );

  return result;
}
