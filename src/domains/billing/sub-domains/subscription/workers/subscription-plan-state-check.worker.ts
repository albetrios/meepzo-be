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
import { SUBSCRIPTION_PLAN_STATE_CHECK_QUEUE_NAME } from '@/domains/billing/sub-domains/subscription/queues/subscription-plan-state-check.queue.js';
import {
  type SubscriptionPlanStateCheckJobData,
  subscriptionPlanStateCheckJobDataSchema,
} from '@/domains/billing/sub-domains/subscription/queues/subscription-plan-state-check.job.schema.js';
import { SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_JOB_NAME } from './subscription-plan-state-check.constants.js';
import {
  type SubscriptionPlanStateCheckServices,
  processSubscriptionPlanStateCheckJob,
  runSubscriptionPlanStateCheckSweep,
} from './subscription-plan-state-check.processor.js';

/**
 * BullMQ worker of the plan-state check (routes-final § 8.B BL17, BLC10 — WC-59): the 15-minute
 * sweep and one check per due subscription, on one queue.
 *
 * @remarks
 * - **Algorithm:** routes on `job.name` — the sweep job
 *   ({@link SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_JOB_NAME}, no payload) runs
 *   {@link runSubscriptionPlanStateCheckSweep}; every other job validates its payload at the
 *   boundary (`parseJobDataOrDeadLetter`) and runs {@link processSubscriptionPlanStateCheckJob}
 *   under the propagated trace context. Concurrency `RETENTION_WORKER_CONCURRENCY`, the retention
 *   lock.
 * - **Failure modes:** our own failures take the queue's attempts; a malformed payload is
 *   dead-lettered at once; safe to skip — the next sweep finds the rows again.
 * - **Side effects:** see the processor; holds a Redis connection until the handle closes.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `retention`; no Stripe call,
 *   so not gated on Stripe); the services come from the worker composition root.
 */
export function createSubscriptionPlanStateCheckWorker(
  services: SubscriptionPlanStateCheckServices,
): WorkerHandle {
  const worker = new Worker<SubscriptionPlanStateCheckJobData>(
    SUBSCRIPTION_PLAN_STATE_CHECK_QUEUE_NAME,
    async (job) => {
      if (job.name === SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_JOB_NAME) {
        return runSubscriptionPlanStateCheckSweep();
      }
      const jobData = await parseJobDataOrDeadLetter({
        schema: subscriptionPlanStateCheckJobDataSchema,
        job,
        queueName: SUBSCRIPTION_PLAN_STATE_CHECK_QUEUE_NAME,
      });
      return runWithPropagatedTraceContext({
        carrier: { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
        spanName: job.name,
        callback: () => processSubscriptionPlanStateCheckJob({ jobData, services }),
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
      { jobId, queueName: SUBSCRIPTION_PLAN_STATE_CHECK_QUEUE_NAME },
      'billing.plan_state_check.worker.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: SUBSCRIPTION_PLAN_STATE_CHECK_QUEUE_NAME });
}
