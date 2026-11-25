import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eventBus, type DomainEvent } from '@/core/events/event-bus.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
  STUDIO_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import type { StripeWebhookService } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook.service.js';
import {
  SUBSCRIPTION_EVENT,
  type PlanStateChangedPayload,
} from '@/domains/billing/sub-domains/subscription/events/subscription.events.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';
import { env } from '@/shared/config/env.config.js';
import { provisionOrganizationWithOwner } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase, operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createDomainContainers } from '@/worker-containers.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';

const DAY = 24 * 60 * 60 * 1000;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * feat-instagram-dm-sending ROUTE row R26 — routes-final § 8.D BL22, BL23 (BLC12): the Stripe
 * webhook's plan-state cases — an unpaid trial end and a scheduled move to Free leave a local Free
 * row, a paid schedule flip moves the plan down, a cancelled paid plan ends (AC-11.9's state change),
 * a dunning plan paid again resumes; each emits `subscription.plan_state_changed` once, after the
 * commit; an out-of-order or replayed event changes nothing. Real worker service, real Postgres;
 * Stripe's payloads are built here (no Stripe call is made).
 */
describe('Stripe webhook — the plan-state cases (R26)', () => {
  let service: StripeWebhookService;
  const planStateEvents: PlanStateChangedPayload[] = [];
  const readOnlyEnforced = env.BILLING_READ_ONLY_ENFORCED;

  beforeAll(async () => {
    await initializeI18nextForBackgroundWork();
    service = createDomainContainers().billingDomain.stripeWebhookService;
    eventBus.on({
      eventType: SUBSCRIPTION_EVENT.PLAN_STATE_CHANGED,
      handler: async (event: DomainEvent<unknown>) => {
        planStateEvents.push(event.payload as PlanStateChangedPayload);
      },
    });
  });

  afterAll(async () => {
    env.BILLING_READ_ONLY_ENFORCED = readOnlyEnforced;
    await cleanupDatabase();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    // The billing notices go to `subscription:manage` holders (the Owner), so the roles need theirs.
    await seedAllPermissions();
    planStateEvents.length = 0;
    env.BILLING_READ_ONLY_ENFORCED = true;
  });

  /** Free, Creator and Studio with Stripe prices; the migration's own rows are turned off. */
  async function catalog() {
    await getOperatorDatabase().update(plans).set({ is_active: false });
    const free = await createTestPlan({
      name: `Free ${randomUUID()}`,
      priceMonthly: '0.00',
      priceYearly: '0.00',
      features: FREE_PLAN_FEATURES,
    });
    const creator = await createTestPlan({
      name: `Creator ${randomUUID()}`,
      priceMonthly: '29.00',
      priceYearly: '276.00',
      features: CREATOR_PLAN_FEATURES,
      stripePriceMonthlyId: 'price_creator_monthly',
      stripePriceYearlyId: 'price_creator_yearly',
    });
    const studio = await createTestPlan({
      name: `Studio ${randomUUID()}`,
      priceMonthly: '79.00',
      priceYearly: '756.00',
      features: STUDIO_PLAN_FEATURES,
      stripePriceMonthlyId: 'price_studio_monthly',
      stripePriceYearlyId: 'price_studio_yearly',
    });
    return { free, creator, studio };
  }

  /** A team organization with one Stripe-backed row in the given state. */
  async function organizationWithRow({
    planId,
    status,
    periodEnd,
    extra = {},
  }: {
    planId: number;
    status: string;
    periodEnd: Date;
    extra?: Partial<typeof subscriptions.$inferInsert>;
  }) {
    const user = await createTestUser();
    // Provisioned the real way (Owner role and membership), so the billing notices have their
    // `subscription:manage` recipient.
    const { organization } = await provisionOrganizationWithOwner({
      name: 'Plan state team',
      slug: `plan-state-${randomUUID().slice(0, 12)}`,
      type: 'TEAM',
      ownerUserId: user.id,
    });
    const providerSubscriptionId = `sub_r26_${randomUUID().replaceAll('-', '')}`;
    const created = await createTestSubscription({
      organizationId: organization.id,
      planId,
      status,
      providerSubscriptionId,
      providerCustomerId: 'cus_r26',
    });
    await getOperatorDatabase()
      .update(subscriptions)
      .set({
        current_period_start: new Date(periodEnd.getTime() - 30 * DAY),
        current_period_end: periodEnd,
        ...extra,
      })
      .where(eq(subscriptions.id, created.id));
    return { organization, providerSubscriptionId, subscriptionId: created.id };
  }

  function stripeEvent({
    type,
    providerSubscriptionId,
    organizationPublicId,
    status,
    priceId,
    periodEnd,
    createdAt = new Date(),
    eventId = `evt_r26_${randomUUID()}`,
  }: {
    type: 'customer.subscription.updated' | 'customer.subscription.deleted';
    providerSubscriptionId: string;
    organizationPublicId: string;
    status: string;
    priceId: string;
    periodEnd: Date;
    createdAt?: Date;
    eventId?: string;
  }): Stripe.Event {
    return {
      id: eventId,
      type,
      created: seconds(createdAt),
      data: {
        object: {
          id: providerSubscriptionId,
          customer: 'cus_r26',
          status,
          cancel_at_period_end: false,
          canceled_at: status === 'canceled' ? seconds(createdAt) : null,
          metadata: { organization_id: organizationPublicId },
          items: {
            data: [
              {
                quantity: 1,
                current_period_start: seconds(new Date(periodEnd.getTime() - 30 * DAY)),
                current_period_end: seconds(periodEnd),
                price: { id: priceId },
              },
            ],
          },
        },
      },
    } as unknown as Stripe.Event;
  }

  async function rowsOf(organizationId: number) {
    return getOperatorDatabase()
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organization_id, organizationId));
  }

  it('an unpaid trial end cancels the row, puts the organization on a local Free row and says trial_ended once (BL22 case 1)', async () => {
    const { free, creator } = await catalog();
    const trialEnd = new Date(Date.now() - 60_000);
    const { organization, providerSubscriptionId } = await organizationWithRow({
      planId: creator.id,
      status: 'TRIALING',
      periodEnd: trialEnd,
      extra: { trial_end: trialEnd },
    });
    const event = stripeEvent({
      type: 'customer.subscription.deleted',
      providerSubscriptionId,
      organizationPublicId: organization.public_id,
      status: 'canceled',
      priceId: 'price_creator_monthly',
      periodEnd: trialEnd,
    });

    await service.handleEvent({ event });
    await service.handleEvent({ event });

    const rows = await rowsOf(organization.id);
    expect(
      rows.find((row) => row.provider_subscription_id === providerSubscriptionId)?.status,
    ).toBe('CANCELED');
    const freeRows = rows.filter((row) => row.provider_subscription_id === null);
    expect(freeRows).toHaveLength(1);
    expect(freeRows[0]).toMatchObject({ status: 'ACTIVE', plan_id: free.id, provider: null });
    expect(planStateEvents).toEqual([
      {
        organizationPublicId: organization.public_id,
        change: 'trial_ended',
        previous: { state: 'active', plan_public_id: creator.public_id },
        current: { state: 'active', plan_public_id: free.public_id },
        features: FREE_PLAN_FEATURES,
        kept_channel_account_public_ids: null,
        change_key: null,
      },
    ]);
  });

  it('a scheduled move to Free ends at the period end on a local Free row with the kept accounts (BL22 case 2)', async () => {
    const { free, creator } = await catalog();
    const periodEnd = new Date(Date.now() - 60_000);
    const { organization, providerSubscriptionId } = await organizationWithRow({
      planId: creator.id,
      status: 'ACTIVE',
      periodEnd,
      extra: {
        cancel_at_period_end: true,
        scheduled_plan_id: free.id,
        scheduled_change_at: periodEnd,
        downgrade_keep: ['cha_keptaccount00000000000'],
      },
    });

    await service.handleEvent({
      event: stripeEvent({
        type: 'customer.subscription.deleted',
        providerSubscriptionId,
        organizationPublicId: organization.public_id,
        status: 'canceled',
        priceId: 'price_creator_monthly',
        periodEnd,
      }),
    });

    const rows = await rowsOf(organization.id);
    expect(rows.filter((row) => row.status === 'ACTIVE').map((row) => row.plan_id)).toEqual([
      free.id,
    ]);
    expect(planStateEvents).toHaveLength(1);
    expect(planStateEvents[0]).toMatchObject({
      change: 'moved_down',
      previous: { state: 'active', plan_public_id: creator.public_id },
      current: { state: 'active', plan_public_id: free.public_id },
      kept_channel_account_public_ids: ['cha_keptaccount00000000000'],
    });
  });

  it("a paid schedule flip follows Stripe's price, clears the schedule and says moved_down with the kept accounts (BL22 case 3)", async () => {
    const { creator, studio } = await catalog();
    const nextPeriodEnd = new Date(Date.now() + 30 * DAY);
    const { organization, providerSubscriptionId, subscriptionId } = await organizationWithRow({
      planId: studio.id,
      status: 'ACTIVE',
      periodEnd: new Date(Date.now() - 60_000),
      extra: {
        scheduled_plan_id: creator.id,
        scheduled_change_at: new Date(Date.now() - 60_000),
        downgrade_keep: ['cha_firstkept000000000000', 'cha_secondkept00000000000'],
      },
    });

    await service.handleEvent({
      event: stripeEvent({
        type: 'customer.subscription.updated',
        providerSubscriptionId,
        organizationPublicId: organization.public_id,
        status: 'active',
        priceId: 'price_creator_monthly',
        periodEnd: nextPeriodEnd,
      }),
    });

    const [row] = await getOperatorDatabase()
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId));
    expect(row).toMatchObject({
      status: 'ACTIVE',
      plan_id: creator.id,
      scheduled_plan_id: null,
      scheduled_change_at: null,
      downgrade_keep: null,
    });
    expect(planStateEvents).toEqual([
      expect.objectContaining({
        change: 'moved_down',
        previous: { state: 'active', plan_public_id: studio.public_id },
        current: { state: 'active', plan_public_id: creator.public_id },
        features: CREATOR_PLAN_FEATURES,
        kept_channel_account_public_ids: ['cha_firstkept000000000000', 'cha_secondkept00000000000'],
      }),
    ]);
  });

  it('a cancelled paid plan ends at its period end with no grace and no Free row — plan_ended, read only (BL22 case 4, AC-11.9)', async () => {
    const { creator } = await catalog();
    const periodEnd = new Date(Date.now() - 60_000);
    const { organization, providerSubscriptionId } = await organizationWithRow({
      planId: creator.id,
      status: 'ACTIVE',
      periodEnd,
      extra: { cancel_at_period_end: true },
    });

    await service.handleEvent({
      event: stripeEvent({
        type: 'customer.subscription.deleted',
        providerSubscriptionId,
        organizationPublicId: organization.public_id,
        status: 'canceled',
        priceId: 'price_creator_monthly',
        periodEnd,
      }),
    });

    const rows = await rowsOf(organization.id);
    expect(rows.map((row) => row.status)).toEqual(['CANCELED']);
    expect(planStateEvents).toHaveLength(1);
    expect(planStateEvents[0]).toMatchObject({
      change: 'plan_ended',
      previous: { state: 'active', plan_public_id: creator.public_id },
      current: { state: 'read_only' },
      kept_channel_account_public_ids: null,
    });
  });

  it('a dunning plan paid again says resumed (BL22 case 5); entering the grace announces no plan change but tells the billing managers the payment failed (WC-57)', async () => {
    const { creator } = await catalog();
    const periodEnd = new Date(Date.now() + 10 * DAY);
    const { organization, providerSubscriptionId } = await organizationWithRow({
      planId: creator.id,
      status: 'ACTIVE',
      periodEnd,
    });
    const update = (status: string, createdAt: Date) =>
      service.handleEvent({
        event: stripeEvent({
          type: 'customer.subscription.updated',
          providerSubscriptionId,
          organizationPublicId: organization.public_id,
          status,
          priceId: 'price_creator_monthly',
          periodEnd,
          createdAt,
        }),
      });

    await update('past_due', new Date(Date.now() - 10_000));
    expect(planStateEvents).toEqual([]);
    // Entering the grace is a failed payment: the billing managers are told once (WC-57, P318).
    const told = await operatorQuery<Array<{ type: string }>>`
      SELECT type FROM notify.notifications
      WHERE organization_id = ${organization.id} AND type = 'billing.payment_failed'`;
    expect(told).toHaveLength(1);

    await update('active', new Date());
    expect(planStateEvents).toEqual([
      expect.objectContaining({
        change: 'resumed',
        previous: { state: 'grace', plan_public_id: creator.public_id },
        current: { state: 'active', plan_public_id: creator.public_id },
      }),
    ]);
  });

  it('an out-of-order deletion older than the row changes nothing and announces nothing', async () => {
    const { creator } = await catalog();
    const trialEnd = new Date(Date.now() - 60_000);
    const { organization, providerSubscriptionId } = await organizationWithRow({
      planId: creator.id,
      status: 'TRIALING',
      periodEnd: trialEnd,
      extra: { trial_end: trialEnd, last_stripe_event_created_at: new Date() },
    });

    await service.handleEvent({
      event: stripeEvent({
        type: 'customer.subscription.deleted',
        providerSubscriptionId,
        organizationPublicId: organization.public_id,
        status: 'canceled',
        priceId: 'price_creator_monthly',
        periodEnd: trialEnd,
        createdAt: new Date(Date.now() - 3_600_000),
      }),
    });

    const rows = await rowsOf(organization.id);
    expect(rows.map((row) => row.status)).toEqual(['TRIALING']);
    expect(
      await getOperatorDatabase()
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.organization_id, organization.id),
            isNull(subscriptions.provider_subscription_id),
          ),
        ),
    ).toEqual([]);
    expect(planStateEvents).toEqual([]);
  });
});
