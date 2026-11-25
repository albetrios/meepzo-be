/**
 * Job name of the daily sweep — a repeatable job on the daily-check queue
 * (`src/infrastructure/queue/scheduler.ts`, 04:00 UTC), run by the daily-check worker. It lists the
 * connected accounts and adds one check per account (IA8).
 */
export const INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_JOB_NAME = 'sweep-connected-instagram-accounts';

/** Accounts one sweep page reads (one short retention read per page, the adds after it). */
export const INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE = 500;

/**
 * Most pages one sweep reads — 100 000 accounts, the bound that keeps one sweep run finite. An
 * estate that reaches it logs `app.instagram_account.daily_check.sweep_capped` at error: the
 * accounts past the cap get no check that day, so the cap (or the page size) must be raised.
 */
export const INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_MAX_PAGES = 200;

/**
 * Job name of the 10-minute webhook subscription sweep (feat-instagram-dm-sending WC-25, ROUTE row
 * R40) — a second repeatable job on the daily-check queue (`scheduler.ts`), run by the daily-check
 * worker: it hands each connected account one subscription check on `instagram-tasks`.
 */
export const INSTAGRAM_WEBHOOK_SUBSCRIPTION_SWEEP_JOB_NAME =
  'sweep-instagram-webhook-subscriptions';
