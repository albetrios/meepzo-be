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

/**
 * A token that ends within this many days is flagged by the token check for a reconnect
 * (`last_check_error` = `token_expires_soon (expires_at …)` — P355).
 *
 * @remarks
 * Rationale: whether Meta's system-user token ends depends on the login configuration (Meta's
 * "Authentication and access tokens"); a dated token is read at the callback. A week gives the
 * owner several daily checks to see the flag before Meta refuses the token (code 190).
 *
 * Consequences of change:
 * - Decreasing → the owner is told later, closer to the break.
 * - Increasing → the flag shows sooner and stays longer.
 *
 * Last reviewed: 2026-11-25.
 */
export const CHANNEL_CONNECTION_TOKEN_EXPIRY_WARNING_DAYS = 7;

/**
 * A `connected` connection whose last login that shared an account (a login sharing nothing keeps
 * `connected_at`, C-D21) is older than this many days and that still has no
 * account that is not revoked is revoked by the daily token check and its token deleted
 * (feat-meta-connect-flow CN9, C-D3) — a login nobody picked from stops holding a live token.
 *
 * @remarks
 * Rationale: a week lets an owner come back to the account picker (route 151 re-reads what the
 * login shared) without logging in again; past it, the unused token is only a risk.
 *
 * Consequences of change:
 * - Decreasing → an owner who left the picker for a few days has to log in again.
 * - Increasing → unused tokens stay live longer.
 *
 * Last reviewed: 2026-11-26.
 */
export const CHANNEL_CONNECTION_UNPICKED_KEEP_DAYS = 7;
