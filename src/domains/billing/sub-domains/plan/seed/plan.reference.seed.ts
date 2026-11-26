/**
 * Billing plan seed — the Flowdm product catalog (Free, Creator, Studio; Starter, Growth and Pro off).
 * Domain-owned; used by scripts/seed orchestration.
 */
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import {
  PLAN_FEATURE_KEYS,
  PRO_PLAN_FEATURE_KEYS,
} from '@/domains/billing/sub-domains/plan/plan.constants.js';
import {
  type PlanFeatures,
  planFeaturesSchema,
} from '@/domains/billing/sub-domains/plan/plan.types.js';

const PRO_KEYS: ReadonlySet<string> = new Set(PRO_PLAN_FEATURE_KEYS);

function featureSwitches({ isProOn }: { isProOn: boolean }): PlanFeatures['feature_switches'] {
  return Object.fromEntries(
    PLAN_FEATURE_KEYS.map((key) => [key, isProOn || !PRO_KEYS.has(key)]),
  ) as PlanFeatures['feature_switches'];
}

/**
 * Free's features (routes-final BL12, P83): 1,000 messages a month, 1 account, no priority support,
 * every PRO switch off except `broadcasts` and `segments`, and every other switch on. The
 * switched-off rows carry them too (P80, P27).
 *
 * @remarks
 * `broadcasts` and `segments` are on since iteration change-plan-gates (P13): migration
 * `20261126140000_billing_free_plan_segments_broadcasts.sql` writes the same two values into the
 * stored Free, Starter, Growth and Pro rows, so a fresh database (this seed) and an existing one (the
 * migration) hold the same catalog — `plan-catalog-migration.unit.test.ts` pins the two together.
 */
export const FREE_PLAN_FEATURES: PlanFeatures = Object.freeze({
  message_month_limit: 1000,
  channel_accounts_max: 1,
  has_priority_support: false,
  feature_switches: {
    ...featureSwitches({ isProOn: false }),
    broadcasts: true,
    segments: true,
  },
});

/** Creator's features: 10,000 messages a month, 3 accounts, every switch on (BL12). */
export const CREATOR_PLAN_FEATURES: PlanFeatures = Object.freeze({
  message_month_limit: 10000,
  channel_accounts_max: 3,
  has_priority_support: false,
  feature_switches: featureSwitches({ isProOn: true }),
});

/** Studio's features: 50,000 messages a month, 10 accounts, priority support, every switch on (BL12). */
export const STUDIO_PLAN_FEATURES: PlanFeatures = Object.freeze({
  message_month_limit: 50000,
  channel_accounts_max: 10,
  has_priority_support: true,
  feature_switches: featureSwitches({ isProOn: true }),
});

/**
 * The product plan catalog `pnpm db:seed` installs — the same rows as migration
 * `20261124060244_billing_flowdm_plans.sql` (routes-final BLC6) as amended by
 * `20261126140000_billing_free_plan_segments_broadcasts.sql` (Free's `broadcasts` and `segments` on,
 * change-plan-gates P13): Free, Creator and Studio active
 * (Creator and Studio at placeholder prices, P37), Starter, Growth and Pro off with Free's features
 * (P80, billing rows are never deleted). Members are unlimited on every plan (`included_seats` empty,
 * D55).
 */
export const DEFAULT_PLANS = [
  { name: 'Free', price_monthly: '0.00', price_yearly: '0.00', features: FREE_PLAN_FEATURES },
  {
    name: 'Creator',
    price_monthly: '29.00',
    price_yearly: '276.00',
    features: CREATOR_PLAN_FEATURES,
  },
  {
    name: 'Studio',
    price_monthly: '79.00',
    price_yearly: '756.00',
    features: STUDIO_PLAN_FEATURES,
  },
  {
    name: 'Starter',
    price_monthly: '10.00',
    price_yearly: '100.00',
    is_active: false,
    features: FREE_PLAN_FEATURES,
  },
  {
    name: 'Growth',
    price_monthly: '30.00',
    price_yearly: '300.00',
    is_active: false,
    features: FREE_PLAN_FEATURES,
  },
  {
    name: 'Pro',
    price_monthly: '99.00',
    price_yearly: '990.00',
    is_active: false,
    features: FREE_PLAN_FEATURES,
  },
];

/**
 * Idempotently inserts the {@link DEFAULT_PLANS} catalog (or a caller-supplied list), skipping rows
 * whose `name` already exists via `ON CONFLICT DO NOTHING`.
 *
 * @remarks
 * Every row's features are parsed with `planFeaturesSchema` before the insert — a missing or unknown
 * key is refused when written (AC-11.2), before the database's `chk_plans_features` would.
 */
export async function seedPlans(
  items: Array<{
    name: string;
    price_monthly: string;
    price_yearly: string;
    is_active?: boolean;
    included_seats?: number | null;
    features: PlanFeatures;
  }> = DEFAULT_PLANS,
) {
  const inserted = [];
  for (const plan of items) {
    const [row] = await getRequestDatabase()
      .insert(plans)
      .values({
        public_id: generatePublicId('plan'),
        name: plan.name,
        price_monthly: plan.price_monthly,
        price_yearly: plan.price_yearly,
        is_active: plan.is_active ?? true,
        included_seats: plan.included_seats ?? null,
        features: planFeaturesSchema.parse(plan.features),
      })
      .onConflictDoNothing()
      .returning();
    if (row) inserted.push(row);
  }
  return inserted;
}
