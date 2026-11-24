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
