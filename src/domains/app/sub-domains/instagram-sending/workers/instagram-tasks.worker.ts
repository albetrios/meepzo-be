import { Worker } from 'bullmq';
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
import { INSTAGRAM_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import {
  type InstagramTaskJobData,
  instagramTaskJobDataSchema,
} from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.job.schema.js';
import {
  INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAME_SET,
  type InstagramSendRepairDutyServices,
  runInstagramSendRepairDuty,
} from './instagram-send-repair-duties.processor.js';
import {
  type InstagramTasksServices,
  processInstagramTaskTicket,
} from './instagram-tasks.processor.js';

/**
 * BullMQ worker of the jobs around sending (feat-instagram-dm-sending SN2, D3):
 * one task per job, routed to its owner's handler by job name.
 *
 * @remarks
 * - **Algorithm:** a sending repair duty's repeat job (R47 — `repair-lost-turns` … `repair-broadcast-end`,
 *   no payload) runs {@link runInstagramSendRepairDuty}; any other job validates its payload at the boundary (`parseJobDataOrDeadLetter` — ids only,
 *   `organizationPublicId` for the job scope) and runs {@link processInstagramTaskTicket} under the propagated
 *   trace context, with BullMQ's lock token (a ticket that goes back is moved with it). Concurrency
 *   `WORKER_CONCURRENCY_INSTAGRAM_TASKS` — job places, which wait on Meta; the database is reached only through the
 *   process's database limiter (`WORKER_INSTAGRAM_DATABASE_SLOTS`, SN24).
 * - **Failure modes:** one attempt per ticket (plan §24.6); a malformed payload is dead-lettered at
 *   once; a ticket that goes back spends no try. A plain worker — never paused by the Instagram
 *   circuit (SN2: the lanes' stops decide), no BullMQ rate limiter.
 * - **Side effects:** see {@link processInstagramTaskTicket}; holds a Redis connection until the handle closes.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `instagram`, throughput,
 *   `isEnabled: env.SENDING_ENABLED`); the services come from the worker composition root
 *   (`appDomain`). Log lines carry ids only, never message text.
 */
export function createInstagramTasksWorker(
  services: InstagramTasksServices & {
    /** The sending repair duties riding this queue (SN6, R47); absent — none is run. */
    repairDuties?: InstagramSendRepairDutyServices | undefined;
  },
): WorkerHandle {
  const worker = new Worker<InstagramTaskJobData>(
    INSTAGRAM_TASKS_QUEUE_NAME,
    async (job, token) => {
      // The sending repair duties ride this queue (R47, P94): one repeat job each, no payload.
      if (INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAME_SET.has(job.name)) {
        if (services.repairDuties === undefined) return;
        await runInstagramSendRepairDuty({ duty: job.name, services: services.repairDuties });
        return;
      }
      const jobData = await parseJobDataOrDeadLetter({
        schema: instagramTaskJobDataSchema,
        job,
        queueName: INSTAGRAM_TASKS_QUEUE_NAME,
      });
      return runWithPropagatedTraceContext({
        carrier: { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
        spanName: job.name,
        callback: () => processInstagramTaskTicket({ job, token, jobData, services }),
      });
    },
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: getWorkerConcurrencyInstagramTasks(),
      ...getDefaultWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queueName: INSTAGRAM_TASKS_QUEUE_NAME },
      'app.instagram_tasks.worker.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: INSTAGRAM_TASKS_QUEUE_NAME });
}
