import type { InstagramAccountSettingsOutput } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';
import type { InstagramAccountRow } from './instagram-account.repository.js';
import type { InstagramAccountExtensionOutput } from './instagram-account.types.js';

/**
 * The Instagram account object (feat-instagram-dm-sending routes-final § 2.A.6) — the `instagram`
 * part of the channel account that 1B's serializer embeds (routes 7, 9–11).
 *
 * @remarks
 * - **Algorithm:** names every key (no row spread); `is_webhook_subscribed` is
 *   `webhook_subscribed_at` set, `is_messages_webhook_missing` is `messages_webhook_missing_at` set
 *   (P358); timestamps as ISO 8601.
 * - **Failure modes:** none — a pure mapping. **Side effects:** none.
 * - **Notes:** no id of its own and never a token; the launch's `name`, `scopes` and
 *   `access_expires_at` are gone (IA8).
 */
export function serializeInstagramAccountExtension({
  instagram,
  settings,
}: {
  instagram: Pick<
    InstagramAccountRow,
    | 'instagram_user_id'
    | 'username'
    | 'account_type'
    | 'is_private'
    | 'followers_count'
    | 'profile_picture_url'
    | 'starter_questions_set_at'
    | 'webhook_subscribed_at'
    | 'messages_webhook_missing_at'
    | 'profile_synced_at'
  >;
  settings: InstagramAccountSettingsOutput;
}): InstagramAccountExtensionOutput {
  return {
    instagram_user_id: instagram.instagram_user_id,
    username: instagram.username,
    account_type: instagram.account_type,
    is_private: instagram.is_private,
    followers_count: instagram.followers_count,
    profile_picture_url: instagram.profile_picture_url,
    starter_questions_set_at: instagram.starter_questions_set_at?.toISOString() ?? null,
    is_webhook_subscribed: instagram.webhook_subscribed_at !== null,
    is_messages_webhook_missing: instagram.messages_webhook_missing_at !== null,
    profile_synced_at: instagram.profile_synced_at?.toISOString() ?? null,
    settings,
  };
}
