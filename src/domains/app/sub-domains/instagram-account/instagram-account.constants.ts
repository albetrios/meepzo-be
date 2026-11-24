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
 * Longest error text the daily account check logs — Meta's class, code, subcode and HTTP status cut
 * to it (the `varchar(500)` of `app.channel_connections.last_check_error`).
 */
export const INSTAGRAM_ACCOUNT_REFRESH_ERROR_MAX_LENGTH = 500;

/**
 * The frontend's Instagram page (meepzo-fe), where the reconnect card lives — the link of the
 * reconnect notice (IA9), joined to `FRONTEND_URL` so the email's button works too.
 */
export const INSTAGRAM_ACCOUNT_FRONTEND_PATH = '/instagram';
