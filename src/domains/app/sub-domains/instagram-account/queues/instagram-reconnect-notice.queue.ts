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
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { parseBullMQJobData } from '@/shared/utils/validation/bullmq-job-validation.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { FIVE_SECONDS_MS, SEVEN_DAYS_SECONDS } from '@/shared/constants/ttl.constants.js';
import type { InstagramAccountBrokenConnectionStatus } from '@/domains/app/sub-domains/instagram-account/instagram-account.constants.js';
import {
  instagramReconnectNoticeJobDataSchema,
  type InstagramReconnectNoticeJobDataValidated,
} from './instagram-reconnect-notice.job.schema.js';

/** BullMQ queue of the reconnect notice (IA9, IAC9): one job per account and break. */
export const INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME = 'instagram-reconnect-notice';

/** Job name of one reconnect notice. */
export const INSTAGRAM_RECONNECT_NOTICE_JOB_NAME = 'send-instagram-reconnect-notice';

/** Validated payload of a job on {@link INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME}. */
export type InstagramReconnectNoticeJobData = InstagramReconnectNoticeJobDataValidated;

/** One break of one account — what a reconnect notice is about. */
export interface InstagramConnectionBreak {
  organizationPublicId: string;
  instagramAccountPublicId: string;
  connectionStatus: InstagramAccountBrokenConnectionStatus;
  /** The channel account's `updated_at` the guarded break wrote (R6) — it names this break. */
  connectionStatusChangedAt: Date;
}

let instagramReconnectNoticeQueue: Queue<InstagramReconnectNoticeJobData> | null = null;

function getInstagramReconnectNoticeQueue(): Queue<InstagramReconnectNoticeJobData> {
  if (instagramReconnectNoticeQueue) return instagramReconnectNoticeQueue;
  instagramReconnectNoticeQueue = new Queue<InstagramReconnectNoticeJobData>(
    INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
    {
      connection: getBullMQProducerConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      defaultJobOptions: {
        removeOnComplete: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
        removeOnFail: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
        attempts: 3,
        backoff: { type: 'exponential', delay: FIVE_SECONDS_MS, jitter: QUEUE_RETRY_JITTER_RATIO },
      },
    },
  );
  return instagramReconnectNoticeQueue;
}

/**
 * The job id of one break's notice: the account and the time it broke (IA9 — one break, one
 * notice).
 *
 * @remarks
 * A second enqueue of the same break is dropped by BullMQ while the job is kept (seven days). A
 * reconnect followed by a new break stamps a new time, so the new break gets a new job and is told
 * again.
 */
export function buildInstagramReconnectNoticeJobId({
  instagramAccountPublicId,
  connectionStatusChangedAt,
}: Pick<
  InstagramConnectionBreak,
  'instagramAccountPublicId' | 'connectionStatusChangedAt'
>): string {
  return `${INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME}-${instagramAccountPublicId}-${connectionStatusChangedAt.getTime()}`;
}

/**
 * Enqueues the reconnect notice of one break (IA9), keyed by
 * {@link buildInstagramReconnectNoticeJobId}.
 *
 * @remarks
 * - **Algorithm:** validates the payload, then one `queue.add` with the break's job id.
 * - **Failure modes:** propagates BullMQ errors (Redis unreachable or full).
 * - **Side effects:** at most one job per break on the reconnect-notice queue.
 * - **Notes:** called after the guarded status change commits, never inside its transaction —
 *   use {@link enqueueInstagramReconnectNoticeBestEffort} there.
 */
export async function enqueueInstagramReconnectNotice({
  connectionBreak,
  requestId,
}: {
  connectionBreak: InstagramConnectionBreak;
  requestId?: string | undefined;
}): Promise<void> {
  const jobData = parseBullMQJobData({
    schema: instagramReconnectNoticeJobDataSchema,
    data: omitUndefined({
      organizationPublicId: connectionBreak.organizationPublicId,
      instagramAccountPublicId: connectionBreak.instagramAccountPublicId,
      connectionStatus: connectionBreak.connectionStatus,
      connectionStatusChangedAt: connectionBreak.connectionStatusChangedAt.toISOString(),
      requestId,
      ...captureTraceContextForPropagation(),
    }),
    queueName: INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
  });
  await getInstagramReconnectNoticeQueue().add(INSTAGRAM_RECONNECT_NOTICE_JOB_NAME, jobData, {
    jobId: buildInstagramReconnectNoticeJobId(connectionBreak),
  });
}

/**
 * {@link enqueueInstagramReconnectNotice} that never throws: a failed enqueue is logged
 * (`app.instagram_account.reconnect_notice_enqueue_failed`) and the break stands.
 *
 * @remarks
 * No sweep re-sends a lost notice (no row holds it — `workers-and-events.md`, "When Redis refuses
 * the enqueue"); the account still shows `expired` or `error` on the Instagram page (route 2).
 */
export async function enqueueInstagramReconnectNoticeBestEffort({
  connectionBreak,
  requestId,
}: {
  connectionBreak: InstagramConnectionBreak;
  requestId?: string | undefined;
}): Promise<void> {
  try {
    await enqueueInstagramReconnectNotice({ connectionBreak, requestId });
  } catch (error) {
    logger.warn(
      {
        error,
        organizationPublicId: connectionBreak.organizationPublicId,
        instagramAccountPublicId: connectionBreak.instagramAccountPublicId,
      },
      'app.instagram_account.reconnect_notice_enqueue_failed',
    );
  }
}

/** Closes the lazily created reconnect-notice producer queue (graceful shutdown). */
export async function closeInstagramReconnectNoticeQueue(): Promise<void> {
  if (instagramReconnectNoticeQueue) {
    await instagramReconnectNoticeQueue.close();
    instagramReconnectNoticeQueue = null;
  }
}
