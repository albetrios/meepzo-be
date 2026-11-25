import { describe, expect, it } from 'vitest';
import {
  buildOwnerProblemDedupeKey,
  decideOwnerProblems,
} from '@/domains/app/sub-domains/instagram-sending/workers/instagram-owner-problem-email.processor.js';
import { decideMessageMonthLine } from '@/domains/app/sub-domains/instagram-sending/message-month-notice.service.js';

const MINUTE = 60 * 1000;
const now = new Date('2026-11-25T12:00:00Z');
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE);

function stop(reason: string, startedMinutesAgo: number, endedMinutesAgo: number | null = null) {
  return {
    organizationPublicId: 'org_ownerproblemtest00001',
    channelAccountPublicId: 'cha_ownerproblemtest00001',
    displayName: '@acme.shop',
    reason,
    startedAt: at(startedMinutesAgo),
    endedAt: endedMinutesAgo === null ? null : at(endedMinutesAgo),
  };
}

/** The owners' problem emails' decision (WC-57, AC-10.6) and the month lines (WC-56) — pure. */
describe('owner problem emails and month lines (R53)', () => {
  it('tells a block at once, once in 6 hours for every lane row and a second block', () => {
    const told = decideOwnerProblems({
      stops: [stop('blocked', 5), stop('blocked', 5), stop('blocked', 2)],
      now,
    });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ kind: 'blocked', username: 'acme.shop' });
    expect(buildOwnerProblemDedupeKey(told[0]!)).toBe(
      `owner-problem:cha_ownerproblemtest00001:blocked:${String(at(5).getTime())}`,
    );
  });

  it('tells a block again after 6 hours', () => {
    const told = decideOwnerProblems({
      stops: [stop('blocked', 7 * 60), stop('blocked', 10)],
      now,
    });
    expect(told.map((problem) => problem.dueAt)).toEqual([at(10)]);
  });

  it('tells another stop only after an hour, never one that ended before, never login or month stops', () => {
    expect(decideOwnerProblems({ stops: [stop('too_fast', 30)], now })).toEqual([]);
    expect(decideOwnerProblems({ stops: [stop('too_fast', 90, 40)], now })).toEqual([]);
    expect(decideOwnerProblems({ stops: [stop('too_fast', 61)], now })[0]?.kind).toBe('long_stop');
    expect(
      decideOwnerProblems({ stops: [stop('login_expired', 120), stop('plan_limit', 120)], now }),
    ).toEqual([]);
    expect(
      decideOwnerProblems({
        stops: [
          stop('access_off', 1),
          stop('plan_ended', 1),
          stop('plan_downgrade', 1),
          stop('wrong_permission', 1),
        ],
        now,
      }).map((problem) => problem.kind),
    ).toEqual(['message_access_off', 'plan_ended', 'plan_switch_off', 'connection_stopped']);
  });

  it('decides the highest month line only', () => {
    expect(decideMessageMonthLine({ used: 799, limit: 1000 })).toBeNull();
    expect(decideMessageMonthLine({ used: 800, limit: 1000 })).toBe(80);
    expect(decideMessageMonthLine({ used: 1000, limit: 1000 })).toBe(100);
    expect(decideMessageMonthLine({ used: 5000, limit: null })).toBeNull();
  });
});
