import {
  PLAN_FEATURE_KEYS,
  PLAN_FEATURE_SWITCH_DEFAULT,
  type PlanFeatureKey,
} from './plan.constants.js';
import { type PlanFeatures, planFeaturesSchema } from './plan.types.js';

/** Whether `value` is a plain JSON object (not an array, not `null`). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses a plan row's stored `features` strictly (BL12), after the plan's switch default fills each
 * feature switch the row lacks (change-plan-gates EN2, P19, P36) — and names the switches it filled.
 *
 * @remarks
 * - **Algorithm:** when `features.feature_switches` is an object, every key of `PLAN_FEATURE_KEYS`
 *   the object does not carry gets `PLAN_FEATURE_SWITCH_DEFAULT` (`false`, off) and is recorded in
 *   `defaultedKeys`, in `PLAN_FEATURE_KEYS` order (the entitlement registry's switch order, which is
 *   built from that list with that default); the result is then parsed by `planFeaturesSchema`,
 *   which stays `.strict()`.
 * - **Failure modes:** throws a `ZodError` as before for anything the default does not cover — an
 *   unknown key, a wrongly typed value, a missing top-level key or a missing limit
 *   (`message_month_limit`, `channel_accounts_max` have no default, P36).
 * - **Side effects:** none — pure; the input is never mutated.
 * - **Notes:** a row that carries every switch parses exactly as before with `defaultedKeys` empty,
 *   so the default only changes a row that used to throw. Read by both plan reads
 *   (`PlanRepository`'s `parsePlanRow` and the plan-access query in `SubscriptionRepository`), so a
 *   key added to `PLAN_FEATURE_KEYS` needs no plan-data change (P19). Lives in the plan sub-domain so
 *   both repositories read their own domain's plan rule, never the entitlement module.
 */
export function parsePlanFeaturesWithDefaults(features: unknown): {
  features: PlanFeatures;
  defaultedKeys: PlanFeatureKey[];
} {
  const defaultedKeys: PlanFeatureKey[] = [];
  if (!(isJsonObject(features) && isJsonObject(features.feature_switches))) {
    return { features: planFeaturesSchema.parse(features), defaultedKeys };
  }
  const switches: Record<string, unknown> = { ...features.feature_switches };
  for (const key of PLAN_FEATURE_KEYS) {
    if (Object.hasOwn(switches, key)) continue;
    switches[key] = PLAN_FEATURE_SWITCH_DEFAULT;
    defaultedKeys.push(key);
  }
  return {
    features: planFeaturesSchema.parse({ ...features, feature_switches: switches }),
    defaultedKeys,
  };
}
