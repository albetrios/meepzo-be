import { describe, expect, it } from 'vitest';
import {
  type PlanStateCheckRow,
  buildPlanChoiceDedupeKey,
  buildTrialEndingDedupeKey,
  decidePlanStateCheckFindings,
} from '@/domains/billing/sub-domains/subscription/subscription-plan-state.util.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-25T12:00:00.000Z');

function row(overrides: Partial<PlanStateCheckRow> = {}): PlanStateCheckRow {
  return {
    publicId: 'sub_aaaaaaaaaaaaaaaaaaaaa',
    status: 'ACTIVE',
    currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
    trialEnd: null,
    planPublicId: 'pln_aaaaaaaaaaaaaaaaaaaaa',
    isPlanActive: true,
    ...overrides,
  };
}

const decide = (overrides: Partial<PlanStateCheckRow>, now = NOW) =>
  decidePlanStateCheckFindings({ row: row(overrides), now, dunningGraceDays: 14 });

/**
 * feat-instagram-dm-sending ROUTE row R52 — routes-final § 8.B BL17, BL24 (WC-59): what the
 * plan-state check finds on one subscription.
 */
describe('decidePlanStateCheckFindings (BL17, BL24)', () => {
  it('finds nothing on a live paid plan', () => {
    expect(decide({})).toEqual([]);
  });

  it('finds a grace that ended 14 days after the period end, keyed by that period end', () => {
    const periodEnd = new Date(NOW.getTime() - 15 * DAY);
    expect(decide({ status: 'PAST_DUE', currentPeriodEnd: periodEnd })).toEqual([
      { kind: 'grace_ended', periodEnd },
    ]);
    expect(decide({ status: 'UNPAID', currentPeriodEnd: periodEnd })).toEqual([
      { kind: 'grace_ended', periodEnd },
    ]);
  });

  it('does not find a grace still running, nor one that ended more than 7 days ago', () => {
    expect(
      decide({ status: 'PAST_DUE', currentPeriodEnd: new Date(NOW.getTime() - 13 * DAY) }),
    ).toEqual([]);
    expect(
      decide({ status: 'PAST_DUE', currentPeriodEnd: new Date(NOW.getTime() - 22 * DAY) }),
    ).toEqual([]);
  });

  it('gives a trial the 3-day notice, then the 1-day notice, and nothing before or after', () => {
    const at = (hoursLeft: number) =>
      decide({
        status: 'TRIALING',
        trialEnd: new Date(NOW.getTime() + hoursLeft * 60 * 60 * 1000),
      });
    expect(at(80)).toEqual([]);
    expect(at(72)).toEqual([{ kind: 'trial_notice', days: 3 }]);
    expect(at(30)).toEqual([{ kind: 'trial_notice', days: 3 }]);
    expect(at(24)).toEqual([{ kind: 'trial_notice', days: 1 }]);
    expect(at(1)).toEqual([{ kind: 'trial_notice', days: 1 }]);
    expect(at(-1)).toEqual([]);
  });

  it('finds a live subscription on a switched-off plan row; an ended one is not found', () => {
    expect(decide({ isPlanActive: false })).toEqual([{ kind: 'legacy_plan' }]);
    expect(decide({ isPlanActive: false, status: 'CANCELED' })).toEqual([]);
  });

  it('builds the notices once keys per subscription (P88)', () => {
    expect(buildTrialEndingDedupeKey({ subscriptionPublicId: 'sub_x', days: 3 })).toBe(
      'trial-ending:sub_x:3',
    );
    expect(buildPlanChoiceDedupeKey('sub_x')).toBe('plan-choice:sub_x');
  });
});
