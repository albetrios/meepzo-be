import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  AUTOMATION_BACKFILL_STUCK_QUEUED_MINUTES,
  AUTOMATION_BACKFILL_STUCK_READ_MINUTES,
  AUTOMATION_BACKFILL_WATCH_LIMIT,
} from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.constants.js';
import { createRetentionAutomationBackfillRepository } from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.repository.js';
import type { AutomationBackfillReadQueue } from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.types.js';

/**
 * What one watch round did: the accounts with a stuck read and the wake-ups Redis refused.
 *
 * @remarks
 * - **Algorithm:** counts only.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** logged as `app.automation_backfill.watch_completed`.
 */
export interface AutomationBackfillWatchResult {
  stuckAccountCount: number;
  failedWakeCount: number;
}

/**
 * The past-comments watch (feat-instagram-dm-sending § 4.C AU32, AUC12; worker-changes WC-41): every
 * 10 minutes, the read job of each account whose `reading` read has had no new page for 30 minutes
 * (it is started again from zero) or whose `queued` read waits over 10 minutes with its job lost.
 *
 * @remarks
 * - **Algorithm:** one read across organizations under `runGlobalRetentionWorkerJob`
 *   (`listAccountsWithStuckReads` over `idx_automation_backfills_watch`, the policy's sweep arm),
 *   then — the context closed — one wake-up per account through the read queue; the job decides
 *   (one read at a time per account: a fresh `reading` read is left alone, a stuck one restarted,
 *   else the oldest `queued` one starts).
 * - **Failure modes:** a failed read throws to BullMQ (the next round reads again); a failed wake-up
 *   is logged (`app.automation_backfill.watch_wake_failed`).
 * - **Side effects:** tasks on the channel's queue; nothing is written here.
 * - **Notes:** channel-neutral (AUC13); the intake worker passes Instagram's read queue.
 */
export async function runAutomationBackfillWatchJob({
  readQueue,
  now = new Date(),
}: {
  readQueue: AutomationBackfillReadQueue;
  now?: Date | undefined;
}): Promise<AutomationBackfillWatchResult> {
  const accounts = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionAutomationBackfillRepository(databaseHandle).listAccountsWithStuckReads({
      stuckReadBefore: new Date(
        now.getTime() - AUTOMATION_BACKFILL_STUCK_READ_MINUTES * MILLISECONDS_PER_MINUTE,
      ),
      stuckQueuedBefore: new Date(
        now.getTime() - AUTOMATION_BACKFILL_STUCK_QUEUED_MINUTES * MILLISECONDS_PER_MINUTE,
      ),
      limit: AUTOMATION_BACKFILL_WATCH_LIMIT,
    }),
  );
  const result: AutomationBackfillWatchResult = {
    stuckAccountCount: accounts.length,
    failedWakeCount: 0,
  };
  for (const account of accounts) {
    try {
      await readQueue.enqueueAutomationBackfillRead(account);
    } catch (error) {
      result.failedWakeCount += 1;
      logger.warn(
        { ...account, errorName: error instanceof Error ? error.name : typeof error },
        'app.automation_backfill.watch_wake_failed',
      );
    }
  }
  logger.info(result, 'app.automation_backfill.watch_completed');
  return result;
}
