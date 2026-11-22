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
import { AUTOMATION_NEXT_POST_EXPIRY_QUEUE_NAME } from './automation-next-post-expiry.constants.js';
import { runAutomationNextPostExpiryJob } from './automation-next-post-expiry.processor.js';

/**
 * The "next post" expiry worker (routes-final § 3.A AU15, AUC8; WC-6, D9) — family `retention`,
 * registered with `retentionDefinition`; its repeatable schedule (every 15 minutes, UTC) lives in
 * `src/infrastructure/queue/scheduler.ts`.
 *
 * @remarks
 * - **Algorithm:** every job runs {@link runAutomationNextPostExpiryJob}: a cross-organization scan,
 *   then each organization's change in its own context.
 * - **Failure modes:** stalled jobs are logged through the `stalled` listener; processor errors go
 *   through BullMQ retries and the queue's DLQ (attached by bootstrap).
 * - **Side effects:** registers a `Worker` against Redis with the retention options
 *   (`RETENTION_WORKER_CONCURRENCY`, `getRetentionWorkerOptions`).
 * - **Notes:** no Instagram call — a pure database sweep, so no provider pause and no gate on the
 *   Instagram settings.
 */
export function createAutomationNextPostExpiryWorker(): WorkerHandle {
  const worker = new Worker(
    AUTOMATION_NEXT_POST_EXPIRY_QUEUE_NAME,
    async () => runAutomationNextPostExpiryJob(),
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: AUTOMATION_NEXT_POST_EXPIRY_QUEUE_NAME },
      'automation-next-post-expiry.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: AUTOMATION_NEXT_POST_EXPIRY_QUEUE_NAME });
}
