import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  paymentProviderCalls,
  resetPaymentProviderCalls,
} from '@/domains/billing/__tests__/factories/fake-payment-provider.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
  STUDIO_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { organization_entitlement_overrides } from '@/domains/billing/sub-domains/entitlement/entitlement-override.schema.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';
import { trial_accounts } from '@/domains/billing/sub-domains/subscription/trial-account.schema.js';
import {
  SUBSCRIPTION_EVENT,
  type PlanStateChangedPayload,
} from '@/domains/billing/sub-domains/subscription/events/subscription.events.js';
import { insertChannelAccount } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedAllPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { eventBus, type DomainEvent } from '@/core/events/event-bus.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { ConflictError } from '@/shared/errors/index.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';

vi.mock('@/domains/billing/sub-domains/subscription/stripe-payment-provider.js', async () => {
  const { FakePaymentProvider } = await import(
    '@/domains/billing/__tests__/factories/fake-payment-provider.js'
  );
  return { StripePaymentProvider: FakePaymentProvider };
});

type SubscriptionBody = {
  id: string;
  status: string;
  plan_id: string | null;
  trial_end: string | null;
  current_period_end: string;
  cancel_at_period_end: boolean;
  is_trial: boolean;
  scheduled_change: {
    plan_id: string;
    change_at: string;
    keep_channel_account_ids: string[];
  } | null;
};

type ErrorBody = {
  error: { reason?: string; errors?: { field: string }[] };
};

type ContextBody = {
  data: {
    active_organization: {
      channel_accounts_count: number;
      plan_access: {
        state: string;
        trial_ends_at: string | null;
        plan: { id: string; name: string } | null;
        features: unknown;
        is_plan_choice_required: boolean;
      };
    };
  };
};

const DAY = 24 * 60 * 60 * 1000;

/**
 * feat-instagram-dm-sending ROUTE row R24 — routes-final § 8.B: the 7-day no-card trial (route 102,
 * BL7, BL14, BL18), the move down at the period end with the kept accounts (route 103, BL5, BL6,
 * BL15), and the context's plan access and account count (route 108, BL16, BL24) — AC-11.4, AC-11.5,
 * AC-11.7, AC-10.2. Stripe is the payment-provider fake (the Stripe calls are contract-tested).
 */
