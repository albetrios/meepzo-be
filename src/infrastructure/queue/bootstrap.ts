/**
 * Queue bootstrap: registers BullMQ repeatable jobs, then starts domain workers.
 * Processor registration lives in domain worker files; queue families and pool demand
 * are centralized in worker-registration.registry.ts and worker-connection-budget.ts.
 */

import type { Worker } from 'bullmq';
import { isWorkerRuntime } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { STRIPE_WEBHOOK_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js';
import { MAIL_QUEUE_NAME } from '@/infrastructure/mail/queues/mail.queue.js';
import { attachDeadLetterAndAlerting } from '@/infrastructure/queue/dlq/dead-letter.js';
import { attachBullMQJobMetrics } from '@/infrastructure/observability/metrics/bullmq-metrics.js';
import { attachWorkerQueueHeartbeat } from '@/infrastructure/queue/worker-runtime/worker-queue-heartbeat.js';
import { registerScheduledJobs } from '@/infrastructure/queue/scheduler.js';
import { bullmqRedisConnection } from '@/infrastructure/cache/bullmq-redis.client.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { usesSeparateBullMqRedisEndpoint } from '@/infrastructure/cache/redis-url.parse.util.js';
import { resolveBullMqRedisUrl } from '@/infrastructure/cache/redis-url.util.js';
import { startWorkerClockWatch } from '@/infrastructure/queue/worker-runtime/worker-clock-watch.js';
import { startWorkerRedisWatch } from '@/infrastructure/queue/worker-runtime/worker-redis-watch.js';
import { INSTAGRAM_SENDING_WATCH_SETTINGS } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import { auditSchedulerRegistryConsistency } from '@/infrastructure/queue/worker-runtime/scheduler-registry-audit.js';
import {
  computeWorkerPostgresPoolDemand,
  resolveActiveWorkerQueueNames,
} from '@/infrastructure/queue/worker-runtime/worker-connection-budget.js';
import { getSelectedWorkerQueueFamilies } from '@/infrastructure/queue/worker-runtime/worker-queue-family.util.js';
import { getWorkerRegistrationsForFamilies } from '@/infrastructure/queue/worker-runtime/worker-registration.registry.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { env } from '@/shared/config/env.config.js';
import {
  startProcessMemoryMonitoring,
  stopProcessMemoryMonitoring,
} from '@/shared/utils/infrastructure/process-memory-monitor.util.js';
import type { DomainContainers } from '@/worker-containers.js';

export { closeDeadLetterQueues } from '@/infrastructure/queue/dlq/dead-letter.js';

/**
 * Lifecycle handle returned by every worker factory (and the scheduler) so the
 * shutdown sequence can drain them uniformly. `worker` and `queueName` are present
 * for BullMQ workers and consumed by {@link attachDeadLetterAndAlerting}; they are
 * absent for the scheduler-only handle which has no `failed` event source.
 */
export interface WorkerHandle {
  close: () => Promise<void>;
  /** Set for BullMQ worker processors; omitted for the scheduler-only handle. */
  worker?: Worker;
  queueName?: string;
}

/** Stops the worker RSS monitor on shutdown (delegates to the shared process memory monitor). */
export function stopRssMonitoring(): void {
  stopProcessMemoryMonitoring();
}

/**
 * Starts one worker and attaches the hooks every worker carries: the dead-letter + Sentry `failed`
 * listener, the job-duration histogram, and the queue heartbeat `/readyz` reads to tell a stalled
 * worker from an idle one.
 */
function pushWorkerWithRuntimeHooks({
  workers,
  createWorker,
}: {
  workers: WorkerHandle[];
  createWorker: () => WorkerHandle;
}): void {
  const handle = createWorker();
  workers.push(handle);
  if (handle.worker !== undefined && handle.queueName !== undefined) {
    attachDeadLetterAndAlerting({ worker: handle.worker, queueName: handle.queueName });
    attachBullMQJobMetrics({ worker: handle.worker, queueName: handle.queueName });
    attachWorkerQueueHeartbeat({ worker: handle.worker, queueName: handle.queueName });
  }
}

/**
 * The two watches each server process runs for itself (feat-instagram-dm-sending WC-21, WC-23 —
 * not on the shared schedule; worker-changes note 6: they need no slot): the clock against
 * Postgres every minute (a server over 2 s off takes no tickets — the sending check reads it) and
 * the "Redis lost" watch every 10 seconds (P7), which re-registers this process's schedules and
 * runs the registered rebuild steps under one lock. Started where the `instagram` family runs.
 */
async function startSendingProcessWatches(
  activeQueueNames: ReadonlySet<string>,
): Promise<WorkerHandle[]> {
  const clockWatch = await startWorkerClockWatch({
    intervalMilliseconds: INSTAGRAM_SENDING_WATCH_SETTINGS.clockCheckMilliseconds,
    warnAboveMilliseconds: INSTAGRAM_SENDING_WATCH_SETTINGS.clockSkewMaxMilliseconds,
  });
  const clients = usesSeparateBullMqRedisEndpoint({
    cacheRedisUrl: env.REDIS_URL,
    bullMqRedisUrl: resolveBullMqRedisUrl(),
  })
    ? [redisConnection, bullmqRedisConnection]
    : [redisConnection];
  const redisWatch = await startWorkerRedisWatch({
    clients,
    intervalMilliseconds: INSTAGRAM_SENDING_WATCH_SETTINGS.redisWatchMilliseconds,
    rebuildSchedules: async () => {
      const handle = await registerScheduledJobs({ activeQueueNames });
      await handle.close();
    },
  });
  return [clockWatch, redisWatch];
}

/**
 * Boots every BullMQ worker selected by `WORKER_QUEUE_FAMILIES` for the current
 * process: starts RSS monitoring, audits the registry against the scheduler cron
 * list, registers repeatable jobs for queues that have a worker locally, then
 * instantiates each worker (skipping `mail` / `stripe-webhook` when their secrets
 * are missing) and attaches the DLQ + Sentry `failed` listener
 * ({@link attachDeadLetterAndAlerting}), the job-duration histogram and the queue heartbeat. Returned handles are drained in reverse
 * order during shutdown.
 */
export async function registerDomainWorkers(
  workerContainers: DomainContainers,
): Promise<WorkerHandle[]> {
  // C1 (context-layer audit): every worker-runtime database guard —
  // assertWorkerDatabaseContext, the FORCE-RLS table asserts, the unpinned-pool
  // throw — is gated on isWorkerRuntime(). Starting BullMQ processors without the
  // flag would silently disable that entire guard net, so fail the boot instead.
  if (!isWorkerRuntime()) {
    throw new Error(
      'registerDomainWorkers requires MEEPZO_BE_RUNTIME=worker — the worker-runtime RLS guard net is disabled without it. ' +
        'Start workers via src/worker.ts (which sets it) or set the variable explicitly.',
    );
  }
  const workers: WorkerHandle[] = [];
  const selectedFamilies = getSelectedWorkerQueueFamilies();
  const poolDemand = computeWorkerPostgresPoolDemand({
    families: selectedFamilies,
    workerContainers,
  });

  startProcessMemoryMonitoring({
    processLabel: 'worker',
    thresholdMegabytes: env.PROCESS_RSS_WARN_THRESHOLD_MB,
  });

  logger.info(
    {
      selectedFamilies,
      peakPostgresConcurrency: poolDemand.peakPostgresConcurrency,
      peakPostgresConcurrencyHoldingExternalIo: poolDemand.peakPostgresConcurrencyHoldingExternalIo,
      enabledPostgresQueues: poolDemand.queues
        .filter((entry) => entry.enabled && entry.postgresConcurrency > 0)
        .map((entry) => ({
          queueName: entry.queueName,
          postgresConcurrency: entry.postgresConcurrency,
          holdsConnectionDuringExternalIo: entry.holdsConnectionDuringExternalIo,
          criticality: entry.criticality,
        })),
    },
    'worker.queue_families.selected',
  );

  auditSchedulerRegistryConsistency();

  const activeQueueNames = resolveActiveWorkerQueueNames({
    families: selectedFamilies,
    workerContainers,
  });
  const schedulerHandle = await registerScheduledJobs({ activeQueueNames });
  workers.push(schedulerHandle);

  if (selectedFamilies.includes('instagram')) {
    workers.push(...(await startSendingProcessWatches(activeQueueNames)));
  }

  const registrations = getWorkerRegistrationsForFamilies(selectedFamilies);

  for (const registration of registrations) {
    if (registration.isEnabled !== undefined && !registration.isEnabled(workerContainers)) {
      if (registration.queueName === MAIL_QUEUE_NAME) {
        logger.warn('RESEND_API_KEY not configured — mail worker skipped');
      } else if (registration.queueName === STRIPE_WEBHOOK_QUEUE_NAME) {
        logger.warn(
          'STRIPE_WEBHOOK_SECRET not configured — stripe webhook ingress and worker skipped',
        );
      }
      continue;
    }

    pushWorkerWithRuntimeHooks({
      workers,
      createWorker: () => registration.create(workerContainers),
    });
    logger.info({ queueName: registration.queueName }, `Registered ${registration.logLabel}`);
  }

  return workers;
}
