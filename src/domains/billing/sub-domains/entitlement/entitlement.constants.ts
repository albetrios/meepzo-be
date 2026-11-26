import {
  PLAN_FEATURE_KEYS,
  type PlanFeatureKey,
} from '@/domains/billing/sub-domains/plan/plan.constants.js';

/**
 * How a registry key is read (change-plan-gates EN1): `switch` a plan feature on or off, `cap` a
 * ceiling on things the organization holds (accounts, seats), `metered` a ceiling on a count that
 * starts again each period (this month's DMs).
 */
export type EntitlementKind = 'switch' | 'cap' | 'metered';

/** The product a registry key belongs to (change-plan-gates P17): keys stay bare, the entry names it. */
export type EntitlementProduct = 'instagram' | 'core';

/**
 * One entry of {@link ENTITLEMENT_REGISTRY} (change-plan-gates EN1): the key, how it is read, its
 * product, the value a plan row that lacks it reads (P19) and whether an organization override may
 * set it (P18).
 */
export interface EntitlementRegistryEntry<Key extends string = string> {
  key: Key;
  kind: EntitlementKind;
  product: EntitlementProduct;
  /**
   * The registry default (P19, P36): a switch is `false` (off), seats `null` (unlimited); `undefined`
   * means **no default** — every plan row must carry the key and a row without it fails its strict
   * read, as today.
   */
  default: boolean | number | null | undefined;
  overridable: boolean;
}

/**
 * The plan feature switches as registry entries (EN1, P21) — built from the plan's own
 * `PLAN_FEATURE_KEYS`, never a copy of the list: each is off by default and overridable.
 */
const ENTITLEMENT_SWITCH_ENTRIES: ReadonlyArray<EntitlementRegistryEntry<PlanFeatureKey>> =
  PLAN_FEATURE_KEYS.map((key) => ({
    key,
    kind: 'switch',
    product: 'instagram',
    default: false,
    overridable: true,
  }));

/**
 * The plan limits an organization override may raise or lower (plan-gating close, P270) — the two
 * number keys of `billing.plans.features` (BL12), in their registry order. Seats are a limit too but
 * never overridable (P18), so they are not here.
 */
const ENTITLEMENT_OVERRIDABLE_LIMIT_ENTRIES = [
  {
    key: 'message_month_limit',
    kind: 'metered',
    product: 'instagram',
    default: undefined,
    overridable: true,
  },
  {
    key: 'channel_accounts_max',
    kind: 'cap',
    product: 'instagram',
    default: undefined,
    overridable: true,
  },
] as const satisfies ReadonlyArray<EntitlementRegistryEntry>;

/** The seats registry entry (P18): a `core` cap read from the plan's included seats, never overridable. */
const ENTITLEMENT_SEATS_ENTRY = {
  key: 'seats',
  kind: 'cap',
  product: 'core',
  default: null,
  overridable: false,
} as const satisfies EntitlementRegistryEntry;

/** A plan limit an override may set — one of {@link ENTITLEMENT_OVERRIDE_LIMIT_KEYS}. */
export type EntitlementOverrideLimitKey =
  (typeof ENTITLEMENT_OVERRIDABLE_LIMIT_ENTRIES)[number]['key'];

/** A switch key of the registry — a plan feature key (`PLAN_FEATURE_KEYS`). */
export type EntitlementSwitchKey = PlanFeatureKey;

/** A limit key of the registry: the two plan limits and `seats` (`null` = unlimited). */
export type EntitlementLimitKey = EntitlementOverrideLimitKey | typeof ENTITLEMENT_SEATS_ENTRY.key;

/** Any key of {@link ENTITLEMENT_REGISTRY}. */
export type EntitlementKey = EntitlementSwitchKey | EntitlementLimitKey;

/**
 * The entitlement key registry (change-plan-gates EN1, P17–P19, P21, P36): every key the code
 * gates, one entry each, in this order — the 11 plan feature switches (`instagram`, off by default,
 * overridable), `message_month_limit` (`metered`, `instagram`, no default, overridable),
 * `channel_accounts_max` (`cap`, `instagram`, no default, overridable) and `seats` (`cap`, `core`,
 * unlimited by default, not overridable).
 *
 * @remarks
 * The one list the module answers plan questions from: `resolve` names a source per key from it,
 * the registry default fills a switch a plan row lacks (`parsePlanFeaturesWithDefaults`), and the
 * override key lists below are derived from its `overridable` entries.
 */
