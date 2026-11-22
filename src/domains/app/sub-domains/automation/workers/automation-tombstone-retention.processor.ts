import type { BatchDeleteResult } from '@/infrastructure/database/utils/batch-delete.util.js';
import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { AUTOMATION_TOMBSTONE_RETENTION_DAYS } from '@/shared/constants/instagram.constants.js';
import { createRetentionAutomationRepository } from '@/domains/app/sub-domains/automation/automation.repository.js';

/**
 * Removes for good every automation deleted more than {@link AUTOMATION_TOMBSTONE_RETENTION_DAYS}
 * (180) days ago that no run or comment log points at any more (routes-final § 3.B AU25, AQ7,
 * WC-15).
 *
 * @remarks
 * - **Algorithm:** a cutoff `now - 180 days`, then one `runGlobalRetentionWorkerJob` that deletes
 *   the automations whose `deleted_at` is before it, in capped batches
 *   (`deleteInBatchesByCondition`, `idx_automations_tombstoned`, through the retention-bound
 *   repository). The table's `USING` sweep arm lets the retention context see every
 *   organization's automations; it opens no organization's data otherwise.
 * - **Failure modes:** an automation a run or a comment log still points at (`RESTRICT`) fails
 *   its delete with a foreign-key violation: the batch falls back to one delete per row, skips it
 *   and counts it in `blockedCount` (a warn log per skipped row) — the next day tries it again.
 *   Any other database error propagates to BullMQ (retries, then the queue's DLQ).
 * - **Side effects:** hard-deletes rows from `app.automations` (deleted ones only — a live
 *   automation is never touched); `info` logs at the start and the end with counts only. The
 *   audit log keeps the delete (AQ7).
 * - **Notes:** idempotent and safe to skip — the next day catches up, and deleting twice changes
 *   nothing. Runs at 03:40 UTC, after run retention (03:20) and comment-log retention (03:30), so an
 *   automation goes soon after the last row pointing at it. `now` is injectable for tests.
 */
export async function runAutomationTombstoneRetentionJob({
  now = new Date(),
}: {
  now?: Date | undefined;
} = {}): Promise<BatchDeleteResult> {
  const cutoff = new Date(
    now.getTime() - AUTOMATION_TOMBSTONE_RETENTION_DAYS * MILLISECONDS_PER_DAY,
  );

  logger.info(
    { retentionDays: AUTOMATION_TOMBSTONE_RETENTION_DAYS, cutoffDate: cutoff.toISOString() },
    'automation-tombstone-retention.starting',
  );

  const result = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionAutomationRepository(databaseHandle).deleteTombstonedBefore(cutoff),
  );

  logger.info(
    {
      deletedCount: result.deletedCount,
      blockedCount: result.blockedCount,
      hasMore: result.hasMore,
      retentionDays: AUTOMATION_TOMBSTONE_RETENTION_DAYS,
    },
    'automation-tombstone-retention.completed',
  );

  return result;
}
