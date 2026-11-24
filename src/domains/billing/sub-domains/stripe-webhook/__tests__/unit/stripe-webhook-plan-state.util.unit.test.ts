import { describe, expect, it } from 'vitest';
import {
  decideEndedPlanChange,
  decideSyncedPlanChange,
  isLiveSubscriptionStatus,
  isScheduledMoveApplied,
} from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook-plan-state.util.js';

const periodEnd = new Date('2026-12-01T00:00:00Z');

describe('stripe-webhook-plan-state.util (routes-final § 8.D BL22)', () => {
  describe('decideEndedPlanChange', () => {
    it('a row still trialing ends as trial_ended', () => {
      expect(
        decideEndedPlanChange({
          before: { status: 'TRIALING', trial_end: periodEnd, current_period_end: periodEnd },
          isScheduledPlanFree: false,
        }),
      ).toBe('trial_ended');
    });

    it('a row whose period never passed its trial end (never paid) ends as trial_ended', () => {
      expect(
        decideEndedPlanChange({
          before: { status: 'PAST_DUE', trial_end: periodEnd, current_period_end: periodEnd },
          isScheduledPlanFree: true,
        }),
      ).toBe('trial_ended');
    });

    it('a paid row with a scheduled move to Free ends as moved_down', () => {
      expect(
        decideEndedPlanChange({
          before: {
            status: 'ACTIVE',
            trial_end: new Date('2026-10-01T00:00:00Z'),
            current_period_end: periodEnd,
          },
          isScheduledPlanFree: true,
        }),
      ).toBe('moved_down');
    });

    it('any other paid row ends as plan_ended', () => {
      expect(
        decideEndedPlanChange({
          before: { status: 'ACTIVE', trial_end: null, current_period_end: periodEnd },
          isScheduledPlanFree: false,
        }),
      ).toBe('plan_ended');
    });
  });

  describe('decideSyncedPlanChange', () => {
    const base = { isScheduledMove: false, isCheaperPlan: false };

    it('the scheduled move applied is moved_down', () => {
      expect(
        decideSyncedPlanChange({
          ...base,
          before: { status: 'ACTIVE', plan_id: 2 },
          after: { status: 'ACTIVE', plan_id: 1 },
          isScheduledMove: true,
        }),
      ).toBe('moved_down');
    });

    it.each(['PAST_DUE', 'UNPAID'])('paid again from %s is resumed', (status) => {
      expect(
        decideSyncedPlanChange({
          ...base,
          before: { status, plan_id: 1 },
          after: { status: 'ACTIVE', plan_id: 1 },
        }),
      ).toBe('resumed');
    });

    it.each(['INCOMPLETE', 'PAUSED'])('paid for the first time from %s is upgraded', (status) => {
      expect(
        decideSyncedPlanChange({
          ...base,
          before: { status, plan_id: 1 },
          after: { status: 'ACTIVE', plan_id: 1 },
        }),
      ).toBe('upgraded');
    });

    it('another plan is upgraded, or moved_down when cheaper', () => {
      const before = { status: 'ACTIVE', plan_id: 1 };
      const after = { status: 'ACTIVE', plan_id: 2 };
      expect(decideSyncedPlanChange({ ...base, before, after })).toBe('upgraded');
      expect(decideSyncedPlanChange({ ...base, before, after, isCheaperPlan: true })).toBe(
        'moved_down',
      );
    });

    it('entering the grace and an unchanged row name no change', () => {
      expect(
        decideSyncedPlanChange({
          ...base,
          before: { status: 'ACTIVE', plan_id: 1 },
          after: { status: 'PAST_DUE', plan_id: 1 },
        }),
      ).toBeNull();
      expect(
        decideSyncedPlanChange({
          ...base,
          before: { status: 'TRIALING', plan_id: 1 },
          after: { status: 'ACTIVE', plan_id: 1 },
        }),
      ).toBeNull();
    });
  });

  describe('isScheduledMoveApplied', () => {
    it("is true only when Stripe's price is now the scheduled plan's", () => {
      const before = { plan_id: 2, scheduled_plan_id: 1 };
      expect(isScheduledMoveApplied({ before, resolvedPlanId: 1 })).toBe(true);
      expect(isScheduledMoveApplied({ before, resolvedPlanId: 2 })).toBe(false);
      expect(isScheduledMoveApplied({ before, resolvedPlanId: undefined })).toBe(false);
      expect(
        isScheduledMoveApplied({
          before: { plan_id: 2, scheduled_plan_id: null },
          resolvedPlanId: 1,
        }),
      ).toBe(false);
    });
  });

  it('isLiveSubscriptionStatus refuses only the terminal statuses', () => {
    expect(isLiveSubscriptionStatus('TRIALING')).toBe(true);
    expect(isLiveSubscriptionStatus('PAST_DUE')).toBe(true);
    expect(isLiveSubscriptionStatus('CANCELED')).toBe(false);
    expect(isLiveSubscriptionStatus('INCOMPLETE_EXPIRED')).toBe(false);
  });
});
