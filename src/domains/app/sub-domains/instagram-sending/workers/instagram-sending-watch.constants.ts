import { INSTAGRAM_SENDING_WATCH_SETTINGS } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';

/**
 * Every 10 seconds (WC-22, P7): the all-accounts outage rule over the last 30 s of calls and the
 * accounts in a down stop, and the all-stop count's 24-hour reset — a duty on
 * `instagram-sending-repair` (ROUTE row R48).
 */
export const INSTAGRAM_WATCH_OUTAGE_CHECK_JOB_NAME = 'outage-check';

/** The outage watch's interval (SNC5's `everyMilliseconds`). */
export const INSTAGRAM_WATCH_OUTAGE_CHECK_EVERY_MILLISECONDS =
  INSTAGRAM_SENDING_WATCH_SETTINGS.outageCheckMilliseconds;

/** Every minute (WC-16): the accounts with waiting Live replies are checked against their Lives. */
export const INSTAGRAM_WATCH_LIVE_CHECK_JOB_NAME = 'live-check';

/** The Live check's cron. */
export const INSTAGRAM_WATCH_LIVE_CHECK_CRON = '* * * * *';

/** Every 10 minutes (WC-24, S29): each account's "will go / may expire" estimate. */
export const INSTAGRAM_WATCH_WAITING_ESTIMATE_JOB_NAME = 'waiting-estimate';

/** The waiting estimate's cron. */
export const INSTAGRAM_WATCH_WAITING_ESTIMATE_CRON = `*/${INSTAGRAM_SENDING_WATCH_SETTINGS.estimateEveryMinutes} * * * *`;

/** The watch duties on the repair queue (job names). */
export const INSTAGRAM_WATCH_DUTY_NAMES = [
  INSTAGRAM_WATCH_OUTAGE_CHECK_JOB_NAME,
  INSTAGRAM_WATCH_LIVE_CHECK_JOB_NAME,
  INSTAGRAM_WATCH_WAITING_ESTIMATE_JOB_NAME,
] as const;

/** Logical Redis key of the late-lane gauge the outage watch writes and readiness reads (SNC9). */
export const INSTAGRAM_WATCH_LATE_LANES_KEY = 'app:instagram_sending:late_lanes';

/** The late-lane gauge's life in Redis: a stale gauge (no watch running) disappears. */
export const INSTAGRAM_WATCH_LATE_LANES_TTL_SECONDS = 120;

/**
 * The repair worker's jobs at once in one process (P94: the duties run in parallel) — one place per
 * duty on the queue (R52's 2, R48's 3 watches, R47's 11), so a duty working its 40 s budget never
 * holds another back (the 10-second outage watch above all). The places hold no Postgres: every
 * database unit waits for a slot of the `instagram-database` limiter (SN24).
 *
 * @remarks
 * Consequences of change: a duty added to or removed from the repair queue changes this number —
 * `scheduler.unit.test.ts` pins it to the queue's scheduler count.
 */
export const INSTAGRAM_SENDING_REPAIR_CONCURRENCY = 16;

/** How long a repair duty's database unit waits for a limiter slot (longer than a ticket's 2 s). */
export const INSTAGRAM_REPAIR_DATABASE_SLOT_WAIT_MILLISECONDS = 10_000;
