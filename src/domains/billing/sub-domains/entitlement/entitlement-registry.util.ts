import {
  type PlanFeatures,
  planFeaturesSchema,
} from '@/domains/billing/sub-domains/plan/plan.types.js';
import { ENTITLEMENT_REGISTRY, type EntitlementSwitchKey } from './entitlement.constants.js';

/** Whether `value` is a plain JSON object (not an array, not `null`). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses a plan row's stored `features` strictly (BL12), after the registry default fills each
 * feature switch the row lacks (change-plan-gates EN2, P19, P36) — and names the switches it filled.
 *
 * @remarks
 * - **Algorithm:** when `features.feature_switches` is an object, every registry `switch` entry the
 *   object does not carry gets its registry default (`false`, off) and its key is recorded in
 *   `defaultedKeys`, in registry order; the result is then parsed by `planFeaturesSchema`, which
 *   stays `.strict()`.
 * - **Failure modes:** throws a `ZodError` as before for anything the default does not cover — an
 *   unknown key, a wrongly typed value, a missing top-level key or a missing limit
 *   (`message_month_limit`, `channel_accounts_max` have no default, P36).
 * - **Side effects:** none — pure; the input is never mutated.
 * - **Notes:** a row that carries every switch parses exactly as before with `defaultedKeys` empty,
 *   so the default only changes a row that used to throw. Read by both plan reads
 *   (`PlanRepository`'s `parsePlanRow` and the plan-access query), so a key added to the registry
 *   needs no plan-data change (P19).
 */
export function parsePlanFeaturesWithDefaults(features: unknown): {
  features: PlanFeatures;
  defaultedKeys: EntitlementSwitchKey[];
} {
  const defaultedKeys: EntitlementSwitchKey[] = [];
  if (!(isJsonObject(features) && isJsonObject(features.feature_switches))) {
    return { features: planFeaturesSchema.parse(features), defaultedKeys };
  }
  const switches: Record<string, unknown> = { ...features.feature_switches };
  for (const entry of ENTITLEMENT_REGISTRY) {
    if (entry.kind !== 'switch' || Object.hasOwn(switches, entry.key)) continue;
    switches[entry.key] = entry.default;
    defaultedKeys.push(entry.key as EntitlementSwitchKey);
  }
  return {
    features: planFeaturesSchema.parse({ ...features, feature_switches: switches }),
    defaultedKeys,
  };
}
