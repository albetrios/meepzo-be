import { MEMBERSHIP_STATUS } from '@/domains/tenancy/sub-domains/membership/membership.constants.js';
import { and, asc, desc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { alias } from 'drizzle-orm/pg-core';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import { databaseNowTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { DEFAULT_REPOSITORY_LIST_LIMIT } from '@/shared/constants/query-limits.constants.js';
import { capListWithWarning } from '@/shared/utils/infrastructure/list-cap.util.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { planFeaturesSchema } from '@/domains/billing/sub-domains/plan/plan.types.js';
import type {
  PlanAccessPlan,
  PlanAccessSubject,
  StripeSubscriptionPriorState,
  SubscriptionCreateData,
  SubscriptionUpdateData,
  StripeSubscriptionOrderingState,
} from './subscription.types.js';
import { organization_entitlement_overrides } from '@/domains/billing/sub-domains/entitlement/entitlement-override.schema.js';
import { parseEntitlementOverrides } from '@/domains/billing/sub-domains/entitlement/entitlement-override.util.js';

/** A joined plan's columns as one {@link PlanAccessPlan}, its features parsed; `null` when no row joined. */
function toPlanAccessPlan(columns: {
  public_id: string | null;
  name: string | null;
  is_active: boolean | null;
  price_monthly: string | null;
  price_yearly: string | null;
  features: unknown;
}): PlanAccessPlan | null {
  if (
    columns.public_id === null ||
    columns.name === null ||
    columns.is_active === null ||
    columns.price_monthly === null ||
    columns.price_yearly === null
  ) {
    return null;
  }
  return {
    public_id: columns.public_id,
    name: columns.name,
    is_active: columns.is_active,
    price_monthly: columns.price_monthly,
    price_yearly: columns.price_yearly,
    features: planFeaturesSchema.parse(columns.features),
  };
}

/**
 * Subscription statuses that release the per-organization subscription slot.
 *
 * @remarks
 * A subscription in one of these states neither occupies the single-subscription
 * slot (so the organization can create a fresh subscription) nor is mutable. This list is
 * the single source of truth shared by three call sites that must agree
 * (audit-#1): the `idx_subscriptions_org` partial-unique index predicate, the
 * {@link SubscriptionRepository.findActiveByOrganization} filter, and the
 * service-layer `TERMINAL_STATUSES` guard. `INCOMPLETE_EXPIRED` is included so an
 * abandoned-checkout subscription cannot permanently lock the organization out
 * of re-subscribing.
 */
export const INACTIVE_SUBSCRIPTION_STATUSES = ['CANCELED', 'INCOMPLETE_EXPIRED'] as const;

/**
 * Drizzle `select` projection that mirrors every {@link subscriptions} column and adds
 * the joined `billing.plans.public_id` as `plan_public_id` so the response serializer
 * (sec-re-07) can surface a stable public plan reference without leaking the bigserial
 * `plan_id` (which sec-T #17 correctly strips).
 */
const subscriptionRowWithPlanPublicId = {
  id: subscriptions.id,
  public_id: subscriptions.public_id,
  organization_id: subscriptions.organization_id,
  plan_id: subscriptions.plan_id,
  status: subscriptions.status,
  billing_cycle: subscriptions.billing_cycle,
  // REQ-4: purchased seat quantity (synced from Stripe; NULL until first sync).
  seats: subscriptions.seats,
  current_period_start: subscriptions.current_period_start,
  current_period_end: subscriptions.current_period_end,
  trial_end: subscriptions.trial_end,
  cancel_at_period_end: subscriptions.cancel_at_period_end,
  canceled_at: subscriptions.canceled_at,
  provider: subscriptions.provider,
  provider_subscription_id: subscriptions.provider_subscription_id,
  provider_customer_id: subscriptions.provider_customer_id,
  created_at: subscriptions.created_at,
  updated_at: subscriptions.updated_at,
  created_by_user_id: subscriptions.created_by_user_id,
  updated_by_user_id: subscriptions.updated_by_user_id,
  last_stripe_event_created_at: subscriptions.last_stripe_event_created_at,
  scheduled_plan_id: subscriptions.scheduled_plan_id,
  scheduled_change_at: subscriptions.scheduled_change_at,
  downgrade_keep: subscriptions.downgrade_keep,
  /** The scheduled plan's public id (BL5), read through a sub-select — `null` with no scheduled change. */
  scheduled_plan_public_id: sql<
    string | null
  >`(SELECT scheduled_plan.public_id FROM billing.plans AS scheduled_plan WHERE scheduled_plan.id = ${subscriptions.scheduled_plan_id})`,
  plan_public_id: plans.public_id,
  // REQ-4: the joined plan's seat allowance — the fallback for seats_total when the
  // subscription has no Stripe-synced `seats` yet.
  plan_included_seats: plans.included_seats,
} as const;

/** The column values of a new subscription row (a fresh public id each call — see `create`). */
function buildSubscriptionInsertValues(data: SubscriptionCreateData) {
  return {
    public_id: generatePublicId('subscription'),
    organization_id: data.organization_id,
    plan_id: data.plan_id,
    billing_cycle: data.billing_cycle,
    status: data.status ?? 'TRIALING',
    current_period_start: data.current_period_start,
    current_period_end: data.current_period_end,
    trial_end: data.trial_end,
    // audit-#1: the deletion-tombstone path persists a terminal CANCELED row
    // (with canceled_at / cancel_at_period_end) so a later out-of-order
    // `customer.subscription.created` cannot resurrect it. Every other path
    // leaves these at their column defaults (NULL / false).
    canceled_at: data.canceled_at,
    cancel_at_period_end: data.cancel_at_period_end,
    provider: data.provider,
    provider_subscription_id: data.provider_subscription_id,
    provider_customer_id: data.provider_customer_id,
    created_by_user_id: data.created_by_user_id,
    last_stripe_event_created_at: data.last_stripe_event_created_at,
  };
}

/**
 * Drizzle access to the `billing.subscriptions` table — a **mutable state table**, not an
 * immutable append-only ledger (audit-#B2). Rows are updated in place as the subscription
 * transitions status (Stripe syncs, cancel/resume, plan changes, seat counts); they are never
 * hard-deleted in normal flow. DB-level append-only enforcement (as on `audit.logs`) is
 * intentionally NOT applied here because in-place status transitions are the table's core purpose —
 * immutability is scoped to the monotonic `last_stripe_event_created_at` watermark guard below,
 * which prevents stale/out-of-order events from regressing the row, not to the row as a whole.
 *
 * @remarks
 * - **Algorithm:** Each organization is constrained to a single *non-terminal*
 *   subscription row by the partial unique index `idx_subscriptions_org`
 *   (`UNIQUE(organization_id) WHERE status NOT IN ('CANCELED',
 *   'INCOMPLETE_EXPIRED')`), so a fresh subscription can be created once a prior
 *   one is canceled or an abandoned-checkout row expires (audit-#1). Stripe-driven
 *   writes
 *   ({@link syncFromStripeProviderSubscription},
 *   {@link markCanceledByProviderSubscriptionId}) gate the update on
 *   `last_stripe_event_created_at` being `NULL` or strictly older than the incoming
 *   event timestamp so out-of-order or same-second stale events are dropped. The
 *   in-place sync uses strict `<` while cancellation uses `<=`; this asymmetry is
 *   deliberate and makes a terminal cancel **deterministically win** a same-second
 *   in-place update regardless of delivery order (audit-#6, locked by test). Stripe
 *   `event.created` has 1-second resolution, so a created/updated event in the same
 *   second as the stored watermark is resolved by re-reading the subscription from
 *   Stripe: the sync's `reconciliation` branch applies that snapshot only to the row
 *   version (`xmin`) it was read against, keeping the watermark with `GREATEST`.
 * - **Failure modes:** Insert collisions on `public_id` are retried by
 *   {@link runInsertWithPublicIdentifierRetry}; updates that miss the
 *   timestamp guard return `null` to the caller so the worker can log a stale
 *   event instead of writing.
 * - **Side effects:** Writes the `subscriptions` table only; all queries run
 *   under either an organization RLS context (HTTP) or a worker-supplied
 *   handle from {@link createWorkerSubscriptionRepository}.
 * - **Notes:** Tenant isolation is enforced by both the WHERE clauses and the
 *   `subscriptions_tenant_isolation` RLS policy on the table.
 */
export class SubscriptionRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  async listByOrganization(organization_id: number, limit = DEFAULT_REPOSITORY_LIST_LIMIT) {
    // Fetch one extra row so a hit on the cap is observable instead of a silent truncation.
    // sec-re-07: left-join plans so the serializer can surface plan_public_id as the
    // documented public `plan_id` field without leaking the bigserial.
    const rows = await this.db()
      .select(subscriptionRowWithPlanPublicId)
      .from(subscriptions)
      .leftJoin(plans, eq(subscriptions.plan_id, plans.id))
      .where(eq(subscriptions.organization_id, organization_id))
      // audit #37: deterministic order so the cap truncates the OLDEST rows, not an arbitrary set,
      // if an organization ever exceeds the cap (churned CANCELED history).
      .orderBy(desc(subscriptions.created_at), desc(subscriptions.id))
      .limit(limit + 1);
    return capListWithWarning({
      rows,
      limit,
      resource: 'billing.subscriptions',
      context: { organizationId: organization_id },
    });
  }

  async findActiveByOrganization(organization_id: number) {
    // sec-re-07: join plans for `plan_public_id` (see listByOrganization).
    const rows = await this.db()
      .select(subscriptionRowWithPlanPublicId)
      .from(subscriptions)
      .leftJoin(plans, eq(subscriptions.plan_id, plans.id))
      .where(
        and(
          eq(subscriptions.organization_id, organization_id),
          // audit-#1: exclude every slot-releasing status (CANCELED AND
          // INCOMPLETE_EXPIRED), kept in lockstep with the idx_subscriptions_org
          // partial-unique predicate so an abandoned-checkout row does not block
          // re-subscription.
          notInArray(subscriptions.status, [...INACTIVE_SUBSCRIPTION_STATUSES]),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Resolves the org's active subscription seat allowance while holding a row lock (REQ-4).
   *
   * @remarks
   * - **Algorithm:** two queries in the caller's transaction: (1) `SELECT ... FOR UPDATE` on the
   *   active (non-terminal) `subscriptions` row alone — NO join, because Postgres rejects
   *   `FOR UPDATE` against the nullable side of an outer join (`42601`) — so a concurrent member-add
   *   blocks on this row until the caller's seat check + membership insert commit, closing the
   *   two-concurrent-adds-exceed-the-limit race. (2) a plain (unlocked) lookup of the plan's
   *   `included_seats` (a global catalog row that must NOT be locked). Returns
   *   `plan_included_seats` (the ceiling; null = unlimited) with the status and period the caller
   *   needs for the Free-ceiling decisions.
   * - **Failure modes:** returns `null` when the organization has no active subscription (the seat check is
   *   then a no-op — the billing-free flow still works).
   * - **Side effects:** acquires a row-level `FOR UPDATE` lock released at the enclosing
   *   transaction's COMMIT/ROLLBACK; the caller MUST run inside a transaction for the lock to span
   *   the subsequent insert.
   */
  async findActiveSeatStateByOrganizationForUpdate(organization_id: number): Promise<{
    plan_included_seats: number | null;
    status: string;
    current_period_end: Date;
  } | null> {
    const lockedRows = await this.db()
      .select({
        plan_id: subscriptions.plan_id,
        status: subscriptions.status,
        current_period_end: subscriptions.current_period_end,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organization_id, organization_id),
          notInArray(subscriptions.status, [...INACTIVE_SUBSCRIPTION_STATUSES]),
        ),
      )
      .limit(1)
      .for('update');
    const locked = lockedRows[0];
    if (!locked) return null;
    // Plan is a global catalog row — read its seat allowance WITHOUT a lock.
    const planRows = await this.db()
      .select({ included_seats: plans.included_seats })
      .from(plans)
      .where(eq(plans.id, locked.plan_id))
      .limit(1);
    return {
      plan_included_seats: planRows[0]?.included_seats ?? null,
      status: locked.status,
      current_period_end: locked.current_period_end,
    };
  }

  /**
   * What an organization's plan entitlement is decided from (owner decision D3, routes-final BL2): the
   * organization's type, its current subscription — the live (non-terminal) row when it has one, else
   * its most recent — with that subscription's plan, and the catalog's Free plan.
   *
   * @remarks
   * - **Algorithm:** one query: the organization row LEFT JOIN its subscriptions (served by
   *   `idx_subscriptions_org_status`) LEFT JOIN the subscription's plan LEFT JOIN the Free plan (the
   *   active plan priced zero on both cycles, lowest id — a scalar subquery over the small catalog),
   *   ordered live-first then newest, `LIMIT 1`. An organization has one live row at most
   *   (`idx_subscriptions_org`) and a short history. Both plans' features are parsed with
   *   `planFeaturesSchema` (BL12) — a malformed row throws.
   * - **Failure modes:** returns `null` when the organization is not visible in the current context
   *   (RLS) or does not exist; `subscription` is `null` when it never had one; `freePlan` is `null`
   *   when the catalog has no Free plan.
   * - **Side effects:** none — read-only, under the caller's organization context.
   */
  /**
   * Whether the organization ever had a trial (BL7): a subscription row of it with `trial_end` set —
   * rows are never deleted (billing ledgers). Served by `idx_subscriptions_org_trialled`.
   */
  async hasOrganizationTrialled(organization_id: number): Promise<boolean> {
    const rows = await this.db()
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organization_id, organization_id),
          sql`${subscriptions.trial_end} IS NOT NULL`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async findPlanAccessSubject(organization_public_id: string): Promise<PlanAccessSubject | null> {
    const freePlan = alias(plans, 'free_plan');
    const rows = await this.db()
      .select({
        organization_type: organizations.type,
        subscription_status: subscriptions.status,
        subscription_current_period_end: subscriptions.current_period_end,
        subscription_trial_end: subscriptions.trial_end,
        plan_public_id: plans.public_id,
        plan_name: plans.name,
        plan_is_active: plans.is_active,
        plan_price_monthly: plans.price_monthly,
        plan_price_yearly: plans.price_yearly,
        plan_features: plans.features,
        free_plan_public_id: freePlan.public_id,
        free_plan_name: freePlan.name,
        free_plan_is_active: freePlan.is_active,
        free_plan_price_monthly: freePlan.price_monthly,
        free_plan_price_yearly: freePlan.price_yearly,
        free_plan_features: freePlan.features,
        // P270: the organization's not-deleted overrides, in the same read (BL2) — expired ones too;
        // `resolvePlanAccess` keeps those in force at its clock.
        overrides: sql<unknown>`(
          SELECT coalesce(
            jsonb_agg(
              jsonb_build_object(
                'key', ${organization_entitlement_overrides.key},
                'value', ${organization_entitlement_overrides.value},
                'expires_at', ${organization_entitlement_overrides.expires_at}
              )
              ORDER BY ${organization_entitlement_overrides.key}
            ),
            '[]'::jsonb
          )
          FROM ${organization_entitlement_overrides}
          WHERE ${organization_entitlement_overrides.organization_id} = ${organizations.id}
            AND ${organization_entitlement_overrides.deleted_at} IS NULL
        )`,
      })
      .from(organizations)
      .leftJoin(subscriptions, eq(subscriptions.organization_id, organizations.id))
      .leftJoin(plans, eq(plans.id, subscriptions.plan_id))
      .leftJoin(
        freePlan,
        eq(
          freePlan.id,
          sql`(SELECT ${plans.id} FROM ${plans} WHERE ${plans.is_active} AND ${plans.price_monthly} = 0 AND ${plans.price_yearly} = 0 ORDER BY ${plans.id} LIMIT 1)`,
        ),
      )
      .where(eq(organizations.public_id, organization_public_id))
      .orderBy(
        // false (live) sorts before true (terminal); an organization without rows has one NULL row.
        asc(inArray(subscriptions.status, [...INACTIVE_SUBSCRIPTION_STATUSES])),
        desc(subscriptions.created_at),
        desc(subscriptions.id),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      organization: { type: row.organization_type },
      subscription:
        row.subscription_status === null || row.subscription_current_period_end === null
          ? null
          : {
              status: row.subscription_status,
              current_period_end: row.subscription_current_period_end,
              trial_end: row.subscription_trial_end,
              plan: toPlanAccessPlan({
                public_id: row.plan_public_id,
                name: row.plan_name,
                is_active: row.plan_is_active,
                price_monthly: row.plan_price_monthly,
                price_yearly: row.plan_price_yearly,
                features: row.plan_features,
              }),
            },
      freePlan: toPlanAccessPlan({
        public_id: row.free_plan_public_id,
        name: row.free_plan_name,
        is_active: row.free_plan_is_active,
        price_monthly: row.free_plan_price_monthly,
        price_yearly: row.free_plan_price_yearly,
        features: row.free_plan_features,
      }),
      overrides: parseEntitlementOverrides(
        Array.isArray(row.overrides)
          ? (row.overrides as { key: unknown; value: unknown; expires_at: unknown }[])
          : [],
      ),
    };
  }

  async findByPublicId(public_id: string, organization_id: number) {
    // sec-re-07: join plans for `plan_public_id` (see listByOrganization).
    const rows = await this.db()
      .select(subscriptionRowWithPlanPublicId)
      .from(subscriptions)
      .leftJoin(plans, eq(subscriptions.plan_id, plans.id))
      .where(
        and(
          eq(subscriptions.public_id, public_id),
          eq(subscriptions.organization_id, organization_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The row for one Stripe subscription in the current organization context (with
   * `plan_public_id`), or `null` — the HTTP create's fallback when the webhook inserted it first.
   */
  async findByProviderSubscriptionId(provider_subscription_id: string) {
    const rows = await this.db()
      .select(subscriptionRowWithPlanPublicId)
      .from(subscriptions)
      .leftJoin(plans, eq(subscriptions.plan_id, plans.id))
      .where(eq(subscriptions.provider_subscription_id, provider_subscription_id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Resolves the organization (internal id + public id) named by the active webhook RLS context.
   * Used by the Stripe webhook paths (the sec-B9 fallback INSERT, the cancellation tombstone, the
   * subscription events) so they do not have to take an `OrganizationService` dependency just to
   * map the public id baked into the GUC by `runStripeWebhookHandlerWithOrganizationContext`.
   */
  async findOrganizationFromCurrentContext(): Promise<{ id: number; public_id: string } | null> {
    const rows = await this.db()
      .select({ id: organizations.id, public_id: organizations.public_id })
      .from(organizations)
      .where(
        sql`${organizations.public_id} = current_setting('app.current_organization_public_id', true)`,
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async create(data: SubscriptionCreateData) {
    const inserted = await runInsertWithPublicIdentifierRetry({
      insert: async () => {
        const rows = await this.db()
          .insert(subscriptions)
          .values(buildSubscriptionInsertValues(data))
          .returning();
        return rows[0]!;
      },
    });
    return this.reloadInsertedSubscription(inserted.public_id, data.organization_id);
  }

  /**
   * Inserts a Stripe-backed row unless one already exists for its `provider_subscription_id` — the
   * webhook paths, where a concurrent `.created` / `.deleted` may have written it first. `null`
   * when one did: `ON CONFLICT DO NOTHING` on that index alone keeps the transaction usable (a
   * caught unique violation would have aborted it), and any other violation still throws.
   */
  async createUnlessProviderSubscriptionExists(data: SubscriptionCreateData) {
    const inserted = await runInsertWithPublicIdentifierRetry({
      insert: async () => {
        const rows = await this.db()
          .insert(subscriptions)
          .values(buildSubscriptionInsertValues(data))
          .onConflictDoNothing({
            target: subscriptions.provider_subscription_id,
            where: sql`${subscriptions.provider_subscription_id} IS NOT NULL`,
          })
          .returning();
        return rows[0] ?? null;
      },
    });
    return inserted === null
      ? null
      : this.reloadInsertedSubscription(inserted.public_id, data.organization_id);
  }

  /**
   * Inserts the organization's local `ACTIVE` Free row (no Stripe id) unless it already holds a live
   * row — the Stripe webhook's unpaid trial end and scheduled move to Free (routes-final § 8.D BL22).
   * `null` when a live row exists: `ON CONFLICT DO NOTHING` on the one-live-row index
   * (`idx_subscriptions_org`) keeps the webhook's transaction usable (a caught unique violation would
   * abort it) — the organization subscribed again meanwhile, and that row is its plan.
   */
  async createLocalFreeRowUnlessLive(data: SubscriptionCreateData) {
    const inserted = await runInsertWithPublicIdentifierRetry({
      insert: async () => {
        const rows = await this.db()
          .insert(subscriptions)
          .values(buildSubscriptionInsertValues(data))
          .onConflictDoNothing({
            target: subscriptions.organization_id,
            where: sql`${subscriptions.status} NOT IN ('CANCELED', 'INCOMPLETE_EXPIRED')`,
          })
          .returning();
        return rows[0] ?? null;
      },
    });
    return inserted === null
      ? null
      : this.reloadInsertedSubscription(inserted.public_id, data.organization_id);
  }

  /**
   * sec-re-07: re-select with the plans join so the returned row carries plan_public_id for the
   * HTTP serializer. The follow-up SELECT runs inside the same caller-supplied context
   * (organization for HTTP, worker handle for the webhook fallback path) so RLS still applies — a
   * successful INSERT in this context is guaranteed visible to the same context's SELECT, so a
   * missing row would mean a bug elsewhere (and we'd rather surface that loudly than return a row
   * that's silently missing plan_public_id).
   */
  private async reloadInsertedSubscription(public_id: string, organization_id: number) {
    const joined = await this.findByPublicId(public_id, organization_id);
    if (!joined) {
      throw new Error(
        `subscription.create: row ${public_id} not visible after insert (context/RLS mismatch?)`,
      );
    }
    return joined;
  }

  async update(public_id: string, organization_id: number, data: SubscriptionUpdateData) {
    const rows = await this.db()
      .update(subscriptions)
      .set({
        ...data,
        updated_at: databaseNowTimestamp,
      })
      .where(
        and(
          eq(subscriptions.public_id, public_id),
          eq(subscriptions.organization_id, organization_id),
          // Terminal subscriptions are immutable. Refuse to mutate a CANCELED / INCOMPLETE_EXPIRED
          // row even if a concurrent webhook moved it there AFTER the service's TERMINAL_STATUSES
          // read-check — a compare-and-set that closes the terminal-guard TOCTOU (route-audit B6).
          notInArray(subscriptions.status, [...INACTIVE_SUBSCRIPTION_STATUSES]),
        ),
      )
      .returning({ id: subscriptions.id });
    if (rows.length === 0) return null;
    // sec-re-07: re-select with the plans join so the HTTP response carries
    // plan_public_id. The two-step (UPDATE then SELECT) runs inside the
    // caller's existing RLS context so the SELECT can never see a row
    // outside the organization.
    return this.findByPublicId(public_id, organization_id);
  }

  /**
   * Returns true when a local row already exists for `provider_subscription_id` (regardless
   * of organization context — this is a system-level existence check). Used by the Stripe
   * webhook service to distinguish two failure modes of {@link syncFromStripeProviderSubscription}
   * returning null (sec-B finding #5):
   *   1. The row does not exist yet (Stripe outran our HTTP create — retryable race).
   *   2. The row exists but is at a newer watermark (stale event — no-op).
   *
   * Case 1 must throw so BullMQ retries until the race resolves; case 2 must silently skip.
   * The earlier code conflated the two and silently dropped both, which let an `updated`-
   * before-`created` reorder shadow newer state.
   */
  async existsByProviderSubscriptionId(provider_subscription_id: string): Promise<boolean> {
    const rows = await this.db()
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.provider_subscription_id, provider_subscription_id))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The organizations the hourly seat reconcile must act on — read across tenants, so only under
   * the retention maintenance context. `quantityDrift`: Stripe-backed, non-terminal subscriptions
   * whose synced quantity (`seats`) differs from the seats in use (ACTIVE + INVITED, at least 1).
   * `entitlementLapsed`: TEAM organizations without a paid entitlement (no ACTIVE / TRIALING
   * subscription, and no dunning one still inside `dunningGraceDays`) holding more ACTIVE members
   * than the Free plan allows (the cheapest active plan's `included_seats`; none when unlimited).
   */
  async findSeatReconcileCandidates(options: {
    limit: number;
    dunningGraceDays: number;
  }): Promise<{ quantityDrift: string[]; entitlementLapsed: string[] }> {
    const quantityDriftRows = await this.db()
      .select({ public_id: organizations.public_id })
      .from(subscriptions)
      .innerJoin(organizations, eq(organizations.id, subscriptions.organization_id))
      .where(
        and(
          isNull(organizations.deleted_at),
          sql`${subscriptions.provider_subscription_id} IS NOT NULL`,
          notInArray(subscriptions.status, [...INACTIVE_SUBSCRIPTION_STATUSES]),
          sql`${subscriptions.seats} IS DISTINCT FROM GREATEST(1, (
            SELECT count(*) FROM ${memberships}
            WHERE ${memberships.organization_id} = ${subscriptions.organization_id}
              AND ${memberships.deleted_at} IS NULL
              AND ${memberships.status} IN (${MEMBERSHIP_STATUS.ACTIVE}, ${MEMBERSHIP_STATUS.INVITED})
          ))`,
        ),
      )
      .orderBy(subscriptions.id)
      .limit(options.limit);
    const entitlementLapsedRows = await this.db()
      .select({ public_id: organizations.public_id })
      .from(organizations)
      .where(
        and(
          eq(organizations.type, 'TEAM'),
          isNull(organizations.deleted_at),
          sql`NOT EXISTS (
            SELECT 1 FROM ${subscriptions}
            WHERE ${subscriptions.organization_id} = ${organizations.id}
              AND (
                ${subscriptions.status} IN ('ACTIVE', 'TRIALING')
                OR (
                  ${subscriptions.status} IN ('PAST_DUE', 'UNPAID')
                  AND ${subscriptions.current_period_end} + make_interval(days => ${options.dunningGraceDays}) > now()
                )
              )
          )`,
          sql`(
            SELECT count(*) FROM ${memberships}
            WHERE ${memberships.organization_id} = ${organizations.id}
              AND ${memberships.deleted_at} IS NULL
              AND ${memberships.status} = ${MEMBERSHIP_STATUS.ACTIVE}
          ) > (
            SELECT ${plans.included_seats} FROM ${plans}
            WHERE ${plans.is_active} ORDER BY ${plans.price_monthly} ASC LIMIT 1
          )`,
        ),
      )
      .orderBy(organizations.id)
      .limit(options.limit);
    return {
      quantityDrift: quantityDriftRows.map((row) => row.public_id),
      entitlementLapsed: entitlementLapsedRows.map((row) => row.public_id),
    };
  }

  /**
   * One page of the subscriptions the plan-state check must look at (BL17, BL24 — WC-59): read across
   * tenants, so only under the retention maintenance context (the subscriptions policy's `USING`
   * bypass arm). A row is due when (a) its dunning grace ended within the last `lookbackDays`, (b)
   * its trial ends within `trialNoticeMaxDays`, or (c) it is live on a switched-off plan row.
   *
   * @remarks
   * Keyset by `subscriptions.id` (`afterId`), `limit` rows a page, team organizations not deleted
   * only. Served by the plan-state indexes of R24 (`current_period_end` of the dunning rows,
   * `trial_end` of the trialing rows) and `plan_id`'s index.
   */
  async listPlanStateCheckDue(options: {
    dunningGraceDays: number;
    lookbackDays: number;
    trialNoticeMaxDays: number;
    afterId: number;
    limit: number;
  }): Promise<
    { subscriptionId: number; subscriptionPublicId: string; organizationPublicId: string }[]
  > {
    const graceEnd = sql`${subscriptions.current_period_end} + make_interval(days => ${options.dunningGraceDays})`;
    return this.db()
      .select({
        subscriptionId: subscriptions.id,
        subscriptionPublicId: subscriptions.public_id,
        organizationPublicId: organizations.public_id,
      })
      .from(subscriptions)
      .innerJoin(organizations, eq(organizations.id, subscriptions.organization_id))
      .where(
        and(
          eq(organizations.type, 'TEAM'),
          isNull(organizations.deleted_at),
          sql`${subscriptions.id} > ${options.afterId}`,
          or(
            and(
              inArray(subscriptions.status, ['PAST_DUE', 'UNPAID']),
              sql`${graceEnd} <= now()`,
              sql`${graceEnd} > now() - make_interval(days => ${options.lookbackDays})`,
            ),
            and(
              eq(subscriptions.status, 'TRIALING'),
              sql`${subscriptions.trial_end} > now()`,
              sql`${subscriptions.trial_end} <= now() + make_interval(days => ${options.trialNoticeMaxDays})`,
            ),
            and(
              notInArray(subscriptions.status, [...INACTIVE_SUBSCRIPTION_STATUSES]),
              sql`${subscriptions.plan_id} IN (SELECT ${plans.id} FROM ${plans} WHERE NOT ${plans.is_active})`,
            ),
          ),
        ),
      )
      .orderBy(asc(subscriptions.id))
      .limit(options.limit);
  }

  /**
   * One subscription of the organization as the plan-state check re-reads it inside the organization
   * (BL17): its status, period end, trial end, plan and whether that plan row is still on, and the
   * organization's name (the notices' text); `null` when absent.
   */
  async findPlanStateCheckRow({
    organizationId,
    subscriptionPublicId,
  }: {
    organizationId: number;
    subscriptionPublicId: string;
  }): Promise<{
    publicId: string;
    status: string;
    currentPeriodEnd: Date;
    trialEnd: Date | null;
    planPublicId: string | null;
    isPlanActive: boolean | null;
    organizationName: string;
  } | null> {
    const rows = await this.db()
      .select({
        publicId: subscriptions.public_id,
        status: subscriptions.status,
        currentPeriodEnd: subscriptions.current_period_end,
        trialEnd: subscriptions.trial_end,
        planPublicId: plans.public_id,
        isPlanActive: plans.is_active,
        organizationName: organizations.name,
      })
      .from(subscriptions)
      .innerJoin(organizations, eq(organizations.id, subscriptions.organization_id))
      .leftJoin(plans, eq(plans.id, subscriptions.plan_id))
      .where(
        and(
          eq(subscriptions.organization_id, organizationId),
          eq(subscriptions.public_id, subscriptionPublicId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The customer-visible fields a Stripe sync can change, and what decides its plan-state case (the
   * trial end, the scheduled move down), before the sync runs (`null` when absent).
   */
  async findPublicStateByProviderSubscriptionId(
    provider_subscription_id: string,
  ): Promise<StripeSubscriptionPriorState | null> {
    const rows = await this.db()
      .select({
        status: subscriptions.status,
        cancel_at_period_end: subscriptions.cancel_at_period_end,
        canceled_at: subscriptions.canceled_at,
        current_period_start: subscriptions.current_period_start,
        current_period_end: subscriptions.current_period_end,
        plan_id: subscriptions.plan_id,
        billing_cycle: subscriptions.billing_cycle,
        trial_end: subscriptions.trial_end,
        scheduled_plan_id: subscriptions.scheduled_plan_id,
        downgrade_keep: subscriptions.downgrade_keep,
      })
      .from(subscriptions)
      .where(eq(subscriptions.provider_subscription_id, provider_subscription_id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Read the precise MVCC version without losing PostgreSQL timestamp microseconds in a JS Date. */
  async findStripeProviderOrderingState(
    providerSubscriptionId: string,
  ): Promise<StripeSubscriptionOrderingState | null> {
    const rows = await this.db()
      .select({
        version: sql<string>`xmin::text`,
        watermark: subscriptions.last_stripe_event_created_at,
        status: subscriptions.status,
      })
      .from(subscriptions)
      .where(eq(subscriptions.provider_subscription_id, providerSubscriptionId))
      .limit(1);
    return rows[0] ?? null;
  }

  async syncFromStripeProviderSubscription(
    provider_subscription_id: string,
    data: SubscriptionUpdateData,
    stripe_event_created_at: Date,
    reconciliation?: StripeSubscriptionOrderingState,
  ) {
    const rows = await this.db()
      .update(subscriptions)
      .set({
        ...data,
        last_stripe_event_created_at: reconciliation
          ? sql`GREATEST(${subscriptions.last_stripe_event_created_at}, ${stripe_event_created_at.toISOString()}::timestamptz)`
          : stripe_event_created_at,
        updated_at: databaseNowTimestamp,
      })
      .where(
        and(
          eq(subscriptions.provider_subscription_id, provider_subscription_id),
          // Never RESURRECT a locally-terminal subscription via an in-place `.updated` sync — only
          // the dedicated `.deleted` handler (markCanceled) writes terminal state. Without this, a
          // late `.updated` whose Stripe timestamp beats the wall-clock watermark stamped by an
          // offboarding / immediate-cancel could flip a CANCELED org's sub back to ACTIVE
          // (route-audit B5). A non-terminal Dashboard cancel (ACTIVE → CANCELED via `.updated`) is
          // unaffected: the guard checks the CURRENT row status, not the incoming one.
          notInArray(subscriptions.status, [...INACTIVE_SUBSCRIPTION_STATUSES]),
          reconciliation
            ? and(
                sql`xmin::text = ${reconciliation.version}`,
                sql`date_trunc('second', ${subscriptions.last_stripe_event_created_at}) = ${stripe_event_created_at.toISOString()}::timestamptz`,
              )
            : or(
                isNull(subscriptions.last_stripe_event_created_at),
                lt(subscriptions.last_stripe_event_created_at, stripe_event_created_at),
              ),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async markCanceledByProviderSubscriptionId(
    provider_subscription_id: string,
    stripe_event_created_at: Date,
  ) {
    const rows = await this.db()
      .update(subscriptions)
      .set({
        status: 'CANCELED',
        canceled_at: new Date(),
        last_stripe_event_created_at: stripe_event_created_at,
        updated_at: databaseNowTimestamp,
      })
      .where(
        and(
          eq(subscriptions.provider_subscription_id, provider_subscription_id),
          or(
            isNull(subscriptions.last_stripe_event_created_at),
            lte(subscriptions.last_stripe_event_created_at, stripe_event_created_at),
          ),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }
}

/**
 * {@link SubscriptionRepository} bound to a retention maintenance handle — the cross-tenant reads of
 * the seat reconcile ({@link SubscriptionRepository.findSeatReconcileCandidates}) and the plan-state
 * check's sweep ({@link SubscriptionRepository.listPlanStateCheckDue}).
 */
export function createRetentionSubscriptionRepository(
  databaseHandle: WorkerDatabaseHandle,
): SubscriptionRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new SubscriptionRepository(databaseHandle);
}

/** Worker-only factory — requires an explicit handle from `withAppDatabaseContext`. */
export function createWorkerSubscriptionRepository(
  databaseHandle: WorkerDatabaseHandle,
): SubscriptionRepository {
  assertWorkerDatabaseContext(['organization']);
  return new SubscriptionRepository(databaseHandle);
}
