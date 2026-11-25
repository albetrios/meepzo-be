import { describe, expect, it } from 'vitest';
import { computeInstagramWaitingEstimate } from '@/domains/app/sub-domains/instagram-sending/instagram-send-estimate.util.js';

const NOW = new Date('2026-11-25T10:00:00.000Z');

/** The plan's worked example (§12.3): 3,000 waiting, limit 300, 300 new in the last hour, urgent. */
const WORKED_EXAMPLE = new Map([
  [1, 200],
  [3, 300],
  [6, 200],
  [12, 300],
  [168, 2000],
]);

/**
 * The "will go / may expire" estimate (feat-instagram-dm-sending WC-24, D10, plan §12.3 — ROUTE row
 * R48, AC-17.24).
 */
describe('computeInstagramWaitingEstimate', () => {
  it("answers the plan's worked example: 140 may expire, 2,860 will go", () => {
    const estimate = computeInstagramWaitingEstimate({
      now: NOW,
      waitingByHoursLeft: WORKED_EXAMPLE,
      hourLimit: 300,
      newOpeningMessagesLastHour: 300,
      stop: { kind: 'none' },
      lastExpiresAt: null,
    });
    expect(estimate).toMatchObject({ waitingCount: 3000, willGoCount: 2860, mayExpireCount: 140 });
    // 2,860 at 120 an hour: done in about 23.8 hours.
    expect((estimate.doneAt!.getTime() - NOW.getTime()) / 3_600_000).toBeCloseTo(2860 / 120, 5);
  });

  it('nothing goes before a known stop ends: everything expiring within it may expire', () => {
    const estimate = computeInstagramWaitingEstimate({
      now: NOW,
      waitingByHoursLeft: WORKED_EXAMPLE,
      hourLimit: 300,
      newOpeningMessagesLastHour: 300,
      stop: { kind: 'until', until: new Date(NOW.getTime() + 30 * 3_600_000) },
      lastExpiresAt: null,
    });
    expect(estimate.mayExpireCount).toBeGreaterThanOrEqual(1000);
    expect(estimate.willGoCount + estimate.mayExpireCount).toBe(3000);
  });

  it('under a stop with no end, nothing will go and done is the last expiry', () => {
    const lastExpiresAt = new Date(NOW.getTime() + 100 * 3_600_000);
    expect(
      computeInstagramWaitingEstimate({
        now: NOW,
        waitingByHoursLeft: new Map([[100, 5]]),
        hourLimit: 600,
        newOpeningMessagesLastHour: 0,
        stop: { kind: 'endless' },
        lastExpiresAt,
      }),
    ).toEqual({ waitingCount: 5, willGoCount: 0, mayExpireCount: 5, doneAt: lastExpiresAt });
  });

  it('answers zeros with nothing waiting', () => {
    expect(
      computeInstagramWaitingEstimate({
        now: NOW,
        waitingByHoursLeft: new Map(),
        hourLimit: 600,
        newOpeningMessagesLastHour: 0,
        stop: { kind: 'none' },
        lastExpiresAt: null,
      }),
    ).toEqual({ waitingCount: 0, willGoCount: 0, mayExpireCount: 0, doneAt: null });
  });

  it('uses the old share 1/5 without an urgent DM, so a busy hour still moves the old line', () => {
    const estimate = computeInstagramWaitingEstimate({
      now: NOW,
      waitingByHoursLeft: new Map([[20, 200]]),
      hourLimit: 600,
      newOpeningMessagesLastHour: 600,
      stop: { kind: 'none' },
      lastExpiresAt: null,
    });
    // 120 an hour for 20 hours: all 200 go.
    expect(estimate).toMatchObject({ willGoCount: 200, mayExpireCount: 0 });
  });
});
