import type { InstagramAccountSettingsOutput } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';
import type {
  InstagramAccountOutput,
  InstagramAccountVisibleConnectionStatus,
} from './instagram-account.types.js';

/** Where an Instagram profile lives: `https://instagram.com/{username}` (1.A.6 `profile_url`). */
const INSTAGRAM_PROFILE_BASE_URL = 'https://instagram.com';

/** The `app.instagram_accounts` columns the account object reads — never the token table. */
interface InstagramAccountSerializableRow {
  public_id: string;
  instagram_user_id: string;
  username: string | null;
  name: string | null;
  biography: string | null;
  website: string | null;
  profile_picture_url: string | null;
  followers_count: number;
  follows_count: number;
  media_count: number;
  scopes: string[];
  connection_status: string;
  token_expires_at: Date | null;
  webhook_subscribed_at: Date | null;
  connected_at: Date;
  profile_synced_at: Date | null;
  updated_at: Date;
}

/**
 * Maps a not-revoked `app.instagram_accounts` row, its serialized settings and the resolved
 * connecting user to the public Instagram account object (routes-final § 1.A.6).
 *
 * @remarks
 * - **Algorithm:** names every key (no row spread): `id` from `public_id`; `profile_url` built from
 *   the username; `access_expires_at` from the column `token_expires_at` (renamed in the API, D35);
 *   `is_webhook_subscribed` from `webhook_subscribed_at`; timestamps as ISO 8601;
 *   `connected_by_user_id` is the caller-resolved `usr_…`.
 * - **Failure modes:** none — a pure mapping. The service never passes a revoked row (it answers
 *   `404 instagram_not_connected` instead), so `connection_status` is one of the three visible ones.
 * - **Side effects:** none.
 * - **Notes:** the token never reaches this layer — the row carries only its expiry copy (IA5);
 *   `instagram_app_user_id` and the internal ids stay inside. No key names a token or a secret, so
 *   the idempotency layer stores the connect answer and a repeated key replays it (K3, D35).
 */
export function serializeInstagramAccount({
  account,
  settings,
  connected_by_user_public_id,
}: {
  account: InstagramAccountSerializableRow;
  settings: InstagramAccountSettingsOutput;
  /** `usr_…` of the row's `connected_by_user_id`, or `null`. */
  connected_by_user_public_id: string | null;
}): InstagramAccountOutput {
  return {
    id: account.public_id,
    instagram_user_id: account.instagram_user_id,
    username: account.username,
    name: account.name,
    biography: account.biography,
    website: account.website,
    profile_picture_url: account.profile_picture_url,
    profile_url:
      account.username === null
        ? null
        : `${INSTAGRAM_PROFILE_BASE_URL}/${encodeURIComponent(account.username)}`,
    followers_count: account.followers_count,
    follows_count: account.follows_count,
    media_count: account.media_count,
    scopes: [...account.scopes],
    connection_status: account.connection_status as InstagramAccountVisibleConnectionStatus,
    access_expires_at: account.token_expires_at?.toISOString() ?? null,
    is_webhook_subscribed: account.webhook_subscribed_at !== null,
    settings,
    connected_by_user_id: connected_by_user_public_id,
    connected_at: account.connected_at.toISOString(),
    profile_synced_at: account.profile_synced_at?.toISOString() ?? null,
    updated_at: account.updated_at.toISOString(),
  };
}
