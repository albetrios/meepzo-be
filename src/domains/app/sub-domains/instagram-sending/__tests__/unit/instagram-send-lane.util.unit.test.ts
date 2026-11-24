import { describe, expect, it } from 'vitest';
import {
  listLaneHolds,
  pickActiveStop,
  planStopHoldsLane,
} from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.util.js';

const FREE_ACCOUNT = { paused_at: null, suspended_at: null, plan_stop_reason: null };

/** A lane row's stop fields. */
function lane(name: string, stopReason: string | null = null, stopUntil: Date | null = null) {
  return { lane: name, stop_reason: stopReason, stop_until: stopUntil };
}

/**
 * The lane holds (feat-instagram-dm-sending routes-final § 6.A SN9, SN12, CA3, D62) and the active
 * stop of 1B.6: which of the account's pause, suspend, plan stop and the lane's error stop hold a
 * lane, and the stop route 6–7 show.
 */
describe('the lane holds and the active stop', () => {
  it('plan_limit holds slow, fast and broadcast and lets the reply lane go on (D62)', () => {
    expect(planStopHoldsLane({ planStopReason: 'plan_limit', lane: 'slow' })).toBe(true);
    expect(planStopHoldsLane({ planStopReason: 'plan_limit', lane: 'fast' })).toBe(true);
    expect(planStopHoldsLane({ planStopReason: 'plan_limit', lane: 'broadcast' })).toBe(true);
    expect(planStopHoldsLane({ planStopReason: 'plan_limit', lane: 'reply' })).toBe(false);
  });

  it.each(['plan_ended', 'plan_downgrade'])('%s holds all four lanes', (reason) => {
    for (const name of ['slow', 'reply', 'fast', 'broadcast'] as const) {
      expect(planStopHoldsLane({ planStopReason: reason, lane: name })).toBe(true);
    }
  });

  it('a plan stop on the account and an error stop on the lane both hold (SN9)', () => {
    const holds = listLaneHolds({
      lane: lane('slow', 'too_fast', new Date('2026-11-24T10:15:00Z')),
      account: { ...FREE_ACCOUNT, plan_stop_reason: 'plan_limit' },
    });
    expect(holds.map((hold) => hold.kind)).toEqual(['plan_stop', 'error_stop']);
  });

  it('a suspend and a pause hold every lane, the suspend first', () => {
    const holds = listLaneHolds({
      lane: lane('reply'),
      account: { ...FREE_ACCOUNT, paused_at: new Date(), suspended_at: new Date() },
    });
    expect(holds.map((hold) => hold.kind)).toEqual(['suspended', 'paused']);
  });

  it('a free lane of a free account has no hold', () => {
    expect(listLaneHolds({ lane: lane('fast'), account: FREE_ACCOUNT })).toEqual([]);
  });

  it('the active stop is the reason on the most lanes, `all` when it holds every lane', () => {
    expect(pickActiveStop([lane('slow'), lane('reply'), lane('fast'), lane('broadcast')])).toBe(
      null,
    );
    expect(
      pickActiveStop([
        lane('slow', 'login_expired'),
        lane('reply', 'login_expired'),
        lane('fast', 'login_expired'),
        lane('broadcast', 'login_expired'),
      ]),
    ).toEqual({ lane: 'all', reason: 'login_expired', stop_until: null });
    const until = new Date('2026-11-24T11:00:00Z');
    expect(
      pickActiveStop([
        lane('slow', 'too_fast', new Date('2026-11-24T10:30:00Z')),
        lane('reply', 'too_fast', until),
        lane('fast', 'blocked', null),
        lane('broadcast'),
      ]),
    ).toEqual({ lane: 'slow', reason: 'too_fast', stop_until: until.toISOString() });
  });

  it('a tie goes to the stronger group', () => {
    expect(
      pickActiveStop([
        lane('slow', 'too_fast', new Date()),
        lane('fast', 'blocked', new Date()),
        lane('reply'),
        lane('broadcast'),
      ])?.reason,
    ).toBe('blocked');
  });
});
