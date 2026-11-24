import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '@/shared/config/env.config.js';
import {
  isDunningEntitlementLapsed,
  requiresFreeSeatCeiling,
  resolvePlanAccess,
} from '@/domains/billing/sub-domains/subscription/subscription-entitlement.util.js';
import type {
  PlanAccessPlan,
  PlanAccessSubject,
} from '@/domains/billing/sub-domains/subscription/subscription.types.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
  STUDIO_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-17T10:00:00.000Z');
const LAPSE_GRACE_DAYS = 14;

const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);
const daysAfter = (base: Date, days: number): Date => new Date(base.getTime() + days * DAY);

const FREE_PLAN: PlanAccessPlan = {
  public_id: 'pln_free',
  name: 'Free',
  price_monthly: '0.00',
  price_yearly: '0.00',
  features: FREE_PLAN_FEATURES,
};
const CREATOR_PLAN: PlanAccessPlan = {
  public_id: 'pln_creator',
  name: 'Creator',
  price_monthly: '29.00',
  price_yearly: '276.00',
  features: CREATOR_PLAN_FEATURES,
};
/** A switched-off old row: paid, but its features are Free's (P80). */
const GROWTH_PLAN: PlanAccessPlan = {
  public_id: 'pln_growth',
  name: 'Growth',
  price_monthly: '30.00',
  price_yearly: '300.00',
  features: FREE_PLAN_FEATURES,
};

const ON_FREE = { plan: { publicId: 'pln_free', name: 'Free' }, features: FREE_PLAN_FEATURES };
const ON_CREATOR = {
  plan: { publicId: 'pln_creator', name: 'Creator' },
  features: CREATOR_PLAN_FEATURES,
};

function organizationSubject(
  options: {
    type?: 'TEAM' | 'PERSONAL';
    subscription?: PlanAccessSubject['subscription'];
    freePlan?: PlanAccessPlan | null;
  } = {},
): PlanAccessSubject {
  return {
    organization: { type: options.type ?? 'TEAM' },
    subscription: options.subscription ?? null,
    freePlan: options.freePlan === undefined ? FREE_PLAN : options.freePlan,
  };
}

function subscription(options: {
  status: string;
  periodEndDaysAgo: number;
  plan?: PlanAccessPlan | null;
  trialEnd?: Date | null;
}): NonNullable<PlanAccessSubject['subscription']> {
  return {
    status: options.status,
    current_period_end: daysAgo(options.periodEndDaysAgo),
    trial_end: options.trialEnd ?? null,
    plan: options.plan === undefined ? CREATOR_PLAN : options.plan,
  };
}

const decide = (subject: PlanAccessSubject | null, isReadOnlyEnforced = true) =>
  resolvePlanAccess({ subject, now: NOW, isReadOnlyEnforced });

/**
 * The plan entitlement (owner decision D3; routes-final BL2, BL3 — plan:L7966–L7973): Free never
 * ends; a paid plan is active; a lapsed paid plan has its dunning grace then read-only; a cancelled
 * paid plan is read-only from its period end; the features always come from the plan that applies.
 */
