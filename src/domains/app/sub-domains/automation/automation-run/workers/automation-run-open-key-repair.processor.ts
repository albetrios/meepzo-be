import {
  REPAIR_DUTY_PIECE_SIZE,
  type RepairDutyContext,
  type RepairDutyOutcome,
  runRepairDutyPieces,
} from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';
import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';

/**
 * The job name of the open-run key repair (WC-67), one repeat job of its own (P94).
 *
 * @remarks
 * Notes: scheduled every minute on the intake queue `instagram-webhook` (`scheduler.ts`).
 */
export const AUTOMATION_RUN_OPEN_KEY_REPAIR_JOB_NAME = 'repair-open-run-keys';

/**
 * Removes open-run keys whose run has ended (feat-instagram-dm-sending § 4.B AU37, AUC15; WC-67;
 * P100, P94): a key still naming a completed, failed or cancelled run — its delete missed in the
 * commit that ended the run — goes, so a missed delete never blocks her from starting that
 * automation again; a key whose run is still open is left alone.
 *
 * @remarks
 * - **Algorithm:** pieces of {@link REPAIR_DUTY_PIECE_SIZE} through R14's
 *   `AutomationRunService.repairOpenRunKeys` on a retention handle (one delete, `SKIP LOCKED`, the
 *   sweep arm in `USING`), until a piece comes back short or the budget is spent.
 * - **Failure modes:** a database error propagates (the next minute runs again).
 * - **Side effects:** deletes keys only. A key it removes also lets the partition upkeep drop that
 *   key's runs part (R49: a leftover key blocks the part's DETACH until then).
 * - **Notes:** safe to run twice — a removed key is gone; removing twice changes nothing.
 */
export async function runAutomationRunOpenKeyRepairDuty({
  context,
  runService,
}: {
  context: RepairDutyContext;
  runService: Pick<AutomationRunService, 'repairOpenRunKeys'>;
}): Promise<RepairDutyOutcome> {
  return runRepairDutyPieces<number>({
    context,
    runPiece: async () => {
      const removed = await runGlobalRetentionWorkerJob((databaseHandle) =>
        runService.repairOpenRunKeys({ databaseHandle, limit: REPAIR_DUTY_PIECE_SIZE }),
      );
      return {
        done: removed,
        size: removed,
        nextCursor: removed < REPAIR_DUTY_PIECE_SIZE ? null : 0,
      };
    },
  });
}
