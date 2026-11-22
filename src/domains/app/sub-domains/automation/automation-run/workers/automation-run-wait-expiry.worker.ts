import { Worker } from 'bullmq';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import {
  getRetentionWorkerOptions,
  RETENTION_WORKER_CONCURRENCY,
} from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { AUTOMATION_RUN_WAIT_EXPIRY_QUEUE_NAME } from './automation-run-wait-expiry.constants.js';
import {
  type AutomationRunWaitExpiryService,
  runAutomationRunWaitExpiryJob,
} from './automation-run-wait-expiry.processor.js';

/**
 * The 7-day wait check's worker (routes-final § 3.B AU25, AUC12; WC-13, D8) — family `retention`,
 * registered with `retentionDefinition`; its repeatable schedule (every hour, UTC) lives in
 * `src/infrastructure/queue/scheduler.ts`.
 *
 * @remarks
 * - **Algorithm:** every job runs {@link runAutomationRunWaitExpiryJob} with the app container's
 *   run service: a cross-organization scan, then each organization's cancel in its own context.
 * - **Failure modes:** stalled jobs are logged through the `stalled` listener; processor errors go
 *   through BullMQ retries and the queue's DLQ (attached by bootstrap).
 * - **Side effects:** registers a `Worker` against Redis with the retention options
 *   (`RETENTION_WORKER_CONCURRENCY`, `getRetentionWorkerOptions`).
 * - **Notes:** no Instagram call — a pure database sweep, so no provider pause and no gate on the
 *   Instagram settings; a cron with no per-job tenant payload.
 */
export function createAutomationRunWaitExpiryWorker({
  runService,
}: {
  runService: AutomationRunWaitExpiryService;
}): WorkerHandle {
  const worker = new Worker(
    AUTOMATION_RUN_WAIT_EXPIRY_QUEUE_NAME,
    async () => runAutomationRunWaitExpiryJob({ runService }),
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: AUTOMATION_RUN_WAIT_EXPIRY_QUEUE_NAME },
      'automation-run-wait-expiry.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: AUTOMATION_RUN_WAIT_EXPIRY_QUEUE_NAME });
}
