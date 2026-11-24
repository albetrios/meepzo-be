import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { CHANNEL_ACCOUNT_NEW_ACCOUNT_LIMIT_DAYS } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import {
  BROADCAST_HOUR_LIMIT_DEFAULT,
  DAY_LIMIT_DEFAULT_FACTOR,
  DAY_LIMIT_ENABLED,
  FAST_HOUR_LIMIT_DEFAULT,
  NEW_ACCOUNT_HOUR_LIMIT,
  OPENING_HOUR_LIMIT_DEFAULT,
  PERSON_HOUR_LIMIT_DEFAULT,
} from './instagram-account-settings.constants.js';
import type { InstagramAccountSettingsRow } from './instagram-account-settings.repository.js';
import type {
  InstagramAccountEffectiveLimitsOutput,
  InstagramAccountSettingsOutput,
} from './instagram-account-settings.types.js';

/** The settings columns {@link resolveInstagramEffectiveLimits} reads. */
type InstagramAccountLimitColumns = Pick<
  InstagramAccountSettingsRow,
  | 'opening_hour_limit'
  | 'opening_day_limit'
  | 'fast_hour_limit'
  | 'person_hour_limit'
  | 'broadcast_hour_limit'
>;

/**
 * The limits an account's lanes use now (routes-final § 2.B.6 `effective_limits`, IA14): each owner
 * value, else the settings file's.
 *
 * @remarks
 * - **Algorithm:** the opening hour limit is the owner's; with none, `NEW_ACCOUNT_HOUR_LIMIT` (150)
 *   while `connected_at` is less than `CHANNEL_ACCOUNT_NEW_ACCOUNT_LIMIT_DAYS` ago, else
 *   `OPENING_HOUR_LIMIT_DEFAULT` (D5). The day limit is `null` while `DAY_LIMIT_ENABLED` is off,
 *   else the owner's or the hour limit × `DAY_LIMIT_DEFAULT_FACTOR`. The rest: owner, else default.
 * - **Failure modes:** none — a pure function. **Side effects:** none.
 * - **Notes:** sub-domain 6's lanes (ROUTE row R18) read the same rule, so the answer shows what
 *   they do.
 */
export function resolveInstagramEffectiveLimits({
  settings,
  connectedAt,
  now,
}: {
  settings: InstagramAccountLimitColumns;
  /** The channel account's latest pick or reconnect — starts the new-account window. */
  connectedAt: Date;
  now: Date;
}): InstagramAccountEffectiveLimitsOutput {
  const isNewAccount =
    now.getTime() - connectedAt.getTime() <
    CHANNEL_ACCOUNT_NEW_ACCOUNT_LIMIT_DAYS * MILLISECONDS_PER_DAY;
  const openingHourLimit =
    settings.opening_hour_limit ??
    (isNewAccount ? NEW_ACCOUNT_HOUR_LIMIT : OPENING_HOUR_LIMIT_DEFAULT);
  return {
    opening_hour_limit: openingHourLimit,
    opening_day_limit: DAY_LIMIT_ENABLED
      ? (settings.opening_day_limit ?? openingHourLimit * DAY_LIMIT_DEFAULT_FACTOR)
      : null,
    fast_hour_limit: settings.fast_hour_limit ?? FAST_HOUR_LIMIT_DEFAULT,
    person_hour_limit: settings.person_hour_limit ?? PERSON_HOUR_LIMIT_DEFAULT,
    broadcast_hour_limit: settings.broadcast_hour_limit ?? BROADCAST_HOUR_LIMIT_DEFAULT,
  };
}

/**
 * Maps an `app.instagram_account_settings` row, with its channel account's switch and connect time,
 * to the public settings object (routes-final § 2.B.6) — route 12's answer and the `settings` of the
 * channel account's `instagram` part.
 *
 * @remarks
 * - **Algorithm:** names every key (no row spread, so a column added later never reaches the wire
 *   unreviewed); `is_automation_enabled` is the channel account's (P42); `effective_limits` from
 *   {@link resolveInstagramEffectiveLimits}; the internal `updated_by_user_id` swapped for the
 *   caller-resolved `usr_…` id; `updated_at` as ISO 8601.
 * - **Failure modes:** none — a pure mapping. **Side effects:** none.
 * - **Notes:** the internal ids (`id`, `organization_id`, `channel_account_id`) never leave.
 */
export function serializeInstagramAccountSettings({
  settings,
  channel_account,
  updated_by_user_public_id,
  now,
}: {
  settings: InstagramAccountSettingsRow;
  /** The channel account's automation switch and its latest pick or reconnect. */
  channel_account: { is_automation_enabled: boolean; connected_at: Date };
  /** `usr_…` of the row's `updated_by_user_id`, or `null` when it has none. */
  updated_by_user_public_id: string | null;
  /** The clock the new-account window is read against. */
  now: Date;
}): InstagramAccountSettingsOutput {
  return {
    is_automation_enabled: channel_account.is_automation_enabled,
    opening_hour_limit: settings.opening_hour_limit,
    opening_day_limit: settings.opening_day_limit,
    fast_hour_limit: settings.fast_hour_limit,
    person_hour_limit: settings.person_hour_limit,
    broadcast_hour_limit: settings.broadcast_hour_limit,
    effective_limits: resolveInstagramEffectiveLimits({
      settings,
      connectedAt: channel_account.connected_at,
      now,
    }),
    is_day_limit_enabled: DAY_LIMIT_ENABLED,
    is_automatic_notice_enabled: settings.is_automatic_notice_enabled,
    extra_stop_words: [...settings.extra_stop_words],
    is_comment_reply_trigger_enabled: settings.is_comment_reply_trigger_enabled,
    is_once_per_person_per_post_enabled: settings.is_once_per_person_per_post_enabled,
    is_mark_seen_after_reply_enabled: settings.is_mark_seen_after_reply_enabled,
    extra_delay_seconds_min: settings.extra_delay_seconds_min,
    extra_delay_seconds_max: settings.extra_delay_seconds_max,
    updated_by_user_id: updated_by_user_public_id,
    updated_at: settings.updated_at.toISOString(),
  };
}
