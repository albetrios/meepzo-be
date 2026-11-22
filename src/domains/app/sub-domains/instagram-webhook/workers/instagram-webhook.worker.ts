import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import { parseJobDataOrDeadLetter } from '@/infrastructure/queue/dlq/poison-job.util.js';
import { runWithPropagatedTraceContext } from '@/infrastructure/observability/tracing/trace-context.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { createProviderPausableWorker } from '@/infrastructure/queue/worker-runtime/provider-outage-pause.util.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import { getDefaultWorkerOptions } from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { getWorkerConcurrencyInstagram } from '@/shared/config/worker-concurrency.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  INSTAGRAM_WEBHOOK_QUEUE_NAME,
  type InstagramWebhookAccountJobData,
} from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { instagramWebhookAccountJobDataSchema } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.job.schema.js';
import { INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME } from './instagram-webhook-reclaim.constants.js';
import { runInstagramWebhookReclaimJob } from './instagram-webhook-reclaim.processor.js';
import {
  type InstagramWebhookProcessingServices,
  processInstagramWebhookAccountJob,
} from './instagram-webhook.processor.js';

/**
 * BullMQ worker of Instagram webhook event processing (routes-final § 4.A WH5, WH12–WH15,
 * WHC10–WHC11): one account's events per job, and the every-minute stuck-event pick-up, on one
 * queue.
 *
 * @remarks
 * - **Algorithm:** routes on `job.name` — the pick-up ({@link INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME},
 *   no payload) runs {@link runInstagramWebhookReclaimJob}; every other job validates its payload
 *   at the boundary (`parseJobDataOrDeadLetter`), carries the organization's public id
 *   (`organizationPublicId`) into the job scope, and runs {@link processInstagramWebhookAccountJob}
 *   under the propagated trace context. Concurrency `WORKER_CONCURRENCY_INSTAGRAM` (falling back to
 *   `WORKER_CONCURRENCY`): different accounts side by side; one account never twice at once (the
 *   queue's per-account deduplication).
 * - **Failure modes:** built with `createProviderPausableWorker` for the `instagram` provider:
 *   while Instagram is down (its circuit open) the queue pauses on every replica and probes every
 *   five minutes, the parked job spending no attempt — and the processor has given the event its
 *   attempt back. A temporary failure takes the queue's 5 attempts with growing waits from 5 s; a
 *   malformed payload is dead-lettered at once.
 * - **Side effects:** see {@link processInstagramWebhookAccountJob} and
 *   {@link runInstagramWebhookReclaimJob}; holds a Redis connection until the handle closes.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `instagram`, throughput,
 *   gated on the Instagram app settings); the services come from the worker composition root
 *   (`appDomain`), never built here. Log lines carry ids and counts only, never message text (WH6).
 */
export function createInstagramWebhookWorker(
  services: InstagramWebhookProcessingServices,
): WorkerHandle {
  const worker = createProviderPausableWorker<InstagramWebhookAccountJobData>({
    queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
    provider: 'instagram',
    processor: async (job) => {
      // The every-minute pick-up rides this queue (no worker or pool of its own); no payload.
      if (job.name === INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME) {
        return runInstagramWebhookReclaimJob({ requestId: job.id });
      }
      const jobData = await parseJobDataOrDeadLetter({
        schema: instagramWebhookAccountJobDataSchema,
        job,
        queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
      });
      const { organizationPublicId, instagramAccountPublicId, requestId } = jobData;
      logger.info(
        { jobId: job.id, organizationPublicId, instagramAccountPublicId, requestId },
        'app.instagram_webhook.processing',
      );
      return runWithPropagatedTraceContext({
        carrier: { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
        spanName: job.name,
        callback: () =>
          processInstagramWebhookAccountJob({
            jobData,
            services,
            jobId: job.id ?? INSTAGRAM_WEBHOOK_QUEUE_NAME,
          }),
      });
    },
    workerOptions: {
      connection: getBullMQConnectionOptions(),
      concurrency: getWorkerConcurrencyInstagram(),
      ...getDefaultWorkerOptions(),
    },
  });

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME },
      'app.instagram_webhook.worker.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME });
}
