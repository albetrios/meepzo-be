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
 * The unique index on `app.instagram_accounts` whose violation decides a pick race between two
 * organizations (MC7): this Instagram account not revoked in another organization. The constraint
 * name on the Postgres error is this one.
 */
export const INSTAGRAM_ACCOUNT_UNIQUE_INDEXES = {
  /** One organization at a time per Instagram account → `connected_elsewhere`. */
  instagramUserLive: 'idx_instagram_accounts_instagram_user_live',
} as const;

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
