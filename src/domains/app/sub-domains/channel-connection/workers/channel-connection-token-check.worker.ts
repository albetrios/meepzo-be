import { Worker } from 'bullmq';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { parseJobDataOrDeadLetter } from '@/infrastructure/queue/dlq/poison-job.util.js';
import { runWithPropagatedTraceContext } from '@/infrastructure/observability/tracing/trace-context.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import {
  RETENTION_WORKER_CONCURRENCY,
  getRetentionWorkerOptions,
} from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME,
  type ChannelConnectionTokenCheckJobData,
} from '@/domains/app/sub-domains/channel-connection/queues/channel-connection-token-check.queue.js';
import { channelConnectionTokenCheckJobDataSchema } from '@/domains/app/sub-domains/channel-connection/queues/channel-connection-token-check.job.schema.js';
import {
  CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_JOB_NAME,
  INSTAGRAM_WEBHOOK_SUBSCRIPTION_SWEEP_JOB_NAME,
} from './channel-connection-token-check.constants.js';
import {
  type ChannelConnectionTokenCheckServices,
  processChannelConnectionTokenCheckJob,
  runChannelConnectionTokenCheckSweep,
} from './channel-connection-token-check.processor.js';

/**
 * BullMQ worker of the channel connection's daily token check (routes-final § 1 MC10, MCC6): the
 * hourly sweep and one check per due connection, on one queue.
 *
 * @remarks
 * - **Algorithm:** routes on `job.name` — the sweep job
 *   ({@link CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_JOB_NAME}, no payload) runs
 *   {@link runChannelConnectionTokenCheckSweep}; the 10-minute webhook subscription sweep
 *   ({@link INSTAGRAM_WEBHOOK_SUBSCRIPTION_SWEEP_JOB_NAME}, WC-25) runs the services'
 *   `webhookSubscriptionSweep`; every other job validates its payload at the
 *   boundary (`parseJobDataOrDeadLetter`), carries the organization's public id into the job scope,
 *   and runs {@link processChannelConnectionTokenCheckJob} under the propagated trace context.
 *   Concurrency `RETENTION_WORKER_CONCURRENCY`, the retention lock.
 * - **Failure modes:** never paused (F3, P47): a check that meets Meta down or its open circuit
 *   returns `deferred` without spending an attempt, and the next hourly sweep adds it again. Our
 *   own failures take the queue's attempts; a malformed payload is dead-lettered at once.
 * - **Side effects:** see {@link processChannelConnectionTokenCheckJob} and
 *   {@link runChannelConnectionTokenCheckSweep}; holds a Redis connection until the handle closes.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `retention`, gated on the
 *   Meta app settings); the services come from the worker composition root (`appDomain`).
 */
export function createChannelConnectionTokenCheckWorker(
  services: ChannelConnectionTokenCheckServices,
): WorkerHandle {
  const worker = new Worker<ChannelConnectionTokenCheckJobData>(
    CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME,
    async (job) => {
      if (job.name === CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_JOB_NAME) {
        return runChannelConnectionTokenCheckSweep();
      }
      if (job.name === INSTAGRAM_WEBHOOK_SUBSCRIPTION_SWEEP_JOB_NAME) {
        if (services.webhookSubscriptionSweep === undefined) {
          logger.warn(
            { jobId: job.id },
            'app.channel_connection.webhook_subscription_sweep.unwired',
          );
          return { outcome: 'skipped', reason: 'unwired' };
        }
        return services.webhookSubscriptionSweep();
      }
      const jobData = await parseJobDataOrDeadLetter({
        schema: channelConnectionTokenCheckJobDataSchema,
        job,
        queueName: CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME,
      });
      const { organizationPublicId, channelConnectionPublicId } = jobData;
      logger.info(
        { jobId: job.id, organizationPublicId, channelConnectionPublicId },
        'app.channel_connection.token_check.processing',
      );
      return runWithPropagatedTraceContext({
        carrier: { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
        spanName: job.name,
        callback: () =>
          processChannelConnectionTokenCheckJob({
            jobData,
            services,
            requestId: job.id ?? CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME,
          }),
      });
    },
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queueName: CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME },
      'app.channel_connection.token_check.worker.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME });
}
