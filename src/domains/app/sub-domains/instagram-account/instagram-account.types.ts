import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { InstagramAccountSettingsOutput } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';
import type { InstagramAccountSettingsRow } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import type { InstagramAccountConnectionStatus } from './instagram-account.constants.js';
import type { InstagramAccountKey, InstagramAccountRow } from './instagram-account.repository.js';

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

/** Input of {@link InstagramAccountService.disconnect}. */
export interface InstagramAccountDisconnectInput {
  scope: OrganizationPrincipalDatabaseScope;
  /** The request id, sent to Instagram as `X-Request-Id`. */
  requestId: string;
}

/**
 * The organization's live account and its encrypted token, read in one unit of work for an
 * Instagram call made after it closes — the post and story pickers (routes 5–6, IA16).
 *
 * @remarks
 * The token stays ciphertext: only the Instagram client decrypts it, right before its call (IA5).
 */
export interface InstagramAccountAccess {
  /** The not-revoked account — `connected`, `expired` or `error`. */
  account: InstagramAccountRow;
  /** Its organization and internal id — the key every later call on it takes. */
  instagramAccount: InstagramAccountKey;
  /** The encrypted long-lived token; `null` when the account has none. */
  encryptedAccessToken: string | null;
}

/**
 * What Meta signed, in one organization the resolver named (IA19, IA20) — the part of
 * {@link InstagramAccountMetaDisconnectInput} and {@link InstagramAccountMetaErasureInput} they share.
 */
export interface InstagramAccountMetaRequest {
  /** That organization's verified scope, minted by the Meta callback service (ledgered there). */
  scope: OrganizationPrincipalDatabaseScope;
  /** The app-scoped id Meta signed (`user_id`, IQ3) — the column `instagram_app_user_id`. */
  instagramAppUserId: string;
  /**
   * When Meta signed the request (`issued_at`, Unix seconds), or `null` when it sent none: an account
   * connected after it is left alone (D53).
   */
  issuedAt: number | null;
}

/**
 * Input of {@link InstagramAccountService.disconnectForMeta} — Meta's deauthorize (IA19) or data
 * deletion (IA20) in one organization the resolver named.
 */
export interface InstagramAccountMetaDisconnectInput extends InstagramAccountMetaRequest {
  /** `true` for the data deletion: also erase each account's profile (IA20). */
  shouldEraseProfile: boolean;
}

/**
 * Input of {@link InstagramAccountErasureService.eraseForMeta}: the disconnect and, on a data
 * deletion, the profile and stored posts erased with it.
 */
export interface InstagramAccountMetaErasureInput extends InstagramAccountMetaRequest {
  /** `true` for the data deletion (IA20); `false` for the deauthorize (IA19). */
  shouldEraseData: boolean;
}

/**
 * What an erase changed in one organization — Meta's callback (IA19, IA20) or the organization's
 * delete (D54) — for the caller's audit entry.
 *
 * @remarks
 * Only accounts something changed on are named: one already revoked and erased is not.
 */
export interface InstagramAccountErasure {
  /** `iga_…` of every account something changed on (normally one). */
  instagramAccountPublicIds: string[];
  /** Stored posts erased (`0` on a deauthorize). */
  erasedPostCount: number;
}

/**
 * What an erase changed on one account of one organization (IA19, IA20, D54) — for the caller's
 * audit entry and its "was anything left to do" check.
 *
 * @remarks
 * All three flags `false` means the account was already revoked, held no token and (when the profile
 * is erased too) its profile was already erased: a repeat changed nothing.
 */
export interface InstagramAccountDisconnectChange {
  /** Its organization and internal id — the key the stored posts' erase takes. */
  instagramAccount: InstagramAccountKey;
  /** `iga_…`, for the audit entry. */
  instagramAccountPublicId: string;
  /** The account moved to `revoked` now (it was `connected`, `expired` or `error`). */
  wasRevoked: boolean;
  /** A token row was there and is now erased. */
  wasTokenErased: boolean;
  /** The profile was erased now (it was asked for and not erased yet). */
  wasProfileErased: boolean;
}

