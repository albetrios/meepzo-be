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
  type InstagramSendFastJobData,
  instagramSendFastJobDataSchema,
} from './instagram-send-fast.job.schema.js';

/**
 * BullMQ queue of the fast lane (feat-instagram-dm-sending SN2): one ticket per fast message, family
 * `instagram` — run in the existing `worker` service (P140).
 */
export const INSTAGRAM_SEND_FAST_QUEUE_NAME = 'instagram-send-fast';

/** Job name of one fast message's send. */
export const INSTAGRAM_SEND_FAST_MESSAGE_JOB_NAME = 'instagram-send-fast-message';

/** BullMQ states of a ticket that is still on its way — a late ticket, not a lost one (WC-13). */
const PRESENT_TICKET_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
]);

let instagramSendFastQueue: Queue<InstagramSendFastJobData> | null = null;

function getInstagramSendFastQueue(): Queue<InstagramSendFastJobData> {
  if (instagramSendFastQueue) return instagramSendFastQueue;
  instagramSendFastQueue = new Queue<InstagramSendFastJobData>(INSTAGRAM_SEND_FAST_QUEUE_NAME, {
    connection: getBullMQProducerConnectionOptions(),
    prefix: getBullMQKeyPrefix(),
    defaultJobOptions: {
      removeOnComplete: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      removeOnFail: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      // Plan §24.6: one attempt per ticket — a new try is a new ticket with its try number.
      attempts: 1,
    },
  });
  return instagramSendFastQueue;
}

/**
 * The ticket id of one fast message's try (SN2): `fast-<igm_…>-<tries>` — one job per try.
 *
 * @remarks
 * Pure. A new try has a new number, so a retained completed ticket never blocks the next one.
 */
export function instagramSendFastMessageJobId({
  instagramMessagePublicId,
  tries,
}: {
  instagramMessagePublicId: string;
  tries: number;
}): string {
  return `fast-${instagramMessagePublicId}-${String(tries)}`;
}

/**
 * Adds one fast message's ticket (SN2) — after the commit that saved it waiting (R42, R44) or by the
 * repair duty that finds it lost (R47).
 *
 * @remarks
 * - **Algorithm:** validates the payload (ids only, `organizationPublicId` for the job scope), then
 *   `queue.add` with the try's job id.
 * - **Failure modes:** propagates BullMQ / Redis errors — the message stays `waiting` for the repair
 *   duty; an enqueue never fails a request.
 * - **Side effects:** at most one job on the queue.
 */
export async function enqueueInstagramSendFastMessage(
  ticket: Pick<
    InstagramSendFastJobData,
    | 'organizationPublicId'
    | 'channelAccountPublicId'
    | 'instagramMessagePublicId'
    | 'automationRunStartedAt'
    | 'tries'
  > & {
    /** Holds the ticket until the message's `not_before` (no worker ever waits, plan §24.6). */
    delayMilliseconds?: number | undefined;
  },
): Promise<void> {
  const { delayMilliseconds, ...fields } = ticket;
  const jobData = parseBullMQJobData({
    schema: instagramSendFastJobDataSchema,
    data: { ...fields, ...captureTraceContextForPropagation() },
    queueName: INSTAGRAM_SEND_FAST_QUEUE_NAME,
  });
  await getInstagramSendFastQueue().add(INSTAGRAM_SEND_FAST_MESSAGE_JOB_NAME, jobData, {
    jobId: instagramSendFastMessageJobId(fields),
    ...(delayMilliseconds !== undefined && delayMilliseconds > 0
      ? { delay: delayMilliseconds }
      : {}),
  });
}

/**
 * Re-adds the fast messages whose tickets are lost (feat-instagram-dm-sending WC-13, R47): a ticket
 * still on its way is only counted; one with no job, or a job that finished, is added again in one
 * `addBulk` with its own delay (the spread after a fast stop) — the same job id, never twice.
 *
 * @remarks
 * Algorithm: one `getJob` (and its state) per ticket, the finished ones removed, then one `addBulk`.
 * Failure modes: a Redis error propagates. Side effects: the fast queue's jobs. Notes: payloads are
 * validated like {@link enqueueInstagramSendFastMessage}'s.
 */
export async function addMissingInstagramSendFastMessages(
  tickets: readonly (Pick<
    InstagramSendFastJobData,
    | 'organizationPublicId'
    | 'channelAccountPublicId'
    | 'instagramMessagePublicId'
    | 'automationRunStartedAt'
    | 'tries'
  > & { delayMilliseconds?: number | undefined })[],
): Promise<{ added: number; present: number }> {
  const queue = getInstagramSendFastQueue();
  const toAdd: Parameters<typeof queue.addBulk>[0] = [];
  let present = 0;
  for (const { delayMilliseconds, ...fields } of tickets) {
    const jobId = instagramSendFastMessageJobId(fields);
    const job = await queue.getJob(jobId);
    if (job !== undefined && job !== null) {
      if (PRESENT_TICKET_STATES.has(await job.getState())) {
        present += 1;
        continue;
      }
      await job.remove();
    }
    toAdd.push({
      name: INSTAGRAM_SEND_FAST_MESSAGE_JOB_NAME,
      data: parseBullMQJobData({
        schema: instagramSendFastJobDataSchema,
        data: { ...fields, ...captureTraceContextForPropagation() },
        queueName: INSTAGRAM_SEND_FAST_QUEUE_NAME,
      }),
      opts: {
        jobId,
        ...(delayMilliseconds !== undefined && delayMilliseconds > 0
          ? { delay: delayMilliseconds }
          : {}),
      },
    });
  }
  if (toAdd.length > 0) await queue.addBulk(toAdd);
  return { added: toAdd.length, present };
}

/** Closes the lazily created producer queue (graceful shutdown). */
export async function closeInstagramSendFastQueue(): Promise<void> {
  if (instagramSendFastQueue) {
    await instagramSendFastQueue.close();
    instagramSendFastQueue = null;
  }
}
