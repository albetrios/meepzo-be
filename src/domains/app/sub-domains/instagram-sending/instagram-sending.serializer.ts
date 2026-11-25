import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import type { PlanAccess } from '@/domains/billing/sub-domains/subscription/subscription.types.js';
import type { ChannelAccountRow } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import {
  CHANNEL_ACCOUNT_NEW_ACCOUNT_LIMIT_DAYS,
  type ChannelAccountPlanStopReason,
} from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import type { InstagramSendDayCounts } from './instagram-send-day-count.repository.js';
import type { InstagramSendLaneRow } from './instagram-send-lane.repository.js';
import type { InstagramSendStopRow } from './instagram-send-stop.repository.js';
import { planStopHoldsLane } from './instagram-send-lane.util.js';
import type { MessageMonthCountRead } from './message-month-count.repository.js';
import type { SendingStateRow } from './sending-state.repository.js';
import {
  APP_USAGE_TRIAL_ENDING_NOTICE_DAYS,
  type InstagramSendLane,
  type InstagramSendLaneState,
  type InstagramSendStopReason,
  type InstagramSendWaitReason,
  MESSAGE_MONTH_NEARLY_SHARE,
} from './instagram-sending.constants.js';
import type {
  AppUsageNoticeOutput,
  AppUsageOutput,
  DirectMessageMeterState,
  InstagramSendingStatusLaneOutput,
  InstagramSendingStatusOutput,
} from './instagram-sending.types.js';

/** An ISO timestamp, or `null`. */
function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** One lane of route 63, with the account's plan stop when its reason holds this lane (CA3). */
function serializeLane({
  lane,
  account,
  waitingCount,
  openStops,
}: {
  lane: InstagramSendLaneRow;
  account: ChannelAccountRow;
  waitingCount: number;
  openStops: readonly InstagramSendStopRow[];
}): InstagramSendingStatusLaneOutput {
  const name = lane.lane as InstagramSendLane;
  // The newest open history row of this stop — on this lane, or on `all` when it took every lane.
  const stopStart = openStops
    .filter(
      (stop) => stop.reason === lane.stop_reason && (stop.lane === name || stop.lane === 'all'),
    )
    .at(-1);
  const holdsPlanStop = planStopHoldsLane({
    planStopReason: account.plan_stop_reason,
    lane: name,
  });
  return {
    lane: name,
    state: lane.state as InstagramSendLaneState,
    waiting_count: waitingCount,
    wait_reason: lane.wait_reason as InstagramSendWaitReason | null,
    next_send_at: isoOrNull(lane.next_run_at),
    stop:
      lane.stop_reason === null
        ? null
        : {
            reason: lane.stop_reason as InstagramSendStopReason,
            until: isoOrNull(lane.stop_until),
            started_at: isoOrNull(stopStart?.started_at ?? null),
          },
    plan_stop: holdsPlanStop
      ? {
          reason: account.plan_stop_reason as ChannelAccountPlanStopReason,
          since: isoOrNull(account.plan_stopped_at),
        }
      : null,
  };
}

/**
 * Shapes route 63's Instagram sending status (routes-final § 6.A.6, SN14) from rows already read.
 *
 * @remarks
 * - `new_account_limit_until` is `connected_at` + 7 days while that is still ahead (D5), else `null`.
 * - Each lane's `stop` is its error stop, `started_at` from its open history row; `plan_stop` is the account's when its reason holds that
 *   lane (`plan_limit` lets the reply lane go on, D62).
 * - `all_accounts_stop` is the global row's stop while it has not ended.
 * - `estimate` is the slow lane's stored estimate (S29), `null` until its job has written one.
 * - Waiting counts, the "chat closed" lines and the last broadcast, past-comments and retry results
 *   come from the later rows' sources and default to zero / empty / `null`.
 */
