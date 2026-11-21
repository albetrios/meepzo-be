import type { InstagramAccountSettingsOutput } from './instagram-account-settings.types.js';

/**
 * Maps an `app.instagram_account_settings` row to the public settings object (routes-final
 * § 1.B.6) — nested under the account by route 2, answered by route 3 (R4).
 *
 * @remarks
 * - **Algorithm:** copies the six setting columns, swaps the internal `updated_by_user_id` for the
 *   caller-resolved `usr_…` public id, and writes `updated_at` as ISO 8601. Every key is named — no
 *   row spread, so a column added later never reaches the wire unreviewed.
 * - **Failure modes:** none — a pure mapping.
 * - **Side effects:** none.
 * - **Notes:** the internal ids (`id`, `organization_id`, `instagram_account_id`) never leave.
 */
export function serializeInstagramAccountSettings({
  settings,
  updated_by_user_public_id,
}: {
  settings: {
    is_automation_enabled: boolean;
    is_public_reply_safety_enabled: boolean;
    public_reply_chance_percent: number;
    public_reply_hour_limit: number;
    public_reply_gap_min_seconds: number;
    public_reply_gap_max_seconds: number;
    updated_at: Date;
  };
  /** `usr_…` of the row's `updated_by_user_id`, or `null` when it has none. */
  updated_by_user_public_id: string | null;
}): InstagramAccountSettingsOutput {
  return {
    is_automation_enabled: settings.is_automation_enabled,
    is_public_reply_safety_enabled: settings.is_public_reply_safety_enabled,
    public_reply_chance_percent: settings.public_reply_chance_percent,
    public_reply_hour_limit: settings.public_reply_hour_limit,
    public_reply_gap_min_seconds: settings.public_reply_gap_min_seconds,
    public_reply_gap_max_seconds: settings.public_reply_gap_max_seconds,
    updated_by_user_id: updated_by_user_public_id,
    updated_at: settings.updated_at.toISOString(),
  };
}
