import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/** The marker key every worker process watches: missing means Redis was emptied or replaced. */
export const WORKER_REDIS_MARKER_KEY = 'worker:redis_marker';

/** The one rebuild lock across processes (WC-21: the quick counts rebuilt under one lock). */
export const WORKER_REDIS_REBUILD_LOCK_KEY = 'worker:redis_rebuild_lock';

/** How long one rebuild may hold the lock. */
const WORKER_REDIS_REBUILD_LOCK_MILLISECONDS = 120_000;

/**
 * One thing to put back in Redis after it was lost (feat-instagram-dm-sending WC-21, SN10): a
 * domain registers its own (the sending gate 1 counts), the bootstrap passes the schedules.
 *
 * @remarks
 * Notes: each step must be safe to run twice and must read Postgres, the source of truth.
 */
export interface WorkerRedisRebuildStep {
  name: string;
  run: () => Promise<void>;
}

const registeredSteps = new Map<string, WorkerRedisRebuildStep>();

/**
 * Registers a rebuild step by name (a later one of the same name replaces it) — called by a
 * domain container, run only by the worker processes' watch.
 *
 * @remarks
 * Algorithm: a process-wide map. Failure modes: none. Side effects: the map entry.
 */
export function registerWorkerRedisRebuildStep(step: WorkerRedisRebuildStep): void {
  registeredSteps.set(step.name, step);
}

/**
 * What one watch tick saw (for the log and the tests).
 *
 * @remarks
 * Notes: `rebuilt` — this process ran the steps; `rebuilt_elsewhere` — another process holds the
 * lock; `unreachable` — Redis did not answer (nothing to do until it does).
 */
export type WorkerRedisWatchOutcome = 'intact' | 'unreachable' | 'rebuilt' | 'rebuilt_elsewhere';

/**
 * One tick of the "Redis lost" watch (WC-21): reads the marker; when it is gone (Redis came back
 * empty or new), rebuilds under the one lock — the schedules, then every registered step — and
 * writes a new marker.
 *
 * @remarks
 * - **Algorithm:** `GET` the marker on each watched client; an error → `unreachable`; all present
 *   → `intact`. A missing one → `SET` the lock `NX PX`; holding it, run `rebuildSchedules` and the
 *   steps in order, then `SET` a fresh marker and release the lock; not holding it →
 *   `rebuilt_elsewhere` (the holder writes the marker).
 * - **Failure modes:** a failed step stops the rebuild before the marker is written and releases
 *   the lock, so the next tick tries again (WC-21: tried again; the gates stay safe because
 *   Postgres decides). Never throws.
 * - **Side effects:** Redis keys; the steps' writes; `worker.redis_watch.*` logs.
 */
export async function runWorkerRedisWatchTick({
  clients,
  rebuildSchedules,
  steps = [...registeredSteps.values()],
}: {
  clients: readonly Redis[];
  rebuildSchedules: () => Promise<void>;
  steps?: readonly WorkerRedisRebuildStep[];
}): Promise<WorkerRedisWatchOutcome> {
  let isLost = false;
  try {
    for (const client of clients) {
      if ((await client.get(WORKER_REDIS_MARKER_KEY)) === null) isLost = true;
    }
  } catch (error) {
    logger.warn({ error_name: (error as Error | null)?.name }, 'worker.redis_watch.unreachable');
    return 'unreachable';
  }
  if (!isLost) return 'intact';
  const lockClient = clients[0];
  if (lockClient === undefined) return 'intact';
  const lockValue = randomUUID();
  try {
    const locked = await lockClient.set(
      WORKER_REDIS_REBUILD_LOCK_KEY,
      lockValue,
      'PX',
      WORKER_REDIS_REBUILD_LOCK_MILLISECONDS,
      'NX',
    );
    if (locked !== 'OK') return 'rebuilt_elsewhere';
  } catch (error) {
    logger.warn({ error_name: (error as Error | null)?.name }, 'worker.redis_watch.unreachable');
    return 'unreachable';
  }
  logger.warn({ steps: steps.map((step) => step.name) }, 'worker.redis_watch.rebuild_started');
  try {
    await rebuildSchedules();
    for (const step of steps) await step.run();
    const marker = randomUUID();
    for (const client of clients) await client.set(WORKER_REDIS_MARKER_KEY, marker);
    logger.warn({}, 'worker.redis_watch.rebuilt');
    return 'rebuilt';
  } catch (error) {
    logger.error(
      { error_name: (error as Error | null)?.name },
      'worker.redis_watch.rebuild_failed',
    );
    return 'unreachable';
  } finally {
    try {
      if ((await lockClient.get(WORKER_REDIS_REBUILD_LOCK_KEY)) === lockValue) {
        await lockClient.del(WORKER_REDIS_REBUILD_LOCK_KEY);
      }
    } catch {
      // The lock expires by itself.
    }
  }
}

/**
 * Starts the "Redis lost" watch in this worker process (feat-instagram-dm-sending WC-21, SN10,
 * SNC8; P7: every 10 seconds): the marker is written now when missing (a first boot is not a loss),
 * then each tick runs {@link runWorkerRedisWatchTick}.
 *
 * @remarks
 * - **Algorithm:** `SET NX` the marker on each client (best-effort), then an unref'd interval;
 *   ticks never overlap.
 * - **Failure modes:** none — each tick logs its own.
 * - **Side effects:** a timer, Redis reads every tick; a rebuild's writes.
 * - **Notes:** each process watches for itself — not a shared schedule, which Redis itself carries.
 *   `close()` clears the timer.
 */
export async function startWorkerRedisWatch({
  clients,
  intervalMilliseconds,
  rebuildSchedules,
}: {
  clients: readonly Redis[];
  intervalMilliseconds: number;
  rebuildSchedules: () => Promise<void>;
}): Promise<{ close: () => Promise<void> }> {
  try {
    const marker = randomUUID();
    for (const client of clients) await client.set(WORKER_REDIS_MARKER_KEY, marker, 'NX');
  } catch (error) {
    logger.warn({ error_name: (error as Error | null)?.name }, 'worker.redis_watch.unreachable');
  }
  let isRunning = false;
  const timer = setInterval(() => {
    if (isRunning) return;
    isRunning = true;
    void runWorkerRedisWatchTick({ clients, rebuildSchedules }).finally(() => {
      isRunning = false;
    });
  }, intervalMilliseconds);
  timer.unref();
  return {
    close: async () => {
      clearInterval(timer);
    },
  };
}
