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
import { INSTAGRAM_WEBHOOK_EVENT_RETENTION_QUEUE_NAME } from './instagram-webhook-event-retention.constants.js';
import { runInstagramWebhookEventRetentionJob } from './instagram-webhook-event-retention.processor.js';

/**
 * The daily 30-day clean-up of `app.instagram_webhook_events` (WH19, WHC15) — family `instagram`,
 * registered with `retentionDefinition`; its repeatable schedule (03:00, worker-changes rule 11)
 * lives in `src/infrastructure/queue/scheduler.ts`.
 *
 * @remarks
 * - **Algorithm:** every job runs {@link runInstagramWebhookEventRetentionJob}, which opens its own
 *   `runGlobalRetentionWorkerJob` context.
 * - **Failure modes:** stalled jobs are logged through the `stalled` listener; processor errors go
 *   through BullMQ retries and the queue's DLQ (attached by bootstrap).
 * - **Side effects:** registers a `Worker` against Redis with the retention options
 *   (`RETENTION_WORKER_CONCURRENCY`, `getRetentionWorkerOptions`).
 * - **Notes:** no Instagram call and no tenant job — a pure database sweep, so no provider pause.
 */
export function createInstagramWebhookEventRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    INSTAGRAM_WEBHOOK_EVENT_RETENTION_QUEUE_NAME,
    async () => runInstagramWebhookEventRetentionJob(),
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: INSTAGRAM_WEBHOOK_EVENT_RETENTION_QUEUE_NAME },
      'instagram-webhook-event-retention.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: INSTAGRAM_WEBHOOK_EVENT_RETENTION_QUEUE_NAME });
}
