/**
 * Constants of the channel connection (routes-final § 1): its providers, statuses, token types,
 * the permissions a Meta login must grant, the audit resource type and the reasons it answers.
 *
 * @remarks
 * Code constants, not env (P4): they do not vary by environment.
 */

/** The providers a connection logs in with — `meta` only this iteration (MC1). */
export const CHANNEL_CONNECTION_PROVIDERS = ['meta'] as const;

/** The statuses of a connection (MC5, MC8, MC11). */
export const CHANNEL_CONNECTION_STATUS = {
  CONNECTED: 'connected',
  ERROR: 'error',
  REVOKED: 'revoked',
} as const;

/** One value of {@link CHANNEL_CONNECTION_STATUS}. */
export type ChannelConnectionStatus =
  (typeof CHANNEL_CONNECTION_STATUS)[keyof typeof CHANNEL_CONNECTION_STATUS];

/** A token's type (P49): Meta writes `system_user`; a later provider `oauth_user`. */
export const CHANNEL_CONNECTION_TOKEN_TYPES = ['system_user', 'oauth_user'] as const;

/** One value of {@link CHANNEL_CONNECTION_TOKEN_TYPES}. */
export type ChannelConnectionTokenType = (typeof CHANNEL_CONNECTION_TOKEN_TYPES)[number];

/** The channels a connection brings accounts in for — `instagram` only this iteration (D27). */
export const CHANNEL_CONNECTION_CHANNELS = ['instagram'] as const;

/** One value of {@link CHANNEL_CONNECTION_CHANNELS}. */
export type ChannelConnectionChannel = (typeof CHANNEL_CONNECTION_CHANNELS)[number];

/**
 * The permissions a Meta login must grant (MC5 step 4) — without one the callback answers
 * `422 provider_permissions_missing` and saves nothing. `ads_read` is optional (MC13).
 */
export const META_REQUIRED_PERMISSIONS = [
  'instagram_basic',
  'instagram_manage_messages',
  'instagram_manage_comments',
] as const;

/** The optional permission of the ad picker (MC13); `has_ads_access` reads it. */
export const META_ADS_PERMISSION = 'ads_read';

/** Most accounts one pick names (1.8: `provider_account_ids` 1–10). */
export const CHANNEL_ACCOUNT_PICK_MAX = 10;

/** The channel accounts a plan allows when the organization has no readable plan (Free's limit). */
export const CHANNEL_ACCOUNTS_MAX_WITHOUT_PLAN = 1;

/** Audit `resource_type` of the connection's entries (MC12). */
export const CHANNEL_CONNECTION_AUDIT_RESOURCE_TYPE = 'channel_connection';

/** The idempotency-key prefix the frontend sends on the callback (`channel-connect:<state>`). */
export const CHANNEL_CONNECT_IDEMPOTENCY_KEY_PREFIX = 'channel-connect:';
