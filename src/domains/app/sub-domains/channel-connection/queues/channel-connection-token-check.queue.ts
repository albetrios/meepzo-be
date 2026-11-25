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
  channelConnectionTokenCheckJobDataSchema,
  type ChannelConnectionTokenCheckJobDataValidated,
} from './channel-connection-token-check.job.schema.js';

/**
 * BullMQ queue of the channel connection's daily token check (routes-final § 1 MC10, MCC6): one
 * job per due connection — and so per organization — plus the hourly sweep that adds them, a second
 * job name on the same queue.
 */
export const CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME = 'channel-connection-token-check';

/** Job name of one connection's token check. */
export const CHANNEL_CONNECTION_TOKEN_CHECK_JOB_NAME = 'check-channel-connection-token';

/** Validated payload of a job on {@link CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME}. */
export type ChannelConnectionTokenCheckJobData = ChannelConnectionTokenCheckJobDataValidated;

/** One connection the sweep hands to the queue — the two public ids its job carries. */
export interface ChannelConnectionTokenCheckTarget {
  organizationPublicId: string;
  channelConnectionPublicId: string;
}

let channelConnectionTokenCheckQueue: Queue<ChannelConnectionTokenCheckJobData> | null = null;

function getChannelConnectionTokenCheckQueue(): Queue<ChannelConnectionTokenCheckJobData> {
  if (channelConnectionTokenCheckQueue) return channelConnectionTokenCheckQueue;
  channelConnectionTokenCheckQueue = new Queue<ChannelConnectionTokenCheckJobData>(
    CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME,
    {
      connection: getBullMQProducerConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      defaultJobOptions: {
        removeOnComplete: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
        removeOnFail: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
        // Meta down or busy spends no attempt (the check returns `deferred` and the next hourly
        // sweep adds it again); these cover our own one-off failure (the database).
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: MILLISECONDS_PER_MINUTE,
          jitter: QUEUE_RETRY_JITTER_RATIO,
        },
      },
    },
  );
  return channelConnectionTokenCheckQueue;
}

/**
 * The job id of one connection's check in one UTC hour: at most one job per connection per sweep.
 *
 * @remarks
 * Two sweeps in the same hour add the same id and BullMQ drops the second while the first is kept
 * (seven days). The hour is part of the key, so a check that met Meta down (`deferred`, the
 * connection still due) is added again by the next hourly sweep; a check that ran stamps
 * `last_checked_at`, so the connection is not due again for 24 hours (MC10).
 */
export function buildChannelConnectionTokenCheckJobId({
  channelConnectionPublicId,
  sweptAt,
}: {
  channelConnectionPublicId: string;
  sweptAt: Date;
}): string {
  return `${CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME}-${channelConnectionPublicId}-${sweptAt.toISOString().slice(0, 13)}`;
}

/**
 * Adds one token-check job per due connection (the sweep, MC10), each keyed by
 * {@link buildChannelConnectionTokenCheckJobId}; returns how many adds were sent.
 *
 * @remarks
 * - **Algorithm:** validates every payload, then one `addBulk`.
 * - **Failure modes:** propagates BullMQ errors — the sweep logs them, and the next hourly sweep
 *   lists the connections again (they are still due).
 * - **Side effects:** at most one job per connection per hour on the token-check queue.
 */
export async function enqueueChannelConnectionTokenChecks({
  targets,
  sweptAt,
}: {
  targets: readonly ChannelConnectionTokenCheckTarget[];
  sweptAt: Date;
}): Promise<number> {
  if (targets.length === 0) return 0;
  const traceContext = captureTraceContextForPropagation();
  const jobs = targets.map((target) => ({
    name: CHANNEL_CONNECTION_TOKEN_CHECK_JOB_NAME,
    data: parseBullMQJobData({
      schema: channelConnectionTokenCheckJobDataSchema,
      data: {
        organizationPublicId: target.organizationPublicId,
        channelConnectionPublicId: target.channelConnectionPublicId,
        ...traceContext,
      },
      queueName: CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME,
    }),
    opts: {
      jobId: buildChannelConnectionTokenCheckJobId({
        channelConnectionPublicId: target.channelConnectionPublicId,
        sweptAt,
      }),
    },
  }));
  await getChannelConnectionTokenCheckQueue().addBulk(jobs);
  return jobs.length;
}

/** Closes the lazily created token-check producer queue (graceful shutdown). */
export async function closeChannelConnectionTokenCheckQueue(): Promise<void> {
  if (channelConnectionTokenCheckQueue) {
    await channelConnectionTokenCheckQueue.close();
    channelConnectionTokenCheckQueue = null;
  }
}
