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
import {
  APP_PARTITION_UPKEEP_DROP_JOB_NAME,
  APP_PARTITION_UPKEEP_QUEUE_NAME,
} from './app-partition-upkeep.constants.js';
import { runAppPartitionUpkeepJob } from './app-partition-upkeep.processor.js';
import { APP_TABLE_CLEAN_UP_JOB_NAME } from './app-table-clean-up.constants.js';
import { runAppTableCleanUpJob } from './app-table-clean-up.processor.js';

/**
 * The shared upkeep of the `app` tables (feat-instagram-dm-sending WC-55, WHC13): the seven
 * time-split tables' parts, and the hourly batch clean-up of the plain ones (WC-53, WC-54, WC-62 —
 * ROUTE row R50, on this queue so no pool place is added) — family `retention`, registered with
 * `retentionDefinition`; its three repeatable schedules (the daily make at a quiet hour, the hourly
 * make-and-drop, the hourly clean-up) live in `src/infrastructure/queue/scheduler.ts`.
 *
 * @remarks
 * - **Algorithm:** a job named `clean-up-app-tables` runs {@link runAppTableCleanUpJob}; one named
 *   `drop-expired-app-partitions` runs {@link runAppPartitionUpkeepJob} in `drop` mode; every
 *   other job name (the daily `make-app-partitions`) in `make` mode. One job at a time, so the
 *   clean-up (up to its 10-minute budget) and the drop never overlap. When the
 *   worker starts it also runs one `make` pass at once, outside BullMQ, so a server that was down
 *   past the made days gets its parts before the next schedule (WC-55: "and when a server starts").
 * - **Failure modes:** stalled jobs are logged through the `stalled` listener; processor errors go
 *   through BullMQ retries and the queue's DLQ (attached by bootstrap). A failed start pass is
 *   logged only — the schedules try again.
 * - **Side effects:** registers a `Worker` against Redis with the retention options
 *   (`RETENTION_WORKER_CONCURRENCY`, `getRetentionWorkerOptions`) and starts the one `make` pass.
 * - **Notes:** no third-party call and no tenant job — a pure database pass, so no provider pause.
 *   Replicas starting together make each part once (the function tolerates a part made first by
 *   another worker).
 */
export function createAppPartitionUpkeepWorker(): WorkerHandle {
  const worker = new Worker(
    APP_PARTITION_UPKEEP_QUEUE_NAME,
    async (job) => {
      if (job.name === APP_TABLE_CLEAN_UP_JOB_NAME) return runAppTableCleanUpJob();
      return runAppPartitionUpkeepJob({
        mode: job.name === APP_PARTITION_UPKEEP_DROP_JOB_NAME ? 'drop' : 'make',
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
    logger.warn({ jobId, queue: APP_PARTITION_UPKEEP_QUEUE_NAME }, 'app-partition-upkeep.stalled');
  });

  runAppPartitionUpkeepJob({ mode: 'make' }).catch((error: unknown) => {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'app-partition-upkeep.start_pass_failed',
    );
  });

  return buildWorkerHandle({ worker, queueName: APP_PARTITION_UPKEEP_QUEUE_NAME });
}
