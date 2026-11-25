import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { getWorkerConcurrencyInstagramDatabaseTasks } from '@/shared/config/worker-concurrency.util.js';
import { instagramDatabaseTaskJobDataSchema } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-database-tasks.job.schema.js';
import {
  INSTAGRAM_DATABASE_TASK_QUEUE,
  type InstagramTasksServices,
} from './instagram-tasks.processor.js';
import { createInstagramTaskQueueWorker } from './instagram-tasks.worker.js';

/**
 * BullMQ worker of the database-heavy jobs around sending (scale review S19, P97): bulk contact
 * changes, segment counts, broadcast audiences, the failed-message retry.
 *
 * @remarks
 * - **Algorithm:** the shared task-queue worker for `instagram-database-tasks` (each job carries
 *   `organizationPublicId` for its job scope, K8); concurrency
 *   `WORKER_CONCURRENCY_INSTAGRAM_DATABASE_TASKS`; at most
 *   `INSTAGRAM_DATABASE_TASKS_PER_ORGANIZATION_MAX` tasks of one organization at once per process;
 *   no sending gate (these tasks call no Meta).
 * - **Failure modes:** as the shared builder; a Meta-calling handler here is dead-lettered.
 * - **Side effects:** the handlers' rows and follow-up jobs.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `instagram`, throughput,
 *   no `isEnabled` — it runs with sending off too, R46) beside `instagram-tasks`, sharing its handlers and the
 *   process's `instagram-database` limiter.
 */
export function createInstagramDatabaseTasksWorker(services: InstagramTasksServices): WorkerHandle {
  return createInstagramTaskQueueWorker({
    queue: INSTAGRAM_DATABASE_TASK_QUEUE,
    jobDataSchema: instagramDatabaseTaskJobDataSchema,
    concurrency: getWorkerConcurrencyInstagramDatabaseTasks(),
    services,
  });
}
