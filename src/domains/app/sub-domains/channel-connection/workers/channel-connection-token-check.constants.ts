import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';

/**
 * Job name of the hourly sweep — a repeatable job on the token-check queue
 * (`src/infrastructure/queue/scheduler.ts`), run by the token-check worker. It lists the due
 * connections and adds one check per connection (routes-final § 1 MC10).
 */
export const CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_JOB_NAME = 'sweep-due-channel-connections';

/**
 * How long a connection's last check stays fresh: every 24 hours per connection, spread over the
 * day by when each one was connected or last checked (MC10, WC-34).
 */
export const CHANNEL_CONNECTION_TOKEN_CHECK_INTERVAL_MS = MILLISECONDS_PER_DAY;

/** Connections one sweep page reads (one short retention read per page, the adds after it). */
export const CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_PAGE_SIZE = 500;

/**
 * Most pages one sweep reads — 100 000 due connections, the bound that keeps one sweep run finite.
 * An estate that reaches it logs `app.channel_connection.token_check.sweep_capped` at error; the
 * connections past the cap are still due and a later hourly sweep lists them.
 */
export const CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_MAX_PAGES = 200;

/**
 * Job name of the 10-minute webhook subscription sweep (feat-instagram-dm-sending WC-25, ROUTE row
 * R40) — a second repeatable job on the token-check queue (`scheduler.ts`), run by the token-check
 * worker through its services' `webhookSubscriptionSweep`: it hands each
 * connected Instagram account one subscription check on `instagram-tasks`. It rode the launch daily
 * check's queue until that check was retired at the R40 × R51 merge.
 */
export const INSTAGRAM_WEBHOOK_SUBSCRIPTION_SWEEP_JOB_NAME =
  'sweep-instagram-webhook-subscriptions';
