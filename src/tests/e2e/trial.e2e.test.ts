import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/shared/config/env.config.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
  STUDIO_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { processSubscriptionPlanStateCheckJob } from '@/domains/billing/sub-domains/subscription/workers/subscription-plan-state-check.processor.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  automationActionPath,
  AUTOMATIONS_PATH,
  commentAutomationBody,
  completeAutomationSteps,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { insertLanes } from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import type { InstagramPlanChangeTaskInput } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-plan-change.job.schema.js';
import { runInstagramPlanChangeTask } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-plan-change.processor.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { getOperatorDatabase, operatorQuery } from '@/tests/helpers/operator-database.js';
import { deliverStripeSubscriptionEvent } from '@/tests/helpers/stripe-subscription-event.helper.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// Stripe's side of route 102 / 103 is the payment-provider fake (the calls are contract-tested).
vi.mock('@/domains/billing/sub-domains/subscription/stripe-payment-provider.js', async () => {
  const { FakePaymentProvider } = await import(
    '@/domains/billing/__tests__/factories/fake-payment-provider.js'
  );
  return { StripePaymentProvider: FakePaymentProvider };
});

/** The plan-change tasks the app's event handler adds to `instagram-database-tasks` (captured). */
const handedTasks = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock(
  '@/domains/app/sub-domains/instagram-sending/queues/instagram-database-tasks.queue.js',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    enqueueInstagramDatabaseTask: async (input: Record<string, unknown>) => {
      handedTasks.push(input);
    },
  }),
);

const DAY = 24 * 60 * 60 * 1000;

type TestAccount = Awaited<ReturnType<typeof insertInstagramAccount>>;
type Catalog = Record<'free' | 'creator' | 'studio', { id: number; public_id: string }>;
type SubscriptionRow = {
  public_id: string;
  status: string;
  plan_id: string;
  trial_end: Date | null;
  current_period_end: Date;
  provider_subscription_id: string;
  provider_customer_id: string;
};

/**
 * Flow — a trial from start to its end (feat-instagram-dm-sending ROUTE row R59, AC-24.1–AC-24.6;
 * routes-final § 8.B BL3, BL7, BL14, BL15, BL17, § 8.D BL22; WC-38, WC-57 payment failed (P224),
 * WC-59). End to end over the built code: route 102's no-card trial and route 103 by
 * `fastify.inject` (payment-provider fake), the app's go-live, the plan-state check's trial notices,
 * the Stripe webhook at the trial end (posted signed, worked by its job, re-fetched through nock),
 * billing's `subscription.plan_state_changed` → the app's handler (task captured) → the plan-change
 * task over the real services.
 */
