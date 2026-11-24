import { z } from 'zod';
import {
  PLAN_CHANNEL_ACCOUNTS_MAX_LIMIT,
  PLAN_FEATURE_KEYS,
  type PlanFeatureKey,
} from './plan.constants.js';

const featureSwitchShape = Object.fromEntries(
  PLAN_FEATURE_KEYS.map((key) => [key, z.boolean()]),
) as Record<PlanFeatureKey, z.ZodBoolean>;

/**
 * The typed `billing.plans.features` (routes-final BL12, P83): the two limits, priority support and
 * one on / off switch per feature key of {@link PLAN_FEATURE_KEYS}.
 *
 * @remarks
 * `.strict()` at both levels: a missing or unknown key is a loud error, never a silent default. Parsed
 * by `PlanRepository` on every read and by the reference seed before every write; the database's
 * `chk_plans_features` pins the four top-level keys and their JSON types too.
 */
export const planFeaturesSchema = z
  .object({
    message_month_limit: z.number().int().min(0),
    channel_accounts_max: z.number().int().min(1).max(PLAN_CHANNEL_ACCOUNTS_MAX_LIMIT),
    has_priority_support: z.boolean(),
    feature_switches: z.object(featureSwitchShape).strict(),
  })
  .strict();

/** A plan's typed features — inferred from {@link planFeaturesSchema}. */
export type PlanFeatures = z.infer<typeof planFeaturesSchema>;

/**
 * Public response shape for plan endpoints (routes-final 8.A.6). Uses the plan's `public_id` as `id`
 * and emits ISO-string timestamps so the type is JSON-safe over the wire.
 */
export interface PlanOutput {
  id: string;
  name: string;
  description: string | null;
  price_monthly: string;
  /** Null when the plan does not offer annual billing. */
  price_yearly: string | null;
  /** `price_yearly` ÷ 12, two decimals (BL13); null when the plan does not offer annual billing. */
  price_yearly_per_month: string | null;
  /** Available purchase intervals. */
  billing_cycles: ('monthly' | 'yearly')[];
  currency: string;
  is_active: boolean;
  /** The typed features (BL12, P83). */
  features: PlanFeatures;
  created_at: string;
  updated_at: string;
}
