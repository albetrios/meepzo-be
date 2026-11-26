import { describe, expect, it } from 'vitest';
import {
  assertKeptChannelAccounts,
  decideChangePlanDirection,
  hasPlanStateChanged,
} from '@/domains/billing/sub-domains/subscription/subscription-plan-change.util.js';
import type { PlanAccess } from '@/domains/billing/sub-domains/subscription/subscription.types.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { ValidationError } from '@/shared/errors/index.js';

const FREE = { id: 1, is_active: true, price_monthly: '0.00', price_yearly: '0.00' };
const CREATOR = { id: 2, is_active: true, price_monthly: '29.00', price_yearly: '276.00' };
const STUDIO = { id: 3, is_active: true, price_monthly: '79.00', price_yearly: '756.00' };
/** A switched-off old row priced above Creator (BL24). */
const GROWTH = { id: 4, is_active: false, price_monthly: '99.00', price_yearly: '990.00' };

const accounts = [
  { publicId: 'cha_aaaaaaaaaaaaaaaaaaaaa', instagramUserId: '1', connectedAt: new Date(1) },
  { publicId: 'cha_bbbbbbbbbbbbbbbbbbbbb', instagramUserId: '2', connectedAt: new Date(2) },
];

const access = (overrides: Partial<PlanAccess> = {}): PlanAccess => ({
  state: 'active',
  graceEndsAt: null,
  trialEndsAt: null,
  plan: { publicId: 'pln_creator', name: 'Creator' },
  features: CREATOR_PLAN_FEATURES,
  seatLimit: null,
  overrides: [],
  isPlanChoiceRequired: false,
  ...overrides,
});

describe('route 103 — the change-plan direction (routes-final § 8.B BL15)', () => {
  it('a dearer plan is up, a cheaper one or Free is down, the same plan releases', () => {
    const decide = (currentPlan: typeof FREE, targetPlan: typeof FREE) =>
      decideChangePlanDirection({ currentPlan, targetPlan, billingCycle: 'monthly' });
    expect(decide(CREATOR, STUDIO)).toBe('up');
    expect(decide(STUDIO, CREATOR)).toBe('down');
    expect(decide(CREATOR, FREE)).toBe('down');
    expect(decide(CREATOR, CREATOR)).toBe('release');
  });

  it('compares the subscription cycle’s price', () => {
    const cheapYearly = { ...STUDIO, id: 9, price_yearly: '100.00' };
    expect(
      decideChangePlanDirection({
        currentPlan: CREATOR,
        targetPlan: cheapYearly,
        billingCycle: 'yearly',
      }),
    ).toBe('down');
    expect(
      decideChangePlanDirection({
        currentPlan: CREATOR,
        targetPlan: cheapYearly,
        billingCycle: 'monthly',
      }),
    ).toBe('up');
  });

  it('leaving a switched-off plan is always up — picking Creator ends the notice at once (BL24)', () => {
    expect(
      decideChangePlanDirection({
        currentPlan: GROWTH,
        targetPlan: CREATOR,
        billingCycle: 'monthly',
      }),
    ).toBe('up');
  });
});

describe('route 103 — keep_channel_account_ids (BL6)', () => {
  const check = (
    keepChannelAccountIds: string[] | undefined,
    direction: 'up' | 'down' | 'release' = 'down',
  ) =>
    assertKeptChannelAccounts({
      keepChannelAccountIds,
      direction,
      accounts,
      targetFeatures: FREE_PLAN_FEATURES,
    });

  it('absent or an own account within the new limit passes', () => {
    expect(() => check(undefined)).not.toThrow();
    expect(() => check(undefined, 'up')).not.toThrow();
    expect(() => check([])).not.toThrow();
    expect(() => check(['cha_bbbbbbbbbbbbbbbbbbbbb'])).not.toThrow();
  });

  it('refuses a move up, more than the new plan allows, and another organization’s account', () => {
    for (const run of [
      () => check(['cha_aaaaaaaaaaaaaaaaaaaaa'], 'up'),
      () => check(['cha_aaaaaaaaaaaaaaaaaaaaa'], 'release'),
      () => check(['cha_aaaaaaaaaaaaaaaaaaaaa', 'cha_bbbbbbbbbbbbbbbbbbbbb']),
      () => check(['cha_zzzzzzzzzzzzzzzzzzzzz']),
    ]) {
      expect(run).toThrow(ValidationError);
    }
    try {
      check(['cha_zzzzzzzzzzzzzzzzzzzzz']);
    } catch (error) {
      expect((error as ValidationError).errors?.[0]).toMatchObject({
        field: 'keep_channel_account_ids',
      });
    }
  });
});

describe('PLAN_STATE_CHANGED — whether the entitlement moved (BL8)', () => {
  it('a state, plan or feature change counts; the same entitlement does not', () => {
    expect(hasPlanStateChanged({ previous: access(), current: access() })).toBe(false);
    expect(
      hasPlanStateChanged({ previous: access(), current: access({ state: 'read_only' }) }),
    ).toBe(true);
    expect(
      hasPlanStateChanged({
        previous: access(),
        current: access({ plan: { publicId: 'pln_studio', name: 'Studio' } }),
      }),
    ).toBe(true);
    expect(
      hasPlanStateChanged({
        previous: access(),
        current: access({ features: FREE_PLAN_FEATURES }),
      }),
    ).toBe(true);
    expect(
      hasPlanStateChanged({
        previous: access(),
        current: access({ trialEndsAt: new Date(), isPlanChoiceRequired: true }),
      }),
    ).toBe(false);
  });
});
