import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import type { ChannelFeature } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import type {
  ChannelAccountLanePort,
  ChannelFeatureCheckResult,
} from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import type { UpdateInstagramAccountSettingsInput } from './instagram-account-settings.dto.js';

/**
 * The limits the account's lanes use now (routes-final § 2.B.6 `effective_limits`): each owner
 * value, else the settings file's — the new-account opening limit included (D5).
 *
 * @remarks
 * `opening_day_limit` is `null` while the settings file's day limit is off (`DAY_LIMIT_ENABLED`).
 */
export interface InstagramAccountEffectiveLimitsOutput {
  opening_hour_limit: number;
  opening_day_limit: number | null;
  fast_hour_limit: number;
  person_hour_limit: number;
  broadcast_hour_limit: number;
}

/**
 * The Instagram account settings object (feat-instagram-dm-sending routes-final § 2.B.6) — route
 * 12's answer and the `settings` inside the channel account's `instagram` part (routes 7, 9–11).
 *
 * @remarks
 * Snake_case wire keys; each owner limit is the saved value or `null` (= the settings file's);
 * `updated_by_user_id` is the last editor's `usr_…` public id, `null` until someone changes the
 * settings (or once that user is deleted, K6). The launch's five public-reply fields are gone.
 */
export interface InstagramAccountSettingsOutput {
  /** The channel account's automation switch (P42) — nothing runs while it is off. */
  is_automation_enabled: boolean;
  opening_hour_limit: number | null;
  opening_day_limit: number | null;
  fast_hour_limit: number | null;
  person_hour_limit: number | null;
  broadcast_hour_limit: number | null;
  /** What the lanes use now. */
  effective_limits: InstagramAccountEffectiveLimitsOutput;
  /** Whether the opening day limit is read (the settings file's `DAY_LIMIT_ENABLED`). */
  is_day_limit_enabled: boolean;
  is_automatic_notice_enabled: boolean;
  /** The owner's stop words, lower case, added to the default ones. */
  extra_stop_words: string[];
  is_comment_reply_trigger_enabled: boolean;
  is_once_per_person_per_post_enabled: boolean;
  is_mark_seen_after_reply_enabled: boolean;
  /** 1–20 seconds, or `null` with its other end (the extra delay is off). */
  extra_delay_seconds_min: number | null;
  extra_delay_seconds_max: number | null;
  /** `usr_…` of the user who last changed the settings, or `null`. */
  updated_by_user_id: string | null;
  /** ISO 8601. */
  updated_at: string;
}

/**
 * The settings columns a route 12 save changes — the validated body without the automation switch
 * (the channel account's) and `expected_updated_at`; the ones left out keep their saved values.
 */
export type InstagramAccountSettingsChanges = Omit<
  UpdateInstagramAccountSettingsInput,
  'is_automation_enabled' | 'expected_updated_at'
>;

/** Input of `InstagramAccountSettingsService.updateSettings` (route 12, IA12–IA14). */
export interface InstagramAccountSettingsUpdateInput {
  /** The caller's organization scope (the signed `org` claim). */
  scope: OrganizationPrincipalDatabaseScope;
  /** `cha_…` of the account (the path's `{channel_account_id}`). */
  channelAccountPublicId: string;
  /** The settings columns to change. */
  changes: InstagramAccountSettingsChanges;
  /** The automation switch to set on the channel account, or `undefined` to keep it. */
  isAutomationEnabled: boolean | undefined;
  /** The settings' `updated_at` as the client read it, or `undefined` for no stale-save check. */
  expectedUpdatedAt: string | undefined;
  /** `usr_…` of the caller; `undefined` for an API-key principal. */
  updatedByUserPublicId: string | undefined;
}

/** One changed field of a save, for the audit entry (AC-3.11): its value before and after. */
export interface InstagramAccountSettingsFieldChange {
  old_value: unknown;
  new_value: unknown;
}

/** What route 12 answers, and the account and changes its audit entry names. */
export interface InstagramAccountSettingsUpdateResult {
  /** The settings as saved (2.B.6). */
  settings: InstagramAccountSettingsOutput;
  /** `cha_…` of the account whose settings changed. */
  channelAccountPublicId: string;
  /** Each field whose value changed, by its wire name — empty for a save that changed nothing. */
  changes: Record<string, InstagramAccountSettingsFieldChange>;
}

/**
 * What route 12 needs of the channel account (sub-domain 1B — P42, CA11), implemented by
 * `ChannelAccountService`. A port, because the channel account service already depends on the
 * settings service (the pick's empty row, the account object's settings).
 *
 * @remarks
 * Every method joins the caller's open unit of work.
 */
export interface InstagramAccountSettingsChannelAccountPort {
  /**
   * The organization's not-revoked Instagram account by its public id — `404
   * channel_account_not_found` when it is another organization's, revoked, missing or of another
   * channel.
   */
  requireLiveInstagramAccount(options: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    channelAccountPublicId: string;
  }): Promise<InstagramAccountSettingsChannelAccount>;
  /** Sets the account's automation switch (P42) in the caller's unit; returns the row as it stands. */
  setAutomationEnabled(
    options: ChannelAccountKey & {
      scope: OrganizationPrincipalDatabaseScope;
      isAutomationEnabled: boolean;
    },
  ): Promise<InstagramAccountSettingsChannelAccount>;
  /** The one feature check (CA11, P50). */
  canChannelAccountUseFeature(options: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    channelAccountId: number;
    feature: ChannelFeature;
  }): Promise<ChannelFeatureCheckResult>;
}

/** The channel account columns route 12 reads (P42, D5). */
export interface InstagramAccountSettingsChannelAccount {
  id: number;
  public_id: string;
  is_automation_enabled: boolean;
  connected_at: Date;
}

/**
 * The lane step a limit change takes after commit (IA14): the account's lanes get a new turn —
 * sub-domain 6's `InstagramSendLaneService.wakeLanes`, passed by the app container as the settings
 * service's fourth constructor argument (ROUTE row R18).
 */
export type InstagramAccountSettingsLanePort = Pick<ChannelAccountLanePort, 'wakeLanes'>;
