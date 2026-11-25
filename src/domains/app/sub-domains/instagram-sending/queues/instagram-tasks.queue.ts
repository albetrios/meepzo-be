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
  type InstagramTaskJobData,
  instagramTaskJobDataSchema,
} from './instagram-tasks.job.schema.js';

/**
 * BullMQ queue of the jobs around sending (feat-instagram-dm-sending SN2, D3), family `instagram`:
 * file upload, failed-message retry, account set-up, starter questions, segment count, broadcast
 * audience, past comments — each owner registers its job name and handler.
 */
export const INSTAGRAM_TASKS_QUEUE_NAME = 'instagram-tasks';

let instagramTasksQueue: Queue<InstagramTaskJobData> | null = null;

function getInstagramTasksQueue(): Queue<InstagramTaskJobData> {
  if (instagramTasksQueue) return instagramTasksQueue;
  instagramTasksQueue = new Queue<InstagramTaskJobData>(INSTAGRAM_TASKS_QUEUE_NAME, {
    connection: getBullMQProducerConnectionOptions(),
    prefix: getBullMQKeyPrefix(),
    defaultJobOptions: {
      removeOnComplete: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      removeOnFail: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      // Plan §24.6: one attempt per ticket — a task's owner keeps its state in Postgres.
      attempts: 1,
    },
  });
  return instagramTasksQueue;
}

/**
 * Adds one task (SN2) — after its owner's commit.
 *
 * @remarks
 * - **Algorithm:** validates the payload (ids only, `organizationPublicId` for the job scope), then
 *   `queue.add` under the task's job name with the owner's job id (one job per row or key —
 *   `retry-failed-<aut_… or con_…>` for the failed-message retry, R46).
 * - **Failure modes:** propagates BullMQ / Redis errors — the owner logs them and leaves its row
 *   pending for its sweep; an enqueue never fails a request.
 * - **Side effects:** at most one job on the queue.
 */
export async function enqueueInstagramTask({
  jobName,
  jobId,
  organizationPublicId,
  taskInput,
  priority,
}: {
  jobName: string;
  jobId: string;
  organizationPublicId: string;
  taskInput: InstagramTaskJobData['taskInput'];
  priority?: number;
}): Promise<void> {
  const jobData = parseBullMQJobData({
    schema: instagramTaskJobDataSchema,
    data: { organizationPublicId, taskInput, ...captureTraceContextForPropagation() },
    queueName: INSTAGRAM_TASKS_QUEUE_NAME,
  });
  await getInstagramTasksQueue().add(jobName, jobData, {
    jobId,
    ...(priority === undefined ? {} : { priority }),
  });
}

/** Closes the lazily created producer queue (graceful shutdown). */
export async function closeInstagramTasksQueue(): Promise<void> {
  if (instagramTasksQueue) {
    await instagramTasksQueue.close();
    instagramTasksQueue = null;
  }
}