describe('resolvePlanAccess — the plan entitlement (D3, BL2, BL3)', () => {
  const originalLapseGrace = env.BILLING_DUNNING_GRACE_DAYS;
  beforeAll(() => {
    env.BILLING_DUNNING_GRACE_DAYS = LAPSE_GRACE_DAYS;
  });
  afterAll(() => {
    env.BILLING_DUNNING_GRACE_DAYS = originalLapseGrace;
  });

  const activeOn = (entitlement: typeof ON_FREE, trialEndsAt: Date | null = null) => ({
    state: 'active',
    graceEndsAt: null,
    trialEndsAt,
    ...entitlement,
  });

  it('Free never ends: a TEAM organization with no subscription is active on Free, however old', () => {
    expect(decide(organizationSubject())).toEqual(activeOn(ON_FREE));
  });

  it('a PERSONAL organization is active on Free, whatever its subscription', () => {
    const subject = organizationSubject({
      type: 'PERSONAL',
      subscription: subscription({ status: 'PAST_DUE', periodEndDaysAgo: 90 }),
    });
    expect(decide(subject)).toEqual(activeOn(ON_FREE));
  });

  it('the local Free row (a move down, an unpaid trial end) reads active on Free', () => {
    const subject = organizationSubject({
      subscription: subscription({ status: 'ACTIVE', periodEndDaysAgo: 400, plan: FREE_PLAN }),
    });
    expect(decide(subject)).toEqual(activeOn(ON_FREE));
  });

  it('ACTIVE on a paid plan is active on that plan, with its features', () => {
    const subject = organizationSubject({
      subscription: subscription({ status: 'ACTIVE', periodEndDaysAgo: -20 }),
    });
    expect(decide(subject)).toEqual(activeOn(ON_CREATOR));
  });

  it('TRIALING is active on the trial plan and answers trialEndsAt', () => {
    const trialEnd = daysAgo(-5);
    const subject = organizationSubject({
      subscription: subscription({
        status: 'TRIALING',
        periodEndDaysAgo: -5,
        trialEnd,
        plan: {
          ...CREATOR_PLAN,
          public_id: 'pln_studio',
          name: 'Studio',
          features: STUDIO_PLAN_FEATURES,
        },
      }),
    });
    expect(decide(subject)).toEqual(
      activeOn(
        { plan: { publicId: 'pln_studio', name: 'Studio' }, features: STUDIO_PLAN_FEATURES },
        trialEnd,
      ),
    );
  });

  it('PAST_DUE / UNPAID inside the grace is grace on its plan, ending period end + 14 days', () => {
    for (const status of ['PAST_DUE', 'UNPAID']) {
      const subject = organizationSubject({
        subscription: subscription({ status, periodEndDaysAgo: 4 }),
      });
      expect(decide(subject)).toEqual({
        state: 'grace',
        graceEndsAt: daysAfter(daysAgo(4), LAPSE_GRACE_DAYS),
        trialEndsAt: null,
        ...ON_CREATOR,
      });
    }
  });

  it('PAST_DUE past the grace is read_only on Free, graceEndsAt when read-only began', () => {
    const subject = organizationSubject({
      subscription: subscription({ status: 'PAST_DUE', periodEndDaysAgo: 30 }),
    });
    expect(decide(subject)).toEqual({
      state: 'read_only',
      graceEndsAt: daysAfter(daysAgo(30), LAPSE_GRACE_DAYS),
      trialEndsAt: null,
      ...ON_FREE,
    });
  });

  it('a cancelled paid plan is active until its period end, then read_only with no grace', () => {
    const running = organizationSubject({
      subscription: subscription({ status: 'CANCELED', periodEndDaysAgo: -3 }),
    });
    expect(decide(running)).toEqual(activeOn(ON_CREATOR));

    const ended = organizationSubject({
      subscription: subscription({ status: 'CANCELED', periodEndDaysAgo: 1 }),
    });
    expect(decide(ended)).toEqual({
      state: 'read_only',
      graceEndsAt: daysAgo(1),
      trialEndsAt: null,
      ...ON_FREE,
    });
  });

  it('an unpaid row that never earned its plan (INCOMPLETE, PAUSED, INCOMPLETE_EXPIRED) is active on Free', () => {
    for (const status of ['INCOMPLETE', 'PAUSED', 'INCOMPLETE_EXPIRED']) {
      const subject = organizationSubject({
        subscription: subscription({ status, periodEndDaysAgo: 60 }),
      });
      expect(decide(subject)).toEqual(activeOn(ON_FREE));
    }
  });

  it("a switched-off old plan reads its own row — Free's features (P80)", () => {
    const subject = organizationSubject({
      subscription: subscription({ status: 'ACTIVE', periodEndDaysAgo: -10, plan: GROWTH_PLAN }),
    });
    expect(decide(subject)).toEqual(
      activeOn({ plan: { publicId: 'pln_growth', name: 'Growth' }, features: FREE_PLAN_FEATURES }),
    );
  });

  it('a missing plan row reads as Free; no Free plan in the catalog leaves plan and features null', () => {
    const missingPlan = organizationSubject({
      subscription: subscription({ status: 'ACTIVE', periodEndDaysAgo: -10, plan: null }),
    });
    expect(decide(missingPlan)).toEqual(activeOn(ON_FREE));
    expect(decide(organizationSubject({ freePlan: null }))).toEqual({
      state: 'active',
      graceEndsAt: null,
      trialEndsAt: null,
      plan: null,
      features: null,
    });
  });

  it("with read-only mode off, a lapsed or cancelled paid plan is active — on Free's features", () => {
    const lapsed = organizationSubject({
      subscription: subscription({ status: 'PAST_DUE', periodEndDaysAgo: 30 }),
    });
    expect(decide(lapsed, false)).toEqual(activeOn(ON_FREE));
    const inGrace = organizationSubject({
      subscription: subscription({ status: 'UNPAID', periodEndDaysAgo: 2 }),
    });
    expect(decide(inGrace, false)).toEqual(activeOn(ON_CREATOR));
  });

  it('an organization not found reads active with no plan', () => {
    expect(decide(null)).toEqual({
      state: 'active',
      graceEndsAt: null,
      trialEndsAt: null,
      plan: null,
      features: null,
    });
  });
});

describe('subscription entitlement helpers', () => {
  const originalLapseGrace = env.BILLING_DUNNING_GRACE_DAYS;
  beforeAll(() => {
    env.BILLING_DUNNING_GRACE_DAYS = LAPSE_GRACE_DAYS;
  });
  afterAll(() => {
    env.BILLING_DUNNING_GRACE_DAYS = originalLapseGrace;
  });

  it('isDunningEntitlementLapsed: only a dunning status past period end + grace', () => {
    const lapsedEnd = daysAgo(LAPSE_GRACE_DAYS + 1);
    const withinEnd = daysAgo(LAPSE_GRACE_DAYS - 1);
    expect(
      isDunningEntitlementLapsed({ status: 'PAST_DUE', currentPeriodEnd: lapsedEnd, now: NOW }),
    ).toBe(true);
    expect(
      isDunningEntitlementLapsed({ status: 'UNPAID', currentPeriodEnd: withinEnd, now: NOW }),
    ).toBe(false);
    expect(
      isDunningEntitlementLapsed({ status: 'ACTIVE', currentPeriodEnd: lapsedEnd, now: NOW }),
    ).toBe(false);
  });

  it('requiresFreeSeatCeiling: no row, an unpaid status or a lapsed dunning one', () => {
    expect(requiresFreeSeatCeiling({ seatState: null, now: NOW })).toBe(true);
    for (const status of ['INCOMPLETE', 'PAUSED']) {
      expect(
        requiresFreeSeatCeiling({
          seatState: { status, current_period_end: daysAgo(-10) },
          now: NOW,
        }),
      ).toBe(true);
    }
    expect(
      requiresFreeSeatCeiling({
        seatState: { status: 'PAST_DUE', current_period_end: daysAgo(LAPSE_GRACE_DAYS + 1) },
        now: NOW,
      }),
    ).toBe(true);
    expect(
      requiresFreeSeatCeiling({
        seatState: { status: 'ACTIVE', current_period_end: daysAgo(-10) },
        now: NOW,
      }),
    ).toBe(false);
  });
});
