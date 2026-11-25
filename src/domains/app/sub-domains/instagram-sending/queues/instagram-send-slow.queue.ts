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
 * per lane turn, family `instagram` — run in the existing `worker` service (P140).
 */
export const INSTAGRAM_SEND_SLOW_QUEUE_NAME = 'instagram-send-slow';

/** Job name of one lane turn. */
export const INSTAGRAM_SEND_LANE_TURN_JOB_NAME = 'instagram-send-lane-turn';

/** BullMQ states of a ticket that is still on its way — a late ticket, not a lost one (WC-13). */
const PRESENT_TICKET_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
]);

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

/**
 * Re-adds the lane turns whose tickets are lost (feat-instagram-dm-sending WC-13, R47): a turn whose
 * ticket is still on its way is only counted (late but present); one with no job, or a job that
 * finished, gets its ticket again in one `addBulk` — the same job id, so a turn is never added twice.
 *
 * @remarks
 * Algorithm: one `getJob` (and its state) per turn, the finished ones removed, then one `addBulk`.
 * Failure modes: a Redis error propagates (the duty's next minute tries again). Side effects: the
 * slow queue's jobs. Notes: payloads are validated like {@link enqueueInstagramSendLaneTurn}'s.
 */
export async function addMissingInstagramSendLaneTurns(
  tickets: readonly {
    organizationPublicId: string;
    channelAccountPublicId: string;
    lane: InstagramSlowQueueLane;
    turnNumber: number;
  }[],
): Promise<{ added: number; present: number }> {
  const queue = getInstagramSendSlowQueue();
  const toAdd: Parameters<typeof queue.addBulk>[0] = [];
  let present = 0;
  for (const ticket of tickets) {
    const jobId = instagramSendLaneTurnJobId(ticket);
    const job = await queue.getJob(jobId);
    if (job !== undefined && job !== null) {
      if (PRESENT_TICKET_STATES.has(await job.getState())) {
        present += 1;
        continue;
      }
      await job.remove();
    }
    toAdd.push({
      name: INSTAGRAM_SEND_LANE_TURN_JOB_NAME,
      data: parseBullMQJobData({
        schema: instagramSendSlowJobDataSchema,
        data: { ...ticket, ...captureTraceContextForPropagation() },
        queueName: INSTAGRAM_SEND_SLOW_QUEUE_NAME,
      }),
      opts: {
        jobId,
        ...(ticket.lane === 'broadcast' ? { priority: INSTAGRAM_BROADCAST_TURN_PRIORITY } : {}),
      },
    });
  }
  if (toAdd.length > 0) await queue.addBulk(toAdd);
  return { added: toAdd.length, present };
}

/** Closes the lazily created producer queue (graceful shutdown). */
export async function closeInstagramSendSlowQueue(): Promise<void> {
  if (instagramSendSlowQueue) {
    await instagramSendSlowQueue.close();
    instagramSendSlowQueue = null;
  }
}
