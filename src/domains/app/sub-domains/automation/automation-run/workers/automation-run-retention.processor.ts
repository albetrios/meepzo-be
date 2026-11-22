import type { BatchDeleteResult } from '@/infrastructure/database/utils/batch-delete.util.js';
import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { AUTOMATION_RUN_RETENTION_DAYS } from '@/shared/constants/instagram.constants.js';
import { createRetentionAutomationRunRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js';

/**
 * Deletes every run that ended — `completed`, `failed` or `cancelled` — more than
 * {@link AUTOMATION_RUN_RETENTION_DAYS} (180) days ago, with its run events (routes-final § 3.B
 * AU25, WC-12, D8). Open runs are never removed.
 *
 * @remarks
 * - **Algorithm:** a cutoff `now - 180 days`, then one `runGlobalRetentionWorkerJob` that deletes
 *   the runs whose `ended_at` is before it, in capped batches (`deleteInBatchesByCondition`,
 *   `idx_automation_runs_ended`, through the retention-bound repository). The table's `USING`
 *   sweep arm lets the retention context see every organization's runs; it opens no
 *   organization's data otherwise (worker-changes rule 1).
 * - **Failure modes:** database errors propagate to BullMQ (retries, then the queue's DLQ). A run
 *   that stops at the batch cap leaves the rest to the next day (`hasMore`).
 * - **Side effects:** hard-deletes rows from `app.automation_runs`; their
 *   `app.automation_run_events` go by `ON DELETE CASCADE`; their `app.automation_comment_logs`
 *   stay with `automation_run_id` emptied (`ON DELETE SET NULL (automation_run_id)`, AU24) until
 *   comment-log retention. `info` logs at the start and the end with counts only.
 * - **Notes:** idempotent and safe to skip — the next day catches up, and deleting twice changes
 *   nothing. Once a final run is gone the contact may trigger that automation again (AU17). Runs at
 *   03:20 UTC, before comment-log retention (03:30) and the deleted-automation purge (03:40).
 *   `now` is injectable for tests.
 */
export async function runAutomationRunRetentionJob({
  now = new Date(),
}: {
  now?: Date | undefined;
} = {}): Promise<BatchDeleteResult> {
  const cutoff = new Date(now.getTime() - AUTOMATION_RUN_RETENTION_DAYS * MILLISECONDS_PER_DAY);

  logger.info(
    { retentionDays: AUTOMATION_RUN_RETENTION_DAYS, cutoffDate: cutoff.toISOString() },
    'automation-run-retention.starting',
  );

  const result = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionAutomationRunRepository(databaseHandle).deleteEndedBefore(cutoff),
  );

  logger.info(
    {
      deletedCount: result.deletedCount,
      blockedCount: result.blockedCount,
      hasMore: result.hasMore,
      retentionDays: AUTOMATION_RUN_RETENTION_DAYS,
    },
    'automation-run-retention.completed',
  );

  return result;
}
