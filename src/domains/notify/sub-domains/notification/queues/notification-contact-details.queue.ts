import { Queue } from 'bullmq';
import { NOTIFICATION_QUEUE_NAME } from './notification.queue.js';
import {
  getBullMQKeyPrefix,
  getBullMQProducerConnectionOptions,
} from '@/infrastructure/queue/connection.js';
import { QUEUE_RETRY_JITTER_RATIO } from '@/infrastructure/queue/queue.constants.js';
import { captureTraceContextForPropagation } from '@/infrastructure/observability/tracing/trace-context.util.js';
import { parseBullMQJobData } from '@/shared/utils/validation/bullmq-job-validation.util.js';
import { FIVE_SECONDS_MS, MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import {
  CONTACT_DETAILS_NOTICE_EVERY_MINUTES,
  NOTIFICATION_CONTACT_DETAILS_JOB_NAME,
} from '@/domains/notify/sub-domains/notification/workers/notification-contact-details.constants.js';
import {
  type NotificationContactDetailsJobData,
  notificationContactDetailsJobDataSchema,
} from './notification-contact-details.job.schema.js';

let contactDetailsQueue: Queue<NotificationContactDetailsJobData> | null = null;

/**
 * The process-wide `notification-contact-details` producer (lazily created): three attempts with
 * growing waits; a finished job is removed at once, so the account's next detail opens a new window
 * (UN13), and a job that failed for good is kept an hour (the window) for the dead-letter view.
 */
function getContactDetailsQueue(): Queue<NotificationContactDetailsJobData> {
  if (contactDetailsQueue) return contactDetailsQueue;
  contactDetailsQueue = new Queue<NotificationContactDetailsJobData>(NOTIFICATION_QUEUE_NAME, {
    connection: getBullMQProducerConnectionOptions(),
    prefix: getBullMQKeyPrefix(),
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: { age: CONTACT_DETAILS_NOTICE_EVERY_MINUTES * 60 },
      attempts: 3,
      backoff: { type: 'exponential', delay: FIVE_SECONDS_MS, jitter: QUEUE_RETRY_JITTER_RATIO },
    },
  });
  return contactDetailsQueue;
}

/**
 * The note's job id: one pending note per channel account (`contact-details-<account>`).
 *
 * @remarks
 * Exported for the unit test.
 */
export function buildNotificationContactDetailsJobId(channelAccountPublicId: string): string {
  return `contact-details-${channelAccountPublicId}`;
}

/**
 * Adds the account's delayed note, due {@link CONTACT_DETAILS_NOTICE_EVERY_MINUTES} after `at`
 * (feat-instagram-dm-sending UN13); while one is pending, BullMQ drops the add (same job id).
 *
 * @remarks
 * - **Algorithm:** the payload validated at the producer; delay = window end − now (never below 0).
 * - **Failure modes:** a Redis failure propagates.
 * - **Side effects:** one BullMQ job, or none.
 * - **Notes:** reached through notify's `noteContactDetailsLeft`.
 */
export async function enqueueNotificationContactDetails({
  organizationPublicId,
  channelAccountPublicId,
  at,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  at: Date;
}): Promise<void> {
  const jobData = parseBullMQJobData({
    schema: notificationContactDetailsJobDataSchema,
    data: {
      organizationPublicId,
      channelAccountPublicId,
      windowStartedAt: at.toISOString(),
      ...captureTraceContextForPropagation(),
    },
    queueName: NOTIFICATION_QUEUE_NAME,
  });
  const dueAt = at.getTime() + CONTACT_DETAILS_NOTICE_EVERY_MINUTES * MILLISECONDS_PER_MINUTE;
  await getContactDetailsQueue().add(NOTIFICATION_CONTACT_DETAILS_JOB_NAME, jobData, {
    jobId: buildNotificationContactDetailsJobId(channelAccountPublicId),
    delay: Math.max(0, dueAt - Date.now()),
  });
}

/** Close the lazily created producer (graceful shutdown, tests). */
export async function closeNotificationContactDetailsQueue(): Promise<void> {
  if (contactDetailsQueue) {
    await contactDetailsQueue.close();
    contactDetailsQueue = null;
  }
}
