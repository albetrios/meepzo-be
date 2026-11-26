import { describe, expect, it } from 'vitest';
import {
  buildEntitlementSnapshot,
  can,
  entitlementSources,
  limit,
} from '@/domains/billing/sub-domains/entitlement/entitlement-snapshot.util.js';
import { PLAN_FEATURE_KEYS } from '@/domains/billing/sub-domains/plan/plan.constants.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { resolvePlanAccess } from '@/domains/billing/sub-domains/subscription/subscription-entitlement.util.js';
import type {
  PlanAccess,
  PlanAccessPlan,
  PlanAccessSubject,
} from '@/domains/billing/sub-domains/subscription/subscription.types.js';
import type { EntitlementOverrideEntry } from '@/domains/billing/sub-domains/entitlement/entitlement-override.util.js';

const NOW = new Date('2026-11-26T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const { mark_seen: _dropped, ...FREE_SWITCHES_WITHOUT_MARK_SEEN } =
  FREE_PLAN_FEATURES.feature_switches;

/** The catalog's Free row as the plan read parses it, lacking `mark_seen` (registry default off). */
const FREE_PLAN_LACKING_MARK_SEEN: PlanAccessPlan = {
  public_id: 'pln_free',
  name: 'Free',
  is_active: true,
  price_monthly: '0.00',
  price_yearly: '0.00',
  features: {
    ...FREE_PLAN_FEATURES,
    feature_switches: { ...FREE_SWITCHES_WITHOUT_MARK_SEEN, mark_seen: false },
  },
  defaulted_keys: ['mark_seen'],
  included_seats: null,
};

/** A TEAM organization with no subscription (on Free) and the given stored overrides. */
function resolveOnFree(overrides: EntitlementOverrideEntry[]): PlanAccess {
  const subject: PlanAccessSubject = {
    organization: { type: 'TEAM' },
    subscription: null,
    freePlan: FREE_PLAN_LACKING_MARK_SEEN,
    overrides,
  };
  return resolvePlanAccess({ subject, now: NOW, isReadOnlyEnforced: true });
}

function planAccess(values: Partial<PlanAccess> = {}): PlanAccess {
  return {
    state: 'active',
    graceEndsAt: null,
    trialEndsAt: null,
    plan: { publicId: 'pln_creator', name: 'Creator' },
    features: CREATOR_PLAN_FEATURES,
    seatLimit: 5,
    defaultedKeys: [],
    overrides: [],
    isPlanChoiceRequired: false,
    ...values,
  };
}

/** The resolved snapshot (change-plan-gates EN2, ENC2, P19, P24). */
describe('buildEntitlementSnapshot — merge order override → plan → default (EN2)', () => {
  it('names the plan as the source of every key the plan row carries', () => {
    const snapshot = buildEntitlementSnapshot({ planAccess: planAccess() });
    expect(snapshot.values.broadcasts).toEqual({ value: true, source: 'plan' });
    expect(snapshot.values.message_month_limit).toEqual({
      value: CREATOR_PLAN_FEATURES.message_month_limit,
      source: 'plan',
    });
    expect(snapshot.values.seats).toEqual({ value: 5, source: 'plan' });
    expect(snapshot).toMatchObject({
      state: 'active',
      graceEndsAt: null,
      trialEndsAt: null,
      plan: { publicId: 'pln_creator', name: 'Creator' },
    });
  });

  it('an active override wins over the plan and over the registry default', () => {
    const access = resolveOnFree([
      { key: 'broadcasts', value: true, expiresAt: null },
      { key: 'mark_seen', value: true, expiresAt: new Date(NOW.getTime() + HOUR) },
      { key: 'channel_accounts_max', value: 4, expiresAt: null },
    ]);
    const snapshot = buildEntitlementSnapshot({ planAccess: access });
    expect(snapshot.values.broadcasts).toEqual({ value: true, source: 'override' });
    expect(snapshot.values.mark_seen).toEqual({ value: true, source: 'override' });
    expect(snapshot.values.channel_accounts_max).toEqual({ value: 4, source: 'override' });
    expect(snapshot.values.segments).toEqual({ value: false, source: 'plan' });
    expect(snapshot.values.message_month_limit).toEqual({
      value: FREE_PLAN_FEATURES.message_month_limit,
      source: 'plan',
    });
  });

  it('a switch the plan row lacks reads off with source default (the registry default)', () => {
    const snapshot = buildEntitlementSnapshot({ planAccess: resolveOnFree([]) });
    expect(snapshot.values.mark_seen).toEqual({ value: false, source: 'default' });
    expect(snapshot.values.starter_questions).toEqual({
      value: FREE_PLAN_FEATURES.feature_switches.starter_questions,
      source: 'plan',
    });
  });

  it('an expired override is ignored: its key falls back to the plan, or to the default', () => {
    const expired = new Date(NOW.getTime() - HOUR);
    const snapshot = buildEntitlementSnapshot({
      planAccess: resolveOnFree([
        { key: 'broadcasts', value: true, expiresAt: expired },
        { key: 'mark_seen', value: true, expiresAt: expired },
        { key: 'message_month_limit', value: 99_999, expiresAt: expired },
      ]),
    });
    expect(snapshot.values.broadcasts).toEqual({ value: false, source: 'plan' });
    expect(snapshot.values.mark_seen).toEqual({ value: false, source: 'default' });
    expect(snapshot.values.message_month_limit).toEqual({
      value: FREE_PLAN_FEATURES.message_month_limit,
      source: 'plan',
    });
  });

  it('with no plan in the catalog every key reads its registry default', () => {
    const snapshot = buildEntitlementSnapshot({
      planAccess: planAccess({
        plan: null,
        features: null,
        seatLimit: null,
        overrides: [{ key: 'broadcasts', value: true, expiresAt: null }],
      }),
    });
    for (const key of PLAN_FEATURE_KEYS) {
      expect(snapshot.values[key]).toEqual({ value: false, source: 'default' });
    }
    expect(snapshot.values.message_month_limit).toEqual({ value: null, source: 'default' });
    expect(snapshot.values.channel_accounts_max).toEqual({ value: null, source: 'default' });
    expect(snapshot.values.seats).toEqual({ value: null, source: 'default' });
  });

  it('keeps the plan read it was built from', () => {
    const access = planAccess({ isPlanChoiceRequired: true });
    expect(buildEntitlementSnapshot({ planAccess: access }).planAccess).toBe(access);
  });

  it('entitlementSources names every registry key in registry order', () => {
    const sources = entitlementSources(buildEntitlementSnapshot({ planAccess: resolveOnFree([]) }));
    expect(Object.keys(sources)).toEqual([
      ...PLAN_FEATURE_KEYS,
      'message_month_limit',
      'channel_accounts_max',
      'seats',
    ]);
    expect(sources.mark_seen).toBe('default');
    expect(sources.seats).toBe('plan');
  });
});

/** `can` and `limit` — pure reads of a snapshot (change-plan-gates EN3, ENC3, P24). */
describe('can and limit (EN3)', () => {
  it('can answers whether a switch is on', () => {
    const snapshot = buildEntitlementSnapshot({
      planAccess: resolveOnFree([{ key: 'segments', value: true, expiresAt: null }]),
    });
    expect(can({ snapshot, key: 'segments' })).toBe(true);
    expect(can({ snapshot, key: 'broadcasts' })).toBe(false);
    expect(can({ snapshot, key: 'mark_seen' })).toBe(false);
    expect(can({ snapshot, key: 'starter_questions' })).toBe(
      FREE_PLAN_FEATURES.feature_switches.starter_questions,
    );
  });

  it('limit answers the ceiling, null for unlimited', () => {
    const snapshot = buildEntitlementSnapshot({ planAccess: planAccess({ seatLimit: null }) });
    expect(limit({ snapshot, key: 'message_month_limit' })).toBe(
      CREATOR_PLAN_FEATURES.message_month_limit,
    );
    expect(limit({ snapshot, key: 'channel_accounts_max' })).toBe(
      CREATOR_PLAN_FEATURES.channel_accounts_max,
    );
    expect(limit({ snapshot, key: 'seats' })).toBeNull();
    expect(
      limit({ snapshot: buildEntitlementSnapshot({ planAccess: planAccess() }), key: 'seats' }),
    ).toBe(5);
  });
});
