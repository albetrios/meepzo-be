import { Worker } from 'bullmq';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { parseJobDataOrDeadLetter } from '@/infrastructure/queue/dlq/poison-job.util.js';
import { runWithPropagatedTraceContext } from '@/infrastructure/observability/tracing/trace-context.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import type { WorkerDatabaseSlotLimiter } from '@/infrastructure/queue/worker-runtime/worker-database-slot-limiter.js';
import { getDefaultWorkerOptions } from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { getWorkerConcurrencyInstagram } from '@/shared/config/worker-concurrency.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { getInstagramDatabaseSlotLimiter } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-ticket.processor.js';
import {
  INSTAGRAM_TAG_EVENT_INTAKE_JOB_NAME,
  INSTAGRAM_WEBHOOK_QUEUE_NAME,
} from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import {
  instagramTagEventIntakeJobDataSchema,
  instagramWebhookIntakeJobDataSchema,
} from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.job.schema.js';
import { INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME } from './instagram-webhook-reclaim.constants.js';
import { runInstagramWebhookReclaimJob } from './instagram-webhook-reclaim.processor.js';
import {
  type InstagramContactProfileReadEnqueue,
  type InstagramWebhookIntakeServices,
  processInstagramWebhookIntakeJob,
} from './instagram-webhook-intake.processor.js';
import {
  type InstagramTagEventIntakeServices,
  processInstagramTagEventIntakeJob,
} from './instagram-tag-event-intake.processor.js';

/**
 * What the intake worker drives: the event intake's and the tag intake's services, and the
 * after-commit profile-read task (S11).
 *
 * @remarks
 * Notes: built by the worker registry from the worker composition root (`appDomain`,
 * `tenancyDomain`).
 */
export interface InstagramWebhookWorkerServices {
  intake: InstagramWebhookIntakeServices;
  tagIntake: InstagramTagEventIntakeServices;
  enqueueProfileRead: InstagramContactProfileReadEnqueue | null;
}

/**
 * BullMQ worker of Instagram intake (feat-instagram-dm-sending § 5 WH5, WH11–WH16, WH25; WC-1–WC-4):
 * the three kind groups' jobs, the tag-intake jobs and the every-minute stuck-event pick-up, on one
 * queue.
 *
 * @remarks
 * - **Algorithm:** routes on `job.name` — the pick-up ({@link INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME},
 *   no payload) runs {@link runInstagramWebhookReclaimJob}; `intake-tag-events` validates its payload
 *   and runs {@link processInstagramTagEventIntakeJob}; `intake-messages`, `intake-live` and
 *   `intake-comments` validate theirs and run {@link processInstagramWebhookIntakeJob} — every unit
 *   of work in a slot of the process's Instagram database limiter (`getInstagramDatabaseSlotLimiter`,
 *   SN24). Concurrency `WORKER_CONCURRENCY_INSTAGRAM`: different accounts and groups side by side;
 *   one group of one account never twice at once but comments (the deduplication, S11).
 * - **Failure modes:** a **plain** worker — never paused by an Instagram outage (WH25, P47 F3):
 *   intake makes no Meta call but a late comment's time read, which fails open. A thrown job (a
 *   database outage, an event's temporary failure) takes the queue's 5 attempts with growing waits
 *   from 5 s; a malformed payload is dead-lettered at once.
 * - **Side effects:** see the processors; holds a Redis connection until the handle closes.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `instagram`, throughput,
 *   gated on the Meta app settings, `databaseSlotLimiterName` `instagram-database`); log lines carry
 *   ids and counts only, never message text (WH6).
 */
export function createInstagramWebhookWorker({
  services,
  limiter = getInstagramDatabaseSlotLimiter(),
}: {
  services: InstagramWebhookWorkerServices;
  /** The process's Instagram database limiter (SN24); tests pass a fake. */
  limiter?: WorkerDatabaseSlotLimiter;
}): WorkerHandle {
  const worker = new Worker(
    INSTAGRAM_WEBHOOK_QUEUE_NAME,
    async (job) => {
      // The every-minute pick-up rides this queue (no worker or pool of its own); no payload.
      if (job.name === INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME) {
        return runInstagramWebhookReclaimJob({ requestId: job.id });
      }
      const jobId = job.id ?? INSTAGRAM_WEBHOOK_QUEUE_NAME;
      if (job.name === INSTAGRAM_TAG_EVENT_INTAKE_JOB_NAME) {
        const jobData = await parseJobDataOrDeadLetter({
          schema: instagramTagEventIntakeJobDataSchema,
          job,
          queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
        });
        return runWithPropagatedTraceContext({
          carrier: { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
          spanName: job.name,
          callback: () =>
            processInstagramTagEventIntakeJob({
              jobData,
              services: services.tagIntake,
              jobId,
              limiter,
            }),
        });
      }
      const jobData = await parseJobDataOrDeadLetter({
        schema: instagramWebhookIntakeJobDataSchema,
        job,
        queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
      });
      logger.info(
        {
          jobId: job.id,
          organizationPublicId: jobData.organizationPublicId,
          channelAccountPublicId: jobData.channelAccountPublicId,
          intakeKind: jobData.intakeKind,
          requestId: jobData.requestId,
        },
        'app.instagram_webhook.intake',
      );
      return runWithPropagatedTraceContext({
        carrier: { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
        spanName: job.name,
        callback: () =>
          processInstagramWebhookIntakeJob({
            jobData,
            services: services.intake,
            jobId,
            enqueueProfileRead: services.enqueueProfileRead,
            limiter,
          }),
      });
    },
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: getWorkerConcurrencyInstagram(),
      ...getDefaultWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME },
      'app.instagram_webhook.worker.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME });
}
