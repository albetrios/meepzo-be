import type { PlanFeatures } from '@/domains/billing/sub-domains/plan/plan.types.js';
/** MVCC token and provider watermark used to guard an authoritative same-second reconciliation. */
export interface StripeSubscriptionOrderingState {
  version: string;
  watermark: Date | null;
  status: string;
}

/**
 * The subscription fields a Stripe sync can change that the public JSON shows — compared before and
 * after a sync so an event is emitted only when a customer-visible field moved.
 */
export interface SubscriptionPublicState {
  status: string;
  cancel_at_period_end: boolean;
  canceled_at: Date | null;
  current_period_start: Date;
  current_period_end: Date;
  plan_id: number;
}

/**
 * A Stripe-backed row before a webhook sync or cancel (routes-final § 8.D BL22): its public state
 * plus what decides the plan-state case — the trial end, the scheduled move down and its kept
 * accounts, and the billing cycle.
 */
export interface StripeSubscriptionPriorState extends SubscriptionPublicState {
  billing_cycle: string;
  trial_end: Date | null;
  scheduled_plan_id: number | null;
  downgrade_keep: string[] | null;
}

/** Repository-level input for {@link SubscriptionRepository.create} — already-resolved numeric IDs. */
export interface SubscriptionCreateData {
  organization_id: number;
  plan_id: number;
  billing_cycle: string;
  status?: string;
  current_period_start: Date;
  current_period_end: Date;
  trial_end?: Date;
  /**
   * Set only by the Stripe `customer.subscription.deleted` tombstone path
   * (audit-#1) when materialising a CANCELED row whose local subscription never
   * existed. The regular create paths leave this unset (defaults to `NULL`).
   */
  /** `null` clears it (a resumed subscription). */
  canceled_at?: Date | null;
  /**
   * Set alongside {@link canceled_at} on the deletion tombstone path so the
   * CANCELED row is unambiguously terminal. Defaults to `false` for every other
   * create path.
   */
  cancel_at_period_end?: boolean;
  created_by_user_id?: number;
  provider?: string;
  provider_subscription_id?: string;
  provider_customer_id?: string;
  /**
   * Initial watermark for the Stripe-event reconciliation guard. Set to `new Date()`
   * by the HTTP `create()` path when Stripe accepted the subscription (sec-B2) so a
   * late-arriving `customer.subscription.created` whose `created` timestamp is older
   * than this value cannot clobber the row. Unset when Stripe is not configured.
   */
  last_stripe_event_created_at?: Date;
}

/**
 * Partial update set for {@link SubscriptionRepository.update} and the
 * webhook-driven sync paths; all fields are optional so callers can apply
 * narrow patches.
 */
export interface SubscriptionUpdateData {
  cancel_at_period_end?: boolean;
  status?: string;
  /** `null` clears it (a resumed subscription). */
  canceled_at?: Date | null;
  current_period_start?: Date;
  current_period_end?: Date;
  plan_id?: number;
  billing_cycle?: string;
  /** BL5 (P77): the plan a move down goes to at the period end; `null` clears the scheduled change. */
  scheduled_plan_id?: number | null;
  /** When the scheduled change applies (the period end); set exactly with `scheduled_plan_id`. */
  scheduled_change_at?: Date | null;
  /** BL6: the `cha_…` ids kept active after the move down; set only with a scheduled change. */
  downgrade_keep?: string[] | null;
  /**
   * REQ-4: purchased seat quantity, written by the Stripe webhook reconcile path from the
   * subscription item's `quantity`. Left unset by every other update path so a partial patch
   * never clobbers the seat count.
   */
  seats?: number;
  updated_at?: Date;
  /**
   * Set by HTTP-side mutations (`cancel`/`resume`/`changePlan`) to `new Date()` so a
   * stale Stripe event delivered later cannot regress the row state (sec-B3). The
   * webhook-driven `syncFromStripeProviderSubscription` path sets this from the event's
   * own `created` timestamp instead — both write through the same column but only the
   * HTTP path uses the current wall clock.
   */
  last_stripe_event_created_at?: Date;
}

