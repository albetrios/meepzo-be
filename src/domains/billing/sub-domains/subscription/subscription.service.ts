import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from '@/shared/errors/index.js';
import { randomUUID } from 'node:crypto';

import {
  getPostgresConstraintName,
  isPostgresUniqueViolation,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import { env } from '@/shared/config/env.config.js';
import {
  RedisLockUnavailableError,
  withRedisLock,
} from '@/infrastructure/cache/redis-lock.util.js';
import { addMonths } from './subscription-period.util.js';
import { INACTIVE_SUBSCRIPTION_STATUSES } from './subscription.repository.js';
import {
  BILLING_SEAT_SYNC_ENABLED,
  CARD_REQUIRED_SUBSCRIPTION_STATUSES,
  PAID_TRIAL_DAYS,
  PLAN_ACCESS_STATE,
} from './subscription.constants.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { TrialAccountRepository } from './trial-account.repository.js';
import { SubscriptionTrialService } from './subscription-trial.service.js';
import {
  type ChangePlanDirection,
  CLEARED_SCHEDULED_CHANGE,
  assertKeptChannelAccounts,
  decideChangePlanDirection,
  hasPlanStateChanged,
} from './subscription-plan-change.util.js';
import {
  UNPAID_ENTITLEMENT_STATUSES,
  requiresFreeSeatCeiling,
  resolvePlanAccess,
} from './subscription-entitlement.util.js';

/**
 * Per-organization lock TTL (seconds) around subscription create (audit-#B4). Must exceed the worst-case
 * `paymentProvider.createSubscription` latency plus the surrounding DB work so the lock never lapses
 * mid-create; a crashed holder auto-releases at this TTL.
 */
const SUBSCRIPTION_CREATE_LOCK_TTL_SECONDS = 20;
/** Max time (ms) a concurrent create waits for the in-flight one to finish before returning a retryable 409. */
const SUBSCRIPTION_CREATE_LOCK_WAIT_MS = 10_000;

/**
 * Subscription statuses that are considered terminal (non-mutable).
 *
 * @remarks
 * `CANCELED` and `INCOMPLETE_EXPIRED` rows can no longer be modified via the
 * cancel / resume / changePlan operations. Attempting to do so would make a
 * spurious Stripe API call against an already-inactive subscription, which
 * produces a Stripe error, surfaces as 503 to the caller, and may confuse
 * downstream event reconciliation. Guard every mutating method with this set
 * before reaching the payment provider (sec-new-B1). Sourced from
 * {@link INACTIVE_SUBSCRIPTION_STATUSES} so the "mutable" and "occupies the
 * subscription slot" definitions stay in lockstep (audit-#1).
 */
const TERMINAL_STATUSES = new Set<string>(INACTIVE_SUBSCRIPTION_STATUSES);

import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { assertTeamOrganization } from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import {
  type PlanService,
  isPaidPlan,
  supportsPlanBillingCycle,
} from '@/domains/billing/sub-domains/plan/plan.service.js';
import type { PaymentProvider } from './payment-provider.port.js';
import type { SubscriptionRepository } from './subscription.repository.js';
import type {
  BillingChannelAccount,
  BillingChannelAccountsPort,
  PlanAccess,
  StripeSubscriptionOrderingState,
  SubscriptionCreateData,
  SubscriptionPublicState,
  StripeSubscriptionPriorState,
  SubscriptionUpdateData,
} from './subscription.types.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { PAGINATION } from '@/shared/constants/pagination.constants.js';
import { BillingAccountSerializer } from './billing-account.serializer.js';
import { SubscriptionSerializer } from './subscription.serializer.js';
import { buildDomainEvent, eventBus, runEnqueueAfterCommit } from '@/core/events/event-bus.js';
import type { OrganizationResourceEventPayload } from '@/core/events/organization-resource-event.js';
import {
  PLAN_STATE_CHANGE,
  SUBSCRIPTION_EVENT,
  type PlanStateChange,
  type PlanStateChangedPayload,
  type PlanStateSnapshot,
  type SubscriptionEventType,
} from './events/subscription.events.js';
import {
  createStripeSetupIntent,
  isStripeConfigured,
  listStripeInvoices,
  listStripePaymentMethods,
  retrieveStripeCustomerDefaultPaymentMethodId,
  retrieveStripePaymentMethod,
} from '@/infrastructure/payment/stripe.client.js';

/**
 * Cross-domain port for the tenancy seat counter (REQ-4): resolves how many seats an
 * organization currently consumes (ACTIVE + INVITED memberships).
 *
 * @remarks
 * - **Algorithm:** declared as a minimal structural interface rather than importing
 *   `MembershipService`, so billing can read the count without a hard import cycle
 *   (tenancy's membership service also depends on billing for the seat-limit check).
 * - **Failure modes:** the implementer runs inside the organization RLS context and throws on a
 *   missing organization.
 * - **Side effects:** none on this type — the implementer issues the COUNT query.
 * - **Notes:** satisfied structurally by `MembershipService.countActiveMembers`; wired in
 *   by the composition root.
 */
export type MembershipSeatUsagePort = {
  countActiveMembers(options: { organizationPublicId: string }): Promise<number>;
};

/** Repository row enriched with the REQ-4 seat counters before serialization. */
type SubscriptionRowWithSeatState = {
  plan_included_seats: number | null;
  status: string;
  current_period_end: Date;
};
import {
  validateChangePlan,
  validateCreateSubscription,
  validateListInvoicesQuery,
} from './subscription.validator.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { enqueueSubscriptionSeatSyncBestEffort } from './queues/subscription-seat-sync.queue.js';

/**
 * Namespaces a client-supplied `X-Idempotency-Key` by organization (and operation) before it is
 * forwarded to Stripe (audit #3).
 *
 * @remarks
 * Stripe idempotency keys are scoped per Stripe *account* (the whole platform), not per tenant, so
 * forwarding a bare client header lets a key chosen by organization A collide with the same string from organization B
 * at Stripe — leaking A's cached object to B, or erroring B's request (`idempotency_error`) as a
 * chosen-key cross-tenant DoS. Prefixing with `op:org` keeps each tenant's key space disjoint.
 * Returns `undefined` when no client key was supplied (the caller passes nothing to Stripe).
 */
export function buildStripeIdempotencyKey({
  operation,
  organizationPublicId,
  clientKey,
}: {
  operation: string;
  organizationPublicId: string;
  clientKey: string | undefined;
}): string | undefined {
  return clientKey === undefined ? undefined : `${operation}:${organizationPublicId}:${clientKey}`;
}

// audit H2: a Stripe-backed subscription must NOT change to a plan that has no
// Stripe price id for its billing cycle. The Stripe price update in changePlan is
// gated on `providerPriceId`, but the local `plan_id` write is unconditional — so
// without this guard the local entitlement switches to the new tier while Stripe
// keeps billing the OLD price, and the watermark stamp blocks the reconciling
// `customer.subscription.updated` webhook (un-self-healing divergence). Only a
// genuinely local-only subscription (no `provider_subscription_id`) may change to
// a price-less plan. Extracted so changePlan stays within its complexity budget.
function assertProviderPriceForStripeBackedPlanChange({
  providerSubscriptionId,
  providerPriceId,
}: {
  providerSubscriptionId: string | null;
  providerPriceId: string | null | undefined;
}): void {
  if (providerSubscriptionId && !providerPriceId) {
    throw new UnprocessableEntityError('errors:planNotAvailableForBillingCycle');
  }
}

/**
 * Why route 102 moved the plan entitlement (BL14): a trial start, a Free row ending a plan-ended
 * state, or a paid plan granted at once.
 */
function createdPlanStateChange({
  isTrial,
  previousAccess,
}: {
  isTrial: boolean;
  previousAccess: PlanAccess;
}): PlanStateChange {
  if (isTrial) return PLAN_STATE_CHANGE.TRIAL_STARTED;
  return previousAccess.state === PLAN_ACCESS_STATE.READ_ONLY
    ? PLAN_STATE_CHANGE.RESUMED
    : PLAN_STATE_CHANGE.UPGRADED;
}

/** A scheduled move to Free is Stripe's period-end cancel on the row (BL5). */
function isScheduledFreeCancel(subscription: {
  scheduled_plan_id: number | null;
  cancel_at_period_end: boolean;
}): boolean {
  return hasScheduledChange(subscription) && subscription.cancel_at_period_end;
}

/** Whether a move down waits for the period end on the row (BL5). */
function hasScheduledChange(subscription: { scheduled_plan_id: number | null }): boolean {
  return (subscription.scheduled_plan_id ?? null) !== null;
}

/** Route 103's subject, read in one organization unit (`readChangePlanSubject`). */
type ChangePlanSubject = Awaited<ReturnType<SubscriptionService['readChangePlanSubject']>>;

/**
 * The first period of a new subscription: a trial's is the trial itself (BL7, `PAID_TRIAL_DAYS`);
 * otherwise one month or one year. addMonths clamps month-end dates (Jan 31 + 1mo → Feb 28/29, not
 * Mar 3) instead of the raw Date.setMonth overflow. For Stripe-backed subscriptions the webhook
 * overwrites it with the authoritative period end; for local-only ones it is the persisted value.
 */
function firstSubscriptionPeriod({
  now,
  isTrial,
  billingCycle,
}: {
  now: Date;
  isTrial: boolean;
  billingCycle: 'monthly' | 'yearly';
}): { trialEnd: Date | undefined; periodEnd: Date } {
  if (isTrial) {
    const trialEnd = new Date(now.getTime() + PAID_TRIAL_DAYS * MILLISECONDS_PER_DAY);
    return { trialEnd, periodEnd: trialEnd };
  }
  return {
    trialEnd: undefined,
    periodEnd: addMonths({ base: now, months: billingCycle === 'yearly' ? 12 : 1 }),
  };
}

/** Whether a customer-visible subscription field differs between two states. */
function subscriptionPublicStateChanged({
  before,
  after,
}: {
  before: SubscriptionPublicState;
  after: SubscriptionPublicState;
}): boolean {
  const time = (value: Date | string | null) => (value === null ? null : new Date(value).getTime());
  return (
    before.status !== after.status ||
    before.cancel_at_period_end !== after.cancel_at_period_end ||
    time(before.canceled_at) !== time(after.canceled_at) ||
    time(before.current_period_start) !== time(after.current_period_start) ||
    time(before.current_period_end) !== time(after.current_period_end) ||
    before.plan_id !== after.plan_id
  );
}

/**
 * Coordinates plan lookups, payment-provider calls, and subscription updates
 * for a single organization.
 *
 * @remarks
 * - **Algorithm:** Each public method runs the database portion inside
 *   {@link withAppDatabaseContext} so Postgres sees the organization GUC for
 *   RLS, then performs the Stripe API call (create / change-plan / cancel /
 *   resume) outside that context, then re-opens an organization context to
 *   write back the resulting row. Webhook-triggered methods
 *   (`syncFromStripeProviderSubscription`, `markCanceledByStripeProviderSubscriptionId`)
 *   accept a repository override so the webhook worker can pass its own
 *   worker-scoped handle.
 * - **Failure modes:** Throws {@link NotFoundError} when the organization,
 *   plan, or subscription cannot be loaded. The mutating operations (`create` /
 *   `changePlan` / `cancel` / `resume`) first reject a PERSONAL organization with
 *   422 via `assertTeamOrganization({ organization, capability: 'BILLING' })` — billing is a
 *   team-only action (a PERSONAL organization cannot manage billing). On `create`, throws
 *   {@link ConflictError} (`errors:subscriptionAlreadyExists`) when the
 *   organization already has a non-terminal subscription (checked before the
 *   Stripe call) or when a concurrent create loses the partial-unique-index
 *   race (Postgres `unique_violation`, `23505`). The payment provider is
 *   **fail-closed**: a Stripe failure on `create` / `cancel` / `resume` /
 *   `changePlan` surfaces as `ServiceUnavailableError` from the provider, which
 *   runs *before* any local write, so no local subscription row is created or
 *   mutated when the provider call fails — the Stripe webhook stays the
 *   reconciliation source of truth. If persistence fails *after* the Stripe
 *   create succeeded, the provider is rolled back via `compensateFailedCreate`.
 *   On `changePlan`, a successful provider price update followed by a local
 *   write failure triggers `compensatePlanChange` back to the previous price.
 * - **Side effects:** External Stripe API calls (create / update / cancel /
 *   resume / compensations) and writes to `billing.subscriptions`.
 * - **Notes:** Stripe network calls MUST stay outside the database context to
 *   avoid blocking a Postgres connection on remote I/O. Idempotency for
 *   `create` is forwarded to Stripe via `idempotencyKey` (the
 *   `X-Idempotency-Key` HTTP header).
 */
export class SubscriptionService {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly planService: PlanService,
    private readonly repository: SubscriptionRepository,
    private readonly paymentProvider: PaymentProvider,
    // REQ-4: resolves seats_used (ACTIVE + INVITED memberships). Optional so the worker
    // composition root and minimal test harnesses can omit it; when unset, seats_used
    // reports 0 (the read paths still return a coherent shape). The HTTP container always wires it.
    private readonly membershipSeatUsage?: MembershipSeatUsagePort,
    // feat-instagram-dm-sending BL7: the one-trial rules over `billing.trial_accounts`.
    private readonly trialService: SubscriptionTrialService = new SubscriptionTrialService(
      new TrialAccountRepository(),
      repository,
    ),
  ) {}

  /** The accounts port (routes-final § 8.10) — wired by the composition roots once the app is built. */
  private channelAccounts: BillingChannelAccountsPort | undefined;

  /**
   * Wires the accounts port (routes-final § 8.10): the app's channel account service, built after
   * billing, so it is passed here by the composition roots (`domainContainersPlugin`,
   * `createWorkerDomainContainers`) — the launch's late-wiring pattern, no container cycle.
   */
  wireChannelAccounts(port: BillingChannelAccountsPort): void {
    this.channelAccounts = port;
  }

  /** The organization's not-revoked channel accounts through the accounts port; `[]` when unwired. */
  private async listChannelAccounts(
    organizationPublicId: string,
  ): Promise<BillingChannelAccount[]> {
    return this.channelAccounts
      ? this.channelAccounts.listActiveChannelAccounts({ organizationPublicId })
      : [];
  }

  /** A trial's accounts (BL7): the organization's not-revoked Instagram user ids; none otherwise. */
  private async listTrialInstagramUserIds({
    organizationPublicId,
    isTrial,
  }: {
    organizationPublicId: string;
    isTrial: boolean;
  }): Promise<string[]> {
    if (!isTrial) return [];
    const accounts = await this.listChannelAccounts(organizationPublicId);
    return accounts.map((account) => account.instagramUserId);
  }

  /**
   * How many not-revoked channel accounts the organization has (route 108's
   * `active_organization.channel_accounts_count`, BL16) — through the accounts port; `0` when unwired
   * (the worker process, minimal harnesses).
   */
  async countConnectedChannelAccounts({
    organizationPublicId,
  }: {
    organizationPublicId: string;
  }): Promise<number> {
    return this.channelAccounts
      ? this.channelAccounts.countConnectedChannelAccounts({ organizationPublicId })
      : 0;
  }

  /**
   * Emits `subscription.plan_state_changed` (routes-final § 8 BL8) when the organization's plan
   * entitlement moved from `previous` — its state, its plan or its features.
   *
   * @remarks
   * - **Algorithm:** re-reads the entitlement ({@link getPlanAccess}); unchanged → nothing (a repeat is
   *   a no-op). Otherwise one event with the previous and current `{ state, plan_public_id }`, the
   *   current typed features (P83) and the kept accounts.
   * - **Failure modes:** a read failure propagates; handler failures are logged by the bus.
   * - **Side effects:** the app's handler enqueues its plan-change task (WC-38, sub-domain 6).
   * - **Notes:** call it **after** the write's commit (routes 102 and 103 call it once their unit has
   *   returned). The Stripe webhook's plan-state cases (through {@link emitPlanStateChangedAfterCommit}) and the plan-state check
   *   (WC-59, R52) emit through it too.
   */
  async emitPlanStateChanged(options: {
    organizationPublicId: string;
    change: PlanStateChange;
    previous: PlanAccess;
    keptChannelAccountPublicIds?: string[] | null;
  }): Promise<void> {
    const current = await this.getPlanAccess({
      organizationPublicId: options.organizationPublicId,
    });
    if (!hasPlanStateChanged({ previous: options.previous, current })) return;
    await eventBus.emit(
      buildDomainEvent<PlanStateChangedPayload>({
        type: SUBSCRIPTION_EVENT.PLAN_STATE_CHANGED,
        payload: {
          organizationPublicId: options.organizationPublicId,
          change: options.change,
          previous: {
            state: options.previous.state,
            plan_public_id: options.previous.plan?.publicId ?? null,
          },
          current: { state: current.state, plan_public_id: current.plan?.publicId ?? null },
          features: current.features,
          kept_channel_account_public_ids: options.keptChannelAccountPublicIds ?? null,
          change_key: null,
        },
      }),
    );
  }

  /**
   * Emits one finding of the plan-state check (WC-59, BL17, BL24 — ROUTE row R52) as
   * `subscription.plan_state_changed`: a grace that ended (`plan_ended`) or a subscription still on a
   * switched-off plan row (`moved_down`).
   *
   * @remarks
   * - **Algorithm:** re-reads the entitlement ({@link getPlanAccess}) for `current` and the features;
   *   `previous` is the state the finding left (the grace, or the old row's own plan) — not compared,
   *   because the entitlement moved by time (the grace end) or never moved (an off row already reads
   *   Free's). `changeKey` makes it once: the app keys its plan-change task by it.
   * - **Failure modes:** a read failure propagates; handler failures are logged by the bus.
   * - **Side effects:** the app's handler enqueues its plan-change task (WC-38).
   * - **Notes:** called by the check's job after its organization unit returned.
   */
  async emitPlanStateCheckFinding(options: {
    organizationPublicId: string;
    change: typeof PLAN_STATE_CHANGE.PLAN_ENDED | typeof PLAN_STATE_CHANGE.MOVED_DOWN;
    previous: PlanStateSnapshot;
    changeKey: string;
  }): Promise<void> {
    const current = await this.getPlanAccess({
      organizationPublicId: options.organizationPublicId,
    });
    await eventBus.emit(
      buildDomainEvent<PlanStateChangedPayload>({
        type: SUBSCRIPTION_EVENT.PLAN_STATE_CHANGED,
        payload: {
          organizationPublicId: options.organizationPublicId,
          change: options.change,
          previous: options.previous,
          current: { state: current.state, plan_public_id: current.plan?.publicId ?? null },
          features: current.features,
          kept_channel_account_public_ids: null,
          change_key: options.changeKey,
        },
      }),
    );
  }

  /**
   * Registers {@link emitPlanStateChanged} to run once the caller's unit of work has committed — the
   * Stripe webhook's plan-state cases (routes-final § 8.D BL22), which decide inside the event's
   * organization unit.
   *
   * @remarks
   * - **Algorithm:** {@link runEnqueueAfterCommit}: a rolled-back event registers nothing; outside any
   *   unit it runs at once.
   * - **Failure modes:** a failure after the commit is logged by the commit queue, never retried — the
   *   webhook's guarded write makes a re-run of the event emit nothing, so the plan-state check (WC-59,
   *   ROUTE row R52) is the backup for a lost one.
   * - **Side effects:** as {@link emitPlanStateChanged}.
   */
  async emitPlanStateChangedAfterCommit(
    options: Parameters<SubscriptionService['emitPlanStateChanged']>[0],
  ): Promise<void> {
    await runEnqueueAfterCommit(() => this.emitPlanStateChanged(options));
  }

  /**
   * Computes `seats_total` / `seats_used` for a subscription row (REQ-4).
   *
   * @remarks
   * - **Algorithm:** unpaid (INCOMPLETE / PAUSED) subscriptions and expired dunning grace use the
   *   Free ceiling, matching membership enforcement. Other rows use the plan's included seats
   *   (null = unlimited) — never `subscriptions.seats`, which is only the quantity billed in Stripe
   *   and follows the member count; `seats_used` is the ACTIVE + INVITED membership count from the injected
   *   {@link MembershipSeatUsagePort}.
   * - **Failure modes:** when the membership port is not wired, `seats_used` defaults to 0 (and a
   *   warning is logged) so the response shape stays stable for minimal/worker harnesses.
   * - **Side effects:** one cross-domain membership COUNT (under the organization RLS context) per call.
   * - **Notes:** the count is resolved ONCE per request and reused across every row (a list of an
   *   org's subscriptions all share the same organization seat usage).
   */
  private async decorateWithSeatCounts<TRow extends SubscriptionRowWithSeatState>({
    organization_public_id,
    rows,
  }: {
    organization_public_id: string;
    rows: TRow[];
  }): Promise<(TRow & { seats_total: number | null; seats_used: number })[]> {
    let seatsUsed = 0;
    if (this.membershipSeatUsage) {
      seatsUsed = await this.membershipSeatUsage.countActiveMembers({
        organizationPublicId: organization_public_id,
      });
    } else {
      logger.warn(
        { organizationPublicId: organization_public_id },
        'subscription.seats_used.membership_port_unwired',
      );
    }
    // Reuse each decision: grace may expire while the Free catalog lookup is pending.
    // One clock read for every row (`Date.now()`, which the seat suites pin).
    const now = new Date(Date.now());
    const freeSeatRequired = rows.map((row) => requiresFreeSeatCeiling({ seatState: row, now }));
    const freeSeatCeiling = freeSeatRequired.some(Boolean)
      ? await this.planService.getFreePlanSeatCeiling()
      : null;
    return rows.map((row, index) => ({
      ...row,
      seats_total: freeSeatRequired[index] ? freeSeatCeiling : row.plan_included_seats,
      seats_used: seatsUsed,
    }));
  }

  /**
   * Emits a subscription resource event with the subscription's public JSON.
   *
   * @remarks
   * - **Algorithm:** re-reads the row with its plan joined (the Stripe sync paths return the bare
   *   row), adds the seat counts ({@link decorateWithSeatCounts}) and serializes it exactly as the
   *   API does ({@link SubscriptionSerializer}).
   * - **Failure modes:** a read failure propagates into the caller's transaction; a row that is no
   *   longer readable emits nothing. Handler failures are swallowed by the bus.
   * - **Side effects:** the notify handler records PENDING webhook delivery attempts.
   * - **Notes:** call it inside the write's organization database context — the HTTP paths and the
   *   Stripe webhook dispatch both do — so the fan-out joins its transaction. Public so the Stripe
   *   webhook service emits through it with its worker-scoped repository.
   */
  async emitSubscriptionEvent(options: {
    type: SubscriptionEventType;
    /** Omitted on the Stripe webhook paths: the organization named by the current context. */
    organizationPublicId?: string;
    subscription: { public_id: string; organization_id: number };
    repositoryOverride?: SubscriptionRepository;
    /**
     * The row's customer-visible state before a Stripe sync; when given and unchanged, nothing is
     * emitted — the same-second reconciliation re-applies a change the HTTP mutation already announced.
     */
    previous?: SubscriptionPublicState | null;
    /**
     * Fail the caller when a handler fails (`emitStrict`) instead of logging and moving on. The
     * Stripe webhook dispatch sets it: its job then retries the whole event, while a swallowed failure
     * would lose the event for good (the watermark makes a re-run emit nothing).
     */
    propagateFailure?: boolean;
  }): Promise<void> {
    const repository = options.repositoryOverride ?? this.repository;
    const organizationPublicId =
      options.organizationPublicId ??
      (await repository.findOrganizationFromCurrentContext())?.public_id;
    if (organizationPublicId === undefined) return;
    const row = await repository.findByPublicId(
      options.subscription.public_id,
      options.subscription.organization_id,
    );
    if (!row) return;
    if (
      options.previous &&
      !subscriptionPublicStateChanged({ before: options.previous, after: row })
    )
      return;
    const [decorated] = await this.decorateWithSeatCounts({
      organization_public_id: organizationPublicId,
      rows: [row],
    });
    const event = buildDomainEvent<OrganizationResourceEventPayload>({
      type: options.type,
      payload: {
        organization_public_id: organizationPublicId,
        data: SubscriptionSerializer.one(decorated!),
      },
    });
    await (options.propagateFailure ? eventBus.emitStrict(event) : eventBus.emit(event));
  }

  /** The customer-visible state of a Stripe-backed row before a sync (see {@link emitSubscriptionEvent}). */
  async findStripeSubscriptionPublicState(options: {
    providerSubscriptionId: string;
    repositoryOverride?: SubscriptionRepository;
  }): Promise<StripeSubscriptionPriorState | null> {
    const repository = options.repositoryOverride ?? this.repository;
    return repository.findPublicStateByProviderSubscriptionId(options.providerSubscriptionId);
  }

  /**
   * Reads the org's active seat allowance under a row lock (REQ-4 seat enforcement).
   *
   * @remarks
   * - **Algorithm:** delegates to {@link SubscriptionRepository.findActiveSeatStateByOrganizationForUpdate},
   *   which takes `FOR UPDATE` on the active subscription row, then resolves the ceiling:
   *   active entitlement → plan `included_seats` (never `subscriptions.seats`, the billed quantity
   *   seat sync keeps equal to the member count); **no active subscription** (F3), an **unpaid
   *   INCOMPLETE / PAUSED subscription**, or a **dunning subscription past its grace window** (F4)
   *   → the Free-tier ceiling
   *   ({@link PlanService.getFreePlanSeatCeiling}). `null` still means "no ceiling to enforce"
   *   (unlimited plan, or no plan catalog configured).
   * - **Failure modes:** none beyond the underlying queries; the caller MUST already hold an
   *   organization DB context + transaction so the lock spans the subsequent membership insert.
   * - **Side effects:** acquires a `FOR UPDATE` row lock (released at the caller's COMMIT) when an
   *   active subscription exists. The Free-tier path has no subscription row to lock; the caller
   *   ({@link MembershipService} add-member) takes a per-organization advisory lock up front so the
   *   count+insert is serialized on the free path too (audit-#M1) — the seat cap no longer depends
   *   on the free ceiling happening to be 1. See `docs/reference/architecture/production-audit-decisions.md`.
   * - **Notes:** this is the cross-domain entry point tenancy's `MembershipService` calls to
   *   enforce the seat limit on add-member; it returns only the numeric ceiling, never the row.
   */
  async reserveSeatCeilingForMemberAdd(organization_id: number): Promise<number | null> {
    const seatState =
      await this.repository.findActiveSeatStateByOrganizationForUpdate(organization_id);
    if (requiresFreeSeatCeiling({ seatState, now: new Date(Date.now()) })) {
      return this.planService.getFreePlanSeatCeiling();
    }
    return seatState?.plan_included_seats ?? null;
  }

  /**
   * An organization's plan entitlement (owner decision D3; routes-final BL2) — the one plan read every
   * decision uses: `state` (`active`, `grace` or `read_only`), `graceEndsAt`, `trialEndsAt`, the plan
   * the organization's features come from and its typed `features` (BL12).
   *
   * @remarks
   * - **Algorithm:** one indexed read of the organization, its current subscription with its plan,
   *   and the catalog's Free plan ({@link SubscriptionRepository.findPlanAccessSubject}), decided by
   *   `resolvePlanAccess` (BL3: Free never ends; a lapsed paid plan has its dunning grace, then
   *   `read_only`; a cancelled paid plan is `read_only` from its period end). With
   *   `BILLING_READ_ONLY_ENFORCED` off the state is always `active`; the plan and features are read
   *   either way. PERSONAL organizations are always `active` on Free.
   * - **Failure modes:** a query failure propagates; a malformed plan row's features throw (BL12); an
   *   organization that does not exist reads `active` with no plan (the route's own checks answer).
   * - **Side effects:** none — read-only, Postgres only (no cache, BL2).
   * - **Notes:** `organizationPublicId` is one the caller has already proved — the signed `org`
   *   claim (the app write guard, `GET /auth/me/context`) or a switch's verified target — read under
   *   that organization's context, which a surrounding context for the same organization lends its
   *   transaction (me/context adds none). Read by `GET /auth/me/context` and the organization
   *   switches (`active_organization.plan_access`), by {@link assertOrganizationWritable}, and — from
   *   later iteration rows — by the account limit, the one feature check and the month limit.
   */
  async getPlanAccess({
    organizationPublicId,
    repositoryOverride,
  }: {
    organizationPublicId: string;
    /** The Stripe webhook's worker-scoped repository: read inside its organization unit, not a new one. */
    repositoryOverride?: SubscriptionRepository;
  }): Promise<PlanAccess> {
    const subject = repositoryOverride
      ? await repositoryOverride.findPlanAccessSubject(organizationPublicId)
      : await withAppDatabaseContext({
          scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId }),
          callback: () => this.repository.findPlanAccessSubject(organizationPublicId),
        });
    return resolvePlanAccess({
      subject,
      now: new Date(Date.now()),
      isReadOnlyEnforced: env.BILLING_READ_ONLY_ENFORCED,
    });
  }

  /**
   * Refuses a write from a read-only organization: 403 with `error.reason` `organization_read_only`.
   *
   * @remarks
   * - **Algorithm:** {@link getPlanAccess}; throws only for `read_only` — `active` and `grace` pass.
   * - **Failure modes:** `ForbiddenError` (`errors:organizationReadOnly`, reason
   *   `organization_read_only`); a query failure propagates.
   * - **Side effects:** none.
   * - **Notes:** the app domain runs it as a `preHandler` on the automation writes only — create,
   *   edit and delete (`POST /api/v1/app/automations`, `PATCH` and `DELETE
   *   /api/v1/app/automations/{automation_id}`; `src/domains/app/app-plan-access.ts`, launch D27).
   *   The app domain's other writes stay open, and so do billing, auth, user, tenancy and upload, so a
   *   read-only organization can still pay, sign in, manage its team, export its data, connect or
   *   disconnect Instagram and erase a contact's personal data; reads and running automations go on.
   */
  async assertOrganizationWritable({
    organizationPublicId,
  }: {
    organizationPublicId: string;
  }): Promise<void> {
    const access = await this.getPlanAccess({ organizationPublicId });
    if (access.state === PLAN_ACCESS_STATE.READ_ONLY) {
      throw new ForbiddenError('errors:organizationReadOnly').withReason('organization_read_only');
    }
  }

  /**
   * Best-effort enqueue of a Stripe seat-quantity reconciliation for an organization (REQ-4).
   *
   * @remarks
   * - **Algorithm:** fire-and-forget enqueue onto the seat-sync queue. Each enqueue is a distinct
   *   durable job; the worker re-reads the authoritative member count and pushes it to Stripe.
   * - **Failure modes:** swallows enqueue errors (logged) — a Redis blip must never fail the
   *   member-management or change-plan request that triggered it.
   * - **Side effects:** writes one job to the seat-sync queue.
   * - **Notes:** the cross-domain entry point tenancy's `MembershipService` calls after a member
   *   add/remove commits, and `changePlan` calls after a successful plan change. Off while
   *   {@link BILLING_SEAT_SYNC_ENABLED} is `false` (BL9, WC-65): members are unlimited, Stripe's
   *   quantity stays 1, nothing is enqueued.
   */
  enqueueSeatQuantitySync({
    organization_public_id,
    idempotencyKey,
  }: {
    organization_public_id: string;
    idempotencyKey?: string | undefined;
  }): void {
    if (!BILLING_SEAT_SYNC_ENABLED) return;
    // audit #1: stamp a STABLE idempotency token so every RETRY of the same job reuses it — the
    // Stripe quantity update is then deduped at Stripe instead of re-issued (which, with
    // proration/usage billing, would post duplicate proration line items). The member add/remove hot
    // path passes no key and gets an organization-scoped random token (a fresh one per enqueue avoids a stale
    // idempotent replay on an N→M→N seat oscillation).
    // sec-review: when the caller DOES supply a client key (`changePlan`), namespace it by organization before
    // it reaches Stripe as `${token}:qty:${n}` — otherwise two organizations reusing the same client-key string
    // with the same resulting seat count collide on ONE Stripe idempotency key across different
    // subscriptions (Stripe 400 param-mismatch → retries exhaust → seats never sync).
    const seatSyncToken =
      buildStripeIdempotencyKey({
        operation: 'sub-seat-sync',
        organizationPublicId: organization_public_id,
        clientKey: idempotencyKey,
      }) ?? `seat-sync:${organization_public_id}:${randomUUID()}`;
    enqueueSubscriptionSeatSyncBestEffort(
      omitUndefined({
        organizationPublicId: organization_public_id,
        idempotencyKey: seatSyncToken,
      }),
    );
  }

  /**
   * Reconciles the Stripe subscription quantity to the org's current member count (REQ-4).
   *
   * @remarks
   * - **Algorithm:** phase 1 (organization DB context) reads the active subscription; the Stripe quantity
   *   update then runs OUTSIDE any DB context (no checkout held across the round trip — mirrors the
   *   HTTP create/cancel/change-plan phasing); phase 2 (organization DB context) persists `subscriptions.seats`
   *   so reads reflect the synced quantity immediately (the `customer.subscription.updated` webhook
   *   also confirms it). Seat usage (ACTIVE + INVITED) comes from the injected membership port.
   * - **Failure modes:** a Stripe outage throws `ServiceUnavailableError` from the provider so the
   *   caller (BullMQ worker) retries; no active subscription / no member-port is a no-op, and so is an
   *   organization that no longer exists (deleted between the membership change and the job — a
   *   permanent condition, so retrying and dead-lettering it would only raise alerts). Local-only
   *   subscriptions (no `provider_subscription_id`) skip the Stripe call but still persist `seats`.
   * - **Side effects:** at most one Stripe update + one local `subscriptions.seats` write.
   * - **Notes:** safe to call from the seat-sync worker directly (it manages its own contexts, like
   *   `cancelActiveForOrganizationOffboarding`); never holds a checkout across the Stripe call.
   */
  async syncSeatQuantityForOrganization({
    organization_public_id,
    idempotencyKey,
  }: {
    organization_public_id: string;
    idempotencyKey?: string | undefined;
  }): Promise<void> {
    if (!this.membershipSeatUsage) {
      logger.warn(
        { organizationPublicId: organization_public_id },
        'subscription.seat_sync.membership_port_unwired',
      );
      return;
    }
    const phaseOne = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization_public_id }),
      callback: async () => {
        try {
          const organization =
            await this.organizationService.requireOrganizationByPublicId(organization_public_id);
          const subscription = await this.repository.findActiveByOrganization(organization.id);
          return { organization, subscription };
        } catch (error) {
          if (error instanceof NotFoundError) return null;
          throw error;
        }
      },
    });
    if (!phaseOne) {
      logger.info(
        { organizationPublicId: organization_public_id },
        'subscription.seat_sync.organization_gone',
      );
      return;
    }
    const { organization, subscription } = phaseOne;
    if (!subscription) return;

    const seatsUsed = await this.membershipSeatUsage.countActiveMembers({
      organizationPublicId: organization_public_id,
    });
    // Stripe requires quantity >= 1; never push 0 (which Stripe rejects) — clamp to 1 so a transient
    // empty-membership read cannot fail the sync.
    const quantity = Math.max(1, seatsUsed);

    // audit #1: scope the Stripe idempotency key by the resolved quantity. The base token is stable
    // across a job's retries (so a retried update with the SAME quantity is deduped at Stripe — no
    // duplicate proration); appending the quantity means a retry that recomputes a DIFFERENT desired
    // quantity becomes a distinct operation instead of a Stripe param-mismatch error. Undefined only
    // on a non-queue direct call (the enqueue path always stamps a token).
    const quantityUpdateIdempotencyKey =
      idempotencyKey !== undefined ? `${idempotencyKey}:qty:${quantity}` : undefined;

    // Stripe network call — OUTSIDE any database context.
    if (subscription.provider_subscription_id) {
      await this.paymentProvider.updateSubscriptionQuantity({
        providerSubscriptionId: subscription.provider_subscription_id,
        quantity,
        idempotencyKey: quantityUpdateIdempotencyKey,
      });
    }

    await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization_public_id }),
      callback: async () =>
        this.repository.update(subscription.public_id, organization.id, {
          seats: quantity,
        }),
    });
  }

  async syncFromStripeProviderSubscription({
    provider_subscription_id,
    data,
    stripe_event_created_at,
    repositoryOverride,
    reconciliation,
  }: {
    provider_subscription_id: string;
    data: SubscriptionUpdateData;
    stripe_event_created_at: Date;
    repositoryOverride?: SubscriptionRepository | undefined;
    reconciliation?: StripeSubscriptionOrderingState | undefined;
  }) {
    const repository = repositoryOverride ?? this.repository;
    return repository.syncFromStripeProviderSubscription(
      provider_subscription_id,
      data,
      stripe_event_created_at,
      ...(reconciliation ? [reconciliation] : []),
    );
  }

  async markCanceledByStripeProviderSubscriptionId({
    provider_subscription_id,
    stripe_event_created_at,
    repositoryOverride,
  }: {
    provider_subscription_id: string;
    stripe_event_created_at: Date;
    repositoryOverride?: SubscriptionRepository | undefined;
  }) {
    const repository = repositoryOverride ?? this.repository;
    return repository.markCanceledByProviderSubscriptionId(
      provider_subscription_id,
      stripe_event_created_at,
    );
  }

  /**
   * sec-B finding #5: existence check on a Stripe-side subscription id, used by the
   * webhook service to distinguish stale-event (no-op) from race-condition (retry)
   * when the sync UPDATE returns null. Routed through the service so tests inject
   * the worker-scoped repository the same way they do for sync/cancel.
   */
  async existsByStripeProviderSubscriptionId({
    provider_subscription_id,
    repositoryOverride,
  }: {
    provider_subscription_id: string;
    repositoryOverride?: SubscriptionRepository | undefined;
  }): Promise<boolean> {
    const repository = repositoryOverride ?? this.repository;
    return repository.existsByProviderSubscriptionId(provider_subscription_id);
  }

  /**
   * Fallback INSERT path for `customer.subscription.created` webhook events
   * whose local row is still missing (sec-B9).
   *
   * @remarks
   * When the Stripe webhook arrives before the HTTP create path has committed
   * the local row (typical B2 race in busy production traffic), the regular
   * sync UPDATE matches 0 rows and the event quietly advances to `processed` —
   * the user's first billing cycle is then invisible to local entitlement.
   * This method resolves the active organization context (`organizationPublicId`
   * is set by the webhook tenancy resolver before the dispatch) and inserts
   * the row with the worker-scoped repository. Returns `null` on a missing
   * organization (catalog drift; should already be caught by the tenancy
   * resolver but defensive here) so the caller can log + advance the ledger
   * rather than throw a non-retryable error.
   */
  async createFromStripeWebhookEvent(input: {
    providerSubscriptionId: string;
    providerCustomerId: string | null;
    planId: number;
    status: string;
    cancelAtPeriodEnd: boolean;
    canceledAt: Date | null;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    billingCycle: string;
    stripeEventCreatedAt: Date;
    repositoryOverride: SubscriptionRepository;
  }) {
    const organization = await input.repositoryOverride.findOrganizationFromCurrentContext();
    if (organization === null) {
      return null;
    }
    // SubscriptionCreateData does not carry cancel_at_period_end / canceled_at
    // — the subsequent customer.subscription.updated event (Stripe always
    // emits one shortly after .created) will sync those columns through the
    // regular UPDATE path. For a brand-new subscription they are essentially
    // always (false, null) anyway.
    return input.repositoryOverride.createUnlessProviderSubscriptionExists({
      organization_id: organization.id,
      plan_id: input.planId,
      billing_cycle: input.billingCycle,
      status: input.status,
      current_period_start: input.currentPeriodStart,
      current_period_end: input.currentPeriodEnd,
      provider: 'stripe',
      provider_subscription_id: input.providerSubscriptionId,
      ...(input.providerCustomerId !== null
        ? { provider_customer_id: input.providerCustomerId }
        : {}),
      last_stripe_event_created_at: input.stripeEventCreatedAt,
    });
  }

  /**
   * Insert a terminal CANCELED tombstone row for a Stripe
   * `customer.subscription.deleted` event whose local subscription row never
   * existed (audit-#1).
   *
   * @remarks
   * - **Algorithm:** resolves the internal organization id from the active
   *   webhook RLS context (set by the tenancy resolver before dispatch), then
   *   inserts a `CANCELED` row keyed by `provider_subscription_id` with the
   *   deletion event's `created` timestamp stamped on `last_stripe_event_created_at`.
   *   The partial unique index `idx_subscriptions_provider_subscription_id_unique`
   *   plus the terminal-status guard in {@link syncFromStripeProviderSubscription}
   *   then make any later out-of-order `.created` / `.updated` for the same id a
   *   no-op, closing the resurrection gap.
   * - **Failure modes:** returns `null` when the organization cannot be resolved
   *   (defensive — the tenancy resolver already throws earlier) so the caller can
   *   fall back to a retryable error instead of silently advancing the ledger, and
   *   when a concurrent insert already wrote the row for this
   *   `provider_subscription_id` (the caller treats that row as the winner).
   * - **Side effects:** one INSERT into `billing.subscriptions`.
   */
  async insertCanceledTombstoneFromStripeWebhookEvent(input: {
    providerSubscriptionId: string;
    providerCustomerId: string | null;
    planId: number;
    billingCycle: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    canceledAt: Date;
    stripeEventCreatedAt: Date;
    repositoryOverride: SubscriptionRepository;
  }) {
    const organization = await input.repositoryOverride.findOrganizationFromCurrentContext();
    if (organization === null) {
      return null;
    }
    return input.repositoryOverride.createUnlessProviderSubscriptionExists({
      organization_id: organization.id,
      plan_id: input.planId,
      billing_cycle: input.billingCycle,
      status: 'CANCELED',
      canceled_at: input.canceledAt,
      cancel_at_period_end: false,
      current_period_start: input.currentPeriodStart,
      current_period_end: input.currentPeriodEnd,
      provider: 'stripe',
      provider_subscription_id: input.providerSubscriptionId,
      ...(input.providerCustomerId !== null
        ? { provider_customer_id: input.providerCustomerId }
        : {}),
      last_stripe_event_created_at: input.stripeEventCreatedAt,
    });
  }

  /**
   * Inserts the organization's local `ACTIVE` Free row after its Stripe subscription ended on an
   * unpaid trial or a scheduled move to Free (routes-final § 8.D BL22; BL5, BL7), in the webhook's
   * organization unit — the same commit as the cancel.
   *
   * @remarks
   * - **Algorithm:** resolves the organization from the webhook context, then
   *   {@link SubscriptionRepository.createLocalFreeRowUnlessLive}: monthly, no Stripe id, the period
   *   from now to one month ahead (a Free row's period decides nothing — Free never ends, BL3).
   * - **Failure modes:** `null` when the organization cannot be resolved, or when it already holds a
   *   live row (it subscribed again meanwhile — that row is its plan).
   * - **Side effects:** at most one INSERT into `billing.subscriptions`.
   */
  async insertLocalFreeRowFromStripeWebhookEvent(input: {
    freePlanId: number;
    repositoryOverride: SubscriptionRepository;
  }) {
    const organization = await input.repositoryOverride.findOrganizationFromCurrentContext();
    if (organization === null) return null;
    const now = new Date();
    return input.repositoryOverride.createLocalFreeRowUnlessLive({
      organization_id: organization.id,
      plan_id: input.freePlanId,
      billing_cycle: 'MONTHLY',
      status: 'ACTIVE',
      current_period_start: now,
      current_period_end: addMonths({ base: now, months: 1 }),
    });
  }

  async list(scope: OrganizationPrincipalDatabaseScope) {
    const organization_public_id = scope.organizationPublicId;
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationByPublicId(organization_public_id);
        const rows = await this.repository.listByOrganization(organization.id);
        // REQ-4: enrich each row with seats_total / seats_used (cross-domain membership count).
        return this.decorateWithSeatCounts({ organization_public_id, rows });
      },
    });
  }

  async get({
    scope,
    subscription_public_id,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    subscription_public_id: string;
  }) {
    const organization_public_id = scope.organizationPublicId;
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationByPublicId(organization_public_id);
        const subscription = await this.repository.findByPublicId(
          subscription_public_id,
          organization.id,
        );
        if (!subscription) throw new NotFoundError('Subscription');
        // REQ-4: attach seats_total / seats_used to the single subscription.
        const [decorated] = await this.decorateWithSeatCounts({
          organization_public_id,
          rows: [subscription],
        });
        return decorated!;
      },
    });
  }

  /**
   * Returns the Stripe PaymentIntent `client_secret` for an INCOMPLETE subscription so the
   * frontend can confirm the first payment. Stripe network I/O runs outside RLS context.
   */
  async getPaymentSetup({
    scope,
    subscription_public_id,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    subscription_public_id: string;
  }) {
    const organization_public_id = scope.organizationPublicId;
    const providerSubscriptionId = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationByPublicId(organization_public_id);
        const subscription = await this.repository.findByPublicId(
          subscription_public_id,
          organization.id,
        );
        if (!subscription) throw new NotFoundError('Subscription');
        if (subscription.status !== 'INCOMPLETE') {
          return null;
        }
        return subscription.provider_subscription_id ?? null;
      },
    });

    if (!providerSubscriptionId) {
      return { client_secret: null as string | null };
    }

    const { isStripeConfigured, retrieveStripeSubscriptionPaymentClientSecret } = await import(
      '@/infrastructure/payment/stripe.client.js'
    );
    if (!isStripeConfigured()) {
      return { client_secret: null };
    }

    const client_secret = await retrieveStripeSubscriptionPaymentClientSecret({
      subscriptionId: providerSubscriptionId,
    });
    return { client_secret };
  }

  /**
   * Route 102: subscribe to a plan — or, with `is_trial`, start its 7-day no-card trial
   * (feat-instagram-dm-sending routes-final § 8.B BL14, BL7).
   *
   * @remarks
   * - **Algorithm:** under the per-organization Redis lock: (1) outside any unit, the entitlement
   *   before (for `PLAN_STATE_CHANGED`) and — for a trial — the organization's not-revoked accounts
   *   through the accounts port; (2) one organization unit: the team check, no live subscription, the
   *   plan and its cycle, and for a trial a paid plan (`422 plan_has_no_trial`) and the one-trial rules
   *   (`409 trial_already_used`); (3) Stripe, outside any unit (the trial settings with
   *   `PAID_TRIAL_DAYS`); (4) one unit: the row (`TRIALING`, `trial_end` = now + 7 days for a trial)
   *   and the `billing.trial_accounts` rows; (5) after commit, `PLAN_STATE_CHANGED` (`trial_started`,
   *   or `resumed` / `upgraded` when the entitlement moved).
   * - **Failure modes:** as built (`409 subscription_already_exists` / `subscription_create_in_progress`,
   *   `422`, `503`), plus the two above; a failed write cancels the Stripe subscription it made.
   * - **Side effects:** Stripe customer and subscription; one subscription row; the trial rows; the
   *   resource and plan-state events.
   * - **Notes:** answers the row with `trial_channel_account_count` for the trial's audit entry (BL10).
   */
  async create({
    scope,
    body,
    created_by_user_public_id,
    idempotencyKey,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    body: unknown;
    created_by_user_public_id: string | undefined;
    idempotencyKey?: string | undefined;
  }) {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateCreateSubscription(body);
    const isTrial = parsed.is_trial === true;
    // B4: serialize concurrent creates for one organization across the pre-check → Stripe create → insert
    // window so two requests with distinct idempotency keys cannot each mint a Stripe subscription
    // (the loser was previously compensated via cancel). The partial unique index + compensating
    // cancel below remain the durable correctness backstop if the lock ever lapses.
    const runCreate = async () => {
      const trialInstagramUserIds = await this.listTrialInstagramUserIds({
        organizationPublicId: organization_public_id,
        isTrial,
      });
      const { organization, plan, createdByUserInternalId } = await this.readCreateSubject({
        scope,
        parsed,
        isTrial,
        trialInstagramUserIds,
        created_by_user_public_id,
      });
      // The entitlement before, for `PLAN_STATE_CHANGED` after the commit (BL8).
      const previousAccess = await this.getPlanAccess({
        organizationPublicId: organization_public_id,
      });
      // A configured provider cannot bill a cycle without a price: same 422 as changePlan,
      // raised before any Stripe call.
      if (
        this.paymentProvider.isConfigured() &&
        !this.paymentProvider.getProviderPriceId({ plan, billingCycle: parsed.billing_cycle })
      ) {
        throw new UnprocessableEntityError('errors:planNotAvailableForBillingCycle');
      }

      const now = new Date();
      const { trialEnd, periodEnd } = firstSubscriptionPeriod({
        now,
        isTrial,
        billingCycle: parsed.billing_cycle,
      });

      // Bill every seat from the first invoice: the members the organization already has (Stripe
      // requires at least 1). A member who joins in between is reconciled by the seat sync after.
      const seatsUsed = this.membershipSeatUsage
        ? await this.membershipSeatUsage.countActiveMembers({
            organizationPublicId: organization_public_id,
          })
        : 1;

      // Stripe network call — outside any database context.
      const paymentResult = await this.paymentProvider.createSubscription(
        omitUndefined({
          organization,
          plan,
          billingCycle: parsed.billing_cycle,
          quantity: Math.max(1, seatsUsed),
          trialPeriodDays: isTrial ? PAID_TRIAL_DAYS : undefined,
          // audit #3: namespace the client key by organization before it reaches Stripe's global key space.
          idempotencyKey: buildStripeIdempotencyKey({
            operation: isTrial ? 'sub-create-trial' : 'sub-create',
            organizationPublicId: organization_public_id,
            clientKey: idempotencyKey,
          }),
        }),
      );

      const persisted = await this.persistCreatedSubscription({
        scope,
        organizationId: organization.id,
        planId: plan.id,
        paymentResult,
        trialInstagramUserIds: isTrial ? trialInstagramUserIds : null,
        values: omitUndefined({
          organization_id: organization.id,
          plan_id: plan.id,
          billing_cycle: parsed.billing_cycle.toUpperCase() as 'MONTHLY' | 'YEARLY',
          // Stripe's create response is authoritative: zero-price or already-paid
          // subscriptions may be ACTIVE despite default_incomplete. Preserve unpaid
          // INCOMPLETE and genuine TRIALING, without relying on an older creation
          // event to reconcile a row whose watermark already supersedes that event.
          // Disabled-provider subscriptions retain the repository's local default.
          status: paymentResult.initialStatus ?? (isTrial ? 'TRIALING' : undefined),
          current_period_start: now,
          current_period_end: periodEnd,
          trial_end: trialEnd,
          created_by_user_id: createdByUserInternalId ?? undefined,
          provider: paymentResult.providerSubscriptionId ? 'stripe' : undefined,
          provider_subscription_id: paymentResult.providerSubscriptionId,
          provider_customer_id: paymentResult.providerCustomerId,
          // sec-B2: stamp the watermark when Stripe accepted the subscription so a
          // late-arriving `customer.subscription.created` event (whose `created`
          // timestamp predates this moment) is filtered by the monotonic guard and
          // cannot regress the row to a stale earlier state. Unset when Stripe is
          // not configured (no webhook to reconcile, no watermark needed).
          last_stripe_event_created_at: paymentResult.providerSubscriptionId
            ? new Date()
            : undefined,
        }),
      });
      const completed = await this.completeCreatedSubscription({
        organization_public_id,
        created: persisted.row,
        ...(persisted.isWebhookRow ? {} : { idempotencyKey }),
      });
      await this.emitPlanStateChanged({
        organizationPublicId: organization_public_id,
        change: createdPlanStateChange({ isTrial, previousAccess }),
        previous: previousAccess,
      });
      return { ...completed, trial_channel_account_count: trialInstagramUserIds.length };
    };

    try {
      return await withRedisLock({
        options: {
          key: `billing:subscription:create:${organization_public_id}`,
          ttlSeconds: SUBSCRIPTION_CREATE_LOCK_TTL_SECONDS,
          waitTimeoutMs: SUBSCRIPTION_CREATE_LOCK_WAIT_MS,
        },
        fn: runCreate,
      });
    } catch (error) {
      if (error instanceof RedisLockUnavailableError) {
        // A concurrent create for this organization held the lock past our wait — return a retryable 409
        // instead of minting a second Stripe subscription. By the time the wait elapses the winner
        // has usually committed, so a retry gets a clean `subscriptionAlreadyExists`.
        throw new ConflictError('errors:subscriptionCreateInProgress').withReason(
          'subscription_create_in_progress',
        );
      }
      throw error;
    }
  }

  /**
   * Route 102's write after Stripe accepted the subscription: the row and, for a trial, its
   * `billing.trial_accounts` rows in one organization unit (BL14), with the resource event.
   *
   * @remarks
   * - **Failure modes:** the webhook fallback inserted the row first (the provider id's unique index)
   *   → that live row is answered (`isWebhookRow`), the trial rows written in their own unit; any other
   *   failure cancels the Stripe subscription (`compensateFailedCreate`) — a lost race for the
   *   organization's one live row is `409 subscription_already_exists`, a trial account another
   *   organization recorded meanwhile `409 trial_already_used`.
   * - **Side effects:** one subscription row, the trial rows, `subscription.created`.
   */
  private async persistCreatedSubscription({
    scope,
    organizationId,
    planId,
    paymentResult,
    trialInstagramUserIds,
    values,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    planId: number;
    paymentResult: { providerSubscriptionId?: string | undefined };
    /** The trial's Instagram user ids; `null` when this is not a trial. */
    trialInstagramUserIds: readonly string[] | null;
    values: SubscriptionCreateData;
  }): Promise<{
    row: Awaited<ReturnType<SubscriptionRepository['create']>>;
    isWebhookRow: boolean;
  }> {
    const recordTrial = async (subscriptionId: number) => {
      if (trialInstagramUserIds === null) return;
      await this.trialService.recordTrialStart({
        organizationId,
        planId,
        subscriptionId,
        instagramUserIds: trialInstagramUserIds,
      });
    };
    try {
      const row = await withAppDatabaseContext({
        scope,
        callback: async () => {
          const created = await this.repository.create(values);
          // BL14: the trial's accounts in the same commit — a race lost to another organization is
          // a 409 that rolls the row back (and the catch below cancels the Stripe subscription).
          await recordTrial(created.id);
          await this.emitSubscriptionEvent({
            type: SUBSCRIPTION_EVENT.CREATED,
            organizationPublicId: scope.organizationPublicId,
            subscription: created,
          });
          return created;
        },
      });
      return { row, isWebhookRow: false };
    } catch (error) {
      // The row for this Stripe subscription is already there: the webhook fallback inserted
      // it from `customer.subscription.created` first. It is live — never cancel it.
      const { providerSubscriptionId } = paymentResult;
      if (
        providerSubscriptionId &&
        getPostgresConstraintName(error) === 'idx_subscriptions_provider_subscription_id_unique'
      ) {
        const existing = await withAppDatabaseContext({
          scope,
          callback: async () => {
            const row = await this.repository.findByProviderSubscriptionId(providerSubscriptionId);
            // The trial's accounts still go with it (BL7), in their own unit.
            if (row) await recordTrial(row.id);
            return row;
          },
        });
        if (existing) return { row: existing, isWebhookRow: true };
      }
      // Only a failed write is compensated (the local row was not created): a failure after the
      // commit must never cancel a subscription the organization now has.
      if (providerSubscriptionId) {
        await this.paymentProvider.compensateFailedCreate(providerSubscriptionId);
      }
      // A concurrent create that lost the race to the partial unique index
      // surfaces as a 409 instead of a 500 (the Stripe sub is already rolled back above).
      if (isPostgresUniqueViolation(error)) {
        throw new ConflictError('errors:subscriptionAlreadyExists');
      }
      throw error;
    }
  }

  /**
   * Route 102's checks in one organization unit, before Stripe: the team check, no live
   * subscription, the active plan and its cycle, and for a trial a paid plan (`422 plan_has_no_trial`)
   * and the one-trial rules (`409 trial_already_used`, BL7).
   */
  private async readCreateSubject({
    scope,
    parsed,
    isTrial,
    trialInstagramUserIds,
    created_by_user_public_id,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    parsed: { plan_id: string; billing_cycle: 'monthly' | 'yearly' };
    isTrial: boolean;
    trialInstagramUserIds: readonly string[];
    created_by_user_public_id: string | undefined;
  }) {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        // Personal organizations cannot manage billing (assertTeamOrganization → 422).
        // Reject before the Stripe call so a personal organization gets 422, not a churned provider call.
        assertTeamOrganization({ organization, capability: 'BILLING' });
        // Reject before the Stripe call when a non-terminal subscription already
        // exists, so a duplicate request never churns the payment provider.
        const existingActive = await this.repository.findActiveByOrganization(organization.id);
        if (existingActive) {
          throw new ConflictError('errors:subscriptionAlreadyExists');
        }
        const plan = await this.planService.requireActivePlanByPublicId(parsed.plan_id);
        if (!supportsPlanBillingCycle({ plan, billingCycle: parsed.billing_cycle })) {
          throw new UnprocessableEntityError('errors:planNotAvailableForBillingCycle');
        }
        if (isTrial) {
          if (!isPaidPlan({ plan })) {
            throw new UnprocessableEntityError('errors:planHasNoTrial').withReason(
              'plan_has_no_trial',
            );
          }
          await this.trialService.assertOrganizationMayTrial({
            organizationId: organization.id,
            instagramUserIds: trialInstagramUserIds,
          });
        }
        const createdByUserInternalId =
          await this.organizationService.resolveUserInternalIdByPublicId(created_by_user_public_id);
        return { organization, plan, createdByUserInternalId };
      },
    });
  }

  /**
   * After a subscription is created: reconcile its Stripe quantity to the members who joined since
   * the count passed at creation (out-of-band, best-effort), and shape the response. REQ-4: a fresh
   * subscription has no Stripe-synced `seats` yet, so seats_total falls back to the plan's
   * included_seats; seats_used reflects current memberships.
   */
  private async completeCreatedSubscription({
    organization_public_id,
    created,
    idempotencyKey,
  }: {
    organization_public_id: string;
    created: Awaited<ReturnType<SubscriptionRepository['create']>>;
    idempotencyKey?: string | undefined;
  }) {
    this.enqueueSeatQuantitySync({ organization_public_id, idempotencyKey });
    const [decorated] = await this.decorateWithSeatCounts({
      organization_public_id,
      rows: [created],
    });
    return decorated!;
  }

  /**
   * After a Stripe event leaves a subscription without its paid entitlement (cancelled, expired,
   * paused, never paid), logs the loss once the event's unit of work commits. Nobody is
   * suspended: an organization that stops paying keeps its whole team (owner decision, 2026-10-17).
   *
   * @remarks
   * - **Algorithm:** returns at once for a status that keeps the entitlement; otherwise resolves
   *   the organization from the event's context and logs `billing.entitlement_lost` after commit,
   *   so a rolled-back event never reports a loss.
   * - **Failure modes:** none of its own; an organization that is gone is a no-op.
   * - **Side effects:** one warning log line. Only an owner's own plan downgrade still suspends
   *   members ({@link changePlan}).
   */
  async logEntitlementLossAfterCommit(options: {
    status: string;
    repositoryOverride: SubscriptionRepository;
  }): Promise<void> {
    if (
      !(TERMINAL_STATUSES.has(options.status) || UNPAID_ENTITLEMENT_STATUSES.has(options.status))
    ) {
      return;
    }
    const organization = await options.repositoryOverride.findOrganizationFromCurrentContext();
    if (!organization) return;
    const organizationPublicId = organization.public_id;
    await runEnqueueAfterCommit(async () => {
      logger.warn({ organizationPublicId, status: options.status }, 'billing.entitlement_lost');
    });
  }

  /**
   * Route 103: change plan — up at once, down at the period end with the accounts kept, or the same
   * plan to take a scheduled move back (feat-instagram-dm-sending routes-final § 8.B BL5, BL6, BL15).
   *
   * @remarks
   * - **Algorithm:** under the per-subscription Redis lock: (1) one organization unit reads the
   *   subscription, its plan and the target, and decides the direction
   *   ({@link decideChangePlanDirection}); (2) a move down checks `keep_channel_account_ids` against the
   *   accounts port and the new plan's `channel_accounts_max` ({@link assertKeptChannelAccounts}); (3)
   *   Stripe, outside any unit; (4) one unit writes the row. **Up:** the price swaps at once (as built)
   *   and any scheduled move is released; `PLAN_STATE_CHANGED` (`upgraded`) after commit. **Down:** a
   *   paid target is a Stripe subscription schedule (P77), Free is `cancel_at_period_end`; the row
   *   records `scheduled_plan_id`, `scheduled_change_at` (the period end, which a trial's end is) and
   *   `downgrade_keep` — the entitlement does not move until the period end (8.D applies it, ROUTE row
   *   R26). **Release:** the schedule (or Free's period-end cancel) is taken back and the three columns
   *   cleared.
   * - **Failure modes:** `400 keep_channel_account_ids`, `404`, `409 subscription_change_in_progress`,
   *   `422` (personal organization, terminal subscription, no price for the cycle), `503` (Stripe);
   *   a failed write after an immediate price swap swaps the price back (as built).
   * - **Side effects:** Stripe (price, schedule or period-end cancel); one row update; the resource and
   *   plan-state events. The member suspension on downgrade is gone (BL9 — plans carry no seats).
   */
  async changePlan({
    scope,
    subscription_public_id,
    body,
    idempotencyKey,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    subscription_public_id: string;
    body: unknown;
    idempotencyKey?: string | undefined;
  }) {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateChangePlan(body);
    // Two concurrent plan changes would both call Stripe and both write the plan from the same
    // snapshot — Stripe and the row could then disagree, and a failing one compensates Stripe back
    // to the price the OTHER request replaced. One at a time per subscription.
    try {
      return await withRedisLock({
        options: {
          key: `billing:subscription:change-plan:${subscription_public_id}`,
          ttlSeconds: SUBSCRIPTION_CREATE_LOCK_TTL_SECONDS,
          waitTimeoutMs: SUBSCRIPTION_CREATE_LOCK_WAIT_MS,
        },
        fn: async () => {
          const subject = await this.readChangePlanSubject({
            scope,
            subscription_public_id,
            targetPlanPublicId: parsed.plan_id,
          });
          const billingCycle =
            subject.subscription.billing_cycle === 'YEARLY' ? 'yearly' : 'monthly';
          const direction = decideChangePlanDirection({
            currentPlan: subject.previousPlan,
            targetPlan: subject.plan,
            billingCycle,
          });
          if (parsed.keep_channel_account_ids !== undefined) {
            assertKeptChannelAccounts({
              keepChannelAccountIds: parsed.keep_channel_account_ids,
              direction,
              accounts:
                direction === 'down' ? await this.listChannelAccounts(organization_public_id) : [],
              targetFeatures: subject.plan.features,
            });
          }
          const updated =
            direction === 'up'
              ? await this.changePlanNow({ scope, subject, billingCycle, idempotencyKey })
              : await this.scheduleOrReleasePlanChange({
                  scope,
                  subject,
                  direction,
                  billingCycle,
                  keepChannelAccountIds: parsed.keep_channel_account_ids ?? null,
                  idempotencyKey,
                });
          // REQ-4: a plan change can change the seat allowance and proration, so reconcile the
          // Stripe subscription quantity to the current member count out-of-band (never inline —
          // a Stripe outage must not fail the plan change). No-op for local-only subscriptions.
          this.enqueueSeatQuantitySync({ organization_public_id, idempotencyKey });
          const [decorated] = await this.decorateWithSeatCounts({
            organization_public_id,
            rows: [updated],
          });
          return decorated!;
        },
      });
    } catch (error) {
      if (error instanceof RedisLockUnavailableError) {
        throw new ConflictError('errors:subscriptionChangeInProgress').withReason(
          'subscription_change_in_progress',
        );
      }
      throw error;
    }
  }

  /** Route 103's reads in one organization unit: the team check, the target plan, the subscription. */
  private async readChangePlanSubject({
    scope,
    subscription_public_id,
    targetPlanPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    subscription_public_id: string;
    targetPlanPublicId: string;
  }) {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        // Personal organizations cannot manage billing — reject before the subscription
        // lookup so a personal organization gets 422 (capability unavailable), not 404.
        assertTeamOrganization({ organization, capability: 'BILLING' });
        const plan = await this.planService.requireActivePlanByPublicId(targetPlanPublicId);
        const subscription = await this.repository.findByPublicId(
          subscription_public_id,
          organization.id,
        );
        if (!subscription) throw new NotFoundError('Subscription');
        if (
          !supportsPlanBillingCycle({
            plan,
            billingCycle: subscription.billing_cycle === 'YEARLY' ? 'yearly' : 'monthly',
          })
        ) {
          throw new UnprocessableEntityError('errors:planNotAvailableForBillingCycle');
        }
        // sec-new-B1: terminal subscriptions cannot have their plan changed
        if (TERMINAL_STATUSES.has(subscription.status)) {
          throw new UnprocessableEntityError('errors:subscriptionNotMutable');
        }
        const previousPlan = await this.planService.requirePlanRecordByInternalId(
          subscription.plan_id,
        );
        return { organization, plan, subscription, previousPlan };
      },
    });
  }

  /**
   * Route 103 up (BL15, as built): the Stripe price swaps at once with proration, any scheduled move
   * down is released first, the row takes the new plan and drops the scheduled change;
   * `PLAN_STATE_CHANGED` (`upgraded`) after commit. A failed write swaps the Stripe price back.
   */
  private async changePlanNow({
    scope,
    subject,
    billingCycle,
    idempotencyKey,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    subject: ChangePlanSubject;
    billingCycle: 'monthly' | 'yearly';
    idempotencyKey: string | undefined;
  }) {
    const organization_public_id = scope.organizationPublicId;
    const { organization, plan, subscription, previousPlan } = subject;
    const previousAccess = await this.getPlanAccess({
      organizationPublicId: organization_public_id,
    });
    const providerPriceId = this.paymentProvider.getProviderPriceId({ plan, billingCycle });
    let providerPlanUpdated = false;

    // audit H2: fail closed before any local write when a Stripe-backed subscription
    // would change to a plan with no Stripe price for its cycle.
    assertProviderPriceForStripeBackedPlanChange({
      providerSubscriptionId: subscription.provider_subscription_id,
      providerPriceId,
    });

    // Stripe network calls — outside any database context. Fail-closed: a provider
    // failure throws ServiceUnavailableError here (before any local write), so the
    // local plan never silently diverges from Stripe. Local-only subscriptions
    // (no provider_subscription_id or no mapped price) skip the calls and proceed.
    if (subscription.provider_subscription_id) {
      await this.releaseProviderScheduledChange({
        subscription,
        organization_public_id,
        idempotencyKey,
      });
    }
    if (subscription.provider_subscription_id && providerPriceId) {
      await this.paymentProvider.updateSubscriptionPrice({
        providerSubscriptionId: subscription.provider_subscription_id,
        providerPriceId,
        idempotencyKey: buildStripeIdempotencyKey({
          operation: 'sub-change-plan',
          organizationPublicId: organization_public_id,
          clientKey: idempotencyKey,
        }),
      });
      providerPlanUpdated = true;
    }
    try {
      const updated = await this.writePlanChange({
        scope,
        organizationId: organization.id,
        subscription_public_id: subscription.public_id,
        data: {
          // The billing period is Stripe's (synced by the webhook): a plan change does not move it,
          // and writing back this request's snapshot could rewind a renewal synced meanwhile.
          plan_id: plan.id,
          ...CLEARED_SCHEDULED_CHANGE,
          ...(isScheduledFreeCancel(subscription) ? { cancel_at_period_end: false } : {}),
        },
      });
      await this.emitPlanStateChanged({
        organizationPublicId: organization_public_id,
        change: PLAN_STATE_CHANGE.UPGRADED,
        previous: previousAccess,
      });
      return updated;
    } catch (error) {
      if (providerPlanUpdated && subscription.provider_subscription_id) {
        const previousProviderPriceId = this.paymentProvider.getProviderPriceId({
          plan: previousPlan,
          billingCycle,
        });
        if (previousProviderPriceId) {
          await this.paymentProvider.compensatePlanChange({
            providerSubscriptionId: subscription.provider_subscription_id,
            previousProviderPriceId,
          });
        }
      }
      throw error;
    }
  }

  /**
   * Route 103 down or release (BL5, BL15). **Down:** a paid target is a Stripe subscription schedule
   * for the period end (P77), Free is Stripe's `cancel_at_period_end` (any schedule released first);
   * the row records `scheduled_plan_id`, `scheduled_change_at` (= `current_period_end`) and
   * `downgrade_keep`. **Release:** the schedule (or Free's period-end cancel) is taken back and the
   * three columns cleared. The entitlement does not move, so no plan-state event (AC-11.7).
   */
  private async scheduleOrReleasePlanChange({
    scope,
    subject,
    direction,
    billingCycle,
    keepChannelAccountIds,
    idempotencyKey,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    subject: ChangePlanSubject;
    direction: Exclude<ChangePlanDirection, 'up'>;
    billingCycle: 'monthly' | 'yearly';
    keepChannelAccountIds: string[] | null;
    idempotencyKey: string | undefined;
  }) {
    const organization_public_id = scope.organizationPublicId;
    const { organization, plan, subscription } = subject;
    const providerSubscriptionId = subscription.provider_subscription_id;
    const isTargetFree = !isPaidPlan({ plan });
    const providerPriceId = this.paymentProvider.getProviderPriceId({ plan, billingCycle });
    if (direction === 'down' && !isTargetFree) {
      assertProviderPriceForStripeBackedPlanChange({ providerSubscriptionId, providerPriceId });
    }
    // Stripe network calls — outside any database context.
    if (providerSubscriptionId) {
      await this.releaseProviderScheduledChange({
        subscription,
        organization_public_id,
        idempotencyKey,
      });
      if (direction === 'down' && isTargetFree) {
        await this.paymentProvider.cancelSubscriptionAtPeriodEnd({
          providerSubscriptionId,
          idempotencyKey: buildStripeIdempotencyKey({
            operation: 'sub-move-down-free',
            organizationPublicId: organization_public_id,
            clientKey: idempotencyKey,
          }),
        });
      } else if (direction === 'down' && providerPriceId) {
        await this.paymentProvider.schedulePriceChangeAtPeriodEnd({
          providerSubscriptionId,
          providerPriceId,
          idempotencyKey: buildStripeIdempotencyKey({
            operation: 'sub-move-down',
            organizationPublicId: organization_public_id,
            clientKey: idempotencyKey,
          }),
        });
      }
    }
    const data: SubscriptionUpdateData =
      direction === 'down'
        ? {
            scheduled_plan_id: plan.id,
            scheduled_change_at: subscription.current_period_end,
            downgrade_keep: keepChannelAccountIds,
            cancel_at_period_end: isTargetFree,
          }
        : {
            ...CLEARED_SCHEDULED_CHANGE,
            ...(isScheduledFreeCancel(subscription) ? { cancel_at_period_end: false } : {}),
          };
    return this.writePlanChange({
      scope,
      organizationId: organization.id,
      subscription_public_id: subscription.public_id,
      data,
    });
  }

  /**
   * Takes back a scheduled move down at Stripe before another change (BL5): the schedule is released,
   * and a scheduled move to Free (Stripe's period-end cancel) is resumed. Nothing scheduled → no call.
   */
  private async releaseProviderScheduledChange({
    subscription,
    organization_public_id,
    idempotencyKey,
  }: {
    subscription: ChangePlanSubject['subscription'];
    organization_public_id: string;
    idempotencyKey: string | undefined;
  }): Promise<void> {
    const providerSubscriptionId = subscription.provider_subscription_id;
    if (!(providerSubscriptionId && hasScheduledChange(subscription))) return;
    const keyFor = (operation: string) =>
      buildStripeIdempotencyKey({
        operation,
        organizationPublicId: organization_public_id,
        clientKey: idempotencyKey,
      });
    if (isScheduledFreeCancel(subscription)) {
      await this.paymentProvider.resumeSubscription({
        providerSubscriptionId,
        idempotencyKey: keyFor('sub-move-down-free-release'),
      });
      return;
    }
    await this.paymentProvider.releaseScheduledPriceChange({
      providerSubscriptionId,
      idempotencyKey: keyFor('sub-move-down-release'),
    });
  }

  /** Writes route 103's row change in one organization unit with the resource event (as built). */
  private async writePlanChange({
    scope,
    organizationId,
    subscription_public_id,
    data,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    subscription_public_id: string;
    data: SubscriptionUpdateData;
  }) {
    const updated = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const row = await this.repository.update(subscription_public_id, organizationId, {
          ...data,
          // sec-B3: stamp the watermark so a stale `customer.subscription.updated` event
          // delivered after this HTTP mutation cannot regress the plan back to its prior
          // price (the webhook guard accepts an event only when its `created` > watermark).
          last_stripe_event_created_at: new Date(),
        });
        if (row) {
          await this.emitSubscriptionEvent({
            type: SUBSCRIPTION_EVENT.UPDATED,
            organizationPublicId: scope.organizationPublicId,
            subscription: row,
          });
        }
        return row;
      },
    });
    if (!updated) throw new NotFoundError('Subscription');
    return updated;
  }

  async cancel({
    scope,
    subscription_public_id,
    idempotencyKey,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    subscription_public_id: string;
    idempotencyKey?: string | undefined;
  }) {
    const organization_public_id = scope.organizationPublicId;
    const { organization, subscription } = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationByPublicId(organization_public_id);
        // Personal organizations cannot manage billing — reject before the subscription
        // lookup so a personal organization gets 422 (capability unavailable), not 404.
        assertTeamOrganization({ organization, capability: 'BILLING' });
        const subscription = await this.repository.findByPublicId(
          subscription_public_id,
          organization.id,
        );
        if (!subscription) throw new NotFoundError('Subscription');
        // sec-new-B1: terminal subscriptions cannot be canceled (they are already non-billable)
        if (TERMINAL_STATUSES.has(subscription.status)) {
          throw new UnprocessableEntityError('errors:subscriptionNotMutable');
        }
        return { organization, subscription };
      },
    });

    // reaudit-#6: a never-activated INCOMPLETE subscription has no active period, so
    // `cancel_at_period_end` is a no-op and the row would keep occupying the org's single
    // subscription slot until a Stripe `incomplete_expired` webhook arrives — if that webhook
    // never lands, the organization is permanently locked out of re-subscribing. Cancel it immediately
    // (at Stripe and locally) so the slot is freed now, giving a programmatic exit.
    if (subscription.status === 'INCOMPLETE') {
      if (subscription.provider_subscription_id) {
        await this.paymentProvider.cancelSubscriptionImmediately({
          providerSubscriptionId: subscription.provider_subscription_id,
          idempotencyKey: buildStripeIdempotencyKey({
            operation: 'sub-cancel-now',
            organizationPublicId: organization_public_id,
            clientKey: idempotencyKey,
          }),
        });
      }
      const canceled = await withAppDatabaseContext({
        scope,
        callback: async () => {
          const row = await this.repository.update(subscription_public_id, organization.id, {
            status: 'CANCELED',
            canceled_at: new Date(),
            last_stripe_event_created_at: new Date(),
          });
          if (row) {
            await this.emitSubscriptionEvent({
              type: SUBSCRIPTION_EVENT.CANCELLED,
              organizationPublicId: organization_public_id,
              subscription: row,
            });
          }
          return row;
        },
      });
      if (!canceled) throw new NotFoundError('Subscription');
      const [decoratedCanceled] = await this.decorateWithSeatCounts({
        organization_public_id,
        rows: [canceled],
      });
      return decoratedCanceled!;
    }

    // Stripe network call — outside any database context.
    if (subscription.provider_subscription_id) {
      await this.paymentProvider.cancelSubscriptionAtPeriodEnd({
        providerSubscriptionId: subscription.provider_subscription_id,
        idempotencyKey: buildStripeIdempotencyKey({
          operation: 'sub-cancel',
          organizationPublicId: organization_public_id,
          clientKey: idempotencyKey,
        }),
      });
    }

    // Scheduling the cancellation is an update; `subscription.cancelled` fires when it ends.
    const updated = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const row = await this.repository.update(subscription_public_id, organization.id, {
          cancel_at_period_end: true,
          // sec-B3: stamp the watermark so a stale Stripe `updated` event arriving later
          // cannot regress `cancel_at_period_end` back to false and silently resume billing.
          last_stripe_event_created_at: new Date(),
        });
        if (row) {
          await this.emitSubscriptionEvent({
            type: SUBSCRIPTION_EVENT.UPDATED,
            organizationPublicId: organization_public_id,
            subscription: row,
          });
        }
        return row;
      },
    });
    if (!updated) throw new NotFoundError('Subscription');
    const [decorated] = await this.decorateWithSeatCounts({
      organization_public_id,
      rows: [updated],
    });
    return decorated!;
  }

  /**
   * Immediately cancels the organization's active subscription as part of organization offboarding
   * (route-audit-#2). Idempotent: a no-op when there is no active subscription.
   *
   * @remarks
   * - **Algorithm:** resolve the organization + its active subscription; if one exists, cancel it at Stripe
   *   NOW (not at period end — the organization is going away) and set the local row `CANCELED`.
   * - **Failure modes:** a Stripe outage throws `ServiceUnavailableError` (propagated), so the
   *   caller's organization delete aborts rather than soft-deleting an organization that keeps billing.
   * - **Side effects:** Stripe cancel + a local `subscriptions` update.
   * - **Notes:** deleting an organization previously left its subscription billing forever — no offboarding
   *   path touched billing. Re-running after a partial failure finds no active sub → no-op.
   */
  async cancelActiveForOrganizationOffboarding(organization_public_id: string): Promise<void> {
    const { organization, subscription } = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization_public_id }),
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationByPublicId(organization_public_id);
        const subscription = await this.repository.findActiveByOrganization(organization.id);
        return { organization, subscription };
      },
    });
    if (!subscription) return;

    // Stripe network call — outside any database context.
    if (subscription.provider_subscription_id) {
      // audit L1: stamp a deterministic idempotency key so an organization-delete retry
      // re-issues the SAME cancel (Stripe dedups) instead of an un-keyed duplicate.
      // No client key exists on the offboarding path, so the provider subscription
      // id is the stable per-subscription discriminator.
      await this.paymentProvider.cancelSubscriptionImmediately({
        providerSubscriptionId: subscription.provider_subscription_id,
        idempotencyKey: buildStripeIdempotencyKey({
          operation: 'sub-cancel-offboarding',
          organizationPublicId: organization_public_id,
          clientKey: subscription.provider_subscription_id,
        }),
      });
    }
    await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization_public_id }),
      callback: async () =>
        this.repository.update(subscription.public_id, organization.id, {
          status: 'CANCELED',
          canceled_at: new Date(),
          last_stripe_event_created_at: new Date(),
        }),
    });
  }

  async resume({
    scope,
    subscription_public_id,
    idempotencyKey,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    subscription_public_id: string;
    idempotencyKey?: string | undefined;
  }) {
    const organization_public_id = scope.organizationPublicId;
    const { organization, subscription } = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationByPublicId(organization_public_id);
        // Personal organizations cannot manage billing — reject before the subscription
        // lookup so a personal organization gets 422 (capability unavailable), not 404.
        assertTeamOrganization({ organization, capability: 'BILLING' });
        const subscription = await this.repository.findByPublicId(
          subscription_public_id,
          organization.id,
        );
        if (!subscription) throw new NotFoundError('Subscription');
        // sec-new-B1: terminal subscriptions cannot be resumed (already non-billable)
        if (TERMINAL_STATUSES.has(subscription.status)) {
          throw new UnprocessableEntityError('errors:subscriptionNotMutable');
        }
        return { organization, subscription };
      },
    });

    // Stripe network call — outside any database context.
    if (subscription.provider_subscription_id) {
      await this.paymentProvider.resumeSubscription({
        providerSubscriptionId: subscription.provider_subscription_id,
        idempotencyKey: buildStripeIdempotencyKey({
          operation: 'sub-resume',
          organizationPublicId: organization_public_id,
          clientKey: idempotencyKey,
        }),
      });
    }

    const updated = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const row = await this.repository.update(subscription_public_id, organization.id, {
          cancel_at_period_end: false,
          // sec-B4: do NOT force-write `status: 'ACTIVE'`. The Stripe webhook is the source
          // of truth for status — the real value may be PAST_DUE (failed payment) or
          // INCOMPLETE (3DS pending), and forcing ACTIVE here grants a transient
          // entitlement window before the follow-up `customer.subscription.updated` event
          // reconciles. The local row now only flips the cancel toggle.
          //
          // sec-B3: stamp the watermark so a stale Stripe `updated` event arriving later
          // (e.g. delayed from the cancel that we are reversing) cannot re-set
          // `cancel_at_period_end` back to true.
          last_stripe_event_created_at: new Date(),
        });
        if (row) {
          await this.emitSubscriptionEvent({
            type: SUBSCRIPTION_EVENT.UPDATED,
            organizationPublicId: organization_public_id,
            subscription: row,
          });
        }
        return row;
      },
    });
    if (!updated) throw new NotFoundError('Subscription');
    const [decorated] = await this.decorateWithSeatCounts({
      organization_public_id,
      rows: [updated],
    });
    return decorated!;
  }

  /**
   * Lists Stripe invoices for the organization's billing customer, one cursor page at a time.
   *
   * @remarks
   * - **Algorithm:** validates the cursor query (`limit` ≤ 100, `after` = a Stripe invoice id),
   *   fetches one Stripe page via `starting_after` + `limit`, and returns the standard list envelope
   *   (`items`/`limit`/`has_more`/`next_cursor`). The next cursor is the last row's Stripe id when
   *   Stripe reports `has_more`; `total` is always `null` (Stripe exposes no count).
   * - **Notes:** returns an empty page when Stripe is not configured or the organization has no provider
   *   customer yet. Invoices live in Stripe, not our DB — this is a cursor passthrough, not a keyset
   *   query, so it does not use the DB list helpers.
   */
  async listInvoices({
    scope,
    query,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    query: unknown;
  }) {
    const parsed = validateListInvoicesQuery(query);
    // `limit` is optional in the DTO (kept optional in OpenAPI) — apply the shared default here.
    const limit = parsed.limit ?? PAGINATION.DEFAULT_LIMIT;
    const emptyPage = {
      items: [] as ReturnType<typeof BillingAccountSerializer.invoices>,
      total: null,
      limit,
      has_more: false,
      next_cursor: null as string | null,
    };
    const customerId = await this.resolveStripeCustomerId(scope);
    if (!(customerId && isStripeConfigured())) {
      return emptyPage;
    }
    const page = await listStripeInvoices({
      customerId,
      options: {
        limit,
        ...(parsed.after ? { startingAfter: parsed.after } : {}),
      },
    });
    const items = BillingAccountSerializer.invoices(page.data);
    const lastItem = items.at(-1);
    return {
      items,
      total: null,
      limit,
      has_more: page.has_more,
      next_cursor: page.has_more ? (lastItem?.id ?? null) : null,
    };
  }

  /**
   * Lists card payment methods on the organization's Stripe customer.
   */
  async listPaymentMethods(scope: OrganizationPrincipalDatabaseScope) {
    const customerId = await this.resolveStripeCustomerId(scope);
    if (!(customerId && isStripeConfigured())) {
      return [];
    }
    const [methods, defaultId] = await Promise.all([
      listStripePaymentMethods({ customerId }),
      retrieveStripeCustomerDefaultPaymentMethodId({ customerId }),
    ]);
    return BillingAccountSerializer.paymentMethods({
      rows: methods,
      default_payment_method_id: defaultId,
    });
  }

  /**
   * Creates a SetupIntent `client_secret` so the frontend can add a card in-app.
   */
  async createPaymentMethodSetup({
    scope,
    idempotencyKey,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    idempotencyKey?: string | undefined;
  }) {
    const organization_public_id = scope.organizationPublicId;
    const customerId = await this.resolveStripeCustomerId(scope);
    if (!customerId) {
      throw new UnprocessableEntityError('errors:subscriptionNotMutable');
    }
    if (!isStripeConfigured()) {
      return { client_secret: null as string | null };
    }
    const client_secret = await createStripeSetupIntent({
      customerId,
      options: omitUndefined({
        idempotencyKey: idempotencyKey
          ? buildStripeIdempotencyKey({
              operation: 'pm-setup',
              organizationPublicId: organization_public_id,
              clientKey: idempotencyKey,
            })
          : undefined,
      }),
    });
    return { client_secret };
  }

  /**
   * Removes a card from the organization's Stripe customer (routes-final § 8.C BL20, route 105).
   *
   * @remarks
   * - **Algorithm:** reads the organization's live subscription row (team-only), closes that unit of
   *   work, then checks with Stripe that the card is the customer's; while a paid plan is on
   *   ({@link CARD_REQUIRED_SUBSCRIPTION_STATUSES} with a Stripe subscription) it lists the customer's
   *   cards and refuses removing the last one; then detaches it through the payment-provider port.
   * - **Failure modes:** `422` on a personal organization; `404` when there is no customer, Stripe has
   *   no such card or it is another customer's (no existence leak); `409 default_card_in_use`; `503`
   *   when Stripe is down or its circuit is open.
   * - **Side effects:** one Stripe detach. No database write.
   * - **Notes:** answers the removed card's public shape so the controller can audit brand and last 4.
   */
  async deletePaymentMethod({
    scope,
    payment_method_id,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    payment_method_id: string;
  }) {
    const { context, card } = await this.requireOrganizationCard({ scope, payment_method_id });
    const subscription = context.subscription;
    if (
      subscription?.provider_subscription_id &&
      CARD_REQUIRED_SUBSCRIPTION_STATUSES.has(subscription.status)
    ) {
      const cards = await listStripePaymentMethods({ customerId: context.customerId });
      if (!cards.some((other) => other.id !== payment_method_id)) {
        throw new ConflictError('errors:defaultCardInUse').withReason('default_card_in_use');
      }
    }
    await this.paymentProvider.detachPaymentMethod({ paymentMethodId: payment_method_id });
    return BillingAccountSerializer.paymentMethod({ row: card, is_default: false });
  }

  /**
   * Makes a card the default — the customer's and the live subscription's (routes-final § 8.C BL21,
   * route 106) — and answers the card list.
   *
   * @remarks
   * - **Algorithm:** the ownership check of {@link SubscriptionService.deletePaymentMethod}, then one
   *   provider call that sets the customer's `invoice_settings.default_payment_method` and, when the
   *   row has a Stripe subscription, its `default_payment_method`; then lists the cards with this one
   *   marked default.
   * - **Failure modes:** `422` on a personal organization; `404` as for the delete; `503` when Stripe
   *   is down or its circuit is open.
   * - **Side effects:** one or two Stripe updates, the client's `X-Idempotency-Key` forwarded as
   *   Stripe's idempotency key (per organization). Repeating it for the default card is harmless.
   */
  async setDefaultPaymentMethod({
    scope,
    payment_method_id,
    idempotencyKey,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    payment_method_id: string;
    idempotencyKey?: string | undefined;
  }) {
    const { context, card } = await this.requireOrganizationCard({ scope, payment_method_id });
    await this.paymentProvider.setDefaultPaymentMethod({
      providerCustomerId: context.customerId,
      providerSubscriptionId: context.subscription?.provider_subscription_id ?? null,
      paymentMethodId: payment_method_id,
      idempotencyKey: buildStripeIdempotencyKey({
        operation: 'pm-default',
        organizationPublicId: scope.organizationPublicId,
        clientKey: idempotencyKey,
      }),
    });
    const cards = await listStripePaymentMethods({ customerId: context.customerId });
    return {
      card: BillingAccountSerializer.paymentMethod({ row: card, is_default: true }),
      payment_methods: BillingAccountSerializer.paymentMethods({
        rows: cards,
        default_payment_method_id: payment_method_id,
      }),
    };
  }

  /**
   * The card routes' ownership check (BL20, BL21): the organization's customer and live subscription,
   * and the card when it is that customer's — else `404`, the same answer for no customer, no such
   * card and another customer's card.
   */
  private async requireOrganizationCard({
    scope,
    payment_method_id,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    payment_method_id: string;
  }) {
    const context = await this.resolveBillingCustomer(scope);
    const customerId = context.customerId;
    if (!(customerId && isStripeConfigured())) throw new NotFoundError('Payment method');
    const card = await retrieveStripePaymentMethod({ paymentMethodId: payment_method_id });
    const cardCustomerId = typeof card?.customer === 'string' ? card.customer : card?.customer?.id;
    if (!card || cardCustomerId !== customerId) throw new NotFoundError('Payment method');
    return { context: { customerId, subscription: context.subscription }, card };
  }

  /** Resolves the Stripe customer id from the org's active subscription row. */
  private async resolveStripeCustomerId(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<string | null> {
    return (await this.resolveBillingCustomer(scope)).customerId;
  }

  /**
   * The organization's live subscription row and its Stripe customer id, read in one unit of work
   * (team-only — `422` on a personal organization).
   */
  private async resolveBillingCustomer(scope: OrganizationPrincipalDatabaseScope) {
    const organization_public_id = scope.organizationPublicId;
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationByPublicId(organization_public_id);
        assertTeamOrganization({ organization, capability: 'BILLING' });
        const subscription = await this.repository.findActiveByOrganization(organization.id);
        return {
          customerId: subscription?.provider_customer_id ?? null,
          subscription: subscription
            ? {
                status: subscription.status,
                provider_subscription_id: subscription.provider_subscription_id,
              }
            : null,
        };
      },
    });
  }
}
