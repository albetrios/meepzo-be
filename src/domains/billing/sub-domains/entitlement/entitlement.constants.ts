import { PLAN_FEATURE_KEYS } from '@/domains/billing/sub-domains/plan/plan.constants.js';

/**
 * The plan limits an organization override may raise or lower (plan-gating close, P270) — the two
 * number keys of `billing.plans.features` (BL12). `has_priority_support` is not overridable.
 */
export const ENTITLEMENT_OVERRIDE_LIMIT_KEYS = [
  'message_month_limit',
  'channel_accounts_max',
] as const;

/** One of {@link ENTITLEMENT_OVERRIDE_LIMIT_KEYS}. */
export type EntitlementOverrideLimitKey = (typeof ENTITLEMENT_OVERRIDE_LIMIT_KEYS)[number];

/**
 * Every key an organization entitlement override may carry (P270): a plan feature switch
 * (`PLAN_FEATURE_KEYS`, a boolean) or a plan limit ({@link ENTITLEMENT_OVERRIDE_LIMIT_KEYS}, an
 * integer).
 *
 * @remarks
 * `billing.organization_entitlement_overrides.chk_organization_entitlement_overrides_key` pins the
 * same list, so a new plan feature key is a billing migration here too (as it already is for the plan
 * rows, P83).
 */
export const ENTITLEMENT_OVERRIDE_KEYS = [
  ...PLAN_FEATURE_KEYS,
  ...ENTITLEMENT_OVERRIDE_LIMIT_KEYS,
] as const;

/** One of {@link ENTITLEMENT_OVERRIDE_KEYS}. */
export type EntitlementOverrideKey = (typeof ENTITLEMENT_OVERRIDE_KEYS)[number];

/** The longest `reason` an override records (the operator's note: a support ticket, a deal). */
export const ENTITLEMENT_OVERRIDE_REASON_MAX_LENGTH = 500;
