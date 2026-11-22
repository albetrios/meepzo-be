import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import { parseJobDataOrDeadLetter } from '@/infrastructure/queue/dlq/poison-job.util.js';
import { runWithPropagatedTraceContext } from '@/infrastructure/observability/tracing/trace-context.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { createProviderPausableWorker } from '@/infrastructure/queue/worker-runtime/provider-outage-pause.util.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import {
  RETENTION_WORKER_CONCURRENCY,
  getRetentionWorkerOptions,
} from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME,
  type InstagramAccountDailyCheckJobData,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-account-daily-check.queue.js';
import { instagramAccountDailyCheckJobDataSchema } from '@/domains/app/sub-domains/instagram-account/queues/instagram-account-daily-check.job.schema.js';
import { INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_JOB_NAME } from './instagram-account-daily-check.constants.js';
import {
  type InstagramAccountDailyCheckService,
  processInstagramAccountDailyCheckJob,
  runInstagramAccountDailyCheckSweep,
} from './instagram-account-daily-check.processor.js';

/**
 * BullMQ worker of the daily account check (IA8, IAC8): the 04:00 UTC sweep and one check per
 * organization's connected account, on one queue.
 *
 * @remarks
 * - **Algorithm:** routes on `job.name` — the sweep job ({@link INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_JOB_NAME},
 *   no payload) runs {@link runInstagramAccountDailyCheckSweep}; every other job validates its
 *   payload at the boundary (`parseJobDataOrDeadLetter`), carries the organization's public id
 *   (`organizationPublicId`) into the job scope, and runs {@link processInstagramAccountDailyCheckJob}
 *   under the propagated trace context. Concurrency `RETENTION_WORKER_CONCURRENCY` (one job at a
 *   time per process), the retention lock.
 * - **Failure modes:** built with `createProviderPausableWorker` for the `instagram` provider: while
 *   Instagram is down (its circuit open) the queue pauses on every replica and probes every five
 *   minutes, the parked job spending no attempt; a throttle pauses for Instagram's wait. Other
 *   failures take the queue's attempts; a malformed payload is dead-lettered at once.
 * - **Side effects:** see {@link processInstagramAccountDailyCheckJob} and
 *   {@link runInstagramAccountDailyCheckSweep}; holds a Redis connection until the handle closes.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `retention`, gated on the
 *   Instagram app settings); the account service comes from the worker composition root
 *   (`appDomain`), never built here.
 */
export function createInstagramAccountDailyCheckWorker({
  accountService,
}: {
  accountService: InstagramAccountDailyCheckService;
}): WorkerHandle {
  const worker = createProviderPausableWorker<InstagramAccountDailyCheckJobData>({
    queueName: INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME,
    provider: 'instagram',
    processor: async (job) => {
      if (job.name === INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_JOB_NAME) {
        return runInstagramAccountDailyCheckSweep();
      }
      const jobData = await parseJobDataOrDeadLetter({
        schema: instagramAccountDailyCheckJobDataSchema,
        job,
        queueName: INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME,
      });
      const { organizationPublicId, instagramAccountPublicId } = jobData;
      logger.info(
        { jobId: job.id, organizationPublicId, instagramAccountPublicId },
        'app.instagram_account.daily_check.processing',
      );
      return runWithPropagatedTraceContext({
        carrier: { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
        spanName: job.name,
        callback: () =>
          processInstagramAccountDailyCheckJob({
            jobData,
            accountService,
            requestId: job.id ?? INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME,
          }),
      });
    },
    workerOptions: {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  });

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queueName: INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME },
      'app.instagram_account.daily_check.worker.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME });
}
