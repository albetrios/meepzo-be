import type { PlanAccess } from '@/domains/billing/sub-domains/subscription/subscription.types.js';
import {
  ENTITLEMENT_REGISTRY,
  type EntitlementKey,
  type EntitlementLimitKey,
  type EntitlementOverrideLimitKey,
  type EntitlementSwitchKey,
} from './entitlement.constants.js';
import type {
  EntitlementResolvedValue,
  EntitlementSnapshot,
  EntitlementSnapshotValues,
  EntitlementSource,
  EntitlementSourcesOutput,
} from './entitlement.types.js';

/** One registry key resolved from the plan read (see {@link buildEntitlementSnapshot}). */
function resolveKey({
  planAccess,
  entry,
  overriddenKeys,
  defaultedKeys,
}: {
  planAccess: PlanAccess;
  entry: (typeof ENTITLEMENT_REGISTRY)[number];
  overriddenKeys: ReadonlySet<string>;
  defaultedKeys: ReadonlySet<string>;
}): EntitlementResolvedValue<boolean | number | null> {
  const registryDefault = { value: entry.default ?? null, source: 'default' as const };
  if (entry.key === 'seats') {
    return planAccess.plan === null
      ? registryDefault
      : { value: planAccess.seatLimit, source: 'plan' };
  }
  const { features } = planAccess;
  if (features === null) return registryDefault;
  const value =
    entry.kind === 'switch'
      ? features.feature_switches[entry.key as EntitlementSwitchKey]
      : features[entry.key as EntitlementOverrideLimitKey];
  let source: EntitlementSource = 'plan';
  if (overriddenKeys.has(entry.key)) source = 'override';
  else if (defaultedKeys.has(entry.key)) source = 'default';
  return { value, source };
}

/**
 * Builds an organization's entitlement snapshot from its one plan read (change-plan-gates EN2, P19):
 * the plan state, its dates, the plan, and every registry key's `{ value, source }`.
 *
 * @remarks
 * - **Algorithm:** walks `ENTITLEMENT_REGISTRY` in order. A switch or plan limit reads the plan
 *   access's `features` (the active overrides are already laid over them by `resolvePlanAccess`);
 *   its source is `override` when an active override names the key, else `default` when the plan
 *   row lacked the switch (`planAccess.defaultedKeys`), else `plan` — the merge order override →
 *   plan → default. `seats` reads `planAccess.seatLimit` (the plan's included seats, from the same
 *   statement) with source `plan`. With no plan in the catalog (`features` `null`), every key reads
 *   its registry default with source `default` — switches off, limits `null` (no limit, as the
 *   entitlements read reports it today), and an active override has nothing to lie on.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 * - **Notes:** an expired override is not in `planAccess.overrides` (filtered at read time), so its
 *   key falls back to `plan` or `default`.
 */
export function buildEntitlementSnapshot({
  planAccess,
}: {
  planAccess: PlanAccess;
}): EntitlementSnapshot {
  const overriddenKeys = new Set<string>(
    planAccess.features === null ? [] : planAccess.overrides.map((override) => override.key),
  );
  const defaultedKeys = new Set<string>(planAccess.defaultedKeys);
  const values = Object.fromEntries(
    ENTITLEMENT_REGISTRY.map((entry) => [
      entry.key,
      resolveKey({ planAccess, entry, overriddenKeys, defaultedKeys }),
    ]),
  ) as EntitlementSnapshotValues;
  return {
    state: planAccess.state,
    graceEndsAt: planAccess.graceEndsAt,
    trialEndsAt: planAccess.trialEndsAt,
    plan: planAccess.plan,
    values,
    planAccess,
  };
}

/**
 * Whether a feature switch is on in a resolved snapshot (change-plan-gates EN3).
 *
 * @remarks
 * - **Algorithm:** reads `snapshot.values[key].value` — no database read (P24); resolve once per
 *   request or job and pass the snapshot to every gate (K2).
 * - **Failure modes:** none — an unknown key does not compile (`EntitlementSwitchKey`).
 * - **Side effects:** none.
 */
export function can({
  snapshot,
  key,
}: {
  snapshot: EntitlementSnapshot;
  key: EntitlementSwitchKey;
}): boolean {
  return snapshot.values[key].value;
}

/**
 * A limit's ceiling in a resolved snapshot (change-plan-gates EN3): a whole number, or `null` for
 * unlimited.
 *
 * @remarks
 * - **Algorithm:** reads `snapshot.values[key].value` — no database read (P24). The counter's owner
 *   keeps its own lock and count and reads only the ceiling here (P23, K4).
 * - **Failure modes:** none — an unknown key does not compile (`EntitlementLimitKey`).
 * - **Side effects:** none.
 */
export function limit({
  snapshot,
  key,
}: {
  snapshot: EntitlementSnapshot;
  key: EntitlementLimitKey;
}): number | null {
  return snapshot.values[key].value;
}

/**
 * The source of every registry key in a snapshot, keyed by key (change-plan-gates EN6) — `sources`
 * on `GET /billing/entitlements`.
 *
 * @remarks
 * Pure; the keys come in registry order.
 */
export function entitlementSources(snapshot: EntitlementSnapshot): EntitlementSourcesOutput {
  return Object.fromEntries(
    ENTITLEMENT_REGISTRY.map((entry) => [entry.key, snapshot.values[entry.key].source]),
  ) as Record<EntitlementKey, EntitlementSource>;
}
