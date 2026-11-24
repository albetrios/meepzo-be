import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES } from '@/shared/constants/instagram.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { createRetentionInstagramWebhookEventRepository } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import type { InstagramWebhookAccountProcessingEnqueue } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';
import { enqueueInstagramWebhookAccountProcessing } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import {
  INSTAGRAM_WEBHOOK_RECLAIM_BATCH_SIZE,
  INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME,
} from './instagram-webhook-reclaim.constants.js';

/**
 * What one stuck-event pick-up did.
 *
 * @remarks
 * - **Algorithm:** `listedCount` accounts had a stuck event; `addedCount` processing adds were sent
 *   (an add for an account whose job is still live is a no-op in BullMQ — the deduplication);
 *   `failedAddCount` adds Redis refused.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** logged as `app.instagram_webhook.reclaim_completed`; a `listedCount` at
 *   {@link INSTAGRAM_WEBHOOK_RECLAIM_BATCH_SIZE} means more wait for the next minute.
 */
export interface InstagramWebhookReclaimResult {
  listedCount: number;
  addedCount: number;
  failedAddCount: number;
}

/**
 * The stuck-event pick-up (routes-final § 4.A WH15, worker-changes WC-2): every minute, hands each
 * Instagram account whose events still wait back to event processing — the recovery for a
 * processing add the receiver lost (WH10) and for a run that crashed mid-event.
 *
 * @remarks
 * - **Algorithm:** one read across organizations under `runGlobalRetentionWorkerJob` (the events
 *   and channel accounts policies' sweep arm, `USING` only — it reads ids and can change nothing, WH3): the
 *   accounts of live organizations with an event still `received` or `queued` more than
 *   {@link INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES} minutes after it arrived and not claimed in
 *   as long, oldest waiting first, at most {@link INSTAGRAM_WEBHOOK_RECLAIM_BATCH_SIZE}. Then, with
 *   the context closed, one processing add per account; each job then works inside its own
 *   organization's scope (`organizationPublicId`).
 * - **Failure modes:** a failed read throws to BullMQ (the next minute reads again); a failed add
 *   is logged (`app.instagram_webhook.reclaim_enqueue_failed`) and the account is found again next
 *   minute.
 * - **Side effects:** processing jobs; no row is changed — processing claims and marks the events.
 * - **Notes:** a repeatable job on the processing queue (`scheduler.ts`), run by the processing
 *   worker — no worker or connection budget of its own (the `subscription-seat-reconcile`
 *   pattern). Safe to run twice: an add for an account whose job waits or runs is dropped or kept
 *   as its one follow-up, and an event claimed in the last 5 minutes is not counted. A stuck event
 *   does not come back for ever — processing's 5-attempt cap fails it (WH12).
 */
export async function runInstagramWebhookReclaimJob({
  requestId = INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME,
  enqueue = enqueueInstagramWebhookAccountProcessing,
}: {
  /** The pick-up job's id, carried on the jobs it adds for log correlation. */
  requestId?: string | undefined;
  enqueue?: InstagramWebhookAccountProcessingEnqueue | undefined;
} = {}): Promise<InstagramWebhookReclaimResult> {
  const accounts = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionInstagramWebhookEventRepository(databaseHandle).listAccountsWithStuckEvents({
      stuckAfterMinutes: INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES,
      limit: INSTAGRAM_WEBHOOK_RECLAIM_BATCH_SIZE,
    }),
  );
  const result: InstagramWebhookReclaimResult = {
    listedCount: accounts.length,
    addedCount: 0,
    failedAddCount: 0,
  };
  for (const { organizationPublicId, channelAccountPublicId } of accounts) {
    try {
      await enqueue({ organizationPublicId, channelAccountPublicId, requestId });
      result.addedCount += 1;
    } catch (error) {
      result.failedAddCount += 1;
      logger.warn(
        {
          organizationPublicId,
          channelAccountPublicId,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'app.instagram_webhook.reclaim_enqueue_failed',
      );
    }
  }
  if (result.listedCount > 0) {
    logger.info(result, 'app.instagram_webhook.reclaim_completed');
  }
  return result;
}
