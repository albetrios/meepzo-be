import { Worker } from 'bullmq';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import {
  RETENTION_WORKER_CONCURRENCY,
  getRetentionWorkerOptions,
} from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { INSTAGRAM_SENDING_REPAIR_QUEUE_NAME } from './instagram-sending-repair.constants.js';
import { runInstagramSendingRepairDuty } from './instagram-sending-repair.processor.js';

/**
 * BullMQ worker of the sending repair duties (routes-final § 6 SN6, P94): each repeat job is one
 * duty, named by its job name — at ROUTE row R52 the month wake's check and the plan-stop backup.
 *
 * @remarks
 * - **Algorithm:** every job runs {@link runInstagramSendingRepairDuty} with `job.name` (no
 *   payload); concurrency `RETENTION_WORKER_CONCURRENCY`, so the duties run in parallel.
 * - **Failure modes:** a failing run is logged by BullMQ; the next scheduled run goes on.
 * - **Side effects:** see the processor; holds a Redis connection until the handle closes.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `instagram`, scheduled); a
 *   pure database sweep — no Meta call, so it runs with sending off too.
 */
export function createInstagramSendingRepairWorker(): WorkerHandle {
  const worker = new Worker(
    INSTAGRAM_SENDING_REPAIR_QUEUE_NAME,
    async (job) => runInstagramSendingRepairDuty({ duty: job.name }),
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queueName: INSTAGRAM_SENDING_REPAIR_QUEUE_NAME },
      'app.instagram_repair.worker.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: INSTAGRAM_SENDING_REPAIR_QUEUE_NAME });
}
