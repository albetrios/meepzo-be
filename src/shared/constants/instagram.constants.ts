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
 * How long one intake claim holds an Instagram webhook event — the lease (WH12, D15).
 *
 * @remarks
 * A claim older than this no longer holds, so a run that crashed mid-event frees it; the
 * every-minute pick-up re-adds the intake job of an event that waited a minute
 * (`INSTAGRAM_WEBHOOK_EVENT_PICK_UP_AFTER_MINUTES`, WH17 — R39) and is not leased this long.
 * Rationale: `src/POLICIES.md`.
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
 * How many UTC days either side of its own day the store function looks for an event's key before
 * saving it (WH9 step 6, WH20): a repeat whose day moved is still a repeat.
 *
 * @remarks
 * A `changes[]` item (a comment) has no time of its own, so its day is the entry's `time` — when
 * Meta *sent* it, which moves with every retry (Meta retries for up to 36 hours, so at most two UTC
 * days later), and the missed-comment check files the same comment under the comment's own time.
 * Keys are ids (`comment:<id>`, `message:<mid>`) or carry their own time, so a key found on a nearby
 * day is always the same event.
 */
export const INSTAGRAM_WEBHOOK_EVENT_KEY_NEARBY_DAYS = 2;

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

/**
 * How many accounts' entries of one Meta delivery the receiver stores at once (WH9, WH2): Meta
 * batches up to 1,000 updates across accounts, and one after another each slow unit (up to
 * {@link INSTAGRAM_WEBHOOK_STORE_TIMEOUT_MS}) would add up past Meta's answer budget, so the whole
 * batch would be delivered again.
 *
 * @remarks
 * One account's entries still go one after another, in delivery order (its events' `created_at`
 * order is intake's claim order). Each running unit holds one connection of the HTTP pool
 * (`DATABASE_POOL_MAX`, 80 by default). The cap is process-wide, not per delivery
 * ({@link INSTAGRAM_WEBHOOK_STORE_SLOT_LIMITER_NAME}, P262): however many deliveries arrive at
 * once, the webhook store holds at most 8 connections, leaving the rest to other requests; a unit
 * that finds no slot within the limiter's wait fails its entry, so Meta's retry brings it back.
 */
export const INSTAGRAM_WEBHOOK_ENTRY_STORE_CONCURRENCY = 8;

/**
 * The name of the process-wide database slot limiter the webhook store's units share
 * (feat-instagram-dm-sending P262), sized {@link INSTAGRAM_WEBHOOK_ENTRY_STORE_CONCURRENCY}.
 *
 * @remarks
 * One limiter per API process (`getWorkerDatabaseSlotLimiter`); every delivery in flight takes its
 * slots, so a burst of Meta deliveries cannot take the whole HTTP pool.
 */
export const INSTAGRAM_WEBHOOK_STORE_SLOT_LIMITER_NAME = 'instagram-webhook-store';

/** Meta's message id (`mid`) is at most this long (feat-instagram-dm-sending 6.B.3). */
export const INSTAGRAM_MESSAGE_ID_MAX_LENGTH = 128;
