import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { InstagramAccountSettingsOutput } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';
import type { InstagramAccountConnectionStatus } from './instagram-account.constants.js';

/**
 * The statuses an answered account can carry — a revoked account is never returned (1.A.6): it
 * reads as `404 instagram_not_connected`.
 */
export type InstagramAccountVisibleConnectionStatus = Exclude<
  InstagramAccountConnectionStatus,
  'revoked'
>;

/**
 * The Instagram account object (routes-final § 1.A.6) — routes 1 and 2. Never the token.
 *
 * @remarks
 * Snake_case wire keys; `id` is the `iga_…` public id; `connected_by_user_id` the latest connecting
 * user's `usr_…` (or `null`); timestamps ISO 8601.
 */
export interface InstagramAccountOutput {
  /** `iga_…`. */
  id: string;
  /** `/me` `user_id` — the professional account's Instagram id. */
  instagram_user_id: string;
  /** Required on every account that is not revoked; typed nullable as the column is. */
  username: string | null;
  name: string | null;
  biography: string | null;
  website: string | null;
  profile_picture_url: string | null;
  /** `https://instagram.com/{username}`; `null` only without a username. */
  profile_url: string | null;
  followers_count: number;
  follows_count: number;
  media_count: number;
  /** The permissions granted on Instagram's consent screen. */
  scopes: string[];
  connection_status: InstagramAccountVisibleConnectionStatus;
  /**
   * When the stored access ends (about 60 days after a connect or renewal) — the column
   * `token_expires_at`, renamed in the API (D35) so no response key names a token.
   */
  access_expires_at: string | null;
  /** Whether `subscribed_apps` succeeded — `false` means no events arrive yet. */
  is_webhook_subscribed: boolean;
  settings: InstagramAccountSettingsOutput;
  /** `usr_…` of the latest connecting user, or `null` (an API key, or the user was deleted). */
  connected_by_user_id: string | null;
  connected_at: string;
  profile_synced_at: string | null;
  updated_at: string;
}

/** The Instagram connect result (routes-final § 1.A.6) — route 1. */
export interface InstagramConnectResultOutput {
  /** `false` when this organization had this Instagram account before, in any status. */
  is_new_connection: boolean;
  instagram_account: InstagramAccountOutput;
}

/** Input of {@link InstagramAccountService.connect}. */
export interface InstagramAccountConnectInput {
  /** The caller's organization scope (the signed `org` claim). */
  scope: OrganizationPrincipalDatabaseScope;
  /** The validated authorization code (`#_` still on — the Instagram client strips it). */
  code: string;
  /** `usr_…` of the connecting user; `undefined` for an API-key principal. */
  connectedByUserPublicId: string | undefined;
  /** The request id, sent to Instagram as `X-Request-Id`. */
  requestId: string;
}

/** Input of {@link InstagramAccountService.disconnect}. */
export interface InstagramAccountDisconnectInput {
  scope: OrganizationPrincipalDatabaseScope;
  /** The request id, sent to Instagram as `X-Request-Id`. */
  requestId: string;
}
