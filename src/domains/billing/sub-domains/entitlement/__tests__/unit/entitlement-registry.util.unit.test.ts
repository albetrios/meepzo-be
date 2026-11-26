import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { parsePlanFeaturesWithDefaults } from '@/domains/billing/sub-domains/entitlement/entitlement-registry.util.js';
import { parsePlanRow } from '@/domains/billing/sub-domains/plan/plan.repository.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';

/** The registry default on a plan row's read (change-plan-gates EN2, P19, P36). */
describe('parsePlanFeaturesWithDefaults (P19)', () => {
  it('parses a row that carries every switch exactly as before, nothing defaulted', () => {
    expect(parsePlanFeaturesWithDefaults(CREATOR_PLAN_FEATURES)).toEqual({
      features: CREATOR_PLAN_FEATURES,
      defaultedKeys: [],
    });
  });

  it('fills each switch the row lacks with its registry default, off, and names it', () => {
    const {
      mark_seen: _markSeen,
      broadcasts: _broadcasts,
      ...switches
    } = CREATOR_PLAN_FEATURES.feature_switches;
    const parsed = parsePlanFeaturesWithDefaults({
      ...CREATOR_PLAN_FEATURES,
      feature_switches: switches,
    });
    expect(parsed.features.feature_switches.mark_seen).toBe(false);
    expect(parsed.features.feature_switches.broadcasts).toBe(false);
    expect(parsed.features.feature_switches.segments).toBe(true);
    // In registry order.
    expect(parsed.defaultedKeys).toEqual(['broadcasts', 'mark_seen']);
  });

  it('never mutates the stored value', () => {
    const { mark_seen: _dropped, ...switches } = FREE_PLAN_FEATURES.feature_switches;
    const stored = { ...FREE_PLAN_FEATURES, feature_switches: switches };
    parsePlanFeaturesWithDefaults(stored);
    expect(Object.hasOwn(stored.feature_switches, 'mark_seen')).toBe(false);
  });

  it('keeps the strict read for everything the default does not cover (P36)', () => {
    const { message_month_limit: _limit, ...withoutLimit } = FREE_PLAN_FEATURES;
    expect(() => parsePlanFeaturesWithDefaults(withoutLimit)).toThrow(ZodError);
    expect(() =>
      parsePlanFeaturesWithDefaults({
        ...FREE_PLAN_FEATURES,
        feature_switches: { ...FREE_PLAN_FEATURES.feature_switches, unknown_feature: true },
      }),
    ).toThrow(ZodError);
    expect(() =>
      parsePlanFeaturesWithDefaults({
        ...FREE_PLAN_FEATURES,
        feature_switches: { ...FREE_PLAN_FEATURES.feature_switches, broadcasts: 1 },
      }),
    ).toThrow(ZodError);
    const { feature_switches: _switches, ...withoutSwitches } = FREE_PLAN_FEATURES;
    expect(() => parsePlanFeaturesWithDefaults(withoutSwitches)).toThrow(ZodError);
    expect(() => parsePlanFeaturesWithDefaults(null)).toThrow(ZodError);
  });

  it('the plan repository read takes the same default', () => {
    const { past_comments: _dropped, ...switches } = CREATOR_PLAN_FEATURES.feature_switches;
    expect(
      parsePlanRow({ id: 1, features: { ...CREATOR_PLAN_FEATURES, feature_switches: switches } })
        .features.feature_switches.past_comments,
    ).toBe(false);
  });
});