describe('Flow: a trial from start to its end (R59)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let catalog: Catalog;
  let accounts: TestAccount[];
  const readOnlyEnforced = env.BILLING_READ_ONLY_ENFORCED;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    env.BILLING_READ_ONLY_ENFORCED = readOnlyEnforced;
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    nock.cleanAll();
    handedTasks.length = 0;
    env.BILLING_READ_ONLY_ENFORCED = true;
    await getOperatorDatabase().update(plans).set({ is_active: false });
    catalog = {
      free: await createTestPlan({
        name: 'Free',
        priceMonthly: '0.00',
        priceYearly: '0.00',
        features: FREE_PLAN_FEATURES,
      }),
      creator: await createTestPlan({
        name: 'Creator',
        priceMonthly: '29.00',
        priceYearly: '276.00',
        features: CREATOR_PLAN_FEATURES,
        stripePriceMonthlyId: 'price_creator_monthly',
        stripePriceYearlyId: 'price_creator_yearly',
      }),
      studio: await createTestPlan({
        name: 'Studio',
        priceMonthly: '79.00',
        priceYearly: '756.00',
        features: STUDIO_PLAN_FEATURES,
        stripePriceMonthlyId: 'price_studio_monthly',
        stripePriceYearlyId: 'price_studio_yearly',
      }),
    };
    team = await createInstagramTeam();
    // Accounts A and B, A connected first.
    accounts = [];
    for (let index = 0; index < 2; index += 1) {
      const account = await insertInstagramAccount({ organizationId: team.organization.id });
      await operatorQuery`
        UPDATE app.channel_accounts SET connected_at = now() - make_interval(days => ${10 - index})
        WHERE id = ${account.channel_account_id}`;
      await insertLanes({
        organizationId: team.organization.id,
        channelAccountId: account.channel_account_id,
      });
      accounts.push(account);
    }
  });

  afterEach(() => {
    nock.cleanAll();
  });

  function post(url: string, payload?: object) {
    return injectAuthenticated(app, {
      method: 'POST',
      url,
      token: team.ownerToken,
      headers: { 'x-idempotency-key': `r59-${randomUUID()}` },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  function startTrial(planPublicId: string) {
    return post(testApiPath('/billing/subscriptions'), {
      plan_id: planPublicId,
      billing_cycle: 'monthly',
      is_trial: true,
    });
  }

  async function liveRow(): Promise<SubscriptionRow> {
    const [row] = await operatorQuery<SubscriptionRow[]>`
      SELECT public_id, status, plan_id::text, trial_end, current_period_end,
             provider_subscription_id, provider_customer_id
      FROM billing.subscriptions
      WHERE organization_id = ${team.organization.id} AND provider_subscription_id IS NOT NULL
      ORDER BY id DESC LIMIT 1`;
    return row!;
  }

  async function planStops(): Promise<Array<string | null>> {
    const rows = await operatorQuery<{ plan_stop_reason: string | null }[]>`
      SELECT plan_stop_reason FROM app.channel_accounts
      WHERE organization_id = ${team.organization.id} ORDER BY connected_at, id`;
    return rows.map((row) => row.plan_stop_reason);
  }

  async function noticesOf(type: string) {
    return operatorQuery<{ user_id: number; data: Record<string, unknown> }[]>`
      SELECT user_id::int AS user_id, data FROM notify.notifications
      WHERE organization_id = ${team.organization.id} AND type = ${type} ORDER BY id`;
  }

  function planStateCheck(subscriptionPublicId: string, now: Date) {
    return processSubscriptionPlanStateCheckJob({
      jobData: { organizationPublicId: team.organization.public_id, subscriptionPublicId },
      services: {
        subscriptionService: app.billingDomain.subscriptionService,
        notificationService: app.notifyDomain.notificationService,
        membershipService: app.tenancyDomain.membershipService,
        organizationSettingsService: app.tenancyDomain.organizationSettingsService,
      },
      now,
    });
  }

  /** Each plan-change task billing's events handed the app, run in order as its worker would. */
  async function runHandedPlanChanges() {
    const domain = app.appDomain;
    const results = [];
    for (const task of handedTasks.splice(0)) {
      results.push(
        await runInstagramPlanChangeTask({
          services: {
            channelAccountService: domain.channelAccountService,
            laneService: domain.instagramSendLaneService,
            broadcastService: domain.broadcastService,
            automationBackfillService: domain.automationBackfillService,
            automationService: domain.automationService,
          },
          organizationPublicId: team.organization.public_id,
          taskInput: task.taskInput as InstagramPlanChangeTaskInput,
          runInDatabaseSlot: (callback) => callback(),
        }),
      );
    }
    return results;
  }

  /** A draft on account A with an email step, then its go-live. */
  async function emailAutomationGoLive() {
    const created = await post(
      AUTOMATIONS_PATH,
      commentAutomationBody({
        channelAccountPublicId: accounts[0]!.public_id,
        overrides: {
          steps: completeAutomationSteps({ email: { on: true, wordings: ['Your email?'] } }),
        },
      }),
    );
    expect(created.statusCode, created.body).toBe(200);
    const automationPublicId = (created.json() as { data: { id: string } }).data.id;
    return post(automationActionPath({ automationPublicId, action: 'go-live' }));
  }

  async function planAccess() {
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/context'),
      token: team.ownerToken,
    });
    expect(response.statusCode, response.body).toBe(200);
    return (
      response.json() as {
        data: {
          active_organization: {
            plan_access: {
              state: string;
              plan: { id: string } | null;
              features: { feature_switches: Record<string, boolean> } | null;
            };
          };
        };
      }
    ).data.active_organization.plan_access;
  }

  it('a Creator trial without a card: both accounts send, an email step goes live, the notices 3 days and 1 day before, then Free keeping the picked account (AC-24.1–AC-24.3, AC-24.5)', async () => {
    const [accountA, accountB] = accounts as [TestAccount, TestAccount];
    const started = await startTrial(catalog.creator.public_id);
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toMatchObject({ data: { is_trial: true, status: 'TRIALING' } });
    const trialRows = await operatorQuery<{ count: number }[]>`
      SELECT count(*)::int AS count FROM billing.trial_accounts
      WHERE organization_id = ${team.organization.id}`;
    expect(trialRows[0]?.count).toBe(2);
    await runHandedPlanChanges();
    expect(await planStops()).toEqual([null, null]);
    expect((await planAccess()).plan?.id).toBe(catalog.creator.public_id);
    // A PRO part goes live during the trial (AC-24.1).
    const live = await emailAutomationGoLive();
    expect(live.statusCode, live.body).toBe(200);

    // 3 days and 1 day before the end: the "trial ends" notice and email, once each (AC-24.2).
    const row = await liveRow();
    const trialEnd = new Date(row.trial_end!);
    expect(trialEnd.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    await planStateCheck(row.public_id, new Date(trialEnd.getTime() - 2.5 * DAY));
    await planStateCheck(row.public_id, new Date(trialEnd.getTime() - 2.5 * DAY));
    const threeDays = await noticesOf('billing.trial_ending');
    expect(threeDays.map((notice) => notice.user_id)).toContain(team.owner.id);
    expect(threeDays.every((notice) => (notice.data.channels as string[]).includes('email'))).toBe(
      true,
    );
    await planStateCheck(row.public_id, new Date(trialEnd.getTime() - 12 * 60 * 60 * 1000));
    expect(await noticesOf('billing.trial_ending')).toHaveLength(2 * threeDays.length);

    // The owner picks B to keep on Free; the trial ends with no card.
    const picked = await post(testApiPath(`/billing/subscriptions/${row.public_id}/change-plan`), {
      plan_id: catalog.free.public_id,
      keep_channel_account_ids: [accountB.public_id],
    });
    expect(picked.statusCode, picked.body).toBe(200);
    handedTasks.length = 0;
    const endedAt = new Date(Date.now() - 60_000);
    await operatorQuery`
      UPDATE billing.subscriptions SET current_period_start = ${new Date(endedAt.getTime() - 7 * DAY)},
        current_period_end = ${endedAt}, trial_end = ${endedAt},
        scheduled_change_at = CASE WHEN scheduled_change_at IS NULL THEN NULL ELSE ${endedAt}::timestamptz END
      WHERE public_id = ${row.public_id}`;
    await deliverStripeSubscriptionEvent({
      app,
      organizationPublicId: team.organization.public_id,
      providerSubscriptionId: row.provider_subscription_id,
      providerCustomerId: row.provider_customer_id,
      type: 'customer.subscription.deleted',
      status: 'canceled',
      priceId: 'price_creator_monthly',
      periodStart: new Date(endedAt.getTime() - 7 * DAY),
      periodEnd: endedAt,
      trialEnd: endedAt,
    });
    expect(
      handedTasks.map((task) => (task.taskInput as InstagramPlanChangeTaskInput).change),
    ).toEqual(['trial_ended']);
    await runHandedPlanChanges();

    // On Free: the picked account kept, the other stopped with plan_downgrade (AC-24.3).
    expect(await planStops()).toEqual(['plan_downgrade', null]);
    expect(accountA.public_id).not.toBe(accountB.public_id);
    const access = await planAccess();
    expect(access.plan?.id).toBe(catalog.free.public_id);
    expect(access.features?.feature_switches.email_ask).toBe(false);
    // Nothing deleted: the email automation stays live with its step saved.
    const automations = await operatorQuery<{ status: string; deleted_at: Date | null }[]>`
      SELECT status, deleted_at FROM app.automations WHERE organization_id = ${team.organization.id}`;
    expect(automations).toEqual([{ status: 'live', deleted_at: null }]);

    // A second trial in the same organization is refused (AC-24.5): the local Free row does not
    // hide the one-trial rule, and no second trial row or account record is made.
    const again = await startTrial(catalog.studio.public_id);
    expect(again.statusCode, again.body).toBe(409);
    expect((again.json() as { error: { reason?: string } }).error.reason, again.body).toBe(
      'trial_already_used',
    );
    const trialling = await operatorQuery<{ count: number }[]>`
      SELECT count(*)::int AS count FROM billing.subscriptions
      WHERE organization_id = ${team.organization.id} AND status = 'TRIALING'`;
    expect(trialling[0]?.count).toBe(0);
    const recorded = await operatorQuery<{ count: number }[]>`
      SELECT count(*)::int AS count FROM billing.trial_accounts
      WHERE organization_id = ${team.organization.id}`;
    expect(recorded[0]?.count).toBe(2);
  });

  /** The trial ends unpaid at Stripe: the organization is left on its local Free row. */
  async function endTrialUnpaid(row: SubscriptionRow) {
    const endedAt = new Date(Date.now() - 60_000);
    await operatorQuery`
      UPDATE billing.subscriptions SET current_period_start = ${new Date(endedAt.getTime() - 7 * DAY)},
        current_period_end = ${endedAt}, trial_end = ${endedAt}
      WHERE public_id = ${row.public_id}`;
    await deliverStripeSubscriptionEvent({
      app,
      organizationPublicId: team.organization.public_id,
      providerSubscriptionId: row.provider_subscription_id,
      providerCustomerId: row.provider_customer_id,
      type: 'customer.subscription.deleted',
      status: 'canceled',
      priceId: 'price_creator_monthly',
      periodStart: new Date(endedAt.getTime() - 7 * DAY),
      periodEnd: endedAt,
      trialEnd: endedAt,
    });
  }

  async function liveRows() {
    return operatorQuery<
      { status: string; plan_id: string; provider_subscription_id: string | null }[]
    >`
      SELECT status, plan_id::text, provider_subscription_id FROM billing.subscriptions
      WHERE organization_id = ${team.organization.id} AND status NOT IN ('CANCELED', 'INCOMPLETE_EXPIRED')`;
  }

  it('a brand-new organization on Free subscribes to a paid plan, and another starts its first trial (route 102)', async () => {
    const paid = await post(testApiPath('/billing/subscriptions'), {
      plan_id: catalog.creator.public_id,
      billing_cycle: 'monthly',
    });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(await liveRows()).toEqual([
      expect.objectContaining({ plan_id: String(catalog.creator.id) }),
    ]);

    team = await createInstagramTeam();
    const trial = await startTrial(catalog.creator.public_id);
    expect(trial.statusCode, trial.body).toBe(200);
    expect(await liveRows()).toEqual([
      expect.objectContaining({ status: 'TRIALING', plan_id: String(catalog.creator.id) }),
    ]);
  });

  it('after an unpaid trial end the organization on its local Free row subscribes to a paid plan; a second trial answers trial_already_used', async () => {
    expect((await startTrial(catalog.creator.public_id)).statusCode).toBe(200);
    await endTrialUnpaid(await liveRow());
    expect(await liveRows()).toEqual([
      { status: 'ACTIVE', plan_id: String(catalog.free.id), provider_subscription_id: null },
    ]);

    const again = await startTrial(catalog.studio.public_id);
    expect(again.statusCode, again.body).toBe(409);
    expect((again.json() as { error: { reason?: string } }).error.reason, again.body).toBe(
      'trial_already_used',
    );

    handedTasks.length = 0;
    const paid = await post(testApiPath('/billing/subscriptions'), {
      plan_id: catalog.creator.public_id,
      billing_cycle: 'monthly',
    });
    expect(paid.statusCode, paid.body).toBe(200);
    // The local Free row ends in the same commit: one live row, the paid one.
    const live = await liveRows();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ plan_id: String(catalog.creator.id) });
    expect(live[0]?.provider_subscription_id).not.toBeNull();
    expect((await planAccess()).plan?.id).toBe(catalog.creator.public_id);
    // The accounts the trial end stopped come back on the paid plan.
    await runHandedPlanChanges();
    expect(await planStops()).toEqual([null, null]);
  });

  it('an organization on a local Free row that never had a trial starts its first trial', async () => {
    await createTestSubscription({
      organizationId: team.organization.id,
      planId: catalog.free.id,
      status: 'ACTIVE',
    });
    const trial = await startTrial(catalog.creator.public_id);
    expect(trial.statusCode, trial.body).toBe(200);
    expect(await liveRows()).toEqual([
      expect.objectContaining({ status: 'TRIALING', plan_id: String(catalog.creator.id) }),
    ]);
    // Free again on Free's own row is still the one live row's job (409).
    const free = await post(testApiPath('/billing/subscriptions'), {
      plan_id: catalog.free.public_id,
      billing_cycle: 'monthly',
    });
    expect(free.statusCode, free.body).toBe(409);
  });

  it('with no pick the oldest-connected account stays on Free (AC-24.3)', async () => {
    expect((await startTrial(catalog.creator.public_id)).statusCode).toBe(200);
    const row = await liveRow();
    handedTasks.length = 0;
    const endedAt = new Date(Date.now() - 60_000);
    await operatorQuery`
      UPDATE billing.subscriptions SET current_period_start = ${new Date(endedAt.getTime() - 7 * DAY)},
        current_period_end = ${endedAt}, trial_end = ${endedAt}
      WHERE public_id = ${row.public_id}`;
    await deliverStripeSubscriptionEvent({
      app,
      organizationPublicId: team.organization.public_id,
      providerSubscriptionId: row.provider_subscription_id,
      providerCustomerId: row.provider_customer_id,
      type: 'customer.subscription.deleted',
      status: 'canceled',
      priceId: 'price_creator_monthly',
      periodStart: new Date(endedAt.getTime() - 7 * DAY),
      periodEnd: endedAt,
      trialEnd: endedAt,
    });
    await runHandedPlanChanges();
    expect(await planStops()).toEqual([null, 'plan_downgrade']);
  });

  it('Creator trial → Studio trial keeps the end date; with a card the plan goes on paid with no gap; a failed payment later tells the owner and keeps sending (AC-24.4, AC-24.6, P224)', async () => {
    expect((await startTrial(catalog.creator.public_id)).statusCode).toBe(200);
    await runHandedPlanChanges();
    const before = await liveRow();

    // The trial changes to Studio: the same end date (AC-24.6).
    const changed = await post(
      testApiPath(`/billing/subscriptions/${before.public_id}/change-plan`),
      { plan_id: catalog.studio.public_id },
    );
    expect(changed.statusCode, changed.body).toBe(200);
    const after = await liveRow();
    expect(after).toMatchObject({ status: 'TRIALING', plan_id: String(catalog.studio.id) });
    expect(new Date(after.trial_end!).getTime()).toBe(new Date(before.trial_end!).getTime());
    await runHandedPlanChanges();
    expect(await planStops()).toEqual([null, null]);

    // A card was added: at the trial end Stripe charges it and the plan goes on paid (AC-24.4).
    const now = new Date();
    await deliverStripeSubscriptionEvent({
      app,
      organizationPublicId: team.organization.public_id,
      providerSubscriptionId: after.provider_subscription_id,
      providerCustomerId: after.provider_customer_id,
      type: 'customer.subscription.updated',
      status: 'active',
      priceId: 'price_studio_monthly',
      periodStart: now,
      periodEnd: new Date(now.getTime() + 30 * DAY),
      trialEnd: now,
    });
    await runHandedPlanChanges();
    expect((await liveRow()).status).toBe('ACTIVE');
    expect(await planStops()).toEqual([null, null]);
    expect(await planAccess()).toMatchObject({
      state: 'active',
      plan: { id: catalog.studio.public_id },
    });

    // The next payment fails: the billing people are told once; sending goes on in the grace (P224).
    await deliverStripeSubscriptionEvent({
      app,
      organizationPublicId: team.organization.public_id,
      providerSubscriptionId: after.provider_subscription_id,
      providerCustomerId: after.provider_customer_id,
      type: 'customer.subscription.updated',
      status: 'past_due',
      priceId: 'price_studio_monthly',
      periodStart: now,
      periodEnd: new Date(now.getTime() + 30 * DAY),
      trialEnd: now,
    });
    const failed = await noticesOf('billing.payment_failed');
    expect(failed.map((notice) => notice.user_id)).toContain(team.owner.id);
    expect(failed.map((notice) => notice.user_id)).not.toContain(team.editor.id);
    expect(failed.every((notice) => (notice.data.channels as string[]).includes('email'))).toBe(
      true,
    );
    await runHandedPlanChanges();
    expect(await planStops()).toEqual([null, null]);
    expect((await planAccess()).state).toBe('grace');
  });
});
