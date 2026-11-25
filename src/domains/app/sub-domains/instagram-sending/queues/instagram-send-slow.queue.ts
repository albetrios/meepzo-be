import { Queue } from 'bullmq';
import {
  getBullMQKeyPrefix,
  getBullMQProducerConnectionOptions,
} from '@/infrastructure/queue/connection.js';
import { DEFAULT_JOB_RETENTION_COUNT } from '@/infrastructure/queue/queue.constants.js';
import { captureTraceContextForPropagation } from '@/infrastructure/observability/tracing/trace-context.util.js';
import { SEVEN_DAYS_SECONDS } from '@/shared/constants/ttl.constants.js';
import { parseBullMQJobData } from '@/shared/utils/validation/bullmq-job-validation.util.js';
import {
  INSTAGRAM_BROADCAST_TURN_PRIORITY,
  type InstagramSlowQueueLane,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import {
  type InstagramSendSlowJobData,
  instagramSendSlowJobDataSchema,
} from './instagram-send-slow.job.schema.js';

/**
 * BullMQ queue of the slow, reply and broadcast lane turns (feat-instagram-dm-sending SN2): one ticket
 * per lane turn, family `instagram-send` — run by the send service (SN24, P91).
 */
export const INSTAGRAM_SEND_SLOW_QUEUE_NAME = 'instagram-send-slow';

/** Job name of one lane turn. */
export const INSTAGRAM_SEND_LANE_TURN_JOB_NAME = 'instagram-send-lane-turn';

let instagramSendSlowQueue: Queue<InstagramSendSlowJobData> | null = null;

function getInstagramSendSlowQueue(): Queue<InstagramSendSlowJobData> {
  if (instagramSendSlowQueue) return instagramSendSlowQueue;
  instagramSendSlowQueue = new Queue<InstagramSendSlowJobData>(INSTAGRAM_SEND_SLOW_QUEUE_NAME, {
    connection: getBullMQProducerConnectionOptions(),
    prefix: getBullMQKeyPrefix(),
    defaultJobOptions: {
      removeOnComplete: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      removeOnFail: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      // Plan §24.6: one attempt per ticket — the lane's own row decides what happens next (a lost
      // turn is re-added by its repair duty), never a BullMQ retry.
      attempts: 1,
    },
  });
  return instagramSendSlowQueue;
}

/**
 * The ticket id of one lane turn (SN2): `<lane>-<cha_…>-<turn_number>` — one job per turn, so a
 * second add of the same turn (the repair re-adding a ticket it thinks lost) is dropped while the
 * first is kept.
 *
 * @remarks
 * Pure. A new turn has a new number, so a retained completed ticket never blocks the next one.
 */
export function instagramSendLaneTurnJobId({
  lane,
  channelAccountPublicId,
  turnNumber,
}: {
  lane: InstagramSlowQueueLane;
  channelAccountPublicId: string;
  turnNumber: number;
}): string {
  return `${lane}-${channelAccountPublicId}-${String(turnNumber)}`;
}

/**
 * Adds one lane turn's ticket (SN2) — after the commit that made the lane ready (the lane wake, the
 * turn's release, the repair duty — R42–R47).
 *
 * @remarks
 * - **Algorithm:** validates the payload (ids only, `organizationPublicId` for the job scope), then
 *   `queue.add` with the turn's job id; a broadcast turn at priority
 *   {@link INSTAGRAM_BROADCAST_TURN_PRIORITY}; `delayMilliseconds` holds it until the lane's
 *   `next_run_at` (no worker ever waits, plan §24.6).
 * - **Failure modes:** propagates BullMQ / Redis errors — the caller logs them and leaves the lane
 *   row ready for its repair duty (R47); an enqueue never fails a request.
 * - **Side effects:** at most one job on the queue.
 */
export async function enqueueInstagramSendLaneTurn({
  organizationPublicId,
  channelAccountPublicId,
  lane,
  turnNumber,
  delayMilliseconds,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  lane: InstagramSlowQueueLane;
  turnNumber: number;
  delayMilliseconds?: number;
}): Promise<void> {
  const jobData = parseBullMQJobData({
    schema: instagramSendSlowJobDataSchema,
    data: {
      organizationPublicId,
      channelAccountPublicId,
      lane,
      turnNumber,
      ...captureTraceContextForPropagation(),
    },
    queueName: INSTAGRAM_SEND_SLOW_QUEUE_NAME,
  });
  await getInstagramSendSlowQueue().add(INSTAGRAM_SEND_LANE_TURN_JOB_NAME, jobData, {
    jobId: instagramSendLaneTurnJobId({ lane, channelAccountPublicId, turnNumber }),
    ...(lane === 'broadcast' ? { priority: INSTAGRAM_BROADCAST_TURN_PRIORITY } : {}),
    ...(delayMilliseconds !== undefined && delayMilliseconds > 0
      ? { delay: delayMilliseconds }
      : {}),
  });
}

/** Closes the lazily created producer queue (graceful shutdown). */
export async function closeInstagramSendSlowQueue(): Promise<void> {
  if (instagramSendSlowQueue) {
    await instagramSendSlowQueue.close();
    instagramSendSlowQueue = null;
  }
}
