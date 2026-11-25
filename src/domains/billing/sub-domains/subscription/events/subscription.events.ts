import type { PlanFeatures } from '@/domains/billing/sub-domains/plan/plan.types.js';

/**
 * Subscription resource events — emitted by {@link SubscriptionService} with the subscription's
 * public JSON and delivered to the organization's subscribed webhooks by the notify domain.
 * `CANCELLED` fires when the subscription reaches `CANCELED`; scheduling a cancellation at the
 * period end is an `UPDATED` (`cancel_at_period_end: true`).
 */
export const SUBSCRIPTION_EVENT = {
  CREATED: 'subscription.created',
  UPDATED: 'subscription.updated',
  CANCELLED: 'subscription.cancelled',
  /**
   * The organization's plan entitlement changed (routes-final § 8 BL8) — internal only, never a
   * customer webhook: emitted after commit with {@link PlanStateChangedPayload}; the app's handler
   * enqueues its plan-change task (WC-38, sub-domain 6).
   */
  PLAN_STATE_CHANGED: 'subscription.plan_state_changed',
} as const;

/** Union of literal event codes defined by {@link SUBSCRIPTION_EVENT}. */
export type SubscriptionEventType = (typeof SUBSCRIPTION_EVENT)[keyof typeof SUBSCRIPTION_EVENT];

/** Why the plan entitlement changed (BL8). */
export const PLAN_STATE_CHANGE = {
  UPGRADED: 'upgraded',
  MOVED_DOWN: 'moved_down',
  PLAN_ENDED: 'plan_ended',
  RESUMED: 'resumed',
  TRIAL_STARTED: 'trial_started',
  TRIAL_ENDED: 'trial_ended',
} as const;

/** Union of {@link PLAN_STATE_CHANGE} values. */
export type PlanStateChange = (typeof PLAN_STATE_CHANGE)[keyof typeof PLAN_STATE_CHANGE];

/** One side of a plan-state change: the entitlement's state and the plan its features come from. */
export interface PlanStateSnapshot {
  state: 'active' | 'grace' | 'read_only';
  plan_public_id: string | null;
}

/**
 * Payload of {@link SUBSCRIPTION_EVENT.PLAN_STATE_CHANGED} (BL8): the organization, why, the previous
 * and current state, the current typed features (so the app turns off exactly the switches the new
 * plan lacks, P83) and — on `moved_down` / `trial_ended` — the channel accounts the owner kept.
 */
export interface PlanStateChangedPayload {
  organizationPublicId: string;
  change: PlanStateChange;
  previous: PlanStateSnapshot;
  current: PlanStateSnapshot;
  /** The current plan's typed features; `null` when the catalog has no Free plan. */
  features: PlanFeatures | null;
  /** `cha_…` ids kept active (`moved_down` / `trial_ended`); `null` otherwise or when none was picked. */
  kept_channel_account_public_ids: string[] | null;
  /**
   * What makes this change once (WC-59, ROUTE row R52): the plan-state check's findings name it — the
   * period end of a grace that ended, the subscription of a switched-off plan row — so the app's
   * handler keys its plan-change task by it and drops a repeat; `null` for every other change (a
   * route or a Stripe event, each its own change).
   */
  change_key: string | null;
}
