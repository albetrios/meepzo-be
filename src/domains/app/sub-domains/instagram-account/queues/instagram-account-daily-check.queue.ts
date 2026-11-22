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
import {
  instagramAccountDailyCheckJobDataSchema,
  type InstagramAccountDailyCheckJobDataValidated,
} from './instagram-account-daily-check.job.schema.js';

/**
 * BullMQ queue of the daily account check (IA8, IAC8): one job per connected account — and so per
 * organization — plus the 04:00 UTC sweep that adds them, a second job name on the same queue.
 */
export const INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME = 'instagram-account-daily-check';

/** Job name of one organization's daily account check. */
export const INSTAGRAM_ACCOUNT_DAILY_CHECK_JOB_NAME = 'check-instagram-account';

/** Validated payload of a job on {@link INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME}. */
export type InstagramAccountDailyCheckJobData = InstagramAccountDailyCheckJobDataValidated;

/** One account the sweep hands to the queue — the two public ids its job carries. */
export interface InstagramAccountDailyCheckTarget {
  organizationPublicId: string;
  instagramAccountPublicId: string;
}

let instagramAccountDailyCheckQueue: Queue<InstagramAccountDailyCheckJobData> | null = null;

function getInstagramAccountDailyCheckQueue(): Queue<InstagramAccountDailyCheckJobData> {
  if (instagramAccountDailyCheckQueue) return instagramAccountDailyCheckQueue;
  instagramAccountDailyCheckQueue = new Queue<InstagramAccountDailyCheckJobData>(
    INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME,
    {
      connection: getBullMQProducerConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      defaultJobOptions: {
        removeOnComplete: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
        removeOnFail: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
        // An Instagram outage spends no attempt (the provider-pausable worker parks the job);
        // these cover a one-off failure while the circuit stays closed.
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: MILLISECONDS_PER_MINUTE,
          jitter: QUEUE_RETRY_JITTER_RATIO,
        },
      },
    },
  );
  return instagramAccountDailyCheckQueue;
}

/**
 * The job id of one account's check on one UTC day: one job per account per day (IA8).
 *
 * @remarks
 * A second sweep the same day adds the same id, and BullMQ drops it while the day's job is kept
 * (seven days). The day is part of the key, so the next day's job is a new one — the stable id
 * never swallows tomorrow's check.
 */
export function buildInstagramAccountDailyCheckJobId({
  instagramAccountPublicId,
  checkedOn,
}: {
  instagramAccountPublicId: string;
  checkedOn: Date;
}): string {
  return `${INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME}-${instagramAccountPublicId}-${checkedOn.toISOString().slice(0, 10)}`;
}

/**
 * Adds one daily-check job per account (the sweep, IA8), each keyed by
 * {@link buildInstagramAccountDailyCheckJobId}; returns how many adds were sent.
 *
 * @remarks
 * - **Algorithm:** validates every payload, then one `addBulk`.
 * - **Failure modes:** propagates BullMQ errors — the sweep logs them, and the next day's sweep
 *   lists the accounts again.
 * - **Side effects:** at most one job per account per day on the daily-check queue.
 */
export async function enqueueInstagramAccountDailyChecks({
  targets,
  checkedOn,
}: {
  targets: readonly InstagramAccountDailyCheckTarget[];
  checkedOn: Date;
}): Promise<number> {
  if (targets.length === 0) return 0;
  const traceContext = captureTraceContextForPropagation();
  const jobs = targets.map((target) => ({
    name: INSTAGRAM_ACCOUNT_DAILY_CHECK_JOB_NAME,
    data: parseBullMQJobData({
      schema: instagramAccountDailyCheckJobDataSchema,
      data: {
        organizationPublicId: target.organizationPublicId,
        instagramAccountPublicId: target.instagramAccountPublicId,
        ...traceContext,
      },
      queueName: INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME,
    }),
    opts: {
      jobId: buildInstagramAccountDailyCheckJobId({
        instagramAccountPublicId: target.instagramAccountPublicId,
        checkedOn,
      }),
    },
  }));
  await getInstagramAccountDailyCheckQueue().addBulk(jobs);
  return jobs.length;
}

/** Closes the lazily created daily-check producer queue (graceful shutdown). */
export async function closeInstagramAccountDailyCheckQueue(): Promise<void> {
  if (instagramAccountDailyCheckQueue) {
    await instagramAccountDailyCheckQueue.close();
    instagramAccountDailyCheckQueue = null;
  }
}
