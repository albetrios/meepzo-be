import { env } from '@/shared/config/env.config.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { isPaidPlan } from '@/domains/billing/sub-domains/plan/plan.service.js';
import { isPersonalOrganization } from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import { INACTIVE_SUBSCRIPTION_STATUSES } from './subscription.repository.js';
import { ACTIVE_PLAN_ACCESS, PLAN_ACCESS_STATE } from './subscription.constants.js';
import type { PlanAccess, PlanAccessPlan, PlanAccessSubject } from './subscription.types.js';

/**
 * Dunning subscription statuses — a payment has failed but the subscription has not yet been
 * canceled. The organization keeps its full plan until `current_period_end + BILLING_DUNNING_GRACE_DAYS`
 * (F4), after which its entitlement lapses to the Free tier.
 */
const DUNNING_STATUSES = new Set<string>(['PAST_DUE', 'UNPAID']);

/**
 * Unpaid states that never earned the plan: INCOMPLETE (first payment pending) and PAUSED (trial
 * ended without a payment method). Both hold the Free ceiling until payment lands.
 */
export const UNPAID_ENTITLEMENT_STATUSES: ReadonlySet<string> = new Set<string>([
  'INCOMPLETE',
  'PAUSED',
]);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>(INACTIVE_SUBSCRIPTION_STATUSES);

/**
 * When a subscription's entitlement grace ends: `current_period_end + BILLING_DUNNING_GRACE_DAYS`.
 * A dunning subscription keeps its plan until then (F4); a lapsed paid one keeps writing under the
 * app routes until then (D3).
 */
export function entitlementGraceEndsAt({ currentPeriodEnd }: { currentPeriodEnd: Date }): Date {
  return new Date(
    new Date(currentPeriodEnd).getTime() + env.BILLING_DUNNING_GRACE_DAYS * MILLISECONDS_PER_DAY,
  );
}

/**
 * F4: true when the subscription is in dunning (PAST_DUE / UNPAID) and its grace
 * ({@link entitlementGraceEndsAt}) has passed, so its entitlement has lapsed to the Free tier.
 * ACTIVE / TRIALING and within-grace dunning keep the full plan.
 */
export function isDunningEntitlementLapsed({
  status,
  currentPeriodEnd,
  now,
}: {
  status: string;
  currentPeriodEnd: Date;
  now: Date;
}): boolean {
  if (!DUNNING_STATUSES.has(status)) return false;
  return now.getTime() > entitlementGraceEndsAt({ currentPeriodEnd }).getTime();
}

/**
 * Whether an organization's live subscription row leaves it on the Free-tier seat ceiling: no live
 * subscription, an unpaid one ({@link UNPAID_ENTITLEMENT_STATUSES}) or a dunning one past its grace.
 *
 * @remarks
 * The REQ-4 seat decision `SubscriptionService` makes for the subscription response's `seats_total`
 * and the add-member seat check. `seatState` is the organization's non-terminal row, or `null`.
 */
export function requiresFreeSeatCeiling({
  seatState,
  now,
}: {
  seatState: { status: string; current_period_end: Date } | null;
  now: Date;
}): boolean {
  return (
    !seatState ||
    UNPAID_ENTITLEMENT_STATUSES.has(seatState.status) ||
    isDunningEntitlementLapsed({
      status: seatState.status,
      currentPeriodEnd: seatState.current_period_end,
      now,
    })
  );
}

function planEntitlement(plan: PlanAccessPlan | null): Pick<PlanAccess, 'plan' | 'features'> {
  return plan
    ? { plan: { publicId: plan.public_id, name: plan.name }, features: plan.features }
    : { plan: null, features: null };
}

