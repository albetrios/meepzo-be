import type { ChannelAccountStatus } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';

/**
 * The statuses an Instagram account reads with — its channel account's (`connected` · `error` ·
 * `revoked`, CA4): since ROUTE row R6 the extension holds no status of its own (2.A.3, IA8).
 */
export type InstagramAccountConnectionStatus = ChannelAccountStatus;

/**
 * What a failed Meta call classifies a broken token as (`expired` on subcode 463, else `error`);
 * either lands as the channel account's `error` (CA4 — `expired` is gone from the status).
 */
export type InstagramAccountBrokenConnectionStatus = 'expired' | 'error';

/**
 * The audit resource type of every Instagram account action (IA7): connect, disconnect, the
 * settings change, and Meta's deauthorize and data deletion.
 */
export const INSTAGRAM_ACCOUNT_AUDIT_RESOURCE_TYPE = 'instagram_account';

/**
 * The frontend's Instagram page (meepzo-fe), where the reconnect card lives — the link of the
 * reconnect notice (IA9), joined to `FRONTEND_URL` so the email's button works too.
 */
export const INSTAGRAM_ACCOUNT_FRONTEND_PATH = '/instagram';

/**
 * Accounts one webhook subscription sweep page reads (WC-25) — one short retention read per page,
 * the adds after it.
 */
export const INSTAGRAM_WEBHOOK_SUBSCRIPTION_SWEEP_PAGE_SIZE = 500;

/**
 * Most pages one webhook subscription sweep reads — 100 000 accounts, the bound that keeps one
 * sweep run finite. An estate that reaches it logs
 * `app.instagram_account.webhook_subscription_check.sweep_capped` at error.
 */
export const INSTAGRAM_WEBHOOK_SUBSCRIPTION_SWEEP_MAX_PAGES = 200;
