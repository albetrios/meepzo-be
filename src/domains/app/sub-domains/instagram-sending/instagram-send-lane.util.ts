import type { ChannelAccountActiveStopOutput } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import type { ChannelAccountPlanStopReason } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import type { InstagramSendLaneRow } from './instagram-send-lane.repository.js';
import {
  INSTAGRAM_SEND_LANES,
  INSTAGRAM_SEND_STOP_STRENGTH,
  type InstagramSendLane,
  type InstagramSendStopReason,
  PLAN_STOP_HELD_LANES,
} from './instagram-sending.constants.js';
import type {
  InstagramSendLaneAccountState,
  InstagramSendLaneHold,
} from './instagram-sending.types.js';

/** Whether `reason` is one of the channel account's plan stops. */
function isPlanStopReason(reason: string | null): reason is ChannelAccountPlanStopReason {
  return reason !== null && reason in PLAN_STOP_HELD_LANES;
}

/**
 * Whether the account's plan stop holds this lane (CA3, D62, P99): `plan_limit` holds slow, fast and
 * broadcast and lets the reply lane go on; `plan_ended` and `plan_downgrade` hold all four.
 */
export function planStopHoldsLane({
  planStopReason,
  lane,
}: {
  planStopReason: string | null;
  lane: InstagramSendLane;
}): boolean {
  return isPlanStopReason(planStopReason) && PLAN_STOP_HELD_LANES[planStopReason].includes(lane);
}

/**
 * Everything that holds one lane now, in the order a turn checks them (SN9, SN12, plan §33.2 rule
 * 4): the team's suspend, the owner's pause, the account's plan stop, the lane's error stop. A plan
 * stop and an error stop both hold at once — both must end before the lane sends.
 *
 * @remarks
 * Pure: reads the lane row and the account's fields only. An error stop whose `stop_until` has
 * passed still holds until it is ended (the repair ends it, WC-13) — `now` is not read.
 */
export function listLaneHolds({
  lane,
  account,
}: {
  lane: Pick<InstagramSendLaneRow, 'lane' | 'stop_reason' | 'stop_until'>;
  account: InstagramSendLaneAccountState;
}): InstagramSendLaneHold[] {
  const holds: InstagramSendLaneHold[] = [];
  if (account.suspended_at !== null) holds.push({ kind: 'suspended' });
  if (account.paused_at !== null) holds.push({ kind: 'paused' });
  if (
    isPlanStopReason(account.plan_stop_reason) &&
    planStopHoldsLane({
      planStopReason: account.plan_stop_reason,
      lane: lane.lane as InstagramSendLane,
    })
  ) {
    holds.push({ kind: 'plan_stop', reason: account.plan_stop_reason });
  }
  if (lane.stop_reason !== null) {
    holds.push({
      kind: 'error_stop',
      reason: lane.stop_reason as InstagramSendStopReason,
      until: lane.stop_until,
    });
  }
  return holds;
}

/**
 * The error stop holding most of the account's lanes (1B.6 `active_stop`), or `null` when no lane
 * holds one: the reason on the most lanes (a tie goes to the stronger group); `lane` is `all` when
 * it holds every lane, else the first lane it holds; `stop_until` is the latest end, or `null` when
 * one of them waits for the owner.
 */
export function pickActiveStop(
  lanes: readonly Pick<InstagramSendLaneRow, 'lane' | 'stop_reason' | 'stop_until'>[],
): ChannelAccountActiveStopOutput | null {
  const byReason = new Map<InstagramSendStopReason, typeof lanes>();
  for (const lane of lanes) {
    if (lane.stop_reason === null) continue;
    const reason = lane.stop_reason as InstagramSendStopReason;
    byReason.set(reason, [...(byReason.get(reason) ?? []), lane]);
  }
  let best: { reason: InstagramSendStopReason; lanes: typeof lanes } | null = null;
  for (const [reason, held] of byReason) {
    if (
      best === null ||
      held.length > best.lanes.length ||
      (held.length === best.lanes.length &&
        INSTAGRAM_SEND_STOP_STRENGTH[reason] > INSTAGRAM_SEND_STOP_STRENGTH[best.reason])
    ) {
      best = { reason, lanes: held };
    }
  }
  if (best === null) return null;
  const ordered = [...best.lanes].sort(
    (left, right) =>
      INSTAGRAM_SEND_LANES.indexOf(left.lane as InstagramSendLane) -
      INSTAGRAM_SEND_LANES.indexOf(right.lane as InstagramSendLane),
  );
  const isEveryLane = ordered.length === INSTAGRAM_SEND_LANES.length;
  const hasOpenEnd = ordered.some((lane) => lane.stop_until === null);
  const latestEnd = hasOpenEnd
    ? null
    : ordered.reduce<Date | null>(
        (latest, lane) =>
          lane.stop_until !== null && (latest === null || lane.stop_until > latest)
            ? lane.stop_until
            : latest,
        null,
      );
  return {
    lane: isEveryLane ? 'all' : (ordered[0]?.lane ?? 'all'),
    reason: best.reason,
    stop_until: latestEnd === null ? null : latestEnd.toISOString(),
  };
}
