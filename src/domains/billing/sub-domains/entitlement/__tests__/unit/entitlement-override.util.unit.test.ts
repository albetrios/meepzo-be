import { describe, expect, it } from 'vitest';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import {
  applyEntitlementOverrides,
  entitlementOverridePlanChange,
  parseEntitlementOverrides,
} from '@/domains/billing/sub-domains/entitlement/entitlement-override.util.js';
import { resolvePlanAccess } from '@/domains/billing/sub-domains/subscription/subscription-entitlement.util.js';

const NOW = new Date('2026-11-26T12:00:00.000Z');
const LATER = new Date('2026-12-26T12:00:00.000Z');
const EARLIER = new Date('2026-11-25T12:00:00.000Z');

/** The merge of per-organization overrides over the plan (plan-gating close, P270, BL12). */
describe('entitlement overrides (P270)', () => {
  it('lays a feature switch and a limit over the plan, leaving the rest', () => {
    const { features, active } = applyEntitlementOverrides({
      features: FREE_PLAN_FEATURES,
      overrides: [
        { key: 'broadcasts', value: true, expiresAt: null },
        { key: 'channel_accounts_max', value: 4, expiresAt: LATER },
      ],
      now: NOW,
    });
    expect(features?.feature_switches.broadcasts).toBe(true);
    expect(features?.channel_accounts_max).toBe(4);
    expect(features?.message_month_limit).toBe(FREE_PLAN_FEATURES.message_month_limit);
    expect(features?.feature_switches.segments).toBe(FREE_PLAN_FEATURES.feature_switches.segments);
    expect(active.map((override) => override.key)).toEqual(['broadcasts', 'channel_accounts_max']);
    // The plan's own object is never changed.
    expect(FREE_PLAN_FEATURES.feature_switches.broadcasts).toBe(false);
  });

  it('can turn a plan feature off and a limit down', () => {
    const { features } = applyEntitlementOverrides({
      features: CREATOR_PLAN_FEATURES,
      overrides: [
        { key: 'broadcasts', value: false, expiresAt: null },
        { key: 'message_month_limit', value: 10, expiresAt: null },
      ],
      now: NOW,
    });
    expect(features?.feature_switches.broadcasts).toBe(false);
    expect(features?.message_month_limit).toBe(10);
  });

  it('skips an expired override (an end at or before now)', () => {
    const { features, active } = applyEntitlementOverrides({
      features: FREE_PLAN_FEATURES,
      overrides: [
        { key: 'broadcasts', value: true, expiresAt: EARLIER },
        { key: 'segments', value: true, expiresAt: NOW },
      ],
      now: NOW,
    });
    expect(features).toEqual(FREE_PLAN_FEATURES);
    expect(active).toEqual([]);
  });

  it('has no base to change without a plan, and lists the overrides in force', () => {
    const result = applyEntitlementOverrides({
      features: null,
      overrides: [{ key: 'broadcasts', value: true, expiresAt: null }],
      now: NOW,
    });
    expect(result.features).toBeNull();
    expect(result.active).toHaveLength(1);
  });

  it('parses stored rows strictly: an unknown key or a wrong type throws (BL12)', () => {
    expect(
      parseEntitlementOverrides([
        { key: 'broadcasts', value: true, expires_at: null },
        { key: 'channel_accounts_max', value: 3, expires_at: '2026-12-01T00:00:00+00:00' },
      ]),
    ).toEqual([
      { key: 'broadcasts', value: true, expiresAt: null },
      { key: 'channel_accounts_max', value: 3, expiresAt: new Date('2026-12-01T00:00:00.000Z') },
    ]);
    expect(() =>
      parseEntitlementOverrides([{ key: 'has_priority_support', value: true, expires_at: null }]),
    ).toThrow();
    expect(() =>
      parseEntitlementOverrides([{ key: 'broadcasts', value: 1, expires_at: null }]),
    ).toThrow();
    expect(() =>
      parseEntitlementOverrides([{ key: 'channel_accounts_max', value: 0, expires_at: null }]),
    ).toThrow();
  });

  it('names the plan change: moved_down when a switch goes off or a limit down, else upgraded', () => {
    const raised = applyEntitlementOverrides({
      features: FREE_PLAN_FEATURES,
      overrides: [{ key: 'broadcasts', value: true, expiresAt: null }],
      now: NOW,
    }).features;
    expect(entitlementOverridePlanChange({ previous: FREE_PLAN_FEATURES, current: raised })).toBe(
      'upgraded',
    );
    expect(entitlementOverridePlanChange({ previous: raised, current: FREE_PLAN_FEATURES })).toBe(
      'moved_down',
    );
    const lowered = { ...CREATOR_PLAN_FEATURES, channel_accounts_max: 1 };
    expect(
      entitlementOverridePlanChange({ previous: CREATOR_PLAN_FEATURES, current: lowered }),
    ).toBe('moved_down');
    expect(
      entitlementOverridePlanChange({ previous: FREE_PLAN_FEATURES, current: FREE_PLAN_FEATURES }),
    ).toBeNull();
    expect(
      entitlementOverridePlanChange({ previous: null, current: FREE_PLAN_FEATURES }),
    ).toBeNull();
  });

  it('resolvePlanAccess merges after the plan state: a lapsed paid plan reads Free plus the override', () => {
    const free = {
      public_id: 'pln_free',
      name: 'Free',
      is_active: true,
      price_monthly: '0.00',
      price_yearly: '0.00',
      features: FREE_PLAN_FEATURES,
      included_seats: null,
    };
    const access = resolvePlanAccess({
      subject: {
        organization: { type: 'TEAM' },
        subscription: {
          status: 'CANCELED',
          current_period_end: EARLIER,
          trial_end: null,
          plan: {
            ...free,
            public_id: 'pln_creator',
            name: 'Creator',
            price_monthly: '29.00',
            price_yearly: '276.00',
            features: CREATOR_PLAN_FEATURES,
          },
        },
        freePlan: free,
        overrides: [
          { key: 'broadcasts', value: true, expiresAt: null },
          { key: 'segments', value: true, expiresAt: EARLIER },
        ],
      },
      now: NOW,
      isReadOnlyEnforced: true,
    });
    // The override never changes the state; it lays over whichever plan applies (Free here).
    expect(access.state).toBe('read_only');
    expect(access.plan?.publicId).toBe('pln_free');
    expect(access.features?.feature_switches.broadcasts).toBe(true);
    expect(access.features?.feature_switches.segments).toBe(false);
    expect(access.overrides).toEqual([{ key: 'broadcasts', value: true, expiresAt: null }]);
  });
});
