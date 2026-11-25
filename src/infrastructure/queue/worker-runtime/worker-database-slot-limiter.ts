import { DelayedError, type Job } from 'bullmq';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * How long a unit of work waits for a database slot before its ticket goes back (P91, SN24): 2 s.
 */
export const WORKER_DATABASE_SLOT_WAIT_MILLISECONDS = 2_000;

/**
 * How far a ticket that found no slot is pushed back (P91): it waits its turn behind the work that
 * holds the slots, with no try used.
 */
export const WORKER_DATABASE_SLOT_RETRY_DELAY_MILLISECONDS = 5_000;

/**
 * Thrown by {@link WorkerDatabaseSlotLimiter.runInSlot} when no slot came free within the wait —
 * contention, never a database failure.
 *
 * @remarks
 * The ticket's worker turns it into "the ticket goes back" ({@link runWithDatabaseSlotTicketReturn})
 * when no outside effect happened yet; after one (a sent message) the caller decides.
 */
export class WorkerDatabaseSlotUnavailableError extends Error {
  constructor(
    public readonly limiterName: string,
    public readonly waitedMilliseconds: number,
  ) {
    super(`no database slot of ${limiterName} within ${String(waitedMilliseconds)} ms`);
    this.name = 'WorkerDatabaseSlotUnavailableError';
  }
}

interface SlotWaiter {
  readonly grant: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * An in-process counting semaphore over the database connections a family of workers may hold at
 * once (feat-instagram-dm-sending SN24, P91): every unit of work — a claim, a result save, an intake
 * event, a task piece — takes one slot first, so the process never asks the pool for more than
 * {@link size} connections however many jobs run side by side.
 *
 * @remarks
 * - **Algorithm:** a counter and a FIFO of waiters. `runInSlot` takes a free slot at once, or waits
 *   in line up to `waitMilliseconds`; a released slot goes straight to the oldest waiter (no
 *   barging), so a long line drains in order. A waiter whose time ran out leaves the line.
 * - **Failure modes:** {@link WorkerDatabaseSlotUnavailableError} when the wait ran out; the
 *   callback's errors propagate after the slot is released.
 * - **Side effects:** none outside the process — the slots are memory, one limiter per name a
 *   process ({@link getWorkerDatabaseSlotLimiter}).
 * - **Notes:** the connection budget (`worker-connection-budget.ts`) counts each named limiter once
 *   per process, at its size — not the job places of the queues that share it.
 */
export class WorkerDatabaseSlotLimiter {
  private held = 0;
  private readonly waiters: SlotWaiter[] = [];

  constructor(
    public readonly name: string,
    public readonly size: number,
  ) {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`database slot limiter ${name} needs a size of at least 1`);
    }
  }

  /** Slots held now. */
  get inUse(): number {
    return this.held;
  }

  /** Units of work waiting in line now. */
  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Runs `callback` while holding one slot; waits up to `waitMilliseconds` for it.
   *
   * @remarks
   * - **Algorithm:** take a free slot, else join the line; the slot is released in a `finally`.
   * - **Failure modes:** {@link WorkerDatabaseSlotUnavailableError} after the wait; the callback's
   *   own errors propagate.
   * - **Side effects:** the callback's.
   */
  async runInSlot<T>({
    callback,
    waitMilliseconds = WORKER_DATABASE_SLOT_WAIT_MILLISECONDS,
  }: {
    callback: () => Promise<T>;
    waitMilliseconds?: number;
  }): Promise<T> {
    await this.acquire(waitMilliseconds);
    try {
      return await callback();
    } finally {
      this.release();
    }
  }

  private acquire(waitMilliseconds: number): Promise<void> {
    if (this.held < this.size && this.waiters.length === 0) {
      this.held += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: SlotWaiter = {
        grant: () => {
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          resolve();
        },
        timer: undefined,
      };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new WorkerDatabaseSlotUnavailableError(this.name, waitMilliseconds));
      }, waitMilliseconds);
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      // The slot passes straight to the oldest waiter: `held` stays the same.
      next.grant();
      return;
    }
    this.held -= 1;
  }
}

const limitersByName = new Map<string, WorkerDatabaseSlotLimiter>();

