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
import { getWorkerConcurrencyNotify } from '@/shared/config/worker-concurrency.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
  type InstagramReconnectNoticeJobData,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.queue.js';
import { instagramReconnectNoticeJobDataSchema } from '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.job.schema.js';
import {
  type InstagramReconnectNoticeServices,
  processInstagramReconnectNoticeJob,
} from './instagram-reconnect-notice.processor.js';

/**
 * BullMQ worker of the reconnect notice (IA9, IAC9): one job per account and break, each sending
 * the organization's `channel-account:manage` holders one in-app notification and one email.
 *
 * @remarks
 * - **Algorithm:** validates the payload at the boundary (`parseJobDataOrDeadLetter`), carries the
 *   organization's public id (`organizationPublicId`) into the job scope, and runs
 *   {@link processInstagramReconnectNoticeJob} under the propagated trace context. Concurrency from
 *   the notify family (`WORKER_CONCURRENCY_NOTIFY`).
 * - **Failure modes:** a failure retries with the queue's backoff (three attempts) and is
 *   dead-lettered after the last; a malformed payload is dead-lettered at once. Not
 *   provider-pausable: it calls no third party — the email leaves through the mail outbox and its
 *   own Resend-pausable worker.
 * - **Side effects:** see {@link processInstagramReconnectNoticeJob}; holds a Redis connection
 *   until the handle closes.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `notify`, throughput); the
 *   three services come from the worker composition root, never built here.
 */
export function createInstagramReconnectNoticeWorker(
  services: InstagramReconnectNoticeServices,
): WorkerHandle {
  const worker = new Worker<InstagramReconnectNoticeJobData>(
    INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
    async (job) => {
      const jobData = await parseJobDataOrDeadLetter({
        schema: instagramReconnectNoticeJobDataSchema,
        job,
        queueName: INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
      });
      const { organizationPublicId, instagramAccountPublicId, requestId } = jobData;
      logger.info(
        { jobId: job.id, organizationPublicId, instagramAccountPublicId, requestId },
        'app.instagram_account.reconnect_notice.processing',
      );
      return runWithPropagatedTraceContext({
        carrier: { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
        spanName: job.name,
        callback: () => processInstagramReconnectNoticeJob({ jobData, services }),
      });
    },
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: getWorkerConcurrencyNotify(),
      ...getDefaultWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queueName: INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME },
      'app.instagram_account.reconnect_notice.worker.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME });
}
