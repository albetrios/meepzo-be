import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { FREE_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import type { PlanFeatures } from '@/domains/billing/sub-domains/plan/plan.types.js';

export interface CreatePlanOptions {
  name?: string;
  priceMonthly?: string;
  priceYearly?: string;
  currency?: string;
  /** REQ-4: seat allowance baked into the plan (null/undefined = unlimited). */
  includedSeats?: number | null;
  /** The typed plan features (BL12, P83); Free's by default. */
  features?: PlanFeatures;
  /** Whether the plan is offered (default true). */
  isActive?: boolean;
  /** The Stripe monthly price a webhook resolves back to this plan (none by default). */
  stripePriceMonthlyId?: string;
  /** The Stripe yearly price (none by default). */
  stripePriceYearlyId?: string;
}

/**
 * Create a test plan in the database.
 */
export async function createTestPlan(options: CreatePlanOptions = {}) {
  const publicId = generatePublicId('plan');

  const [plan] = await getOperatorDatabase()
    .insert(plans)
    .values({
      public_id: publicId,
      name: options.name ?? `Test Plan ${publicId}`,
      price_monthly: options.priceMonthly ?? '9.99',
      price_yearly: options.priceYearly ?? '99.99',
      currency: options.currency ?? 'USD',
      features: options.features ?? FREE_PLAN_FEATURES,
      is_active: options.isActive ?? true,
      // REQ-4: defaults to null (unlimited) so existing callers keep the no-seat-limit behaviour.
      included_seats: options.includedSeats ?? null,
      stripe_price_monthly_id: options.stripePriceMonthlyId ?? null,
      stripe_price_yearly_id: options.stripePriceYearlyId ?? null,
    })
    .returning();

  return plan!;
}
