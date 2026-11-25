import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  runTimeBudgetedCleanUp,
  type TimeBudgetedCleanUpReport,
} from '@/infrastructure/queue/worker-runtime/time-budgeted-clean-up.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { AUTOMATION_TOMBSTONE_RETENTION_DAYS } from '@/shared/constants/instagram.constants.js';
import { createRetentionAutomationRepository } from '@/domains/app/sub-domains/automation/automation.repository.js';
import { AUTOMATION_TOMBSTONE_RETENTION_MAX_ROWS_PER_RUN } from './automation-tombstone-retention.constants.js';

/**
 * Removes for good every automation deleted more than {@link AUTOMATION_TOMBSTONE_RETENTION_DAYS}
 * (180) days ago once no run or comment log points at it — with its counters, reply state and
 * past-comment reads (routes-final
 * § 3.B AU25, AQ7, § 4 AU6, § 6.C.10; feat-instagram-dm-sending WC-47, P92).
 *
 * @remarks
 * - **Algorithm:** a cutoff `now - 180 days`; {@link runTimeBudgetedCleanUp} deletes the automations in units of capped batches
 *   (`idx_automations_tombstoned`), each its own `runGlobalRetentionWorkerJob`, until none is left,
 *   {@link AUTOMATION_TOMBSTONE_RETENTION_MAX_ROWS_PER_RUN} or the time budget; the counters
 *   (`automation_counts` — so they never change while their runs go, AC-18.8), reply states and
 *   backfills go by cascade; the gauge is the oldest due automation's wait.
 * - **Failure modes:** an automation a run or a comment log still points at (`RESTRICT`) fails
 *   its delete: the batch falls back to one delete per row, skips it and counts it in
 *   `blockedCount` — the next hour tries it again, and the gauge alerts after a day. Any other
 *   database error propagates to BullMQ (retries, then the queue's DLQ).
 * - **Side effects:** hard-deletes deleted automations (a live one is never touched); the
 *   `retention_cleanup_*` gauges; `info` logs with counts only. The audit log keeps the delete (AQ7).
 * - **Notes:** the account file links a purged automation names (`app.instagram_attachments`) are
 *   deleted a day before it is due by the hourly app-table clean-up
 *   (`app-table-clean-up.processor.ts`) — automation code imports no channel folder (AUC13).
 *   Idempotent and safe to skip — the next hour catches up. Runs and comment logs go by
 *   part drops (R49), so an automation goes the hour after its last run's part is dropped. `now`
 *   is injectable for tests.
 */
export async function runAutomationTombstoneRetentionJob({
  now = new Date(),
}: {
  now?: Date | undefined;
} = {}): Promise<TimeBudgetedCleanUpReport[]> {
  const cutoff = new Date(
    now.getTime() - AUTOMATION_TOMBSTONE_RETENTION_DAYS * MILLISECONDS_PER_DAY,
  );

  return runTimeBudgetedCleanUp({
    logLabel: 'automation-tombstone-retention',
    tables: [
      {
        table: 'app.automations',
        maxRowsPerRun: AUTOMATION_TOMBSTONE_RETENTION_MAX_ROWS_PER_RUN,
        deleteUnit: ({ maxBatches }) =>
          runGlobalRetentionWorkerJob((databaseHandle) =>
            createRetentionAutomationRepository(databaseHandle).deleteTombstonedBefore({
              cutoff,
              maxBatches,
            }),
          ),
        readOldestOverdueSeconds: () =>
          runGlobalRetentionWorkerJob((databaseHandle) =>
            createRetentionAutomationRepository(databaseHandle).readTombstonedOverdueSeconds(
              cutoff,
            ),
          ),
      },
    ],
  });
}
