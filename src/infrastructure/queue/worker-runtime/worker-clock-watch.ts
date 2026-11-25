import { sql as drizzleSql } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * This process's last clock reading against Postgres (feat-instagram-dm-sending WC-23, helper rule
 * 15): how far this server's clock is from Postgres's `now()`, and when it was read.
 *
 * @remarks
 * Notes: `skewMilliseconds` is this clock minus Postgres's, corrected by half the round trip; `null`
 * before the first reading or after a failed one.
 */
export interface WorkerClockReading {
  skewMilliseconds: number | null;
  checkedAt: Date | null;
}

let lastReading: WorkerClockReading = { skewMilliseconds: null, checkedAt: null };

/**
 * Reads how far this server's clock is from Postgres's (`select now()`), corrected by half the
 * round trip.
 *
 * @remarks
 * - **Algorithm:** local time before and after one `select now()` on the shared pool (the
 *   readiness probe's way — no tenant data, no context); skew = the midpoint minus Postgres's time.
 * - **Failure modes:** a database error propagates.
 * - **Side effects:** one short query.
 */
export async function measurePostgresClockSkewMilliseconds({
  now = () => Date.now(),
}: {
  now?: () => number;
} = {}): Promise<number> {
  const before = now();
  const result = await database.execute<{ now_milliseconds: string }>(
    drizzleSql`select (extract(epoch from clock_timestamp()) * 1000)::bigint::text as now_milliseconds`,
  );
  const after = now();
  const postgresMilliseconds = Number(result.rows[0]?.now_milliseconds);
  if (!Number.isFinite(postgresMilliseconds)) {
    throw new Error('postgres clock read returned no time');
  }
  return Math.round((before + after) / 2 - postgresMilliseconds);
}

/**
 * Reads the clock once and keeps the answer for {@link readWorkerClockReading} — the clock check's
 * one step (WC-23).
 *
 * @remarks
 * - **Algorithm:** {@link measurePostgresClockSkewMilliseconds}; logs `worker.clock.skew` (warn)
 *   when the skew is over `warnAboveMilliseconds`.
 * - **Failure modes:** a failed read keeps `skewMilliseconds: null` (the sending check then refuses
 *   — fail closed) and logs it; never throws.
 * - **Side effects:** the kept reading; the log.
 */
export async function checkWorkerClock({
  warnAboveMilliseconds,
  measure = () => measurePostgresClockSkewMilliseconds(),
}: {
  warnAboveMilliseconds: number;
  measure?: () => Promise<number>;
}): Promise<WorkerClockReading> {
  try {
    const skewMilliseconds = await measure();
    lastReading = { skewMilliseconds, checkedAt: new Date() };
    if (Math.abs(skewMilliseconds) > warnAboveMilliseconds) {
      logger.warn(
        { skew_milliseconds: skewMilliseconds, max_milliseconds: warnAboveMilliseconds },
        'worker.clock.skew',
      );
    }
  } catch (error) {
    lastReading = { skewMilliseconds: null, checkedAt: new Date() };
    logger.warn({ error_name: (error as Error | null)?.name }, 'worker.clock.check_failed');
  }
  return lastReading;
}

/**
 * This process's last clock reading (WC-23) — the sending check reads it before every ticket.
 *
 * @remarks
 * Algorithm: none — the kept value. Failure modes: none. Side effects: none.
 */
export function readWorkerClockReading(): WorkerClockReading {
  return lastReading;
}

/**
 * Sets the kept reading — for tests only (the clock watch is a process singleton).
 *
 * @remarks
 * Algorithm: replaces the kept value. Failure modes: none. Side effects: the kept value.
 */
export function setWorkerClockReadingForTests(reading: WorkerClockReading): void {
  lastReading = reading;
}

/**
 * Starts the clock check in this process (feat-instagram-dm-sending WC-23): one reading now, then
 * one every `intervalMilliseconds`. Each server process checks its own clock — not a shared
 * schedule (BullMQ wakes delayed tickets by the server clock).
 *
 * @remarks
 * - **Algorithm:** awaits the first {@link checkWorkerClock} (so no ticket is taken before the
 *   clock is known), then an unref'd interval.
 * - **Failure modes:** none — each check logs its own failure.
 * - **Side effects:** a timer; one short query a minute (outside the queues' Postgres budget, within
 *   its 25 % headroom).
 * - **Notes:** `close()` clears the timer (the shutdown drains it like a worker handle).
 */
export async function startWorkerClockWatch({
  intervalMilliseconds,
  warnAboveMilliseconds,
}: {
  intervalMilliseconds: number;
  warnAboveMilliseconds: number;
}): Promise<{ close: () => Promise<void> }> {
  await checkWorkerClock({ warnAboveMilliseconds });
  const timer = setInterval(() => {
    void checkWorkerClock({ warnAboveMilliseconds });
  }, intervalMilliseconds);
  timer.unref();
  return {
    close: async () => {
      clearInterval(timer);
    },
  };
}