export function serializeInstagramSendingStatus({
  account,
  lanes,
  openStops,
  today,
  waitingByLane,
  windowClosedByAutomation,
  lastBroadcast,
  lastBackfill,
  lastRetry,
  sendingState,
  now,
}: {
  account: ChannelAccountRow;
  lanes: readonly InstagramSendLaneRow[];
  openStops: readonly InstagramSendStopRow[];
  today: InstagramSendDayCounts;
  waitingByLane: Partial<Record<InstagramSendLane, number>>;
  windowClosedByAutomation: InstagramSendingStatusOutput['window_closed_by_automation'];
  lastBroadcast: InstagramSendingStatusOutput['last_broadcast'];
  lastBackfill: InstagramSendingStatusOutput['last_backfill'];
  lastRetry: InstagramSendingStatusOutput['last_retry'];
  sendingState: SendingStateRow | null;
  now: Date;
}): InstagramSendingStatusOutput {
  const limitEndsAt = new Date(
    account.connected_at.getTime() + CHANNEL_ACCOUNT_NEW_ACCOUNT_LIMIT_DAYS * MILLISECONDS_PER_DAY,
  );
  const slowLane = lanes.find((lane) => lane.lane === 'slow');
  const allStopUntil = sendingState?.all_stop_until ?? null;
  const isAllStopOn =
    sendingState?.all_stop_reason != null && (allStopUntil === null || allStopUntil > now);
  return {
    channel_account_id: account.public_id,
    is_paused: account.paused_at !== null,
    is_suspended: account.suspended_at !== null,
    new_account_limit_until: limitEndsAt > now ? limitEndsAt.toISOString() : null,
    lanes: lanes.map((lane) =>
      serializeLane({
        lane,
        account,
        waitingCount: waitingByLane[lane.lane as InstagramSendLane] ?? 0,
        openStops,
      }),
    ),
    all_accounts_stop: isAllStopOn
      ? { reason: sendingState?.all_stop_reason ?? '', until: isoOrNull(allStopUntil) }
      : null,
    estimate:
      slowLane?.estimated_at == null
        ? null
        : {
            waiting: slowLane.estimate_waiting_count ?? 0,
            will_go: slowLane.estimate_will_go_count ?? 0,
            may_expire: slowLane.estimate_may_expire_count ?? 0,
            done_at: isoOrNull(slowLane.estimate_done_at),
          },
    today: {
      sent: today.sent,
      unknown: today.unknown,
      skipped: today.skipped,
      skipped_window_closed: today.skippedWindowClosed,
      expired: today.expired,
    },
    window_closed_by_automation: windowClosedByAutomation,
    last_broadcast: lastBroadcast,
    last_backfill: lastBackfill,
    last_retry: lastRetry,
    as_of: now.toISOString(),
  };
}

/** The meter's state (SN15): `reached` at the limit, `nearly` from 80 %, else `ok`. */
function meterState({
  used,
  limit,
}: {
  used: number;
  limit: number | null;
}): DirectMessageMeterState {
  if (limit === null) return 'ok';
  if (used >= limit) return 'reached';
  return used >= limit * MESSAGE_MONTH_NEARLY_SHARE ? 'nearly' : 'ok';
}

/** A date's `YYYY-MM-DD` (UTC), or `null`. */
function dayOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/**
 * Shapes route 64's App usage (routes-final § 6.A.6, SN15) from the month, the plan and the count.
 *
 * @remarks
 * - `direct_messages.limit` is the plan's `message_month_limit` (`null` with no plan in the catalog);
 *   `state` `nearly` from 80 %, `reached` at 100 %.
 * - Notices, in this order: the limit nearly reached or reached (`ends_on` the reset day);
 *   `payment_failed` during a lapsed paid plan's grace (`ends_on` the grace's end); `plan_ended`
 *   while read-only; `trial_ending` while the trial ends within
 *   {@link APP_USAGE_TRIAL_ENDING_NOTICE_DAYS} days; `being_set_up` while the organization has no
 *   not-revoked channel account (plan §46 "Workspace being set up", ROUTE row R40). `paused` joins
 *   with the organization's suspend (R24).
 */
export function serializeAppUsage({
  month,
  limit,
  accounts,
  planAccess,
  hasLiveAccount,
  now,
}: {
  month: MessageMonthCountRead;
  limit: number | null;
  accounts: { used: number; maximum: number };
  planAccess: Pick<PlanAccess, 'state' | 'graceEndsAt' | 'trialEndsAt'>;
  /** Whether the organization has a not-revoked channel account (else `being_set_up`). */
  hasLiveAccount: boolean;
  now: Date;
}): AppUsageOutput {
  const state = meterState({ used: month.used, limit });
  const notices: AppUsageNoticeOutput[] = [];
  if (state === 'nearly') {
    notices.push({ kind: 'direct_message_limit_nearly', ends_on: month.resetsOn });
  }
  if (state === 'reached') {
    notices.push({ kind: 'direct_message_limit_reached', ends_on: month.resetsOn });
  }
  if (planAccess.state === 'grace') {
    notices.push({ kind: 'payment_failed', ends_on: dayOrNull(planAccess.graceEndsAt) });
  }
  if (planAccess.state === 'read_only') {
    notices.push({ kind: 'plan_ended', ends_on: null });
  }
  if (
    planAccess.trialEndsAt !== null &&
    planAccess.trialEndsAt > now &&
    planAccess.trialEndsAt.getTime() - now.getTime() <=
      APP_USAGE_TRIAL_ENDING_NOTICE_DAYS * MILLISECONDS_PER_DAY
  ) {
    notices.push({ kind: 'trial_ending', ends_on: dayOrNull(planAccess.trialEndsAt) });
  }
  if (!hasLiveAccount) notices.push({ kind: 'being_set_up', ends_on: null });
  return {
    direct_messages: { used: month.used, limit, resets_on: month.resetsOn, state },
    channel_accounts: accounts,
    notices,
  };
}
