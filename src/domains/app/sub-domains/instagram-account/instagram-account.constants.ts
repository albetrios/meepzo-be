/**
 * Every value of `app.instagram_accounts.connection_status` (IA11), in the order the status moves:
 * `connected` → `expired` | `error` (the guarded change, IA9) → `connected` again on a reconnect;
 * any → `revoked` (a disconnect). Mirrors `chk_instagram_accounts_connection_status`.
 */
export const INSTAGRAM_ACCOUNT_CONNECTION_STATUSES = [
  'connected',
  'expired',
  'error',
  'revoked',
] as const;

/** One value of {@link INSTAGRAM_ACCOUNT_CONNECTION_STATUSES}. */
export type InstagramAccountConnectionStatus =
  (typeof INSTAGRAM_ACCOUNT_CONNECTION_STATUSES)[number];

/** The two statuses the guarded change may move a `connected` account to (IA9). */
export type InstagramAccountBrokenConnectionStatus = Extract<
  InstagramAccountConnectionStatus,
  'expired' | 'error'
>;

/**
 * The unique indexes on `app.instagram_accounts` whose violation decides a connect race (IA12
 * step 4): another not-revoked account in this organization (D5), or this Instagram account
 * not revoked in another organization. The constraint name on the Postgres error is one of these.
 */
export const INSTAGRAM_ACCOUNT_UNIQUE_INDEXES = {
  /** At most one not-revoked account per organization → `organization_already_has_instagram_account`. */
  organizationLive: 'idx_instagram_accounts_organization_live',
  /** One organization at a time per Instagram account → `instagram_account_connected_elsewhere`. */
  instagramUserLive: 'idx_instagram_accounts_instagram_user_live',
} as const;

/** The only `app.instagram_account_tokens.token_type` (Instagram's long-lived token, IA5). */
export const INSTAGRAM_ACCOUNT_TOKEN_TYPE = 'long_lived';

/**
 * The permissions a connect needs granted on Instagram's consent screen (IA12 step 2): reading the
 * account, its messages and its comments. A connect missing any answers
 * `422 instagram_scopes_missing` and stores nothing.
 */
export const INSTAGRAM_ACCOUNT_REQUIRED_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
] as const;

/**
 * The `/me` `account_type` values of a professional account (IA12 step 2); any other (a
 * `PERSONAL` account) answers `422 instagram_account_not_professional`.
 */
export const INSTAGRAM_PROFESSIONAL_ACCOUNT_TYPES = ['BUSINESS', 'MEDIA_CREATOR'] as const;
