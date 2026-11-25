/**
 * Instagram automation policy constants (launch-2026-11-20-ujai): webhook event processing and the
 * webhook's subscription check (routes-final § 4.A), and how long runs, comment logs and deleted
 * automations are kept (§ 3).
 */

/**
 * Processing attempts after which an Instagram webhook event is `failed` (WH12, WH14): the 5th
 * failed attempt marks it `failed` with its error and the account's next event runs. Counts only
 * attempts in which our handling ran — an Instagram outage (open circuit) spends none.
 *
 * @remarks
 * Smaller than `STRIPE_WEBHOOK_MAX_PROCESSING_ATTEMPTS` because one account's later events wait
 * behind a failing one (WQ3, D28): five attempts with growing waits from 5 seconds hold the
 * account back about one to two minutes. Rationale: `src/POLICIES.md`.
 */
export const INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS = 5;

/**
 * Minutes after which a waiting Instagram webhook event counts as stuck, and how long one claim
 * holds an event (WH12, WH15, D15) — one number for both.
 *
 * @remarks
 * The stuck-event pick-up (every minute) re-adds the processing job of an account whose event is
 * still `received` / `queued` this long after it arrived and was not claimed in as long; a claim
 * older than this no longer holds, so a run that crashed mid-event frees it. Rationale:
 * `src/POLICIES.md`.
 */
export const INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES = 5;

/**
 * Events one processing job handles before its account yields the worker slot (WH12): it then adds
 * one follow-up job, so a busy account never keeps the other accounts waiting.
 *
 * @remarks
 * Rationale: `src/POLICIES.md`.
 */
export const INSTAGRAM_WEBHOOK_EVENTS_PER_JOB = 25;

/**
 * The longest `hub.challenge` the Instagram webhook's subscription check echoes (route 16, 4.A.8).
 *
 * @remarks
 * Rationale: `src/POLICIES.md`.
 */
export const INSTAGRAM_WEBHOOK_CHALLENGE_MAX_LENGTH = 256;

/**
 * Days a deleted automation is kept before the daily purge removes it for good, once no run or
 * comment log points at it (AQ7, AU25, WC-15). A product rule, not a setting — unlike the other
 * tombstones' `TOMBSTONE_RETENTION_DAYS`.
 *
 * @remarks
 * Rationale: `src/POLICIES.md`.
 */
export const AUTOMATION_TOMBSTONE_RETENTION_DAYS = 180;

/**
 * Months a message month count (`app.message_month_counts`) is kept, counted from the month's first
 * day, before the hourly clean-up deletes it (feat-instagram-dm-sending WC-54): the current month and
 * the twelve before it stay readable.
 *
 * @remarks
 * Rationale: `src/POLICIES.md`.
 */
export const MESSAGE_MONTH_COUNT_KEEP_MONTHS = 13;

/**
 * Minutes a channel connection's login state stays usable (routes-final § 1 MC3, MC4, P26): the
 * one-use Redis value routes 1 and 40 mint and the callback (route 2) reads and deletes.
 *
 * @remarks
 * Rationale: `src/POLICIES.md`.
 */
export const CONNECT_STATE_MINUTES = 10;

/**
 * How long one Instagram profile read may take during a pick before the pick goes on without it
 * (routes-final § 1 MC3, MC7 — fails open, the username is enough).
 *
 * @remarks
 * Rationale: `src/POLICIES.md`.
 */
export const PROFILE_READ_TIMEOUT_MILLISECONDS = 3000;

/**
 * Meta usage percentage from which every channel's calls on that connection slow down
 * (routes-final § 1 MC19, P51, plan:L2353–L2360).
 *
 * @remarks
 * Rationale: `src/POLICIES.md`.
 */
export const META_USAGE_SLOW_PERCENT = 80;

/**
 * Meta usage percentage from which every channel's calls on that connection wait until the time
 * Meta gave, else {@link META_USAGE_DEFAULT_WAIT_MINUTES} (routes-final § 1 MC19, P51).
 *
 * @remarks
 * Rationale: `src/POLICIES.md`.
 */
export const META_USAGE_WAIT_PERCENT = 95;

/**
 * Minutes a connection waits at {@link META_USAGE_WAIT_PERCENT} when Meta's answer names no
 * `estimated_time_to_regain_access` (routes-final § 1 MC19).
 *
 * @remarks
 * Rationale: `src/POLICIES.md`.
 */
export const META_USAGE_DEFAULT_WAIT_MINUTES = 15;

/**
 * Days an Instagram webhook event, its key and their day parts are kept — and the replay guard: an
 * event whose Meta time is older than this is never saved (feat-instagram-dm-sending § 5.B, WH9
 * step 5, WH19, WH20, WH24; P33, D15).
 *
 * @remarks
 * One number for the three (WHC6, WHC15): a key part older than this may already be dropped, so an
 * older event could no longer be recognised as a repeat. Rationale: `src/POLICIES.md`.
 */
export const INSTAGRAM_WEBHOOK_EVENT_KEEP_DAYS = 8;

/**
 * The webhook store unit's `statement_timeout`, in milliseconds (feat-instagram-dm-sending § 5,
 * WH2, WHC2; plan `WEBHOOK_SAVE_TIMEOUT_MS`): a statement of the unit that runs longer is
 * cancelled, nothing is stored and Meta is answered `503` — inside its 5-second budget — so it
 * delivers again (P32: no Redis buffer).
 *
 * @remarks
 * Below the HTTP connection's own statement timeout (`DATABASE_HTTP_STATEMENT_TIMEOUT_MS`, 5 s).
 * Rationale: `src/POLICIES.md`.
 */
export const INSTAGRAM_WEBHOOK_STORE_TIMEOUT_MS = 3_000;

/** Meta's message id (`mid`) is at most this long (feat-instagram-dm-sending 6.B.3). */
export const INSTAGRAM_MESSAGE_ID_MAX_LENGTH = 128;
