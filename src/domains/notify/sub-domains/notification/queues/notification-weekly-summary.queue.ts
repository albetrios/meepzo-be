import { Queue } from 'bullmq';
import { NOTIFICATION_QUEUE_NAME } from './notification.queue.js';
import {
  getBullMQKeyPrefix,
  getBullMQProducerConnectionOptions,
} from '@/infrastructure/queue/connection.js';
import {
  DEFAULT_JOB_RETENTION_COUNT,
  QUEUE_RETRY_JITTER_RATIO,
} from '@/infrastructure/queue/queue.constants.js';
import { parseBullMQJobData } from '@/shared/utils/validation/bullmq-job-validation.util.js';
import { FIVE_SECONDS_MS, SEVEN_DAYS_SECONDS } from '@/shared/constants/ttl.constants.js';
import { NOTIFICATION_WEEKLY_SUMMARY_JOB_NAME } from '@/domains/notify/sub-domains/notification/workers/notification-weekly-summary.constants.js';
import {
  type NotificationWeeklySummaryJobData,
  notificationWeeklySummaryJobDataSchema,
} from './notification-weekly-summary.job.schema.js';

let weeklySummaryQueue: Queue<NotificationWeeklySummaryJobData> | null = null;

/**
 * The process-wide `notification-weekly-summary` producer (lazily created): three attempts with
 * growing waits; finished jobs kept 7 days, so the same organization and week is added once.
 */
function getWeeklySummaryQueue(): Queue<NotificationWeeklySummaryJobData> {
  if (weeklySummaryQueue) return weeklySummaryQueue;
  weeklySummaryQueue = new Queue<NotificationWeeklySummaryJobData>(NOTIFICATION_QUEUE_NAME, {
    connection: getBullMQProducerConnectionOptions(),
    prefix: getBullMQKeyPrefix(),
    defaultJobOptions: {
      removeOnComplete: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      removeOnFail: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      attempts: 3,
      backoff: { type: 'exponential', delay: FIVE_SECONDS_MS, jitter: QUEUE_RETRY_JITTER_RATIO },
    },
  });
  return weeklySummaryQueue;
}

/**
 * One organization's summary job id: `weekly-summary-<organization>-<Monday>` (UN12) — a sweep run
 * twice in the hour, or a restart, adds nothing.
 *
 * @remarks
 * Exported for the unit test.
 */
export function buildNotificationWeeklySummaryJobId({
  organizationPublicId,
  weekStart,
}: {
  organizationPublicId: string;
  weekStart: string;
}): string {
  return `weekly-summary-${organizationPublicId}-${weekStart}`;
}

/**
 * Adds one organization's weekly summary job (feat-instagram-dm-sending UN12).
 *
 * @remarks
 * - **Algorithm:** the payload validated at the producer; job id per organization and week.
 * - **Failure modes:** a Redis failure propagates (the sweep's next hour… is past the window, so
 *   the sweep's job retries).
 * - **Side effects:** one BullMQ job, or none.
 * - **Notes:** called by the sweep only.
 */
export async function enqueueNotificationWeeklySummary(
  jobData: Pick<NotificationWeeklySummaryJobData, 'organizationPublicId' | 'weekStart'>,
): Promise<void> {
  const data = parseBullMQJobData({
    schema: notificationWeeklySummaryJobDataSchema,
    data: jobData,
    queueName: NOTIFICATION_QUEUE_NAME,
  });
  await getWeeklySummaryQueue().add(NOTIFICATION_WEEKLY_SUMMARY_JOB_NAME, data, {
    jobId: buildNotificationWeeklySummaryJobId(jobData),
  });
}

/** Close the lazily created producer (graceful shutdown, tests). */
export async function closeNotificationWeeklySummaryQueue(): Promise<void> {
  if (weeklySummaryQueue) {
    await weeklySummaryQueue.close();
    weeklySummaryQueue = null;
  }
}