describe('Billing — the trial, the move down and the plan in the context (R24)', () => {
  let app: FastifyInstance;
  const planStateEvents: PlanStateChangedPayload[] = [];

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
    eventBus.on({
      eventType: SUBSCRIPTION_EVENT.PLAN_STATE_CHANGED,
      handler: async (event: DomainEvent<unknown>) => {
        planStateEvents.push(event.payload as PlanStateChangedPayload);
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    resetPaymentProviderCalls();
    planStateEvents.length = 0;
  });

  /** The catalog of 8.A with Stripe prices: Free, Creator, Studio (and Growth, switched off). */
  async function catalog() {
    // The migration's own rows are turned off so these are the plans every read resolves.
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
    const growth = await createTestPlan({
      name: `Growth ${randomUUID()}`,
      priceMonthly: '99.00',
      priceYearly: '990.00',
      features: FREE_PLAN_FEATURES,
      isActive: false,
      stripePriceMonthlyId: 'price_growth_monthly',
    });
    return { free, creator, studio, growth };
  }

  async function owner() {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ['subscription:read', 'subscription:manage', 'organization:read'],
      createdByUserId: user.id,
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { organization, token };
  }

  function post({ token, path, payload }: { token: string; path: string; payload: object }) {
    return injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath(path),
      token,
      headers: { 'x-idempotency-key': `r24-${randomUUID()}` },
      payload,
    });
  }

  async function context(token: string) {
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/context'),
      token,
    });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as ContextBody).data.active_organization;
  }

  const subscriptionOf = (response: { json: () => unknown }) =>
    (response.json() as { data: SubscriptionBody }).data;
  const errorOf = (response: { json: () => unknown }) => (response.json() as ErrorBody).error;

  describe('route 102 — the 7-day no-card trial', () => {
    it('gives the plan at once with its end 7 days ahead, records every account and says so (AC-11.4)', async () => {
      const { creator } = await catalog();
      const { organization, token } = await owner();
      await insertChannelAccount({
        organizationId: organization.id,
        providerAccountId: '178414001',
      });
      await insertChannelAccount({
        organizationId: organization.id,
        providerAccountId: '178414002',
      });

      const started = await post({
        token,
        path: '/billing/subscriptions',
        payload: { plan_id: creator.public_id, billing_cycle: 'monthly', is_trial: true },
      });
      expect(started.statusCode, started.body).toBe(200);
      const subscription = subscriptionOf(started);
      expect(subscription.status).toBe('TRIALING');
      expect(subscription.is_trial).toBe(true);
      expect(subscription.scheduled_change).toBeNull();
      const trialEnd = new Date(subscription.trial_end ?? 0).getTime();
      expect(Math.abs(trialEnd - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
      expect(paymentProviderCalls).toContainEqual(
        expect.objectContaining({ method: 'createSubscription', trialPeriodDays: 7 }),
      );

      const rows = await getOperatorDatabase()
        .select()
        .from(trial_accounts)
        .where(eq(trial_accounts.organization_id, organization.id));
      expect(rows.map((row) => row.instagram_user_id).sort()).toEqual(['178414001', '178414002']);
      expect(rows.every((row) => row.public_id.startsWith('tra_'))).toBe(true);

      const active = await context(token);
      expect(active.channel_accounts_count).toBe(2);
      expect(active.plan_access).toMatchObject({
        state: 'active',
        trial_ends_at: subscription.trial_end,
        plan: { id: creator.public_id },
        features: CREATOR_PLAN_FEATURES,
        is_plan_choice_required: false,
      });
      expect(planStateEvents).toEqual([
        expect.objectContaining({
          organizationPublicId: organization.public_id,
          change: 'trial_started',
          current: { state: 'active', plan_public_id: creator.public_id },
          features: CREATOR_PLAN_FEATURES,
        }),
      ]);
    });

    it('refuses a second trial in the same organization (AC-11.5)', async () => {
      const { creator, studio } = await catalog();
      const { organization, token } = await owner();
      const first = await post({
        token,
        path: '/billing/subscriptions',
        payload: { plan_id: creator.public_id, billing_cycle: 'monthly', is_trial: true },
      });
      expect(first.statusCode, first.body).toBe(200);
      await getOperatorDatabase()
        .update(subscriptions)
        .set({ status: 'CANCELED', canceled_at: new Date() })
        .where(eq(subscriptions.organization_id, organization.id));
      resetPaymentProviderCalls();

      const second = await post({
        token,
        path: '/billing/subscriptions',
        payload: { plan_id: studio.public_id, billing_cycle: 'yearly', is_trial: true },
      });
      expect(second.statusCode, second.body).toBe(409);
      expect(errorOf(second).reason).toBe('trial_already_used');
      expect(paymentProviderCalls).toEqual([]);
    });

    it('refuses a trial when one of its accounts had a trial in another organization (AC-11.5)', async () => {
      const { creator, free } = await catalog();
      const elsewhere = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
      await getOperatorDatabase()
        .insert(trial_accounts)
        .values({
          public_id: generatePublicId('trialAccount'),
          organization_id: elsewhere.id,
          instagram_user_id: '178414777',
          plan_id: free.id,
        });
      const { organization, token } = await owner();
      await insertChannelAccount({
        organizationId: organization.id,
        providerAccountId: '178414777',
      });

      const refused = await post({
        token,
        path: '/billing/subscriptions',
        payload: { plan_id: creator.public_id, billing_cycle: 'monthly', is_trial: true },
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(errorOf(refused).reason).toBe('trial_already_used');
      expect(paymentProviderCalls).toEqual([]);
    });

    it('refuses a trial of Free (422 plan_has_no_trial)', async () => {
      const { free } = await catalog();
      const { token } = await owner();
      const refused = await post({
        token,
        path: '/billing/subscriptions',
        payload: { plan_id: free.public_id, billing_cycle: 'monthly', is_trial: true },
      });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(errorOf(refused).reason).toBe('plan_has_no_trial');
    });

    it('the trial port refuses an account that had a trial elsewhere, and records a picked one (AC-11.5)', async () => {
      const { creator, free } = await catalog();
      const elsewhere = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
      await getOperatorDatabase()
        .insert(trial_accounts)
        .values({
          public_id: generatePublicId('trialAccount'),
          organization_id: elsewhere.id,
          instagram_user_id: '178414888',
          plan_id: free.id,
        });
      const { organization, token } = await owner();
      const started = await post({
        token,
        path: '/billing/subscriptions',
        payload: { plan_id: creator.public_id, billing_cycle: 'monthly', is_trial: true },
      });
      expect(started.statusCode, started.body).toBe(200);
      const trialPort = app.billingDomain.subscriptionTrialService;
      const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id });

      await expect(
        withAppDatabaseContext({
          scope,
          callback: () => trialPort.assertAccountsMayTrial({ providerAccountIds: ['178414888'] }),
        }),
      ).rejects.toMatchObject({ reason: 'trial_used_by_account' });
      await expect(
        withAppDatabaseContext({
          scope,
          callback: () => trialPort.assertAccountsMayTrial({ providerAccountIds: ['178414999'] }),
        }),
      ).resolves.toBeUndefined();

      await withAppDatabaseContext({
        scope,
        callback: () =>
          trialPort.recordTrialAccounts({
            scope,
            organizationId: organization.id,
            providerAccountIds: ['178414999'],
          }),
      });
      const [picked] = await getOperatorDatabase()
        .select()
        .from(trial_accounts)
        .where(eq(trial_accounts.instagram_user_id, '178414999'));
      expect(picked?.organization_id).toBe(organization.id);

      const raced = withAppDatabaseContext({
        scope,
        callback: () =>
          trialPort.recordTrialAccounts({
            scope,
            organizationId: organization.id,
            providerAccountIds: ['178414888'],
          }),
      });
      await expect(raced).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('route 103 — up at once, down at the period end with the kept accounts', () => {
    async function onStudio() {
      const plansCatalog = await catalog();
      const owned = await owner();
      const created = await post({
        token: owned.token,
        path: '/billing/subscriptions',
        payload: { plan_id: plansCatalog.studio.public_id, billing_cycle: 'monthly' },
      });
      expect(created.statusCode, created.body).toBe(200);
      const accounts = [];
      for (const providerAccountId of ['178414101', '178414102', '178414103', '178414104']) {
        accounts.push(
          await insertChannelAccount({ organizationId: owned.organization.id, providerAccountId }),
        );
      }
      resetPaymentProviderCalls();
      planStateEvents.length = 0;
      return { ...plansCatalog, ...owned, subscription: subscriptionOf(created), accounts };
    }

    it('a move down changes nothing until the period end and keeps the picked accounts (AC-11.7)', async () => {
      const { creator, studio, token, subscription, accounts } = await onStudio();
      const keep = [accounts[3]!.public_id, accounts[1]!.public_id];

      const moved = await post({
        token,
        path: `/billing/subscriptions/${subscription.id}/change-plan`,
        payload: { plan_id: creator.public_id, keep_channel_account_ids: keep },
      });
      expect(moved.statusCode, moved.body).toBe(200);
      const body = subscriptionOf(moved);
      expect(body.plan_id).toBe(studio.public_id);
      expect(body.scheduled_change).toEqual({
        plan_id: creator.public_id,
        change_at: subscription.current_period_end,
        keep_channel_account_ids: keep,
      });
      expect(paymentProviderCalls).toContainEqual(
        expect.objectContaining({
          method: 'schedulePriceChangeAtPeriodEnd',
          providerPriceId: 'price_creator_monthly',
        }),
      );
      expect(paymentProviderCalls.map((call) => call.method)).not.toContain(
        'updateSubscriptionPrice',
      );
      expect((await context(token)).plan_access.plan?.id).toBe(studio.public_id);
      expect(planStateEvents).toEqual([]);

      // The same plan again takes the move back.
      const released = await post({
        token,
        path: `/billing/subscriptions/${subscription.id}/change-plan`,
        payload: { plan_id: studio.public_id },
      });
      expect(released.statusCode, released.body).toBe(200);
      expect(subscriptionOf(released).scheduled_change).toBeNull();
      expect(paymentProviderCalls).toContainEqual(
        expect.objectContaining({ method: 'releaseScheduledPriceChange' }),
      );
    });

    it('a move to Free cancels at the period end; a move up applies at once', async () => {
      const { free, creator, token, subscription } = await onStudio();
      const toFree = await post({
        token,
        path: `/billing/subscriptions/${subscription.id}/change-plan`,
        payload: { plan_id: free.public_id },
      });
      expect(toFree.statusCode, toFree.body).toBe(200);
      expect(subscriptionOf(toFree)).toMatchObject({
        cancel_at_period_end: true,
        scheduled_change: { plan_id: free.public_id, keep_channel_account_ids: [] },
      });
      expect(paymentProviderCalls).toContainEqual(
        expect.objectContaining({ method: 'cancelSubscriptionAtPeriodEnd' }),
      );

      // Creator is cheaper than Studio — still a move down, replacing the Free one.
      const toCreator = await post({
        token,
        path: `/billing/subscriptions/${subscription.id}/change-plan`,
        payload: { plan_id: creator.public_id },
      });
      expect(toCreator.statusCode, toCreator.body).toBe(200);
      expect(subscriptionOf(toCreator)).toMatchObject({
        cancel_at_period_end: false,
        scheduled_change: { plan_id: creator.public_id },
      });
      expect(paymentProviderCalls).toContainEqual(
        expect.objectContaining({ method: 'resumeSubscription' }),
      );
    });

    it('a move up applies at once, clears a scheduled move and tells the app (BL8)', async () => {
      const { creator, studio, token, organization } = await catalog().then(
        async (plansCatalog) => ({
          ...plansCatalog,
          ...(await owner()),
        }),
      );
      const created = await post({
        token,
        path: '/billing/subscriptions',
        payload: { plan_id: creator.public_id, billing_cycle: 'monthly' },
      });
      const subscription = subscriptionOf(created);
      planStateEvents.length = 0;

      const upgraded = await post({
        token,
        path: `/billing/subscriptions/${subscription.id}/change-plan`,
        payload: { plan_id: studio.public_id },
      });
      expect(upgraded.statusCode, upgraded.body).toBe(200);
      expect(subscriptionOf(upgraded)).toMatchObject({
        plan_id: studio.public_id,
        scheduled_change: null,
      });
      expect(paymentProviderCalls).toContainEqual(
        expect.objectContaining({
          method: 'updateSubscriptionPrice',
          providerPriceId: 'price_studio_monthly',
        }),
      );
      expect(planStateEvents).toEqual([
        expect.objectContaining({
          organizationPublicId: organization.public_id,
          change: 'upgraded',
          previous: { state: 'active', plan_public_id: creator.public_id },
          current: { state: 'active', plan_public_id: studio.public_id },
        }),
      ]);
    });

    it('refuses kept accounts on a move up, beyond the new plan, or not this organization’s (400)', async () => {
      const { creator, studio, token, subscription, accounts } = await onStudio();
      const other = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
      const foreign = await insertChannelAccount({
        organizationId: other.id,
        providerAccountId: '178414555',
      });
      const cases = [
        { plan_id: studio.public_id, keep_channel_account_ids: [] },
        {
          plan_id: creator.public_id,
          keep_channel_account_ids: accounts.map((account) => account.public_id),
        },
        { plan_id: creator.public_id, keep_channel_account_ids: [foreign.public_id] },
      ];
      for (const payload of cases) {
        const refused = await post({
          token,
          path: `/billing/subscriptions/${subscription.id}/change-plan`,
          payload,
        });
        expect(refused.statusCode, refused.body).toBe(400);
        expect(errorOf(refused).errors?.[0]?.field).toBe('keep_channel_account_ids');
      }
      const repeated = await post({
        token,
        path: `/billing/subscriptions/${subscription.id}/change-plan`,
        payload: {
          plan_id: creator.public_id,
          keep_channel_account_ids: [accounts[0]!.public_id, accounts[0]!.public_id],
        },
      });
      expect(repeated.statusCode, repeated.body).toBe(400);
      expect(paymentProviderCalls).toEqual([]);
    });
    it('reads the new plan’s account limit with the organization’s overrides laid over it (P270)', async () => {
      const { organization, creator, token, subscription, accounts } = await onStudio();
      await getOperatorDatabase()
        .insert(organization_entitlement_overrides)
        .values({
          public_id: generatePublicId('organizationEntitlementOverride'),
          organization_id: organization.id,
          key: 'channel_accounts_max',
          value: accounts.length,
          expires_at: null,
          reason: 'Agency deal',
        });

      const moved = await post({
        token,
        path: `/billing/subscriptions/${subscription.id}/change-plan`,
        payload: {
          plan_id: creator.public_id,
          keep_channel_account_ids: accounts.map((account) => account.public_id),
        },
      });

      expect(moved.statusCode, moved.body).toBe(200);
      expect(subscriptionOf(moved).scheduled_change?.keep_channel_account_ids).toHaveLength(
        accounts.length,
      );
    });
  });

  describe('route 108 — the plan in the context', () => {
    it('an organization still on a switched-off plan is held to Free and asked to choose (BL24, AC-10.2)', async () => {
      const { growth, creator } = await catalog();
      const { organization, token } = await owner();
      const [row] = await getOperatorDatabase()
        .insert(subscriptions)
        .values({
          public_id: generatePublicId('subscription'),
          organization_id: organization.id,
          plan_id: growth.id,
          billing_cycle: 'MONTHLY',
          status: 'ACTIVE',
          provider: 'stripe',
          provider_subscription_id: `sub_legacy_${randomUUID()}`,
          current_period_start: new Date(Date.now() - DAY),
          current_period_end: new Date(Date.now() + 20 * DAY),
        })
        .returning();

      const before = await context(token);
      expect(before.channel_accounts_count).toBe(0);
      expect(before.plan_access).toMatchObject({
        state: 'active',
        plan: { id: growth.public_id },
        features: FREE_PLAN_FEATURES,
        is_plan_choice_required: true,
      });

      // Picking Creator is a move up, at once, and ends the notice.
      const picked = await post({
        token,
        path: `/billing/subscriptions/${row!.public_id}/change-plan`,
        payload: { plan_id: creator.public_id },
      });
      expect(picked.statusCode, picked.body).toBe(200);
      expect(subscriptionOf(picked).plan_id).toBe(creator.public_id);
      const after = await context(token);
      expect(after.plan_access).toMatchObject({
        plan: { id: creator.public_id },
        is_plan_choice_required: false,
      });
    });
  });
});
