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
  type InstagramDatabaseTaskJobData,
  instagramDatabaseTaskJobDataSchema,
} from './instagram-database-tasks.job.schema.js';

/**
 * BullMQ queue of the database-heavy jobs around sending (scale review S19, P97), family
 * `instagram`: bulk contact changes, segment counts, broadcast audiences, the failed-message retry —
 * split from the Meta-calling `instagram-tasks`, so a 100,000-contact change never makes an account
 * set-up wait.
 */
export const INSTAGRAM_DATABASE_TASKS_QUEUE_NAME = 'instagram-database-tasks';

let instagramDatabaseTasksQueue: Queue<InstagramDatabaseTaskJobData> | null = null;

function getInstagramDatabaseTasksQueue(): Queue<InstagramDatabaseTaskJobData> {
  if (instagramDatabaseTasksQueue) return instagramDatabaseTasksQueue;
  instagramDatabaseTasksQueue = new Queue<InstagramDatabaseTaskJobData>(
    INSTAGRAM_DATABASE_TASKS_QUEUE_NAME,
    {
      connection: getBullMQProducerConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      defaultJobOptions: {
        removeOnComplete: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
        removeOnFail: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
        // Plan §24.6: one attempt per ticket — a task's owner keeps its state in Postgres.
        attempts: 1,
      },
    },
  );
  return instagramDatabaseTasksQueue;
}

/**
 * Adds one database-heavy task (S19) — after its owner's commit.
 *
 * @remarks
 * - **Algorithm:** validates the payload (`organizationPublicId` for the job scope, the task's
 *   input), then `queue.add` under the task's job name with the owner's job id — one job per piece
 *   or key (`contact-bulk-<token>-<piece>`, `bcaud-<brc_…>-<piece>`, `segment-count-…`,
 *   `retry-failed-…`, R46).
 * - **Failure modes:** propagates BullMQ / Redis errors — the owner logs them or answers the
 *   request with them; nothing is committed by the add.
 * - **Side effects:** at most one job on the queue.
 */
export async function enqueueInstagramDatabaseTask({
  jobName,
  jobId,
  organizationPublicId,
  taskInput,
  priority,
}: {
  jobName: string;
  jobId: string;
  organizationPublicId: string;
  taskInput: InstagramDatabaseTaskJobData['taskInput'];
  priority?: number;
}): Promise<void> {
  const jobData = parseBullMQJobData({
    schema: instagramDatabaseTaskJobDataSchema,
    data: { organizationPublicId, taskInput, ...captureTraceContextForPropagation() },
    queueName: INSTAGRAM_DATABASE_TASKS_QUEUE_NAME,
  });
  await getInstagramDatabaseTasksQueue().add(jobName, jobData, {
    jobId,
    ...(priority === undefined ? {} : { priority }),
  });
}

/** Closes the lazily created producer queue (graceful shutdown). */
export async function closeInstagramDatabaseTasksQueue(): Promise<void> {
  if (instagramDatabaseTasksQueue) {
    await instagramDatabaseTasksQueue.close();
    instagramDatabaseTasksQueue = null;
  }
}
