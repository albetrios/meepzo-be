import {
  PLAN_STATE_CHANGE,
  type PlanStateChange,
} from '@/domains/billing/sub-domains/subscription/events/subscription.events.js';
import { INACTIVE_SUBSCRIPTION_STATUSES } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import type { StripeSubscriptionPriorState } from '@/domains/billing/sub-domains/subscription/subscription.types.js';

/**
 * The statuses a paid plan is kept in while Stripe retries the payment (BL3 grace) — entering one
 * is a failed payment (the webhook's "payment failed" notice, WC-57).
 */
export const DUNNING_STATUSES: ReadonlySet<string> = new Set(['PAST_DUE', 'UNPAID']);

/** The statuses that hold the plan's features: paid, or in its trial. */
const PAID_ENTITLEMENT_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'TRIALING']);

/** The statuses of a row that never earned its plan (route 102's first payment pending). */
const UNPAID_START_STATUSES: ReadonlySet<string> = new Set(['INCOMPLETE', 'PAUSED']);

const INACTIVE_STATUSES: ReadonlySet<string> = new Set<string>(INACTIVE_SUBSCRIPTION_STATUSES);

/** Whether a row is live (not `CANCELED` / `INCOMPLETE_EXPIRED`) — the only rows a plan-state case starts from. */
export function isLiveSubscriptionStatus(status: string): boolean {
  return !INACTIVE_STATUSES.has(status);
}

/**
 * Whether a `customer.subscription.updated` applies the row's scheduled move down (routes-final
 * § 8.D BL22 case 3): Stripe's price is now the scheduled plan's, and it was not already the row's.
 */
export function isScheduledMoveApplied({
  before,
  resolvedPlanId,
}: {
  before: Pick<StripeSubscriptionPriorState, 'plan_id' | 'scheduled_plan_id'>;
  resolvedPlanId: number | undefined;
}): boolean {
  return (
    before.scheduled_plan_id !== null &&
    resolvedPlanId !== undefined &&
    resolvedPlanId === before.scheduled_plan_id &&
    resolvedPlanId !== before.plan_id
  );
}

/**
 * How a live Stripe-backed row that has just ended changes the plan (routes-final § 8.D BL22).
 *
 * @remarks
 * - **Algorithm:** (1) an **unpaid trial end** — the row was `TRIALING`, or its period never passed
 *   its trial end (never paid) → `trial_ended`; (2) a **scheduled move to Free** → `moved_down`;
 *   (4) otherwise a **paid plan cancelled** → `plan_ended`. Cases (1) and (2) leave the organization
 *   on a local Free row (the caller inserts it in the same commit); (4) leaves none — the plan ends
 *   at its period end with no grace (BL3).
 * - **Failure modes:** none — pure.
 */
export function decideEndedPlanChange({
  before,
  isScheduledPlanFree,
}: {
  before: Pick<StripeSubscriptionPriorState, 'status' | 'trial_end' | 'current_period_end'>;
  isScheduledPlanFree: boolean;
}): PlanStateChange {
  const neverPaid =
    before.trial_end !== null &&
    new Date(before.current_period_end).getTime() <= new Date(before.trial_end).getTime();
  if (before.status === 'TRIALING' || neverPaid) return PLAN_STATE_CHANGE.TRIAL_ENDED;
  if (isScheduledPlanFree) return PLAN_STATE_CHANGE.MOVED_DOWN;
  return PLAN_STATE_CHANGE.PLAN_ENDED;
}

/**
 * How a `customer.subscription.created` / `.updated` sync that left the row live changes the plan
 * (routes-final § 8.D BL22 cases 3 and 5), or `null` when it names no change.
 *
 * @remarks
 * - **Algorithm:** the scheduled move applied → `moved_down`; back to paid from a dunning status →
 *   `resumed`; paid for the first time (`INCOMPLETE` / `PAUSED` → `ACTIVE` / `TRIALING`) →
 *   `upgraded` (BL14); another plan (a Dashboard change) → `moved_down` when it is cheaper on the
 *   row's cycle, else `upgraded`. Into `PAST_DUE` / `UNPAID` → `null`: the grace keeps the plan and
 *   its features, and its end is the plan-state check's `plan_ended` (WC-59, ROUTE row R52).
 * - **Failure modes:** none — pure. The caller still emits only when the entitlement moved.
 */
export function decideSyncedPlanChange({
  before,
  after,
  isScheduledMove,
  isCheaperPlan,
}: {
  before: Pick<StripeSubscriptionPriorState, 'status' | 'plan_id'>;
  after: { status: string; plan_id: number };
  isScheduledMove: boolean;
  isCheaperPlan: boolean;
}): PlanStateChange | null {
  if (isScheduledMove) return PLAN_STATE_CHANGE.MOVED_DOWN;
  if (PAID_ENTITLEMENT_STATUSES.has(after.status)) {
    if (DUNNING_STATUSES.has(before.status)) return PLAN_STATE_CHANGE.RESUMED;
    if (UNPAID_START_STATUSES.has(before.status)) return PLAN_STATE_CHANGE.UPGRADED;
  }
  if (after.plan_id !== before.plan_id) {
    return isCheaperPlan ? PLAN_STATE_CHANGE.MOVED_DOWN : PLAN_STATE_CHANGE.UPGRADED;
  }
  return null;
}
