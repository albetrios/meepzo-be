import { fieldValidationError } from '@/shared/errors/validation.error.js';
import type { PlanFeatures } from '@/domains/billing/sub-domains/plan/plan.types.js';
import type { BillingChannelAccount, PlanAccess } from './subscription.types.js';

/**
 * How route 103 changes a plan (routes-final § 8.B BL15): `up` at once (a dearer plan, or leaving a
 * switched-off one — BL24), `down` at the period end (a cheaper paid plan or Free — BL5), `release`
 * (the current plan again — the scheduled move is taken back).
 */
export type ChangePlanDirection = 'up' | 'down' | 'release';

/** The plan fields the direction is decided from. */
interface ChangePlanPlan {
  id: number;
  is_active: boolean;
  price_monthly: string;
  price_yearly: string;
}

function priceForCycle({
  plan,
  billingCycle,
}: {
  plan: ChangePlanPlan;
  billingCycle: 'monthly' | 'yearly';
}): number {
  return Number(billingCycle === 'yearly' ? plan.price_yearly : plan.price_monthly);
}

/**
 * Decides route 103's direction (BL15): the same plan → `release`; from a switched-off plan (Starter,
 * Growth, Pro) → `up` whatever its old price (picking Creator or Studio ends the "choose a plan"
 * notice at once, BL24); a target cheaper on the subscription's cycle → `down`; otherwise `up` (an
 * equal price changes at once, as built).
 */
export function decideChangePlanDirection({
  currentPlan,
  targetPlan,
  billingCycle,
}: {
  currentPlan: ChangePlanPlan;
  targetPlan: ChangePlanPlan;
  billingCycle: 'monthly' | 'yearly';
}): ChangePlanDirection {
  if (targetPlan.id === currentPlan.id) return 'release';
  if (!currentPlan.is_active) return 'up';
  return priceForCycle({ plan: targetPlan, billingCycle }) <
    priceForCycle({ plan: currentPlan, billingCycle })
    ? 'down'
    : 'up';
}

/**
 * Checks route 103's `keep_channel_account_ids` (BL6): only on a move down; each one of the
 * organization's not-revoked accounts (read through the accounts port); at most the new plan's
 * `channel_accounts_max`. The DTO already refused a malformed id, a repeat and more than 10.
 *
 * @remarks
 * Failure modes: `400` on the field `keep_channel_account_ids` (`errors:keepChannelAccountsInvalid`).
 */
export function assertKeptChannelAccounts({
  keepChannelAccountIds,
  direction,
  accounts,
  targetFeatures,
}: {
  keepChannelAccountIds: readonly string[] | undefined;
  direction: ChangePlanDirection;
  accounts: readonly BillingChannelAccount[];
  targetFeatures: PlanFeatures;
}): void {
  if (keepChannelAccountIds === undefined) return;
  const invalid = () =>
    fieldValidationError({
      field: 'keep_channel_account_ids',
      messageKey: 'errors:keepChannelAccountsInvalid',
    });
  if (direction !== 'down') throw invalid();
  if (keepChannelAccountIds.length > targetFeatures.channel_accounts_max) throw invalid();
  const live = new Set(accounts.map((account) => account.publicId));
  if (!keepChannelAccountIds.every((identifier) => live.has(identifier))) throw invalid();
}

/**
 * Whether the plan entitlement moved (BL8): its state, the plan its features come from, or the
 * features themselves.
 */
export function hasPlanStateChanged({
  previous,
  current,
}: {
  previous: PlanAccess;
  current: PlanAccess;
}): boolean {
  return (
    previous.state !== current.state ||
    (previous.plan?.publicId ?? null) !== (current.plan?.publicId ?? null) ||
    JSON.stringify(previous.features) !== JSON.stringify(current.features)
  );
}
