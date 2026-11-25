import { Worker } from 'bullmq';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import { getRetentionWorkerOptions } from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { INSTAGRAM_SENDING_REPAIR_QUEUE_NAME } from './instagram-sending-repair.constants.js';
import { runInstagramSendingRepairDuty } from './instagram-sending-repair.processor.js';
import { INSTAGRAM_SENDING_REPAIR_CONCURRENCY } from './instagram-sending-watch.constants.js';
import {
  type InstagramSendingWatchDependencies,
  isInstagramSendingWatchDuty,
  runInstagramSendingWatchDuty,
} from './instagram-sending-watch.processor.js';

/**
 * BullMQ worker of the sending repair duties (routes-final § 6 SN6, P94): each repeat job is one
 * duty, named by its job name — at ROUTE row R52 the month wake's check and the plan-stop backup;
 * at R48 the watches (`outage-check`, `live-check`, `waiting-estimate`).
 *
 * @remarks
 * - **Algorithm:** a watch job runs {@link runInstagramSendingWatchDuty}, every other job
 *   {@link runInstagramSendingRepairDuty}, with `job.name` (no payload); concurrency
 *   {@link INSTAGRAM_SENDING_REPAIR_CONCURRENCY}, so the duties run in parallel (P94) — every
 *   database unit of a duty takes a slot of the process's `instagram-database` limiter
 *   (`runInDatabaseSlot`, SN24), which is the queue's Postgres budget.
 * - **Failure modes:** a failing run is logged by BullMQ; the next scheduled run goes on; a slot
 *   not found in time fails that run.
 * - **Side effects:** see the processors; holds a Redis connection until the handle closes.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `instagram`, scheduled). The
 *   repair duties are database sweeps and run with sending off too; the Live check's one Meta read
 *   asks `mayTakeTickets` first.
 */
export function createInstagramSendingRepairWorker({
  watch,
  runInDatabaseSlot,
}: {
  /** The watch duties' dependencies (the app container's); without them a watch job is logged. */
  watch?: InstagramSendingWatchDependencies | undefined;
  runInDatabaseSlot?: (<T>(callback: () => Promise<T>) => Promise<T>) | undefined;
} = {}): WorkerHandle {
  const worker = new Worker(
    INSTAGRAM_SENDING_REPAIR_QUEUE_NAME,
    async (job) => {
      if (!isInstagramSendingWatchDuty(job.name)) {
        return runInstagramSendingRepairDuty({ duty: job.name, runInDatabaseSlot });
      }
      if (watch === undefined) {
        logger.warn({ duty: job.name }, 'app.instagram_watch.not_wired');
        return null;
      }
      return runInstagramSendingWatchDuty({ duty: job.name, dependencies: watch });
    },
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: INSTAGRAM_SENDING_REPAIR_CONCURRENCY,
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
