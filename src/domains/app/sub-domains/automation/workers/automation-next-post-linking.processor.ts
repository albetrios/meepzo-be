import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  type AutomationPostLinkingAccount,
  createRetentionAutomationRepository,
} from '@/domains/app/sub-domains/automation/automation.repository.js';
import { AUTOMATION_NEXT_POST_LINKING_ACCOUNT_LIMIT } from './automation-next-post-linking.constants.js';

/**
 * A channel's per-account linking task (WC-43): reads the account's posts published since
 * `postsSince`, stores the new ones and links each "my next post" automation to the first one after
 * its go-live. Instagram's adds a `next-post-linking` task on `instagram-tasks`; wired by the intake
 * worker, keyed by the account's `channel`.
 *
 * @remarks
 * Notes: a port declared by the consumer (AUC13 — the automation folder names no channel).
 */
export type AutomationPostLinkingEnqueue = (
  account: Omit<AutomationPostLinkingAccount, 'channel'>,
) => Promise<void>;

/**
 * What one linking sweep did: the accounts read, the tasks added, the accounts of a channel with no
 * linking task, and the adds Redis refused.
 *
 * @remarks
 * - **Algorithm:** counts only.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** logged as `app.automation.next_post_linking_sweep_completed`.
 */
export interface AutomationNextPostLinkingSweepResult {
  listedCount: number;
  addedCount: number;
  unsupportedChannelCount: number;
  failedAddCount: number;
}

/**
 * The "next post" linking sweep (feat-instagram-dm-sending § 4 AU6, AUC3; worker-changes WC-43;
 * P12): every 15 minutes, one linking task per connected account with a live waiting "my next post"
 * automation, across organizations — Meta sends no new-post event. "My next post" never expires.
 *
 * @remarks
 * - **Algorithm:** scan, then per account — one read across organizations under
 *   `runGlobalRetentionWorkerJob` (`AutomationRepository.listAccountsForPostLinking`, the sweep arm
 *   of the automations, channel accounts and organizations policies, `USING` only); then, with the
 *   context closed, the account's channel's task (`enqueueByChannel[channel]`) — whose work runs in
 *   that organization's own scope.
 * - **Failure modes:** a failed read throws to BullMQ (the next round reads again); a failed add is
 *   logged (`app.automation.next_post_linking_enqueue_failed`) — safe to skip, the next round links
 *   it.
 * - **Side effects:** tasks on the channels' queues; nothing is written here.
 * - **Notes:** channel-neutral (AUC13 — no `instagram-*` import); the intake worker passes
 *   Instagram's enqueue.
 */
export async function runAutomationNextPostLinkingSweepJob({
  enqueueByChannel,
}: {
  enqueueByChannel: Readonly<Record<string, AutomationPostLinkingEnqueue>>;
}): Promise<AutomationNextPostLinkingSweepResult> {
  const accounts = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionAutomationRepository(databaseHandle).listAccountsForPostLinking({
      limit: AUTOMATION_NEXT_POST_LINKING_ACCOUNT_LIMIT,
    }),
  );
  const result: AutomationNextPostLinkingSweepResult = {
    listedCount: accounts.length,
    addedCount: 0,
    unsupportedChannelCount: 0,
    failedAddCount: 0,
  };
  for (const { channel, ...account } of accounts) {
    const enqueue = enqueueByChannel[channel];
    if (enqueue === undefined) {
      result.unsupportedChannelCount += 1;
      continue;
    }
    try {
      await enqueue(account);
      result.addedCount += 1;
    } catch (error) {
      result.failedAddCount += 1;
      logger.warn(
        {
          organizationPublicId: account.organizationPublicId,
          channelAccountPublicId: account.channelAccountPublicId,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'app.automation.next_post_linking_enqueue_failed',
      );
    }
  }
  if (result.listedCount >= AUTOMATION_NEXT_POST_LINKING_ACCOUNT_LIMIT) {
    logger.warn(result, 'app.automation.next_post_linking_sweep_capped');
  }
  logger.info(result, 'app.automation.next_post_linking_sweep_completed');
  return result;
}
