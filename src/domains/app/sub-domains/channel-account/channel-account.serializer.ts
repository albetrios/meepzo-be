import type { InstagramAccountExtensionOutput } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import type { ChannelAccountRow } from './channel-account.repository.js';
import {
  CHANNEL_ACCOUNT_NEW_ACCOUNT_LIMIT_DAYS,
  CHANNEL_ACCOUNT_PLAN_STOP_REASON,
  type ChannelAccountChannel,
  type ChannelAccountPlanStopReason,
  type ChannelAccountStatus,
} from './channel-account.constants.js';
import type {
  ChannelAccountActiveStopOutput,
  ChannelAccountOutput,
  ChannelAccountSummaryOutput,
} from './channel-account.types.js';
import type { InstagramMessageAccessOutput } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';

/** A timestamp as ISO 8601, `null` kept. */
function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** `false` while the account is "not in your plan" (`plan_downgrade`, CA3, D57). */
function isInPlan(account: ChannelAccountRow): boolean {
  return account.plan_stop_reason !== CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_DOWNGRADE;
}

/**
 * The Channel account summary of route 6 (routes-final § 1B.6): the account menu's row.
 *
 * @remarks
 * - **Algorithm:** names every key (no row spread); `has_sending_stop` is the pause, the suspend,
 *   the plan stop or a lane stop the caller read (`hasLaneStop`).
 * - **Failure modes:** none — a pure mapping. **Side effects:** none.
 * - **Notes:** internal ids never leave; the connection is named by its `chc_…` id.
 */
export function serializeChannelAccountSummary({
  account,
  channel_connection_public_id,
  profile_picture_url,
  has_lane_stop,
  instagram_message_access = null,
}: {
  account: ChannelAccountRow;
  channel_connection_public_id: string;
  /** From the Instagram extension, `null` when it has none. */
  profile_picture_url: string | null;
  /** The Instagram extension's last message-access answer (feat-meta-connect-flow IG4), or `null`. */
  instagram_message_access?: InstagramMessageAccessOutput | null;
  /** A lane stop holds the account (sub-domain 6) — `false` until the lanes exist (R18). */
  has_lane_stop: boolean;
}): ChannelAccountSummaryOutput {
  return {
    id: account.public_id,
    channel: account.channel as ChannelAccountChannel,
    display_name: account.display_name,
    profile_picture_url,
    connection_status: account.connection_status as ChannelAccountStatus,
    channel_connection_id: channel_connection_public_id,
    is_paused: account.paused_at !== null,
    is_suspended: account.suspended_at !== null,
    is_in_plan: isInPlan(account),
    is_automation_enabled: account.is_automation_enabled,
    has_sending_stop:
      account.paused_at !== null ||
      account.suspended_at !== null ||
      account.plan_stop_reason !== null ||
      has_lane_stop,
    connected_at: account.connected_at.toISOString(),
    instagram:
      instagram_message_access === null ? null : { message_access: instagram_message_access },
  };
}

/**
 * The Channel account object of routes 7, 9–11 (routes-final § 1B.6).
 *
 * @remarks
 * - **Algorithm:** names every key; `is_paused` / `is_suspended` / `is_in_plan` from the row;
 *   `new_account_limit_ends_at` is `connected_at` + 7 days while that is still ahead (D5);
 *   `active_stop` is the lane service's answer the caller read in the same unit.
 * - **Failure modes:** none — a pure mapping. **Side effects:** none.
 * - **Notes:** never a token; the launch's `access_expires_at` and `scopes` are gone (1B.6).
 */
export function serializeChannelAccount({
  account,
  channel_connection,
  connected_by_user_public_id,
  active_stop,
  instagram,
  now,
}: {
  account: ChannelAccountRow;
  channel_connection: { id: string; provider: string; status: string };
  connected_by_user_public_id: string | null;
  active_stop: ChannelAccountActiveStopOutput | null;
  /** The Instagram part, built by `serializeInstagramAccountExtension` (2.A.6). */
  instagram: InstagramAccountExtensionOutput | null;
  /** The clock the new-account window is read against. */
  now: Date;
}): ChannelAccountOutput {
  const limitEndsAt = new Date(
    account.connected_at.getTime() + CHANNEL_ACCOUNT_NEW_ACCOUNT_LIMIT_DAYS * MILLISECONDS_PER_DAY,
  );
  return {
    id: account.public_id,
    channel: account.channel as ChannelAccountChannel,
    display_name: account.display_name,
    connection_status: account.connection_status as ChannelAccountStatus,
    channel_connection,
    is_automation_enabled: account.is_automation_enabled,
    is_paused: account.paused_at !== null,
    paused_at: toIsoOrNull(account.paused_at),
    is_suspended: account.suspended_at !== null,
    is_in_plan: isInPlan(account),
    plan_stop_reason: account.plan_stop_reason as ChannelAccountPlanStopReason | null,
    plan_stopped_at: toIsoOrNull(account.plan_stopped_at),
    active_stop,
    new_account_limit_ends_at: limitEndsAt > now ? limitEndsAt.toISOString() : null,
    connected_by_user_id: connected_by_user_public_id,
    connected_at: account.connected_at.toISOString(),
    disconnected_at: toIsoOrNull(account.disconnected_at),
    instagram,
  };
}
