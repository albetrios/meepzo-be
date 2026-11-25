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
import { SESSION_CLEANUP_QUEUE_NAME } from '@/domains/auth/sub-domains/auth-session/workers/session-cleanup.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { runSessionCleanupJob } from './session-cleanup.processor.js';

/**
 * BullMQ worker of the hourly session clean-up: expired and old revoked `auth.sessions`, and ended
 * `auth.trusted_devices` (feat-instagram-dm-sending WC-64, P92).
 *
 * @remarks
 * - **Algorithm:** every job runs {@link runSessionCleanupJob}, which opens one
 *   `MAINTENANCE_SCOPE.SESSION_RETENTION_CLEANUP` context per unit of work and stops at the time
 *   budget or each table's cap.
 * - **Failure modes:** standard BullMQ retry semantics apply; stalled jobs emit
 *   `session-cleanup.stalled` warnings.
 * - **Side effects:** registers a `Worker` against Redis with the retention options.
 * - **Notes:** the hourly repeatable schedule (`AUTH_SESSION_CLEANUP_CRON` overrides it) is
 *   registered in `src/infrastructure/queue/scheduler.ts`; this factory only constructs the
 *   worker — bootstrap wires its lifecycle handle.
 */
export function createSessionCleanupWorker(): WorkerHandle {
  const worker = new Worker(SESSION_CLEANUP_QUEUE_NAME, async () => runSessionCleanupJob(), {
    connection: getBullMQConnectionOptions(),
    prefix: getBullMQKeyPrefix(),
    concurrency: RETENTION_WORKER_CONCURRENCY,
    ...getRetentionWorkerOptions(),
  });

  worker.on('stalled', (jobId) => {
    logger.warn({ jobId, queue: SESSION_CLEANUP_QUEUE_NAME }, 'session-cleanup.stalled');
  });

  return buildWorkerHandle({ worker, queueName: SESSION_CLEANUP_QUEUE_NAME });
}
