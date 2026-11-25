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
import type { ContactTagEventIntakeJobInput } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.types.js';
import type { InstagramWebhookEventIntakeGroup } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.constants.js';
import {
  INSTAGRAM_INTAKE_LOW_PRIORITY,
  INSTAGRAM_INTAKE_PRIORITY,
  INSTAGRAM_TAG_EVENT_INTAKE_PRIORITY,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.constants.js';
import type { InstagramWebhookIntakeRequest } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';
import {
  type InstagramTagEventIntakeJobDataValidated,
  type InstagramWebhookIntakeJobDataValidated,
  instagramTagEventIntakeJobDataSchema,
  instagramWebhookIntakeJobDataSchema,
} from './instagram-webhook.job.schema.js';

/**
 * BullMQ queue of Instagram intake (feat-instagram-dm-sending § 5 WH5, WHC4): four job names —
 * one per kind group of an account ({@link INSTAGRAM_WEBHOOK_INTAKE_JOB_NAMES}) and one for tag
 * events ({@link INSTAGRAM_TAG_EVENT_INTAKE_JOB_NAME}) — plus the stuck-event pick-up, all run by
 * the one intake worker.
 */
export const INSTAGRAM_WEBHOOK_QUEUE_NAME = 'instagram-webhook';

/**
 * The job name of each kind group's intake (WH5, WH11): `intake-messages` (taps, typed answers,
 * DMs, story replies and mentions, shared posts, starter questions, links, ad messages, reactions,
 * echoes), `intake-live` (Live comments), `intake-comments` (comments, ad comments).
 */
export const INSTAGRAM_WEBHOOK_INTAKE_JOB_NAMES = {
  messages: 'intake-messages',
  live: 'intake-live',
  comments: 'intake-comments',
} as const satisfies Record<InstagramWebhookEventIntakeGroup, string>;

/** The job name of one tag-intake job (WH15, WC-4): one contact, or up to 500 of a bulk change. */
export const INSTAGRAM_TAG_EVENT_INTAKE_JOB_NAME = 'intake-tag-events';

/** Validated payload of a kind group's intake job on {@link INSTAGRAM_WEBHOOK_QUEUE_NAME}. */
export type InstagramWebhookIntakeJobData = InstagramWebhookIntakeJobDataValidated;

/** Validated payload of a tag-intake job on {@link INSTAGRAM_WEBHOOK_QUEUE_NAME}. */
export type InstagramTagEventIntakeJobData = InstagramTagEventIntakeJobDataValidated;

/** Any payload this queue carries (the pick-up's is empty). */
type InstagramWebhookQueueJobData =
  | InstagramWebhookIntakeJobData
  | InstagramTagEventIntakeJobData
  | Record<string, never>;

let instagramWebhookQueue: Queue<InstagramWebhookQueueJobData> | null = null;

function getInstagramWebhookQueue(): Queue<InstagramWebhookQueueJobData> {
  if (instagramWebhookQueue) return instagramWebhookQueue;
  instagramWebhookQueue = new Queue<InstagramWebhookQueueJobData>(INSTAGRAM_WEBHOOK_QUEUE_NAME, {
    connection: getBullMQProducerConnectionOptions(),
    prefix: getBullMQKeyPrefix(),
    defaultJobOptions: {
      removeOnComplete: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      removeOnFail: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      // WH12: a job that throws (Postgres unreachable, an event's temporary failure before its
      // 5th try) is retried — five attempts, growing waits from 5 s with jitter. The event's own
      // try count decides when it is `failed`; a database outage spends none.
      attempts: INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS,
      backoff: { type: 'exponential', delay: FIVE_SECONDS_MS, jitter: QUEUE_RETRY_JITTER_RATIO },
    },
  });
  return instagramWebhookQueue;
}

/**
 * The deduplication of one kind group's intake job of one account (WH5, WHC4, S11):
 * `intake-<kind>-<cha_…>`, with `-<slot>` for the second and later comment-intake jobs.
 *
 * @remarks
 * - **Algorithm:** `keepLastIfActive` — while the job waits or sits delayed, a further add is
 *   dropped (that job has not claimed the new events yet, Postgres holds them); while it runs, one
 *   further add is kept and runs right after it.
 * - **Failure modes:** none — pure options. The key is released when the job completes or fails;
 *   a key whose job Redis lost is recovered by the next add (the pick-up).
 * - **Side effects:** none.
 * - **Notes:** the `subscriptionSeatSyncDeduplication` pattern (be-workers-events › per-aggregate
 *   ordering). Messages and Live run one job per account (strict order in the group); comments up
 *   to `INSTAGRAM_COMMENT_INTAKE_JOBS_PER_ACCOUNT` (S11 — `SKIP LOCKED`). Never a stable `jobId`.
 */
export function instagramWebhookIntakeDeduplication({
  intakeKind,
  channelAccountPublicId,
  slot = 0,
}: {
  intakeKind: InstagramWebhookEventIntakeGroup;
  channelAccountPublicId: string;
  /** The comment-intake job's slot (0 for every other kind). */
  slot?: number;
}): DeduplicationOptions {
  const suffix = slot === 0 ? '' : `-${slot}`;
  return { id: `intake-${intakeKind}-${channelAccountPublicId}${suffix}`, keepLastIfActive: true };
}

/**
 * Adds one kind group's intake job of an account (WH5): the receiver's hook after each stored
 * entry (one per kind that got events), the pick-up, and a job that yielded after its 25 events.
 *
 * @remarks
 * - **Algorithm:** validates the payload (public ids only, K8), then `queue.add` under the kind's
 *   job name ({@link INSTAGRAM_WEBHOOK_INTAKE_JOB_NAMES}) with a unique `jobId`, the kind's
 *   deduplication ({@link instagramWebhookIntakeDeduplication}) and its priority — the request's,
 *   else {@link INSTAGRAM_INTAKE_PRIORITY} of the kind (1 · 1 · 5).
 * - **Failure modes:** propagates BullMQ / Redis errors — the receiver logs them and leaves the
 *   events `received` for the pick-up; it never fails Meta's answer.
 * - **Side effects:** at most one job on the queue.
 * - **Notes:** matches `InstagramWebhookIntakeEnqueue`, the receiver's hook the app container wires.
 */
export async function enqueueInstagramWebhookIntake({
  organizationPublicId,
  channelAccountPublicId,
  intakeKind,
  requestId,
  priority,
  slot = 0,
}: InstagramWebhookIntakeRequest): Promise<void> {
  const jobData = parseBullMQJobData({
    schema: instagramWebhookIntakeJobDataSchema,
    data: omitUndefined({
      organizationPublicId,
      channelAccountPublicId,
      intakeKind,
      requestId,
      ...captureTraceContextForPropagation(),
    }),
    queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
  });
  await getInstagramWebhookQueue().add(INSTAGRAM_WEBHOOK_INTAKE_JOB_NAMES[intakeKind], jobData, {
    jobId: `intake-${intakeKind}-${channelAccountPublicId}-${randomUUID()}`,
    priority: priority ?? INSTAGRAM_INTAKE_PRIORITY[intakeKind],
    deduplication: instagramWebhookIntakeDeduplication({
      intakeKind,
      channelAccountPublicId,
      slot,
    }),
  });
}

/**
 * Adds one tag-intake job (WH15, WC-4, S20) — contact's `ContactTagEventIntakeQueue` port, called
 * after the tag change's commit.
 *
 * @remarks
 * - **Algorithm:** validates the payload; one contact → priority
 *   {@link INSTAGRAM_TAG_EVENT_INTAKE_PRIORITY} and the deduplication `intake-tag-events-<con_…>`;
 *   several (a bulk change's piece of up to 500) → {@link INSTAGRAM_INTAKE_LOW_PRIORITY} and no
 *   deduplication (the rows' `done_at` guard makes a repeat harmless).
 * - **Failure modes:** propagates BullMQ / Redis errors — the tag-event service logs them and the
 *   pick-up (WC-27, ROUTE row R47) hands the events over again.
 * - **Side effects:** at most one job on the queue.
 */
export async function enqueueInstagramTagEventIntake({
  organizationPublicId,
  contactPublicIds,
}: ContactTagEventIntakeJobInput): Promise<void> {
  const jobData = parseBullMQJobData({
    schema: instagramTagEventIntakeJobDataSchema,
    data: omitUndefined({
      organizationPublicId,
      contactPublicIds: [...contactPublicIds],
      ...captureTraceContextForPropagation(),
    }),
    queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
  });
  const [onlyContact] = contactPublicIds;
  const isOneContact = contactPublicIds.length === 1 && onlyContact !== undefined;
  await getInstagramWebhookQueue().add(INSTAGRAM_TAG_EVENT_INTAKE_JOB_NAME, jobData, {
    jobId: `intake-tag-events-${onlyContact ?? 'none'}-${randomUUID()}`,
    priority: isOneContact ? INSTAGRAM_TAG_EVENT_INTAKE_PRIORITY : INSTAGRAM_INTAKE_LOW_PRIORITY,
    ...(isOneContact
      ? { deduplication: { id: `intake-tag-events-${onlyContact}`, keepLastIfActive: true } }
      : {}),
  });
}

/** Closes the lazily created intake producer queue (graceful shutdown). */
export async function closeInstagramWebhookQueue(): Promise<void> {
  if (instagramWebhookQueue) {
    await instagramWebhookQueue.close();
    instagramWebhookQueue = null;
  }
}
