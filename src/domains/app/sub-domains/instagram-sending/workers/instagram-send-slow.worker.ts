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
import { getWorkerConcurrencyInstagramSendSlow } from '@/shared/config/worker-concurrency.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { INSTAGRAM_SEND_SLOW_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-slow.queue.js';
import {
  type InstagramSendSlowJobData,
  instagramSendSlowJobDataSchema,
} from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-slow.job.schema.js';
import {
  type InstagramSendSlowServices,
  processInstagramSendSlowTicket,
} from './instagram-send-slow.processor.js';

/**
 * BullMQ worker of the slow, reply and broadcast lane turns
 * (feat-instagram-dm-sending SN2): one ticket per lane turn of one Instagram account.
 *
 * @remarks
 * - **Algorithm:** validates each payload at the boundary (`parseJobDataOrDeadLetter` — ids only,
 *   `organizationPublicId` for the job scope) and runs {@link processInstagramSendSlowTicket} under the propagated
 *   trace context, with BullMQ's lock token (a ticket that goes back is moved with it). Concurrency
 *   `WORKER_CONCURRENCY_INSTAGRAM_SEND_SLOW` — job places, which wait on Meta; the database is reached only through the
 *   process's database limiter (`WORKER_INSTAGRAM_DATABASE_SLOTS`, SN24).
 * - **Failure modes:** one attempt per ticket (plan §24.6); a malformed payload is dead-lettered at
 *   once; a ticket that goes back spends no try. A plain worker — never paused by the Instagram
 *   circuit (SN2: the lanes' stops decide), no BullMQ rate limiter.
 * - **Side effects:** see {@link processInstagramSendSlowTicket}; holds a Redis connection until the handle closes.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `instagram-send`, throughput,
 *   `isEnabled: env.SENDING_ENABLED`); the services come from the worker composition root
 *   (`appDomain`). Log lines carry ids only, never message text.
 */
export function createInstagramSendSlowWorker(services: InstagramSendSlowServices): WorkerHandle {
  const worker = new Worker<InstagramSendSlowJobData>(
    INSTAGRAM_SEND_SLOW_QUEUE_NAME,
    async (job, token) => {
      const jobData = await parseJobDataOrDeadLetter({
        schema: instagramSendSlowJobDataSchema,
        job,
        queueName: INSTAGRAM_SEND_SLOW_QUEUE_NAME,
      });
      return runWithPropagatedTraceContext({
        carrier: { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
        spanName: job.name,
        callback: () => processInstagramSendSlowTicket({ job, token, jobData, services }),
      });
    },
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: getWorkerConcurrencyInstagramSendSlow(),
      ...getDefaultWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queueName: INSTAGRAM_SEND_SLOW_QUEUE_NAME },
      'app.instagram_send_slow.worker.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: INSTAGRAM_SEND_SLOW_QUEUE_NAME });
}
