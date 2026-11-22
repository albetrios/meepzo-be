import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';

/**
 * The Instagram account settings object (routes-final § 1.B.6): the automation switch and the
 * public reply safety, as route 2 nests it under the account and route 3 answers it.
 *
 * @remarks
 * Snake_case wire keys; `updated_by_user_id` is the last editor's `usr_…` public id, `null` until
 * someone changes the settings (or once that user is deleted, K6).
 */
export interface InstagramAccountSettingsOutput {
  /** The master switch — nothing runs while it is off. */
  is_automation_enabled: boolean;
  is_public_reply_safety_enabled: boolean;
  /** 0–100. */
  public_reply_chance_percent: number;
  /** 1–1000 public replies an hour. */
  public_reply_hour_limit: number;
  /** 5–3600 seconds, never above `public_reply_gap_max_seconds`. */
  public_reply_gap_min_seconds: number;
  /** 5–3600 seconds. */
  public_reply_gap_max_seconds: number;
  /** `usr_…` of the user who last changed the settings, or `null`. */
  updated_by_user_id: string | null;
  /** ISO 8601. */
  updated_at: string;
}

/**
 * The settings a route 3 save changes (routes-final § 1.B.8): any of the six, each already in range;
 * the ones left out keep their saved values.
 */
export interface InstagramAccountSettingsChanges {
  is_automation_enabled?: boolean | undefined;
  is_public_reply_safety_enabled?: boolean | undefined;
  public_reply_chance_percent?: number | undefined;
  public_reply_hour_limit?: number | undefined;
  public_reply_gap_min_seconds?: number | undefined;
  public_reply_gap_max_seconds?: number | undefined;
}

/** Input of `InstagramAccountSettingsService.updateSettings` (route 3, IA15). */
export interface InstagramAccountSettingsUpdateInput {
  /** The caller's organization scope (the signed `org` claim). */
  scope: OrganizationPrincipalDatabaseScope;
  /** The validated change — at least one setting. */
  changes: InstagramAccountSettingsChanges;
  /** The settings' `updated_at` as the client read it, or `undefined` for no stale-save check. */
  expectedUpdatedAt: string | undefined;
  /** `usr_…` of the caller; `undefined` for an API-key principal. */
  updatedByUserPublicId: string | undefined;
}

/** What route 3 answers, and the account its audit entry names. */
export interface InstagramAccountSettingsUpdateResult {
  /** The settings as saved (1.B.6). */
  settings: InstagramAccountSettingsOutput;
  /** `iga_…` of the account whose settings changed. */
  instagramAccountPublicId: string;
}