/**
 * An organization's plan state (owner decision D3, 2026-10-17; routes-final BL3): `active` on a live
 * plan — Free never ends — (and always while `LAPSED_PLAN_READ_ONLY_ENABLED` is off, and for a PERSONAL
 * organization), `grace` while a lapsed paid plan's dunning grace runs, `read_only` once it has ended
 * or a cancelled paid plan passed its period end — the automation writes under
 * `/api/v1/app/automations` are then refused (launch D27).
 */
export type PlanAccessState = 'active' | 'grace' | 'read_only';

/**
 * An organization's plan entitlement (routes-final BL2) — the one plan read every decision uses:
 * the state, its dates, the plan the organization's features come from and those typed features.
 * Produced by `resolvePlanAccess`.
 */
export interface PlanAccess {
  state: PlanAccessState;
  /** When the grace ends (`grace`) or ended, i.e. when read-only began (`read_only`); `null` when `active`. */
  graceEndsAt: Date | null;
  /** When the trial ends while the subscription is `TRIALING`; `null` otherwise. */
  trialEndsAt: Date | null;
  /**
   * The plan whose features apply — the subscription's plan, or Free when there is none or it no
   * longer grants its plan; `null` only when the catalog holds no Free plan.
   */
  plan: { publicId: string; name: string } | null;
  /** That plan's typed features (BL12); `null` exactly when `plan` is. */
  features: PlanFeatures | null;
  /**
   * BL24 (P80): the live subscription points at a switched-off plan (Starter, Growth, Pro) — the
   * organization is held to Free's features until it picks Creator or Studio.
   */
  isPlanChoiceRequired: boolean;
}

/**
 * Public `plan_access` body — `active_organization.plan_access` on `GET /auth/me/context` and the two
 * organization switches (routes-final BL16, 8.B.6).
 */
export interface PlanAccessOutput {
  state: PlanAccessState;
  /** ISO 8601 timestamp; `null` when `state` is `active`. */
  grace_ends_at: string | null;
  /** ISO 8601 timestamp — when the 7-day trial ends while it runs; `null` otherwise (BL3). */
  trial_ends_at: string | null;
  /** The plan whose features apply (`pln_…` id and name); `null` only with no Free plan in the catalog. */
  plan: { id: string; name: string } | null;
  /** That plan's typed features (8.A.6); `null` exactly when `plan` is. */
  features: PlanFeatures | null;
  /** `true` while the live subscription is on a switched-off plan — "Choose Creator or Studio" (BL24). */
  is_plan_choice_required: boolean;
}

/** One not-revoked channel account as billing reads it through the accounts port (8.10). */
export interface BillingChannelAccount {
  /** `cha_…` */
  publicId: string;
  /** The Instagram user id (the account's provider id). */
  instagramUserId: string;
  connectedAt: Date;
}

/**
 * The accounts port (routes-final § 8.10): billing never reads app tables — the app's channel account
 * service implements this and the composition roots wire it (`wireChannelAccounts`). Read by routes 102
 * (the trial's accounts), 103 (the kept accounts) and 108 (`channel_accounts_count`).
 */
export interface BillingChannelAccountsPort {
  /** The organization's not-revoked channel accounts, oldest connected first. */
  listActiveChannelAccounts(options: {
    organizationPublicId: string;
  }): Promise<BillingChannelAccount[]>;
  /** How many not-revoked channel accounts the organization has. */
  countConnectedChannelAccounts(options: { organizationPublicId: string }): Promise<number>;
}

/** A plan row as the plan entitlement reads it (its features parsed, BL12). */
export interface PlanAccessPlan {
  public_id: string;
  name: string;
  /** `false` for a switched-off row (Starter, Growth, Pro — BL24). */
  is_active: boolean;
  price_monthly: string;
  price_yearly: string;
  features: PlanFeatures;
}

/**
 * What an organization's plan entitlement is decided from — read by
 * `SubscriptionRepository.findPlanAccessSubject` in one query.
 */
export interface PlanAccessSubject {
  organization: { type: string };
  /**
   * The organization's current subscription: its live (non-terminal) row when it has one, else its
   * most recent; `null` when it never had one.
   */
  subscription: {
    status: string;
    current_period_end: Date;
    trial_end: Date | null;
    /** The subscription's plan; `null` only when the plan row is gone. */
    plan: PlanAccessPlan | null;
  } | null;
  /** The catalog's Free plan (active, priced zero on both cycles); `null` when there is none. */
  freePlan: PlanAccessPlan | null;
}
