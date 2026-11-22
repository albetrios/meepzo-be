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
 * Days an automation run is kept after it ended (`ended_at`), its run events with it (D8, AU25,
 * WC-12); open runs are never removed. A product rule, not a setting.
 *
 * @remarks
 * Rationale: `src/POLICIES.md`.
 */
export const AUTOMATION_RUN_RETENTION_DAYS = 180;

/**
 * Days an automation comment log is kept after it was written (`created_at`) (D8, AU25, WC-9). A
 * product rule, not a setting.
 *
 * @remarks
 * Rationale: `src/POLICIES.md`.
 */
export const AUTOMATION_COMMENT_LOG_RETENTION_DAYS = 180;

/**
 * Days a deleted automation is kept before the daily purge removes it for good, once no run or
 * comment log points at it (AQ7, AU25, WC-15). A product rule, not a setting — unlike the other
 * tombstones' `TOMBSTONE_RETENTION_DAYS`.
 *
 * @remarks
 * Rationale: `src/POLICIES.md`.
 */
export const AUTOMATION_TOMBSTONE_RETENTION_DAYS = 180;
