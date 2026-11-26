import { z } from 'zod';
import { PLAN_FEATURE_KEYS } from '@/domains/billing/sub-domains/plan/plan.constants.js';
import {
  type PlanFeatures,
  planFeaturesSchema,
} from '@/domains/billing/sub-domains/plan/plan.types.js';
import { PLAN_STATE_CHANGE } from '@/domains/billing/sub-domains/subscription/events/subscription.events.js';
import {
  ENTITLEMENT_OVERRIDE_KEYS,
  ENTITLEMENT_OVERRIDE_LIMIT_KEYS,
  type EntitlementOverrideKey,
  type EntitlementOverrideLimitKey,
} from './entitlement.constants.js';

const PLAN_FEATURE_KEY_SET: ReadonlySet<string> = new Set(PLAN_FEATURE_KEYS);

/** An override as the plan entitlement reads it — key, value and expiry (P270). */
export interface EntitlementOverrideEntry {
  key: EntitlementOverrideKey;
  value: boolean | number;
  /** `null` = no end. */
  expiresAt: Date | null;
}

/** The key schema every override passes (`ENTITLEMENT_OVERRIDE_KEYS`). */
export const entitlementOverrideKeySchema = z.enum(ENTITLEMENT_OVERRIDE_KEYS);

/**
 * The value schema of one override key (P270): a boolean for a plan feature switch, else the limit's
 * own bounds from the typed plan features (BL12) — `message_month_limit` ≥ 0,
 * `channel_accounts_max` 1–`PLAN_CHANNEL_ACCOUNTS_MAX_LIMIT`.
 */
export function entitlementOverrideValueSchema(
  key: EntitlementOverrideKey,
): z.ZodType<boolean | number> {
  if (PLAN_FEATURE_KEY_SET.has(key)) return z.boolean();
  return planFeaturesSchema.shape[key as EntitlementOverrideLimitKey];
}

/** Whether an override is in force at `now`: no end, or an end still ahead. */
export function isEntitlementOverrideActive({
  override,
  now,
}: {
  override: { expiresAt: Date | null };
  now: Date;
}): boolean {
  return override.expiresAt === null || override.expiresAt.getTime() > now.getTime();
}

/**
 * Reads the stored overrides of the plan entitlement's one query (P270) into typed entries.
 *
 * @remarks
 * Strict like the plan features (BL12): an unknown key or a value of the wrong type throws — a
 * stored row the database checks let through but the merge cannot type is a loud error, never a
 * silent skip.
 */
export function parseEntitlementOverrides(
  rows: ReadonlyArray<{ key: unknown; value: unknown; expires_at: unknown }>,
): EntitlementOverrideEntry[] {
  return rows.map((row) => {
    const key = entitlementOverrideKeySchema.parse(row.key);
    const value = entitlementOverrideValueSchema(key).parse(row.value);
    const expiresAt =
      row.expires_at === null || row.expires_at === undefined
        ? null
        : new Date(z.union([z.string(), z.date()]).parse(row.expires_at));
    return { key, value, expiresAt };
  });
}

/**
 * Lays an organization's active overrides over its plan's typed features (P270, BL12).
 *
 * @remarks
 * - **Algorithm:** keeps the overrides in force at `now` ({@link isEntitlementOverrideActive}); a
 *   feature key sets `feature_switches[key]`, a limit key the top-level limit; the result is parsed
 *   again by `planFeaturesSchema`, so the merged features stay strictly typed.
 * - **Failure modes:** a merged value the plan schema refuses throws (the set validator keeps it from
 *   being stored). With `features` `null` (no plan in the catalog) nothing is laid over — there is no
 *   base to change — and `active` still lists the overrides in force.
 * - **Notes:** pure; one override per key is stored, so the order of `overrides` never matters.
 */
export function applyEntitlementOverrides({
  features,
  overrides,
  now,
}: {
  features: PlanFeatures | null;
  overrides: readonly EntitlementOverrideEntry[];
  now: Date;
}): { features: PlanFeatures | null; active: EntitlementOverrideEntry[] } {
  const active = overrides.filter((override) => isEntitlementOverrideActive({ override, now }));
  if (features === null || active.length === 0) return { features, active };
  const merged = {
    ...features,
    feature_switches: { ...features.feature_switches },
  };
  for (const override of active) {
    if (PLAN_FEATURE_KEY_SET.has(override.key)) {
      (merged.feature_switches as Record<string, boolean>)[override.key] =
        override.value as boolean;
    } else {
      merged[override.key as EntitlementOverrideLimitKey] = override.value as number;
    }
  }
  return { features: planFeaturesSchema.parse(merged), active };
}

/**
 * Which plan-change an override's set or remove is for the app (BL8, P270): `moved_down` when a
 * switch went off or a limit went down, else `upgraded`; `null` when the features did not move (or
 * there is no plan to compare).
 *
 * @remarks
 * One set or remove changes one key, so the two directions never mix; `moved_down` makes the app
 * stop the accounts over a lowered `channel_accounts_max` and the steps a switch turned off,
 * `upgraded` lets it free them (WC-38).
 */
export function entitlementOverridePlanChange({
  previous,
  current,
}: {
  previous: PlanFeatures | null;
  current: PlanFeatures | null;
}): typeof PLAN_STATE_CHANGE.MOVED_DOWN | typeof PLAN_STATE_CHANGE.UPGRADED | null {
  if (previous === null || current === null) return null;
  if (JSON.stringify(previous) === JSON.stringify(current)) return null;
  const isSwitchLowered = PLAN_FEATURE_KEYS.some(
    (key) => previous.feature_switches[key] && !current.feature_switches[key],
  );
  const isLimitLowered = ENTITLEMENT_OVERRIDE_LIMIT_KEYS.some(
    (key) => current[key] < previous[key],
  );
  return isSwitchLowered || isLimitLowered
    ? PLAN_STATE_CHANGE.MOVED_DOWN
    : PLAN_STATE_CHANGE.UPGRADED;
}
