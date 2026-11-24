import type { PlanAccess, PlanAccessState } from './subscription.types.js';

/** The three {@link PlanAccessState} values of an organization's plan access, by name (owner decision D3). */
export const PLAN_ACCESS_STATE = {
  ACTIVE: 'active',
  GRACE: 'grace',
  READ_ONLY: 'read_only',
} as const satisfies Record<string, PlanAccessState>;

/**
 * The plan access of an organization that may write and has no grace running, with no plan read —
 * the answer when there is no organization to read (or no plan-access service wired).
 */
export const ACTIVE_PLAN_ACCESS: Readonly<PlanAccess> = Object.freeze({
  state: PLAN_ACCESS_STATE.ACTIVE,
  graceEndsAt: null,
  trialEndsAt: null,
  plan: null,
  features: null,
  isPlanChoiceRequired: false,
});

/**
 * Length of the no-card trial of a paid plan, in days (routes-final § 8 BL7, D73) — Stripe's
 * `trial_period_days`. A billing constant, not environment-varying (P4).
 */
export const PAID_TRIAL_DAYS = 7;

/**
 * Days before a trial's end on which its billing recipients get the "trial ending" notice (BL17) —
 * sent by the plan-state check (WC-59, ROUTE row R52), once per subscription and day.
 */
export const TRIAL_NOTICE_DAYS: readonly number[] = Object.freeze([3, 1]);

/**
 * Statuses in which the organization's paid plan needs a card on file: removing its only card is
 * refused `409 default_card_in_use` (routes-final § 8.C BL20) — a trial too, whose end would then have
 * nothing to charge.
 */
export const CARD_REQUIRED_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'ACTIVE',
  'PAST_DUE',
  'UNPAID',
  'TRIALING',
]);

/**
 * Shape of the `{payment_method_id}` path parameter (routes-final § 8.C, P78): Stripe's card id —
 * `pm_` and 1–250 letters and digits. A non-entity parameter (cards live only in Stripe); ownership
 * is checked against the organization's customer.
 */
export const PAYMENT_METHOD_ID_PATTERN = /^pm_[A-Za-z0-9]{1,250}$/;
