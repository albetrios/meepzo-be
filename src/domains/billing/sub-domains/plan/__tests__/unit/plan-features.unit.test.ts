import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  PLAN_FEATURE_KEYS,
  PRO_PLAN_FEATURE_KEYS,
} from '@/domains/billing/sub-domains/plan/plan.constants.js';
import { planFeaturesSchema } from '@/domains/billing/sub-domains/plan/plan.types.js';
import { parsePlanRow } from '@/domains/billing/sub-domains/plan/plan.repository.js';
import {
  CREATOR_PLAN_FEATURES,
  DEFAULT_PLANS,
  FREE_PLAN_FEATURES,
  STUDIO_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';

/** Typed plan features — one switch per feature (routes-final BL12, P83; AC-11.1, AC-11.2). */
describe('planFeaturesSchema (BL12, P83)', () => {
  it('accepts the three plans and pins their values', () => {
    for (const features of [FREE_PLAN_FEATURES, CREATOR_PLAN_FEATURES, STUDIO_PLAN_FEATURES]) {
      expect(planFeaturesSchema.parse(features)).toEqual(features);
    }
    expect(FREE_PLAN_FEATURES).toMatchObject({
      message_month_limit: 1000,
      channel_accounts_max: 1,
      has_priority_support: false,
    });
    expect(CREATOR_PLAN_FEATURES).toMatchObject({
      message_month_limit: 10000,
      channel_accounts_max: 3,
      has_priority_support: false,
    });
    expect(STUDIO_PLAN_FEATURES).toMatchObject({
      message_month_limit: 50000,
      channel_accounts_max: 10,
      has_priority_support: true,
    });
  });

  it('Free has every PRO switch off but broadcasts and segments (P13) and every other switch on; Creator and Studio have all on', () => {
    const onForFree: readonly string[] = ['broadcasts', 'segments'];
    for (const key of PLAN_FEATURE_KEYS) {
      const isPro = (PRO_PLAN_FEATURE_KEYS as readonly string[]).includes(key);
      expect(FREE_PLAN_FEATURES.feature_switches[key], key).toBe(!isPro || onForFree.includes(key));
      expect(CREATOR_PLAN_FEATURES.feature_switches[key]).toBe(true);
      expect(STUDIO_PLAN_FEATURES.feature_switches[key]).toBe(true);
    }
    expect(Object.keys(FREE_PLAN_FEATURES.feature_switches).sort()).toEqual(
      [...PLAN_FEATURE_KEYS].sort(),
    );
  });

  it('has no PRO bundle — the switches are per feature', () => {
    expect(FREE_PLAN_FEATURES).not.toHaveProperty('is_pro_enabled');
    expect(FREE_PLAN_FEATURES).not.toHaveProperty('pro_features');
    expect(Object.keys(FREE_PLAN_FEATURES).sort()).toEqual([
      'channel_accounts_max',
      'feature_switches',
      'has_priority_support',
      'message_month_limit',
    ]);
  });

  it('refuses a missing top-level key', () => {
    const { message_month_limit: _dropped, ...missing } = FREE_PLAN_FEATURES;
    expect(() => planFeaturesSchema.parse(missing)).toThrow(ZodError);
  });

  it('refuses an unknown top-level key (the old bundle among them)', () => {
    expect(() => planFeaturesSchema.parse({ ...FREE_PLAN_FEATURES, is_pro_enabled: true })).toThrow(
      ZodError,
    );
    expect(() => planFeaturesSchema.parse({ ...FREE_PLAN_FEATURES, audit_log: true })).toThrow(
      ZodError,
    );
  });

  it('refuses a wrong type or an out-of-range limit', () => {
    expect(() =>
      planFeaturesSchema.parse({ ...FREE_PLAN_FEATURES, message_month_limit: '1000' }),
    ).toThrow(ZodError);
    expect(() =>
      planFeaturesSchema.parse({ ...FREE_PLAN_FEATURES, message_month_limit: -1 }),
    ).toThrow(ZodError);
    expect(() =>
      planFeaturesSchema.parse({ ...FREE_PLAN_FEATURES, channel_accounts_max: 0 }),
    ).toThrow(ZodError);
    expect(() =>
      planFeaturesSchema.parse({ ...FREE_PLAN_FEATURES, channel_accounts_max: 101 }),
    ).toThrow(ZodError);
    expect(() =>
      planFeaturesSchema.parse({ ...FREE_PLAN_FEATURES, has_priority_support: 'no' }),
    ).toThrow(ZodError);
  });

  it('refuses a switch not in PLAN_FEATURE_KEYS, a missing switch and a non-boolean switch', () => {
    const switches = FREE_PLAN_FEATURES.feature_switches;
    expect(() =>
      planFeaturesSchema.parse({
        ...FREE_PLAN_FEATURES,
        feature_switches: { ...switches, unknown_feature: true },
      }),
    ).toThrow(ZodError);
    const { broadcasts: _dropped, ...missingSwitch } = switches;
    expect(() =>
      planFeaturesSchema.parse({ ...FREE_PLAN_FEATURES, feature_switches: missingSwitch }),
    ).toThrow(ZodError);
    expect(() =>
      planFeaturesSchema.parse({
        ...FREE_PLAN_FEATURES,
        feature_switches: { ...switches, broadcasts: 1 },
      }),
    ).toThrow(ZodError);
  });

  it('the repository read refuses a malformed row loudly (AC-11.2, read half)', () => {
    expect(() => parsePlanRow({ id: 1, features: { priority_support: true } })).toThrow(ZodError);
    expect(parsePlanRow({ id: 1, features: CREATOR_PLAN_FEATURES })).toEqual({
      id: 1,
      features: CREATOR_PLAN_FEATURES,
    });
  });

  it("the reference seed holds Free, Creator and Studio active and the three old rows off with Free's features (P80)", () => {
    expect(
      DEFAULT_PLANS.filter((plan) => plan.is_active !== false).map((plan) => plan.name),
    ).toEqual(['Free', 'Creator', 'Studio']);
    const off = DEFAULT_PLANS.filter((plan) => plan.is_active === false);
    expect(off.map((plan) => plan.name)).toEqual(['Starter', 'Growth', 'Pro']);
    for (const plan of off) expect(plan.features).toEqual(FREE_PLAN_FEATURES);
  });
});
