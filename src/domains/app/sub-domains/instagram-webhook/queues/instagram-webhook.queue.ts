import { randomUUID } from 'node:crypto';
import { type DeduplicationOptions, Queue } from 'bullmq';
import {
  getBullMQKeyPrefix,
  getBullMQProducerConnectionOptions,
} from '@/infrastructure/queue/connection.js';
import {
  DEFAULT_JOB_RETENTION_COUNT,
  QUEUE_RETRY_JITTER_RATIO,
} from '@/infrastructure/queue/queue.constants.js';
import { captureTraceContextForPropagation } from '@/infrastructure/observability/tracing/trace-context.util.js';
import { INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS } from '@/shared/constants/instagram.constants.js';
import { FIVE_SECONDS_MS, SEVEN_DAYS_SECONDS } from '@/shared/constants/ttl.constants.js';
import { parseBullMQJobData } from '@/shared/utils/validation/bullmq-job-validation.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { InstagramWebhookAccountProcessingRequest } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';
import {
  type InstagramWebhookAccountJobDataValidated,
  instagramWebhookAccountJobDataSchema,
} from './instagram-webhook.job.schema.js';

/**
 * BullMQ queue of Instagram webhook event processing (WH5, WHC10): one job per Instagram account
 * works through that account's waiting events, plus the stuck-event pick-up (WH15) — a second job
 * name on the same queue, run by the same worker.
 */
export const INSTAGRAM_WEBHOOK_QUEUE_NAME = 'instagram-webhook';

/** Job name of one account's processing run — "work through this account's waiting events". */
export const INSTAGRAM_WEBHOOK_PROCESS_JOB_NAME = 'process-instagram-webhook-events';

/** Validated payload of a processing job on {@link INSTAGRAM_WEBHOOK_QUEUE_NAME}. */
export type InstagramWebhookAccountJobData = InstagramWebhookAccountJobDataValidated;

let instagramWebhookQueue: Queue<InstagramWebhookAccountJobData> | null = null;

function getInstagramWebhookQueue(): Queue<InstagramWebhookAccountJobData> {
  if (instagramWebhookQueue) return instagramWebhookQueue;
  instagramWebhookQueue = new Queue<InstagramWebhookAccountJobData>(INSTAGRAM_WEBHOOK_QUEUE_NAME, {
    connection: getBullMQProducerConnectionOptions(),
    prefix: getBullMQKeyPrefix(),
    defaultJobOptions: {
      removeOnComplete: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      removeOnFail: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      // WH14: a temporary failure of the account's head event retries the job — five attempts,
      // growing waits from 5 s with jitter, as `subscription-seat-sync`. The event's own attempt
      // count (the same cap) decides when it is `failed`; an Instagram outage spends neither.
      attempts: INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS,
      backoff: { type: 'exponential', delay: FIVE_SECONDS_MS, jitter: QUEUE_RETRY_JITTER_RATIO },
    },
  });
  return instagramWebhookQueue;
}

/**
 * One processing job per Instagram account at a time, on any replica (WH5) — BullMQ
 * `deduplication` keyed by the account, with `keepLastIfActive`.
 *
 * @remarks
 * - **Algorithm:** while the account's job waits or sits delayed (a retry backoff, an Instagram
 *   outage park) a further add is dropped — that job has not claimed the new events yet, so it will
 *   find them in Postgres. While the job runs, a further add is stored, and when the running job
 *   finishes it becomes ONE new job: events stored mid-run are worked through right after it.
 * - **Failure modes:** none — pure options. The key is released when the job completes or fails;
 *   a key whose job Redis lost is recovered by the next add (the stuck-event pick-up adds one every
 *   minute while an event waits).
 * - **Side effects:** none.
 * - **Notes:** the `subscriptionSeatSyncDeduplication` pattern (be-workers-events › per-aggregate
 *   ordering). Two replicas never work one account at once, so its events run strictly in order;
 *   the event claim's 5-minute lease is the backstop. Never a stable `jobId` — a retained completed
 *   job would drop every later add.
 */
export function instagramWebhookAccountProcessingDeduplication(
  instagramAccountPublicId: string,
): DeduplicationOptions {
  return { id: `instagram-webhook-events-${instagramAccountPublicId}`, keepLastIfActive: true };
}

/**
 * Adds the account's processing job (WH5, WH10): the receiver's hook after each stored entry, the
 * stuck-event pick-up (WH15) and a job that yielded after its 25 events (WH12).
 *
 * @remarks
 * - **Algorithm:** validates the payload (`organizationPublicId` for the job scope, K8), then
 *   `queue.add` with a unique `jobId` (`instagram-webhook-events-<cha_…>-<uuid>`) and the account's
 *   deduplication ({@link instagramWebhookAccountProcessingDeduplication}).
 * - **Failure modes:** propagates BullMQ / Redis errors — the receiver logs them and leaves the
 *   events `received` for the stuck-event pick-up; it never fails Meta's answer.
 * - **Side effects:** at most one job on the processing queue (none while the account's job waits).
 * - **Notes:** matches `InstagramWebhookAccountProcessingEnqueue`, the receiver's hook the app
 *   container wires.
 */
export async function enqueueInstagramWebhookAccountProcessing({
  organizationPublicId,
  instagramAccountPublicId,
  requestId,
}: InstagramWebhookAccountProcessingRequest): Promise<void> {
  const jobData = parseBullMQJobData({
    schema: instagramWebhookAccountJobDataSchema,
    data: omitUndefined({
      organizationPublicId,
      instagramAccountPublicId,
      requestId,
      ...captureTraceContextForPropagation(),
    }),
    queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
  });
  await getInstagramWebhookQueue().add(INSTAGRAM_WEBHOOK_PROCESS_JOB_NAME, jobData, {
    jobId: `instagram-webhook-events-${instagramAccountPublicId}-${randomUUID()}`,
    deduplication: instagramWebhookAccountProcessingDeduplication(instagramAccountPublicId),
  });
}

/** Closes the lazily created processing producer queue (graceful shutdown). */
export async function closeInstagramWebhookQueue(): Promise<void> {
  if (instagramWebhookQueue) {
    await instagramWebhookQueue.close();
    instagramWebhookQueue = null;
  }
}
