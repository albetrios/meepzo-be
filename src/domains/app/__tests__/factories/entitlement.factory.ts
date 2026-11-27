import { vi } from 'vitest';
import { buildEntitlementSnapshot } from '@/domains/billing/sub-domains/entitlement/entitlement-snapshot.util.js';
import type { EntitlementSnapshot } from '@/domains/billing/sub-domains/entitlement/entitlement.types.js';
import type { PlanAccess } from '@/domains/billing/sub-domains/subscription/subscription.types.js';
import {
  PLAN_FEATURE_KEYS,
  type PlanFeatureKey,
} from '@/domains/billing/sub-domains/plan/plan.constants.js';
import type { PlanFeatures } from '@/domains/billing/sub-domains/plan/plan.types.js';
import { FREE_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';

/**
 * A plan read as billing answers it, for the app's unit tests (change-plan-gates APC5): `active`,
 * no dates, no plan in the catalog (`features` `null` — every switch off, every limit `null`) unless
 * `values` says otherwise.
 *
 * @remarks
 * Feed it to {@link entitlementSnapshotOf} or {@link entitlementServiceOf}; the snapshot is built by
 * the module's own `buildEntitlementSnapshot`, so a test reads what production reads.
 */
export function planAccessOf(values: Partial<PlanAccess> = {}): PlanAccess {
  return {
    state: 'active',
    graceEndsAt: null,
    trialEndsAt: null,
    plan:
      values.features === undefined || values.features === null
        ? null
        : { publicId: 'pln_test', name: 'Plan' },
    features: null,
    seatLimit: null,
    defaultedKeys: [],
    overrides: [],
    isPlanChoiceRequired: false,
    ...values,
  };
}

/**
 * The entitlement snapshot of {@link planAccessOf}`(values)` — what `EntitlementService.resolve`
 * answers for that plan read.
 *
 * @remarks
 * Pure; `buildEntitlementSnapshot` from the entitlement module.
 */
export function entitlementSnapshotOf(values: Partial<PlanAccess> = {}): EntitlementSnapshot {
  return buildEntitlementSnapshot({ planAccess: planAccessOf(values) });
}

/**
 * A stub of the entitlement module's one read (`Pick<EntitlementService, 'resolve'>`) answering the
 * snapshot of {@link planAccessOf}`(values)` — the app services' plan dependency in a unit test.
 *
 * @remarks
 * `resolve` is a `vi.fn`, so a test can count the plan reads (one per request or job, P24).
 */
export function entitlementServiceOf(values: Partial<PlanAccess> = {}) {
  return { resolve: vi.fn(async () => entitlementSnapshotOf(values)) };
}

/**
 * Free's typed features with every switch off but `switches` — a plan read that holds exactly the
 * switches a test names (Free's limits).
 *
 * @remarks
 * Pure; pass it as `features` to {@link planAccessOf}.
 */
export function planFeaturesWithSwitches(
  switches: Partial<Record<PlanFeatureKey, boolean>>,
): PlanFeatures {
  const allOff = Object.fromEntries(PLAN_FEATURE_KEYS.map((key) => [key, false])) as Record<
    PlanFeatureKey,
    boolean
  >;
  return { ...FREE_PLAN_FEATURES, feature_switches: { ...allOff, ...switches } };
}