export const ENTITLEMENT_REGISTRY: ReadonlyArray<EntitlementRegistryEntry<EntitlementKey>> = [
  ...ENTITLEMENT_SWITCH_ENTRIES,
  ...ENTITLEMENT_OVERRIDABLE_LIMIT_ENTRIES,
  ENTITLEMENT_SEATS_ENTRY,
];

/** The registry's switch keys, in registry order (the plan's `PLAN_FEATURE_KEYS`). */
export const ENTITLEMENT_SWITCH_KEYS: readonly EntitlementSwitchKey[] = ENTITLEMENT_REGISTRY.filter(
  (entry) => entry.kind === 'switch',
).map((entry) => entry.key as EntitlementSwitchKey);

/** The registry's limit keys, in registry order: `message_month_limit`, `channel_accounts_max`, `seats`. */
export const ENTITLEMENT_LIMIT_KEYS: readonly EntitlementLimitKey[] = ENTITLEMENT_REGISTRY.filter(
  (entry) => entry.kind !== 'switch',
).map((entry) => entry.key as EntitlementLimitKey);

/**
 * The plan limits an organization override may raise or lower (plan-gating close, P270) — derived
 * from the registry's overridable limit entries (EN1): `message_month_limit`, `channel_accounts_max`.
 * `has_priority_support` is not in the registry and seats are not overridable (P18).
 */
export const ENTITLEMENT_OVERRIDE_LIMIT_KEYS = ENTITLEMENT_REGISTRY.filter(
  (entry) => entry.overridable && entry.kind !== 'switch',
).map((entry) => entry.key) as unknown as readonly [
  EntitlementOverrideLimitKey,
  ...EntitlementOverrideLimitKey[],
];

/** One of {@link ENTITLEMENT_OVERRIDE_KEYS}: a plan feature switch or an overridable plan limit. */
export type EntitlementOverrideKey = EntitlementSwitchKey | EntitlementOverrideLimitKey;

/**
 * Every key an organization entitlement override may carry (P270) — derived from the registry's
 * `overridable` entries (EN1): the plan feature switches (`PLAN_FEATURE_KEYS`, a boolean), then the
 * plan limits ({@link ENTITLEMENT_OVERRIDE_LIMIT_KEYS}, an integer) — the same 13 keys in the same
 * order as before the registry.
 *
 * @remarks
 * `billing.organization_entitlement_overrides.chk_organization_entitlement_overrides_key` pins the
 * same list, so a new overridable key is a billing migration here too (as it already is for the plan
 * rows, P83); a unit test pins the 13 keys so the registry cannot move the check by accident.
 */
export const ENTITLEMENT_OVERRIDE_KEYS = ENTITLEMENT_REGISTRY.filter(
  (entry) => entry.overridable,
).map((entry) => entry.key) as unknown as readonly [
  EntitlementOverrideKey,
  ...EntitlementOverrideKey[],
];

/** The longest `reason` an override records (the operator's note: a support ticket, a deal). */
export const ENTITLEMENT_OVERRIDE_REASON_MAX_LENGTH = 500;

/**
 * The shared one-line reasons a write route declares no plan gate (change-plan-gates RG2) — the
 * route files and the plan-gate coverage test cite the same words (`config.planGate.open`).
 *
 * @remarks
 * A reason used by one route only stays inline at that route. `open` is a decision, not a gap: each
 * reason says why no plan gate applies (D27: a read-only organization still signs in, pays, runs
 * its team and stops or removes work).
 */
export const PLAN_GATE_OPEN_REASON = {
  IDENTITY:
    'identity, sign-in and the session — never plan-gated (D27: a read-only organization still signs in)',
  USER: "the user's own account and data — not an organization's plan",
  PAYING: 'paying is how an organization leaves Free or read-only (D27) — never plan-gated',
  TEAM: 'running the team — never plan-gated (D27: a read-only organization still manages its team)',
  REMOVING: 'stopping or removing work never needs a plan (D27)',
  DRAFT: 'saves a draft only; the plan is checked when it goes live or is sent',
  META_CALLBACK:
    "Meta's own callback — signed by Meta, no organization plan to check; intake checks none either (plan:L4831), the send claim does (month_limit)",
  CONTACT: "a contact's data — no paid work; erasure must always go through (D27, D54)",
  ACCOUNT:
    'disconnects, pauses or re-logs an account already in the plan — no new plan room is used',
} as const;
