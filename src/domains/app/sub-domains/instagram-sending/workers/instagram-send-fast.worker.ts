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
import { getWorkerConcurrencyInstagramSendFast } from '@/shared/config/worker-concurrency.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { INSTAGRAM_SEND_FAST_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-fast.queue.js';
import {
  type InstagramSendFastJobData,
  instagramSendFastJobDataSchema,
} from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-fast.job.schema.js';
import {
  type InstagramSendFastServices,
  processInstagramSendFastTicket,
} from './instagram-send-fast.processor.js';

/**
 * BullMQ worker of the fast lane (feat-instagram-dm-sending SN2): one ticket per
 * fast message.
 *
 * @remarks
 * - **Algorithm:** validates each payload at the boundary (`parseJobDataOrDeadLetter` — ids only,
 *   `organizationPublicId` for the job scope) and runs {@link processInstagramSendFastTicket} under the propagated
 *   trace context, with BullMQ's lock token (a ticket that goes back is moved with it). Concurrency
 *   `WORKER_CONCURRENCY_INSTAGRAM_SEND_FAST` — job places, which wait on Meta; the database is reached only through the
 *   process's database limiter (`WORKER_INSTAGRAM_DATABASE_SLOTS`, SN24).
 * - **Failure modes:** one attempt per ticket (plan §24.6); a malformed payload is dead-lettered at
 *   once; a ticket that goes back spends no try. A plain worker — never paused by the Instagram
 *   circuit (SN2: the lanes' stops decide), no BullMQ rate limiter.
 * - **Side effects:** see {@link processInstagramSendFastTicket}; holds a Redis connection until the handle closes.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `instagram-send`, throughput,
 *   `isEnabled: env.SENDING_ENABLED`); the services come from the worker composition root
 *   (`appDomain`). Log lines carry ids only, never message text.
 */
export function createInstagramSendFastWorker(services: InstagramSendFastServices): WorkerHandle {
  const worker = new Worker<InstagramSendFastJobData>(
    INSTAGRAM_SEND_FAST_QUEUE_NAME,
    async (job, token) => {
      const jobData = await parseJobDataOrDeadLetter({
        schema: instagramSendFastJobDataSchema,
        job,
        queueName: INSTAGRAM_SEND_FAST_QUEUE_NAME,
      });
      return runWithPropagatedTraceContext({
        carrier: { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
        spanName: job.name,
        callback: () => processInstagramSendFastTicket({ job, token, jobData, services }),
      });
    },
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: getWorkerConcurrencyInstagramSendFast(),
      ...getDefaultWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queueName: INSTAGRAM_SEND_FAST_QUEUE_NAME },
      'app.instagram_send_fast.worker.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: INSTAGRAM_SEND_FAST_QUEUE_NAME });
}
