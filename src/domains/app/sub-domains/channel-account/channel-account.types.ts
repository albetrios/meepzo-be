import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { InstagramAccountSettingsOutput } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';
import type {
  ChannelAccountChannel,
  ChannelAccountPlanStopReason,
  ChannelAccountStatus,
} from './channel-account.constants.js';
import type {
  ChannelFeature,
  ChannelFeatureRefusalReason,
} from './channel-account-capabilities.constants.js';

/** The Channel account summary of route 6 (routes-final § 1B.6). */
export interface ChannelAccountSummaryOutput {
  /** `cha_…`. */
  id: string;
  channel: ChannelAccountChannel;
  display_name: string;
  /** From the Instagram extension. */
  profile_picture_url: string | null;
  connection_status: ChannelAccountStatus;
  /** `chc_…` of the connection the account came through. */
  channel_connection_id: string;
  is_paused: boolean;
  is_suspended: boolean;
  /** `false` while the account is "not in your plan" (`plan_downgrade`, D57). */
  is_in_plan: boolean;
  is_automation_enabled: boolean;
  /** Paused, suspended, plan-stopped or a lane stop holds it. */
  has_sending_stop: boolean;
  connected_at: string;
}

/** The stop that holds most of the account's lanes (1B.6 `active_stop`) — sub-domain 6's. */
export interface ChannelAccountActiveStopOutput {
  lane: string;
  reason: string;
  stop_until: string | null;
}

/**
 * The Instagram part of the Channel account (2.A.6) — the launch's columns until ROUTE row R6
 * reshapes the extension.
 */
export interface ChannelAccountInstagramOutput {
  instagram_user_id: string;
  username: string | null;
  profile_picture_url: string | null;
  followers_count: number;
  is_webhook_subscribed: boolean;
  profile_synced_at: string | null;
  settings: InstagramAccountSettingsOutput;
}

/** The Channel account object of routes 7, 9–11 (routes-final § 1B.6). */
export interface ChannelAccountOutput {
  id: string;
  channel: ChannelAccountChannel;
  display_name: string;
  connection_status: ChannelAccountStatus;
  channel_connection: { id: string; provider: string; status: string };
  is_automation_enabled: boolean;
  is_paused: boolean;
  paused_at: string | null;
  is_suspended: boolean;
  is_in_plan: boolean;
  plan_stop_reason: ChannelAccountPlanStopReason | null;
  plan_stopped_at: string | null;
  active_stop: ChannelAccountActiveStopOutput | null;
  /** `connected_at` + 7 days while that is ahead, else `null` (D5). */
  new_account_limit_ends_at: string | null;
  connected_by_user_id: string | null;
  connected_at: string;
  disconnected_at: string | null;
  /** The Instagram extension when `channel` is `instagram`, else `null`. */
  instagram: ChannelAccountInstagramOutput | null;
}

/** The organization scope and internal id every port call runs with. */
export interface ChannelAccountPortScope {
  /** The caller's organization scope; the port joins the caller's open unit of work. */
  scope: OrganizationPrincipalDatabaseScope;
  /** `tenancy.organizations.id` of the scope's organization. */
  organizationId: number;
}

/**
 * The lane steps of routes 8–11 (routes-final § 1B CA5, CA7–CA9) — the port of sub-domain 6's lane
 * service, built with `app.instagram_send_lanes` at ROUTE row R18. Until then the app container
 * passes none: no lane table exists, so there is nothing to stop, wake or read.
 */
export interface ChannelAccountLanePort {
  /** A disconnected or plan-stopped account's lanes stopped with no turn, in the caller's unit. */
  stopLanes(options: ChannelAccountPortScope & { channelAccountId: number }): Promise<void>;
  /**
   * After commit: each lane with waiting messages gets one turn again (route 10's resume, route 11's
   * activated account); fast tickets come back in pieces (SN).
   */
  wakeLanes(options: ChannelAccountPortScope & { channelAccountId: number }): Promise<void>;
  /** The stop holding most of the account's lanes, or `null`, in the caller's unit (1B.6). */
  readActiveStop(
    options: ChannelAccountPortScope & { channelAccountId: number },
  ): Promise<ChannelAccountActiveStopOutput | null>;
}

/**
 * Which organization-wide plan stop an activated account takes instead of `plan_downgrade` (CA9):
 * `plan_ended` while the organization's plan ended (sub-domain 8, ROUTE row R24), `plan_limit` while
 * it is at its month limit (sub-domain 6's month count, ROUTE row R18), else `null`. Until those rows
 * the app container passes none and the activated account has no plan stop.
 */
export interface ChannelAccountPlanStopPort {
  /** The organization's plan stop now, in the caller's unit. */
  readOrganizationPlanStop(
    options: ChannelAccountPortScope,
  ): Promise<Exclude<ChannelAccountPlanStopReason, 'plan_downgrade'> | null>;
}

/** The one feature check's answer (CA11 (2)): allowed, or the first failing reason. */
export type ChannelFeatureCheckResult =
  | { isAllowed: true }
  | { isAllowed: false; reason: ChannelFeatureRefusalReason };

/** One refusal of {@link ChannelFeatureCheckResult} for a whole automation or broadcast. */
export interface ChannelFeatureProblem {
  feature: ChannelFeature;
  reason: ChannelFeatureRefusalReason;
}

/** What routes 8–11 did, for the controller's audit entry (CA10, AC-2.11). */
export interface ChannelAccountChange {
  channelAccountPublicId: string;
  /** The changed field's value before the write. */
  oldValue: Record<string, unknown>;
  /** The changed field's value after the write. */
  newValue: Record<string, unknown>;
}
