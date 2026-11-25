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
import { AUTOMATION_TOMBSTONE_RETENTION_QUEUE_NAME } from './automation-tombstone-retention.constants.js';
import { runAutomationTombstoneRetentionJob } from './automation-tombstone-retention.processor.js';

/**
 * The hourly deleted-automation purge of `app.automations` (routes-final § 3.B AU25, AQ7, AUC12;
 * WC-15, now WC-47) — family `retention`, registered with `retentionDefinition`; its repeatable schedule
 * (hourly at :47, P92) lives in `src/infrastructure/queue/scheduler.ts`.
 *
 * @remarks
 * - **Algorithm:** every job runs {@link runAutomationTombstoneRetentionJob}, which opens its own
 *   `runGlobalRetentionWorkerJob` context.
 * - **Failure modes:** stalled jobs are logged through the `stalled` listener; processor errors go
 *   through BullMQ retries and the queue's DLQ (attached by bootstrap).
 * - **Side effects:** registers a `Worker` against Redis with the retention options
 *   (`RETENTION_WORKER_CONCURRENCY`, `getRetentionWorkerOptions`).
 * - **Notes:** no Instagram call and no tenant job — a pure database sweep, so no provider pause.
 */
export function createAutomationTombstoneRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    AUTOMATION_TOMBSTONE_RETENTION_QUEUE_NAME,
    async () => runAutomationTombstoneRetentionJob(),
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: AUTOMATION_TOMBSTONE_RETENTION_QUEUE_NAME },
      'automation-tombstone-retention.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: AUTOMATION_TOMBSTONE_RETENTION_QUEUE_NAME });
}
