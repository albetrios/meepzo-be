import type { BatchDeleteResult } from '@/infrastructure/database/utils/batch-delete.util.js';
import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { AUTOMATION_COMMENT_LOG_RETENTION_DAYS } from '@/shared/constants/instagram.constants.js';
import { createRetentionAutomationCommentLogRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.repository.js';

/**
 * Deletes every comment log written more than {@link AUTOMATION_COMMENT_LOG_RETENTION_DAYS} (180)
 * days ago, whatever its status (routes-final § 3.B AU25, WC-9, D8).
 *
 * @remarks
 * - **Algorithm:** a cutoff `now - 180 days`, then one `runGlobalRetentionWorkerJob` that deletes
 *   the logs whose `created_at` is before it, in capped batches (`deleteInBatchesByCondition`,
 *   `idx_automation_comment_logs_created`, through the retention-bound repository). The table's
 *   `USING` sweep arm lets the retention context see every organization's logs; it opens no
 *   organization's data otherwise (worker-changes rule 1).
 * - **Failure modes:** database errors propagate to BullMQ (retries, then the queue's DLQ). A run
 *   that stops at the batch cap leaves the rest to the next day (`hasMore`).
 * - **Side effects:** hard-deletes rows from `app.automation_comment_logs` — nothing points at a
 *   log, so nothing else changes; `info` logs at the start and the end with counts only — never a
 *   comment text (K7).
 * - **Notes:** idempotent and safe to skip — the next day catches up, and deleting twice changes
 *   nothing. A log of a run still open older than 180 days goes too (D8 counts from the write); the
 *   run itself is ended by the 7-day check long before. Runs at 03:30 UTC, after run retention and
 *   before the deleted-automation purge. `now` is injectable for tests.
 */
export async function runAutomationCommentLogRetentionJob({
  now = new Date(),
}: {
  now?: Date | undefined;
} = {}): Promise<BatchDeleteResult> {
  const cutoff = new Date(
    now.getTime() - AUTOMATION_COMMENT_LOG_RETENTION_DAYS * MILLISECONDS_PER_DAY,
  );

  logger.info(
    { retentionDays: AUTOMATION_COMMENT_LOG_RETENTION_DAYS, cutoffDate: cutoff.toISOString() },
    'automation-comment-log-retention.starting',
  );

  const result = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionAutomationCommentLogRepository(databaseHandle).deleteCreatedBefore(cutoff),
  );

  logger.info(
    {
      deletedCount: result.deletedCount,
      blockedCount: result.blockedCount,
      hasMore: result.hasMore,
      retentionDays: AUTOMATION_COMMENT_LOG_RETENTION_DAYS,
    },
    'automation-comment-log-retention.completed',
  );

  return result;
}