/**
 * The account an Instagram webhook delivery entry is for, and the state its events are stored by
 * (routes-final § 4.A, WH3, WH10) — read in the organization's own scope after the resolver found
 * it.
 *
 * @remarks
 * Ids and two flags only — never the token or the profile. "The account itself" is either of its
 * two Instagram ids (WH9): the webhook user id (`entry.id`) and the app-scoped id used in send URLs.
 */
export interface InstagramWebhookAccountState {
  /** Its organization and internal id. */
  instagramAccount: InstagramAccountKey;
  /** `app.channel_accounts.id` it extends — the key the events are stored under (R16, § 5.B.3). */
  channelAccountId: number;
  /** `iga_…`. */
  instagramAccountPublicId: string;
  /** The webhook user id (`/me` `user_id`, the delivery entry's `id`). */
  instagramUserId: string;
  /** The app-scoped id (`/me` `id`) used in send URLs. */
  instagramAppUserId: string;
  /** `connected`, `expired` or `error` — a revoked account is never returned. */
  connectionStatus: InstagramAccountVisibleConnectionStatus;
  /** The account's automation switch (`is_automation_enabled`). */
  isAutomationEnabled: boolean;
}

/**
 * The account Instagram webhook event processing works for (routes-final § 4.A, WH12, WH13): the
 * organization's account with the job's public id, in any status, its automation switch and — only
 * while it is `connected` — its encrypted token, for the reads processing makes itself (a new
 * contact's profile, a post not stored yet).
 *
 * @remarks
 * A revoked account is returned too (unlike {@link InstagramWebhookAccountState}): its waiting
 * events still need their key to be marked `skipped` (`account_disconnected`), or the stuck-event
 * pick-up would find them for ever. The token stays ciphertext (IA5).
 */
export interface InstagramWebhookProcessingAccount {
  /** Its organization and internal id. */
  instagramAccount: InstagramAccountKey;
  /** `app.channel_accounts.id` it extends — the key the events are claimed under (R16, § 5.B.3). */
  channelAccountId: number;
  /** `iga_…`. */
  instagramAccountPublicId: string;
  /** Any status — `connected`, `expired`, `error` or `revoked`. */
  connectionStatus: InstagramAccountConnectionStatus;
  /** The account's automation switch (`is_automation_enabled`; on when it has no settings row). */
  isAutomationEnabled: boolean;
  /** The encrypted long-lived token — `null` unless the account is `connected` and has one. */
  encryptedAccessToken: string | null;
}

/**
 * What the run engine sends with (routes-final § 3.B, AU5, AU19, AU20): the event's account — the
 * organization's not-revoked account with that public id — its encrypted token, the ids a send
 * needs, and its reply-safety settings; read in one unit of work, used after it closes.
 *
 * @remarks
 * The token stays ciphertext: only the Instagram client decrypts it, right before its call (IA5).
 */
export interface InstagramAutomationAccountAccess {
  /** Its organization and internal id — the key the automations, contacts and runs name. */
  instagramAccount: InstagramAccountKey;
  /** `iga_…`. */
  instagramAccountPublicId: string;
  /** The app-scoped id used in send URLs (`POST /{instagram_app_user_id}/messages`). */
  instagramAppUserId: string;
  /** The account's username — the follow request's profile link (schema-routes § 10). */
  username: string | null;
  /** `connected`, `expired` or `error` — a revoked account is never returned. */
  connectionStatus: InstagramAccountVisibleConnectionStatus;
  /** The encrypted long-lived token; `null` when the account has none. */
  encryptedAccessToken: string | null;
  /** The account's settings row (reply safety, AU20); `null` when it has none (the defaults apply). */
  settings: InstagramAccountSettingsRow | null;
}
