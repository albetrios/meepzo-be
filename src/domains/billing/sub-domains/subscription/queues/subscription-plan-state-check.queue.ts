import { Queue } from 'bullmq';
import {
  getBullMQKeyPrefix,
  getBullMQProducerConnectionOptions,
} from '@/infrastructure/queue/connection.js';
import {
  DEFAULT_JOB_RETENTION_COUNT,
  QUEUE_RETRY_JITTER_RATIO,
} from '@/infrastructure/queue/queue.constants.js';
import { captureTraceContextForPropagation } from '@/infrastructure/observability/tracing/trace-context.util.js';
import { parseBullMQJobData } from '@/shared/utils/validation/bullmq-job-validation.util.js';
import { MILLISECONDS_PER_MINUTE, SEVEN_DAYS_SECONDS } from '@/shared/constants/ttl.constants.js';
import { PLAN_STATE_CHECK_MINUTES } from '@/domains/billing/sub-domains/subscription/subscription.constants.js';
import {
  type SubscriptionPlanStateCheckJobData,
  subscriptionPlanStateCheckJobDataSchema,
} from './subscription-plan-state-check.job.schema.js';

/**
 * BullMQ queue of the plan-state check (routes-final § 8.B BL17, BLC10 — WC-59): the 15-minute sweep
 * and one check per due subscription — and so per organization — on one queue.
 */
export const SUBSCRIPTION_PLAN_STATE_CHECK_QUEUE_NAME = 'subscription-plan-state-check';

/** Job name of one subscription's check. */
export const SUBSCRIPTION_PLAN_STATE_CHECK_JOB_NAME = 'check-subscription-plan-state';

/** One subscription the sweep hands to the queue — the two public ids its job carries. */
export interface SubscriptionPlanStateCheckTarget {
  organizationPublicId: string;
  subscriptionPublicId: string;
}

let subscriptionPlanStateCheckQueue: Queue<SubscriptionPlanStateCheckJobData> | null = null;

function getSubscriptionPlanStateCheckQueue(): Queue<SubscriptionPlanStateCheckJobData> {
  if (subscriptionPlanStateCheckQueue) return subscriptionPlanStateCheckQueue;
  subscriptionPlanStateCheckQueue = new Queue<SubscriptionPlanStateCheckJobData>(
    SUBSCRIPTION_PLAN_STATE_CHECK_QUEUE_NAME,
    {
      connection: getBullMQProducerConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      defaultJobOptions: {
        removeOnComplete: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
        removeOnFail: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
        // Our own one-off failure (the database); the next sweep finds the row again anyway.
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: MILLISECONDS_PER_MINUTE,
          jitter: QUEUE_RETRY_JITTER_RATIO,
        },
      },
    },
  );
  return subscriptionPlanStateCheckQueue;
}

/**
 * The job id of one subscription's check in one sweep slot (every
 * {@link PLAN_STATE_CHECK_MINUTES} minutes): at most one job per subscription per sweep.
 *
 * @remarks
 * Two sweeps of the same slot add the same id and BullMQ drops the second. What the check does is
 * once by its own keys (the notices' dedupe keys, the app task's job id), not by this id.
 */
export function buildSubscriptionPlanStateCheckJobId({
  subscriptionPublicId,
  sweptAt,
}: {
  subscriptionPublicId: string;
  sweptAt: Date;
}): string {
  const slot = Math.floor(sweptAt.getTime() / (PLAN_STATE_CHECK_MINUTES * MILLISECONDS_PER_MINUTE));
  return `${SUBSCRIPTION_PLAN_STATE_CHECK_QUEUE_NAME}-${subscriptionPublicId}-${slot}`;
}

/**
 * Adds one check per due subscription (the sweep, BL17), each keyed by
 * {@link buildSubscriptionPlanStateCheckJobId}; returns how many adds were sent.
 *
 * @remarks
 * - **Algorithm:** validates every payload, then one `addBulk`.
 * - **Failure modes:** propagates BullMQ errors — the sweep logs them; the rows are still due at the
 *   next sweep (safe to skip).
 * - **Side effects:** at most one job per subscription per sweep slot.
 */
export async function enqueueSubscriptionPlanStateChecks({
  targets,
  sweptAt,
}: {
  targets: readonly SubscriptionPlanStateCheckTarget[];
  sweptAt: Date;
}): Promise<number> {
  if (targets.length === 0) return 0;
  const traceContext = captureTraceContextForPropagation();
  const jobs = targets.map((target) => ({
    name: SUBSCRIPTION_PLAN_STATE_CHECK_JOB_NAME,
    data: parseBullMQJobData({
      schema: subscriptionPlanStateCheckJobDataSchema,
      data: {
        organizationPublicId: target.organizationPublicId,
        subscriptionPublicId: target.subscriptionPublicId,
        ...traceContext,
      },
      queueName: SUBSCRIPTION_PLAN_STATE_CHECK_QUEUE_NAME,
    }),
    opts: {
      jobId: buildSubscriptionPlanStateCheckJobId({
        subscriptionPublicId: target.subscriptionPublicId,
        sweptAt,
      }),
    },
  }));
  await getSubscriptionPlanStateCheckQueue().addBulk(jobs);
  return jobs.length;
}

/** Closes the lazily created plan-state check producer queue (graceful shutdown). */
export async function closeSubscriptionPlanStateCheckQueue(): Promise<void> {
  if (subscriptionPlanStateCheckQueue) {
    await subscriptionPlanStateCheckQueue.close();
    subscriptionPlanStateCheckQueue = null;
  }
}
