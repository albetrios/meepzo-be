/**
 * Constants of the channel account (feat-instagram-dm-sending routes-final § 1B): its channels,
 * statuses, plan-stop reasons, the audit resource type and the new-account window.
 *
 * @remarks
 * Code constants, not env (P4): they do not vary by environment.
 */

/** The channels an account belongs to — `instagram` only this iteration (D27). */
export const CHANNEL_ACCOUNT_CHANNELS = ['instagram'] as const;

/** One value of {@link CHANNEL_ACCOUNT_CHANNELS}. */
export type ChannelAccountChannel = (typeof CHANNEL_ACCOUNT_CHANNELS)[number];

/** The statuses of a channel account (CA4: no `expired` — the connection's token never ends). */
export const CHANNEL_ACCOUNT_STATUS = {
  CONNECTED: 'connected',
  ERROR: 'error',
  REVOKED: 'revoked',
} as const;

/** One value of {@link CHANNEL_ACCOUNT_STATUS}. */
export type ChannelAccountStatus =
  (typeof CHANNEL_ACCOUNT_STATUS)[keyof typeof CHANNEL_ACCOUNT_STATUS];

/**
 * The plan stop's reasons (CA3, P99): `plan_limit` holds the slow, fast and broadcast lanes (the
 * reply lane goes on, D62); `plan_ended` and `plan_downgrade` hold all four. One at a time:
 * `plan_downgrade` is never replaced by the other two, `plan_ended` replaces `plan_limit`.
 */
export const CHANNEL_ACCOUNT_PLAN_STOP_REASON = {
  PLAN_LIMIT: 'plan_limit',
  PLAN_ENDED: 'plan_ended',
  PLAN_DOWNGRADE: 'plan_downgrade',
} as const;

/** One value of {@link CHANNEL_ACCOUNT_PLAN_STOP_REASON}. */
export type ChannelAccountPlanStopReason =
  (typeof CHANNEL_ACCOUNT_PLAN_STOP_REASON)[keyof typeof CHANNEL_ACCOUNT_PLAN_STOP_REASON];

/** Audit `resource_type` of the account's entries (CA10). */
export const CHANNEL_ACCOUNT_AUDIT_RESOURCE_TYPE = 'channel_account';

/** How long a newly connected account keeps the new-account hour limit (D5): 7 days. */
export const CHANNEL_ACCOUNT_NEW_ACCOUNT_LIMIT_DAYS = 7;

/** Unique indexes a write maps to a route answer (CAQ1). */
export const CHANNEL_ACCOUNT_UNIQUE_INDEXES = {
  /** One organization at a time per provider account → `connected_elsewhere` (P60). */
  providerAccountLive: 'idx_channel_accounts_provider_account_live',
} as const;
