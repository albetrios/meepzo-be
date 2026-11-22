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
import { AUTOMATION_RUN_RETENTION_QUEUE_NAME } from './automation-run-retention.constants.js';
import { runAutomationRunRetentionJob } from './automation-run-retention.processor.js';

/**
 * The daily run retention of `app.automation_runs` (routes-final § 3.B AU25, AUC12; WC-12, D8) —
 * family `retention`, registered with `retentionDefinition`; its repeatable schedule (03:20 UTC,
 * worker-changes rule 11) lives in `src/infrastructure/queue/scheduler.ts`.
 *
 * @remarks
 * - **Algorithm:** every job runs {@link runAutomationRunRetentionJob}, which opens its own
 *   `runGlobalRetentionWorkerJob` context.
 * - **Failure modes:** stalled jobs are logged through the `stalled` listener; processor errors go
 *   through BullMQ retries and the queue's DLQ (attached by bootstrap).
 * - **Side effects:** registers a `Worker` against Redis with the retention options
 *   (`RETENTION_WORKER_CONCURRENCY`, `getRetentionWorkerOptions`).
 * - **Notes:** no Instagram call and no tenant job — a pure database sweep, so no provider pause.
 */
export function createAutomationRunRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    AUTOMATION_RUN_RETENTION_QUEUE_NAME,
    async () => runAutomationRunRetentionJob(),
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: AUTOMATION_RUN_RETENTION_QUEUE_NAME },
      'automation-run-retention.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: AUTOMATION_RUN_RETENTION_QUEUE_NAME });
}