/**
 * The process's one limiter of `name`, created at `size` on first use (SN24: one semaphore per
 * worker process, shared by every queue that names it).
 *
 * @remarks
 * - **Algorithm:** a process-wide map; a later call with another size keeps the first limiter and
 *   logs the mismatch (the size is an env setting read once at boot).
 * - **Failure modes:** a size below 1 throws on first use.
 * - **Side effects:** the map entry; a warn log on a size mismatch.
 */
export function getWorkerDatabaseSlotLimiter({
  name,
  size,
}: {
  name: string;
  size: number;
}): WorkerDatabaseSlotLimiter {
  const existing = limitersByName.get(name);
  if (existing !== undefined) {
    if (existing.size !== size) {
      logger.warn(
        { limiterName: name, size: existing.size, requestedSize: size },
        'worker.database_slot_limiter.size_mismatch',
      );
    }
    return existing;
  }
  const limiter = new WorkerDatabaseSlotLimiter(name, size);
  limitersByName.set(name, limiter);
  return limiter;
}

/**
 * Runs a ticket's work and, when it found no database slot in time, puts the ticket back — moved to
 * `delayed` without spending a try (P91, AC-17.20).
 *
 * @remarks
 * - **Algorithm:** runs `callback`; on {@link WorkerDatabaseSlotUnavailableError} moves the job to
 *   `delayed` for `retryDelayMilliseconds` and throws BullMQ's `DelayedError`, so the attempt count
 *   stays as it was (the provider-pause pattern, `provider-outage-pause.util.ts`).
 * - **Failure modes:** every other error propagates unchanged; without a lock `token` the slot error
 *   propagates (BullMQ then retries normally). A failed move (Redis) propagates.
 * - **Side effects:** one job move and an info log (`worker.database_slot.ticket_returned`).
 * - **Notes:** only for work whose outside effect has not happened yet — a claim, an intake event, a
 *   task piece. A result save after a sent message must not give its ticket back; its caller waits
 *   again instead.
 */
export async function runWithDatabaseSlotTicketReturn<T>({
  job,
  token,
  queueName,
  callback,
  retryDelayMilliseconds = WORKER_DATABASE_SLOT_RETRY_DELAY_MILLISECONDS,
}: {
  job: Job;
  token: string | undefined;
  queueName: string;
  callback: () => Promise<T>;
  retryDelayMilliseconds?: number;
}): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    if (!(error instanceof WorkerDatabaseSlotUnavailableError) || token === undefined) throw error;
    return returnTicketWithoutTry({
      job,
      token,
      delayMilliseconds: retryDelayMilliseconds,
      logFields: { queueName, limiterName: error.limiterName },
      logMessage: 'worker.database_slot.ticket_returned',
    });
  }
}

/**
 * Puts a ticket back on its queue for later without spending a try: moves the job to `delayed` and
 * throws BullMQ's `DelayedError` (P91 — a ticket with no database slot; SN7 — a server that may not
 * take tickets now).
 *
 * @remarks
 * - **Algorithm:** `job.moveToDelayed(now + delay, token)`, an info log, then `DelayedError`, which
 *   tells BullMQ the job was moved on purpose (no attempt counted, no failure recorded).
 * - **Failure modes:** a failed move (Redis) propagates, and BullMQ retries the job normally.
 * - **Side effects:** the job move and the log line.
 */
export async function returnTicketWithoutTry({
  job,
  token,
  delayMilliseconds,
  logFields,
  logMessage,
}: {
  job: Job;
  token: string;
  delayMilliseconds: number;
  logFields: Record<string, unknown>;
  logMessage: string;
}): Promise<never> {
  await job.moveToDelayed(Date.now() + delayMilliseconds, token);
  logger.info({ ...logFields, jobId: job.id, delayMilliseconds }, logMessage);
  throw new DelayedError();
}

/**
 * A job's unit-of-work runner over an optional limiter: each callback in one of the limiter's
 * slots, or run as it is when there is none (a test or a caller without the limiter).
 *
 * @remarks
 * Algorithm: `limiter.runInSlot({ callback })`, else `callback()`. Failure modes: the limiter's
 * (`WorkerDatabaseSlotUnavailableError` after its wait). Side effects: none of its own.
 */
export function toDatabaseSlotRunner(
  limiter: WorkerDatabaseSlotLimiter | null | undefined,
): <T>(callback: () => Promise<T>) => Promise<T> {
  if (limiter === null || limiter === undefined) return (callback) => callback();
  return (callback) => limiter.runInSlot({ callback });
}