/**
 * Decides an organization's plan entitlement (owner decision D3; routes-final BL2, BL3) from its
 * organization, its current subscription and the catalog's Free plan.
 *
 * @remarks
 * - **Algorithm (BL3):** **Free never ends** — no subscription, a PERSONAL organization, a row on the
 *   Free plan (the local Free row of a move down or an unpaid trial end), an unpaid row that never
 *   earned its plan (`INCOMPLETE`, `PAUSED`) or a terminal row that was not a cancelled paid plan
 *   (`INCOMPLETE_EXPIRED`) → `active` on Free. `ACTIVE` / `TRIALING` → `active` on its plan
 *   (`trialEndsAt` = `trial_end` while `TRIALING`). `PAST_DUE` / `UNPAID` → `grace` on its plan until
 *   {@link entitlementGraceEndsAt} (`current_period_end + BILLING_DUNNING_GRACE_DAYS`), then
 *   `read_only` on Free. A **cancelled paid plan** ends at its period end with no grace: `active` on
 *   its plan until `current_period_end`, then `read_only` on Free ("plan ended"). A switched-off old
 *   plan row carries Free's features itself (P80), so it needs no case here — only
 *   `isPlanChoiceRequired` names it (BL24: a live row on a switched-off plan). A missing plan row
 *   reads as Free.
 * - **`isReadOnlyEnforced` false** (`ORGANIZATION_READ_ONLY_ENFORCED_EXCEPT_BILLING` off): the state is always `active`
 *   with no grace date; the plan and features are decided as above.
 * - **Failure modes:** none — pure. `plan` and `features` are `null` only when the catalog has no
 *   Free plan and the subscription grants none.
 */
export function resolvePlanAccess(options: {
  subject: PlanAccessSubject | null;
  now: Date;
  isReadOnlyEnforced: boolean;
}): PlanAccess {
  return {
    ...resolvePlanEntitlement(options),
    isPlanChoiceRequired: isPlanChoiceRequired(options.subject),
  };
}

/**
 * BL24 (P80): the organization's live subscription points at a switched-off plan row (Starter,
 * Growth, Pro) — it is held to Free's features until it picks Creator or Studio. A terminal row, no
 * row or a PERSONAL organization never requires a choice.
 */
function isPlanChoiceRequired(subject: PlanAccessSubject | null): boolean {
  const subscription = subject?.subscription;
  if (!(subject && subscription?.plan) || isPersonalOrganization(subject.organization)) {
    return false;
  }
  return !(TERMINAL_STATUSES.has(subscription.status) || subscription.plan.is_active);
}

function resolvePlanEntitlement({
  subject,
  now,
  isReadOnlyEnforced,
}: {
  subject: PlanAccessSubject | null;
  now: Date;
  isReadOnlyEnforced: boolean;
}): Omit<PlanAccess, 'isPlanChoiceRequired'> {
  if (!subject) return ACTIVE_PLAN_ACCESS;
  const onFree = planEntitlement(subject.freePlan);
  const active = ({
    entitlement,
    trialEndsAt = null,
  }: {
    entitlement: Pick<PlanAccess, 'plan' | 'features'>;
    trialEndsAt?: Date | null;
  }): Omit<PlanAccess, 'isPlanChoiceRequired'> => ({
    state: PLAN_ACCESS_STATE.ACTIVE,
    graceEndsAt: null,
    trialEndsAt,
    ...entitlement,
  });
  const { subscription } = subject;
  if (isPersonalOrganization(subject.organization) || !subscription)
    return active({ entitlement: onFree });

  const subscriptionPlan = subscription.plan;
  if (!(subscriptionPlan && isPaidPlan({ plan: subscriptionPlan })))
    return active({ entitlement: onFree });
  const onPlan = planEntitlement(subscriptionPlan);
  const ended = (graceEndsAt: Date): Omit<PlanAccess, 'isPlanChoiceRequired'> =>
    isReadOnlyEnforced
      ? { state: PLAN_ACCESS_STATE.READ_ONLY, graceEndsAt, trialEndsAt: null, ...onFree }
      : active({ entitlement: onFree });

  if (subscription.status === 'CANCELED') {
    const periodEnd = new Date(subscription.current_period_end);
    return now.getTime() < periodEnd.getTime() ? active({ entitlement: onPlan }) : ended(periodEnd);
  }
  if (
    TERMINAL_STATUSES.has(subscription.status) ||
    UNPAID_ENTITLEMENT_STATUSES.has(subscription.status)
  ) {
    return active({ entitlement: onFree });
  }
  if (DUNNING_STATUSES.has(subscription.status)) {
    const graceEndsAt = entitlementGraceEndsAt({
      currentPeriodEnd: subscription.current_period_end,
    });
    if (now.getTime() > graceEndsAt.getTime()) return ended(graceEndsAt);
    return isReadOnlyEnforced
      ? { state: PLAN_ACCESS_STATE.GRACE, graceEndsAt, trialEndsAt: null, ...onPlan }
      : active({ entitlement: onPlan });
  }
  return active({
    entitlement: onPlan,
    trialEndsAt: subscription.status === 'TRIALING' ? (subscription.trial_end ?? null) : null,
  });
}
