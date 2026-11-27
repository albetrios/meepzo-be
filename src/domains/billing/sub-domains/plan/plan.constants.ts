/**
 * The plan switches that are PRO (plan:L2088, P83): on for Creator and Studio, off on Free except
 * `broadcasts` and `segments` (on for Free since change-plan-gates P13). "PRO" is a label for these
 * switches, not a field — each is its own key in `features.feature_switches`.
 */
export const PRO_PLAN_FEATURE_KEYS = [
  'email_ask',
  'phone_ask',
  'reply_like_person',
  'multiple_public_reply_lines',
  'message_versions',
  'broadcasts',
  'segments',
  'past_comments',
  'extra_delay',
] as const;

/**
 * Every feature key a plan row switches on or off (routes-final BL12, P83) — one boolean per key in
 * `billing.plans.features.feature_switches`, exactly this set.
 *
 * @remarks
 * The PRO switches ({@link PRO_PLAN_FEATURE_KEYS}) plus the channel features every plan has
 * (`starter_questions`, `mark_seen`). The channel-account capability list (`CHANNEL_FEATURES`,
 * iteration row R5, routes-final CA11) names the plan switch each feature reads; a unit test added
 * with that list pins that the two sets agree. A key added here is a new billing migration that
 * writes the switch into every plan row — the typed read refuses a row without it.
 */
export const PLAN_FEATURE_KEYS = [
  ...PRO_PLAN_FEATURE_KEYS,
  'starter_questions',
  'mark_seen',
] as const;

/** One of {@link PLAN_FEATURE_KEYS}. */
export type PlanFeatureKey = (typeof PLAN_FEATURE_KEYS)[number];

/**
 * The value a feature switch a plan row lacks reads (change-plan-gates P19): `false`, off — the one
 * default of `billing.plans.features`; the limits have none (P36).
 *
 * @remarks
 * Filled by `parsePlanFeaturesWithDefaults` (`plan-features.util.ts`) before the strict parse, and
 * the entitlement registry builds its switch entries' `default` from this same constant, so the plan
 * read and the registry cannot disagree.
 */
export const PLAN_FEATURE_SWITCH_DEFAULT = false;

/** The highest `channel_accounts_max` a plan row may carry (routes-final BL12). */
export const PLAN_CHANNEL_ACCOUNTS_MAX_LIMIT = 100;
