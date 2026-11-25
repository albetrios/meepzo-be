import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { PlanFeatures } from '@/domains/billing/sub-domains/plan/plan.types.js';
import type { InstagramAccountExtensionOutput } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
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
  /** The Instagram extension (2.A.6) when `channel` is `instagram`, else `null`. */
  instagram: InstagramAccountExtensionOutput | null;
}

/** The organization scope and internal id every port call runs with. */
export interface ChannelAccountPortScope {
  /** The caller's organization scope; the port joins the caller's open unit of work. */
  scope: OrganizationPrincipalDatabaseScope;
  /** `tenancy.organizations.id` of the scope's organization. */
  organizationId: number;
}

/**
 * The lane steps of routes 8–11 and of the account's break (routes-final § 1B CA4, CA5, CA7–CA9) —
 * the port of sub-domain 6's lane service over `app.instagram_send_lanes`
 * (`InstagramSendLaneService`, ROUTE row R18), which the app container passes as the channel account
 * service's ninth constructor argument.
 */
export interface ChannelAccountLanePort {
  /**
   * A disconnected or plan-stopped account's lanes stopped with no turn, in the caller's unit; with
   * `planStopReason`, the plan stop the account just took is recorded in the stop history (lane
   * `all`, SN13).
   */
  stopLanes(
    options: ChannelAccountPortScope & {
      channelAccountId: number;
      planStopReason?: ChannelAccountPlanStopReason | undefined;
    },
  ): Promise<void>;
  /**
   * After commit: each lane with no error stop gets one turn again (route 10's resume, route 11's
   * activated account, route 12's limit change); a plan stop the account no longer holds is ended in
   * the history.
   */
  wakeLanes(options: ChannelAccountPortScope & { channelAccountId: number }): Promise<void>;
  /**
   * Records a plan stop the account just took in the stop history (lane `all`, SN13) without
   * touching its lanes, in the caller's unit — `plan_limit`, which holds the slow, fast and broadcast
   * lanes through the account's column while the reply lane goes on (D62). Optional: a unit test's
   * port may leave it out.
   */
  recordPlanStop?(
    options: ChannelAccountPortScope & {
      channelAccountId: number;
      planStopReason: ChannelAccountPlanStopReason;
    },
  ): Promise<void>;
  /** The stop holding most of the account's lanes, or `null`, in the caller's unit (1B.6). */
  readActiveStop(
    options: ChannelAccountPortScope & { channelAccountId: number },
  ): Promise<ChannelAccountActiveStopOutput | null>;
  /**
   * The break's stop (CA4, SN5), in the caller's unit: every lane of the account stopped until the
   * owner reconnects — `login_expired` for a token the provider refused, `account_not_shared` for an
   * account missing from the connection's assigned list. A reconnect ends it (MC6).
   */
  startBrokenAccountStop(
    options: ChannelAccountPortScope & {
      channelAccountId: number;
      reason: 'login_expired' | 'account_not_shared';
    },
  ): Promise<void>;
}

/**
 * Which organization-wide plan stop an activated account takes instead of `plan_downgrade` (CA9):
 * `plan_ended` while the organization's plan ended (sub-domain 8, ROUTE row R24), `plan_limit` while
 * it is at its month limit (sub-domain 6's month count — `MessageMonthCountService`, ROUTE row R18),
 * else `null` — `ChannelAccountPlanStopService` answers both, `plan_ended` first.
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

/**
 * A channel account as the automations read it (feat-instagram-dm-sending routes-final § 4.A — AU11,
 * AU13 checks 2 and the private-account warning, AU17's link): its ids, channel, status, its
 * connection's status, and the channel extension's username and privacy.
 */
export interface AutomationChannelAccount {
  id: number;
  /** `cha_…`. */
  public_id: string;
  channel: ChannelAccountChannel;
  connection_status: ChannelAccountStatus;
  /** `app.channel_connections.status` of its connection (`connected`, `error`, `revoked`). */
  channel_connection_status: string | null;
  /** The Instagram username (the `ig.me` link), `null` when unknown. */
  username: string | null;
  /** A private Instagram account gets no comment webhooks (the go-live warning). */
  is_private: boolean;
}

/**
 * A channel account as the run engine reads it once per event (feat-instagram-dm-sending § 4.B,
 * AU34 — channel-neutral): its organization and time zone (the once key's day), its status and
 * automation switch, and the account's automation rules — on Instagram the settings row's "replies
 * under comments" (D64) and "once per person per post" (D65) switches; `true` when no row exists.
 */
export interface AutomationRunChannelAccount {
  organizationId: number;
  id: number;
  /** `cha_…`. */
  public_id: string;
  channel: ChannelAccountChannel;
  connection_status: ChannelAccountStatus;
  is_automation_enabled: boolean;
  /** The organization's IANA time zone. */
  time_zone: string;
  is_comment_reply_trigger_enabled: boolean;
  is_once_per_person_per_post_enabled: boolean;
}

/** One part an automation uses that the account's feature check refuses (AU34, CA11). */
export interface ChannelAutomationPartProblem {
  /** `trigger_type`, `step`, `message_kind` or `feature`. */
  kind: 'trigger_type' | 'step' | 'message_kind' | 'feature';
  /** The part's value (`story_repost`, `follow`, `cards`, `email_ask`). */
  part: string;
  reason: ChannelFeatureRefusalReason;
}

/**
 * What the plan change (WC-37, WC-38 — ROUTE row R52) asks of the organization's accounts: the
 * accounts the owner kept on a move down, and whether accounts "not in your plan" may come back (a
 * move up). The plan's account limit is read by the service (billing's plan read).
 */
export interface ChannelAccountPlanStopsInput {
  /** The organization's job scope. */
  scope: OrganizationPrincipalDatabaseScope;
  /** `cha_…` ids kept on a move down or a trial end (BL6) — `null` keeps the oldest connected. */
  keptChannelAccountPublicIds: readonly string[] | null;
  /** `true` on a move up (upgraded, resumed, trial started): `plan_downgrade` accounts fill the limit. */
  mayActivate: boolean;
}

/** One account whose plan stop the plan change moved — its keys and the stop before and after. */
export interface ChannelAccountPlanStopMove {
  channelAccountId: number;
  channelAccountPublicId: string;
  from: ChannelAccountPlanStopReason | null;
  to: ChannelAccountPlanStopReason | null;
}

/** What `ChannelAccountService.applyOrganizationPlanStops` did (WC-37, WC-38). */
export interface ChannelAccountPlanStopsResult {
  /** `tenancy.organizations.id` of the scope's organization. */
  organizationId: number;
  /** The plan's typed features read for the change (`null` when the catalog has no plan to read). */
  features: PlanFeatures | null;
  /** The name of the plan whose features apply (`null` with no plan in the catalog) — the move down's notice. */
  planName: string | null;
  /** The accounts whose plan stop moved. */
  moves: ChannelAccountPlanStopMove[];
}
