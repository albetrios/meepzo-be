import { Worker } from 'bullmq';
import type { z } from 'zod';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { parseJobDataOrDeadLetter } from '@/infrastructure/queue/dlq/poison-job.util.js';
import { runWithPropagatedTraceContext } from '@/infrastructure/observability/tracing/trace-context.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import { getDefaultWorkerOptions } from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { getWorkerConcurrencyInstagramTasks } from '@/shared/config/worker-concurrency.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { instagramTaskJobDataSchema } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.job.schema.js';
import {
  INSTAGRAM_META_TASK_QUEUE,
  InstagramTaskOrganizationCap,
  type InstagramTaskQueueKind,
  type InstagramTasksServices,
  processInstagramTaskTicket,
} from './instagram-tasks.processor.js';

/**
 * Builds the BullMQ worker of one task queue (SN2, S19) — `instagram-tasks` or
 * `instagram-database-tasks`.
 *
 * @remarks
 * - **Algorithm:** validates each payload at the boundary with the queue's schema
 *   (`parseJobDataOrDeadLetter`) and runs {@link processInstagramTaskTicket} for the queue's kind under
 *   the propagated trace context, with BullMQ's lock token and the worker's own per-organization cap
 *   ({@link InstagramTaskOrganizationCap}). The database is reached only through the process's
 *   database limiter (`WORKER_INSTAGRAM_DATABASE_SLOTS`, SN24).
 * - **Failure modes:** one attempt per ticket (plan §24.6); a malformed payload is dead-lettered at
 *   once; a ticket that goes back spends no try. A plain worker — never paused by the Instagram
 *   circuit (SN2), no BullMQ rate limiter.
 * - **Side effects:** see {@link processInstagramTaskTicket}; holds a Redis connection until the handle
 *   closes.
 * - **Notes:** log lines carry ids only, never message text.
 */
export function createInstagramTaskQueueWorker({
  queue,
  jobDataSchema,
  concurrency,
  services,
}: {
  queue: InstagramTaskQueueKind;
  jobDataSchema: z.ZodType<{
    organizationPublicId: string;
    traceparent?: string | undefined;
    tracestate?: string | undefined;
  }>;
  concurrency: number;
  services: InstagramTasksServices;
}): WorkerHandle {
  const servicesWithCap: InstagramTasksServices = {
    ...services,
    organizationCap:
      services.organizationCap ?? new InstagramTaskOrganizationCap(queue.organizationMax),
  };
  const worker = new Worker(
    queue.queueName,
    async (job, token) => {
      const jobData = await parseJobDataOrDeadLetter({
        schema: jobDataSchema,
        job,
        queueName: queue.queueName,
      });
      return runWithPropagatedTraceContext({
        carrier: { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
        spanName: job.name,
        callback: () =>
          processInstagramTaskTicket({ job, token, jobData, services: servicesWithCap, queue }),
      });
    },
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency,
      ...getDefaultWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn({ jobId, queueName: queue.queueName }, 'app.instagram_tasks.worker.stalled');
  });

  return buildWorkerHandle({ worker, queueName: queue.queueName });
}

/**
 * BullMQ worker of the Meta-calling jobs around sending (feat-instagram-dm-sending SN2, D3, S19):
 * one task per job, routed to its owner's handler by job name.
 *
 * @remarks
 * - **Algorithm:** {@link createInstagramTaskQueueWorker} for `instagram-tasks`; concurrency
 *   `WORKER_CONCURRENCY_INSTAGRAM_TASKS` — job places, which wait on Meta; at most
 *   `INSTAGRAM_TASKS_PER_ORGANIZATION_MAX` of one organization at once per process.
 * - **Failure modes:** as the builder; a database-heavy handler here is dead-lettered.
 * - **Side effects:** see {@link processInstagramTaskTicket}.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `instagram`, throughput,
 *   `isEnabled: env.SENDING_ENABLED`); the services come from the worker composition root
 *   (`appDomain`).
 */
export function createInstagramTasksWorker(services: InstagramTasksServices): WorkerHandle {
  return createInstagramTaskQueueWorker({
    queue: INSTAGRAM_META_TASK_QUEUE,
    jobDataSchema: instagramTaskJobDataSchema,
    concurrency: getWorkerConcurrencyInstagramTasks(),
    services,
  });
}
