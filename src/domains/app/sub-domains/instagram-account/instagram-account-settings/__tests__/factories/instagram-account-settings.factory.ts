import type { InstagramAccountSettingsRow } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';

/**
 * An `app.instagram_account_settings` row as a pick leaves it (R7, 2.B.3 — every limit empty, the
 * column defaults), any column overridden — for unit tests that fake the settings repository.
 */
export function buildInstagramAccountSettingsRow(
  overrides: Partial<InstagramAccountSettingsRow> = {},
): InstagramAccountSettingsRow {
  const createdAt = new Date('2026-11-21T09:00:00.000Z');
  return {
    id: 91,
    organization_id: 7,
    channel_account_id: 5,
    opening_hour_limit: null,
    opening_day_limit: null,
    fast_hour_limit: null,
    person_hour_limit: null,
    broadcast_hour_limit: null,
    is_automatic_notice_enabled: false,
    extra_stop_words: [],
    is_comment_reply_trigger_enabled: true,
    is_once_per_person_per_post_enabled: true,
    is_mark_seen_after_reply_enabled: false,
    extra_delay_seconds_min: null,
    extra_delay_seconds_max: null,
    updated_by_user_id: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}
