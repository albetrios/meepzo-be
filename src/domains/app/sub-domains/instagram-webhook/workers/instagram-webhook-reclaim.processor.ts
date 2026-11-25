import {
  runGlobalRetentionWorkerJob,
  runOrganizationScopedWorkerJob,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES } from '@/shared/constants/instagram.constants.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { InstagramWebhookEventIntakeGroup } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.constants.js';
import {
  createRetentionInstagramWebhookEventRepository,
  createWorkerInstagramWebhookEventRepository,
  type InstagramWebhookDueFailedEvent,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import {
  INSTAGRAM_WEBHOOK_EVENT_PICK_UP_AFTER_MINUTES,
  INSTAGRAM_WEBHOOK_EVENT_RETRY_BATCH_SIZE,
  INSTAGRAM_WEBHOOK_EVENT_RETRY_MAX_AGE_DAYS,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.constants.js';
import type { InstagramWebhookIntakeEnqueue } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';
import { enqueueInstagramWebhookIntake } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import {
  INSTAGRAM_WEBHOOK_RECLAIM_BATCH_SIZE,
  INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME,
} from './instagram-webhook-reclaim.constants.js';

/**
 * What one stuck-event pick-up did.
 *
 * @remarks
 * - **Algorithm:** `listedCount` (account, kind group) pairs had a stuck event; `addedCount` intake adds were sent
 *   (an add for an account whose job is still live is a no-op in BullMQ — the deduplication);
 *   `failedAddCount` adds Redis refused; `retriedEventCount` due `failed` events went back to
 *   `received` (the hourly retry, WH21) and `endedRetryCount` lost their retry time for good (their
 *   trigger is 7 days old).
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** logged as `app.instagram_webhook.reclaim_completed`; a `listedCount` at
 *   {@link INSTAGRAM_WEBHOOK_RECLAIM_BATCH_SIZE} means more wait for the next minute.
 */
export interface InstagramWebhookReclaimResult {
  listedCount: number;
  addedCount: number;
  failedAddCount: number;
  retriedEventCount: number;
  endedRetryCount: number;
}

/** One (account, kind group) the pick-up hands to intake. */
interface IntakeTarget {
  organizationPublicId: string;
  channelAccountPublicId: string;
  intakeGroup: InstagramWebhookEventIntakeGroup;
}

/**
 * The hourly retry of `failed` events (WH17, WH21): the due ones read across organizations, then
 * each organization's rows changed in its own scope — back to `received` while the trigger is under
 * {@link INSTAGRAM_WEBHOOK_EVENT_RETRY_MAX_AGE_DAYS} days old, else the retry time emptied. Returns
 * the (account, kind group) pairs to hand to intake.
 */
async function retryDueFailedEvents(
  result: InstagramWebhookReclaimResult,
): Promise<IntakeTarget[]> {
  const due = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionInstagramWebhookEventRepository(databaseHandle).listDueFailedEvents({
      limit: INSTAGRAM_WEBHOOK_EVENT_RETRY_BATCH_SIZE,
    }),
  );
  const byOrganization = new Map<string, InstagramWebhookDueFailedEvent[]>();
  for (const event of due) {
    const events = byOrganization.get(event.organizationPublicId) ?? [];
    events.push(event);
    byOrganization.set(event.organizationPublicId, events);
  }
  const retryUntilAfter = new Date(
    Date.now() - INSTAGRAM_WEBHOOK_EVENT_RETRY_MAX_AGE_DAYS * MILLISECONDS_PER_DAY,
  );
  const targets = new Map<string, IntakeTarget>();
  for (const [organizationPublicId, events] of byOrganization) {
    const { retried, endedCount } = await runOrganizationScopedWorkerJob({
      job: { organizationPublicId },
      processor: (databaseHandle) =>
        createWorkerInstagramWebhookEventRepository(databaseHandle).retryDueFailedEvents({
          events,
          retryUntilAfter,
        }),
    });
    result.retriedEventCount += retried.length;
    result.endedRetryCount += endedCount;
    const accountOf = new Map(events.map((event) => [event.eventId, event.channelAccountPublicId]));
    for (const { eventId, intakeGroup } of retried) {
      const channelAccountPublicId = accountOf.get(Number(eventId));
      if (channelAccountPublicId === undefined) continue;
      targets.set(`${channelAccountPublicId}|${intakeGroup}`, {
        organizationPublicId,
        channelAccountPublicId,
        intakeGroup,
      });
    }
  }
  return [...targets.values()];
}

/**
 * The stuck-event pick-up (feat-instagram-dm-sending § 5.A WH17, worker-changes WC-12): every
 * minute, (1) hands each Instagram account's kind group whose events still wait back to intake — the
 * recovery for an intake add the receiver lost (WH9 step 8) and for a job that crashed mid-event —
 * and (2) sends the `failed` events whose hourly retry is due back to `received` (WH21).
 *
 * @remarks
 * - **Algorithm:** (1) one read across organizations under `runGlobalRetentionWorkerJob` (the
 *   events and channel accounts policies' sweep arm, `USING` only — it reads ids and can change
 *   nothing, WH3): the accounts of live organizations with an event still `received` or `queued`
 *   more than {@link INSTAGRAM_WEBHOOK_EVENT_PICK_UP_AFTER_MINUTES} minute after it arrived and
 *   not claimed in {@link INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES} (intake's lease), oldest
 *   waiting first, at most {@link INSTAGRAM_WEBHOOK_RECLAIM_BATCH_SIZE} (account, kind group)
 *   pairs. (2) the due `failed` events (`next_attempt_at` passed), read the same way, then changed
 *   per organization in its own job scope: back to `received` with the tries from 0 while the
 *   comment or message is under 7 days old, else the retry time emptied (it stays `failed`). Then,
 *   with every context closed, one intake add per pair (`intake-<kind>`); each job works inside its
 *   own organization's scope (`organizationPublicId`).
 * - **Failure modes:** a failed read or write throws to BullMQ (the next minute reads again; a
 *   retried event already `received` is then a stuck one); a failed add is logged
 *   (`app.instagram_webhook.reclaim_enqueue_failed`) and the account is found again next minute.
 * - **Side effects:** intake jobs; the retried events' status — intake claims and marks them.
 * - **Notes:** a repeatable job on the intake queue (`scheduler.ts`), run by the intake
 *   worker — no worker or connection budget of its own (the `subscription-seat-reconcile`
 *   pattern). Safe to run twice: an add for an account whose job waits or runs is dropped or kept
 *   as its one follow-up, an event claimed in the last 5 minutes is not counted, and a retried
 *   event is changed once (its due time is re-checked). A `failed` event gets 5 more tries an hour
 *   after each 5th failure, so it is tried about every hour until its trigger is 7 days old.
 */
export async function runInstagramWebhookReclaimJob({
  requestId = INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME,
  enqueue = enqueueInstagramWebhookIntake,
}: {
  /** The pick-up job's id, carried on the jobs it adds for log correlation. */
  requestId?: string | undefined;
  enqueue?: InstagramWebhookIntakeEnqueue | undefined;
} = {}): Promise<InstagramWebhookReclaimResult> {
  const accounts = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionInstagramWebhookEventRepository(databaseHandle).listAccountsWithStuckEvents({
      stuckAfterMinutes: INSTAGRAM_WEBHOOK_EVENT_PICK_UP_AFTER_MINUTES,
      leaseMinutes: INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES,
      limit: INSTAGRAM_WEBHOOK_RECLAIM_BATCH_SIZE,
    }),
  );
  const result: InstagramWebhookReclaimResult = {
    listedCount: accounts.length,
    addedCount: 0,
    failedAddCount: 0,
    retriedEventCount: 0,
    endedRetryCount: 0,
  };
  const retried = await retryDueFailedEvents(result);
  const targets = new Map<string, IntakeTarget>();
  for (const target of [...accounts, ...retried]) {
    targets.set(`${target.channelAccountPublicId}|${target.intakeGroup}`, target);
  }
  for (const { organizationPublicId, channelAccountPublicId, intakeGroup } of targets.values()) {
    try {
      await enqueue({
        organizationPublicId,
        channelAccountPublicId,
        intakeKind: intakeGroup,
        requestId,
      });
      result.addedCount += 1;
    } catch (error) {
      result.failedAddCount += 1;
      logger.warn(
        {
          organizationPublicId,
          channelAccountPublicId,
          intakeGroup,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'app.instagram_webhook.reclaim_enqueue_failed',
      );
    }
  }
  if (result.listedCount > 0 || result.retriedEventCount > 0 || result.endedRetryCount > 0) {
    logger.info(result, 'app.instagram_webhook.reclaim_completed');
  }
  return result;
}
