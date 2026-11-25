import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { env } from '@/shared/config/env.config.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
  STUDIO_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertAutomationBackfill } from '@/domains/app/sub-domains/automation/automation-backfill/__tests__/factories/automation-backfill.factory.js';
import { BroadcastRepository } from '@/domains/app/sub-domains/broadcast/broadcast.repository.js';
import type { SegmentConditions } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import { insertAutomationRun } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertInstagramMessage } from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  insertLanes,
  setMonthCount,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import type { InstagramPlanChangeTaskInput } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-plan-change.job.schema.js';
import { runInstagramPlanChangeTask } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-plan-change.processor.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { getOperatorDatabase, operatorQuery } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { deliverStripeSubscriptionEvent } from '@/tests/helpers/stripe-subscription-event.helper.js';
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

/**
 * Flow — a move down at the period end (feat-instagram-dm-sending ROUTE row R58, AC-23.1–AC-23.11;
 * routes-final § 8.B BL5, BL6, BL8, § 8.D BL22, § 1B CA3, § 6 SNC7; WC-38; D57, P83). End to end over
 * the built code: route 103 (the move down and its kept accounts, the move up) by `fastify.inject`,
 * the Stripe webhook at the period end posted signed to route 107 and worked by the webhook job (the
 * event re-fetched from Stripe through nock), billing's `subscription.plan_state_changed` → the
 * app's handler (its task captured) → the plan-change task over the app's real services.
 */
describe('Flow: a move down at the period end (R58)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let catalog: Catalog;
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
  });

  afterEach(() => {
    nock.cleanAll();
  });

  function post(path: string, payload: object) {
    return injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath(path),
      token: team.ownerToken,
      headers: { 'x-idempotency-key': `r58-${randomUUID()}` },
      payload,
    });
  }

  /** Route 102 on a paid plan, then the organization's accounts, oldest-connected first. */
  async function subscribeWithAccounts(planPublicId: string, count: number) {
    const created = await post('/billing/subscriptions', {
      plan_id: planPublicId,
      billing_cycle: 'monthly',
    });
    expect(created.statusCode, created.body).toBe(200);
    const accounts: TestAccount[] = [];
    for (let index = 0; index < count; index += 1) {
      const account = await insertInstagramAccount({ organizationId: team.organization.id });
      await operatorQuery`
        UPDATE app.channel_accounts SET connected_at = now() - make_interval(days => ${60 - index})
        WHERE id = ${account.channel_account_id}`;
      await insertLanes({
        organizationId: team.organization.id,
        channelAccountId: account.channel_account_id,
      });
      accounts.push(account);
    }
    // Joining the paid plan is itself an upgrade (BL8); the flow starts after it.
    handedTasks.length = 0;
    return { subscriptionId: (created.json() as { data: { id: string } }).data.id, accounts };
  }

  async function planStops(): Promise<Array<string | null>> {
    const rows = await operatorQuery<{ plan_stop_reason: string | null }[]>`
      SELECT plan_stop_reason FROM app.channel_accounts
      WHERE organization_id = ${team.organization.id} ORDER BY connected_at, id`;
    return rows.map((row) => row.plan_stop_reason);
  }

  /**
   * Stripe at the period end: the event posted signed to route 107, then worked by the webhook job
   * (which re-fetches it from Stripe — nock).
   */
  async function stripeAtPeriodEnd({
    type,
    status,
    priceId,
  }: {
    type: 'customer.subscription.updated' | 'customer.subscription.deleted';
    status: 'active' | 'canceled';
    priceId: string;
  }) {
    const [row] = await operatorQuery<
      { provider_subscription_id: string; provider_customer_id: string }[]
    >`
      SELECT provider_subscription_id, provider_customer_id FROM billing.subscriptions
      WHERE organization_id = ${team.organization.id} AND provider_subscription_id IS NOT NULL
      ORDER BY id DESC LIMIT 1`;
    // The period ended a minute ago; a renewal starts the next one.
    await operatorQuery`
      UPDATE billing.subscriptions SET current_period_start = now() - interval '31 days',
        current_period_end = now() - interval '1 minute',
        scheduled_change_at = CASE WHEN scheduled_change_at IS NULL THEN NULL ELSE now() - interval '1 minute' END
      WHERE organization_id = ${team.organization.id} AND provider_subscription_id = ${row!.provider_subscription_id}`;
    const now = new Date();
    await deliverStripeSubscriptionEvent({
      app,
      organizationPublicId: team.organization.public_id,
      providerSubscriptionId: row!.provider_subscription_id,
      providerCustomerId: row!.provider_customer_id,
      type,
      status,
      priceId,
      periodStart: now,
      periodEnd: new Date(now.getTime() + 30 * DAY),
    });
  }

  /** The one plan-change task billing's event handed the app (by job id), run as its worker would. */
  async function runHandedPlanChange(change: string) {
    const task = handedTasks.find(
      (candidate) => (candidate.taskInput as InstagramPlanChangeTaskInput).change === change,
    );
    expect(task, `a ${change} task`).toBeDefined();
    const domain = app.appDomain;
    return runInstagramPlanChangeTask({
      services: {
        channelAccountService: domain.channelAccountService,
        laneService: domain.instagramSendLaneService,
        broadcastService: domain.broadcastService,
        automationBackfillService: domain.automationBackfillService,
        automationService: domain.automationService,
      },
      organizationPublicId: team.organization.public_id,
      taskInput: task?.taskInput as InstagramPlanChangeTaskInput,
      runInDatabaseSlot: (callback) => callback(),
    });
  }

  it('Studio with 6 accounts moves to Creator keeping A, B and C: nothing changes until the period end, then the other 3 stop with plan_downgrade; moving up clears them (AC-23.1, AC-23.2, AC-23.10)', async () => {
    const { subscriptionId, accounts } = await subscribeWithAccounts(catalog.studio.public_id, 6);
    const ids = accounts.map((account) => account.public_id);
    const changePlan = `/billing/subscriptions/${subscriptionId}/change-plan`;

    // The owner first keeps D, E and F, then changes her mind before the period end (AC-23.2).
    const first = await post(changePlan, {
      plan_id: catalog.creator.public_id,
      keep_channel_account_ids: ids.slice(3),
    });
    expect(first.statusCode, first.body).toBe(200);
    const changed = await post(changePlan, {
      plan_id: catalog.creator.public_id,
      keep_channel_account_ids: ids.slice(0, 3),
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(
      (changed.json() as { data: { scheduled_change: { keep_channel_account_ids: string[] } } })
        .data.scheduled_change.keep_channel_account_ids,
    ).toEqual(ids.slice(0, 3));

    // Until the period end nothing changes: every account sends, no plan change is handed over.
    expect(await planStops()).toEqual([null, null, null, null, null, null]);
    expect(handedTasks).toEqual([]);

    await stripeAtPeriodEnd({
      type: 'customer.subscription.updated',
      status: 'active',
      priceId: 'price_creator_monthly',
    });
    expect(handedTasks).toEqual([
      expect.objectContaining({
        jobName: 'plan-change',
        organizationPublicId: team.organization.public_id,
        taskInput: { change: 'moved_down', keptChannelAccountPublicIds: ids.slice(0, 3) },
      }),
    ]);
    await expect(runHandedPlanChange('moved_down')).resolves.toMatchObject({ movedCount: 3 });
    expect(await planStops()).toEqual([
      null,
      null,
      null,
      'plan_downgrade',
      'plan_downgrade',
      'plan_downgrade',
    ]);
    const lanes = await operatorQuery<{ state: string }[]>`
      SELECT state FROM app.instagram_send_lanes WHERE channel_account_id = ${accounts[5]!.channel_account_id}`;
    expect(lanes.every((lane) => lane.state === 'stopped')).toBe(true);

    // Moving up again clears every plan_downgrade at once (AC-23.10).
    handedTasks.length = 0;
    const up = await post(changePlan, { plan_id: catalog.studio.public_id });
    expect(up.statusCode, up.body).toBe(200);
    await expect(runHandedPlanChange('upgraded')).resolves.toMatchObject({
      movedCount: 3,
      wokenCount: 3,
    });
    expect(await planStops()).toEqual([null, null, null, null, null, null]);
  });

  it('with no choice the oldest-connected accounts stay (AC-23.2)', async () => {
    const { subscriptionId } = await subscribeWithAccounts(catalog.studio.public_id, 5);
    const moved = await post(`/billing/subscriptions/${subscriptionId}/change-plan`, {
      plan_id: catalog.creator.public_id,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    await stripeAtPeriodEnd({
      type: 'customer.subscription.updated',
      status: 'active',
      priceId: 'price_creator_monthly',
    });
    await runHandedPlanChange('moved_down');
    expect(await planStops()).toEqual([null, null, null, 'plan_downgrade', 'plan_downgrade']);
  });

  it('Creator → Free: one account kept, broadcasts cancelled, the read failed, nothing deleted, one notice — and the month over Free starts plan_limit (AC-23.5–AC-23.9)', async () => {
    const { subscriptionId, accounts } = await subscribeWithAccounts(catalog.creator.public_id, 2);
    const [older, kept] = accounts as [TestAccount, TestAccount];
    const steps = (extra: object) => ({
      hello: {
        on: true,
        versions: [
          { text: 'Hi A', buttons: [{ title: 'Send it', action: 'next' }] },
          { text: 'Hi B', buttons: [{ title: 'Send it', action: 'next' }] },
        ],
      },
      messages: [{ kind: 'text', wait_minutes: 0, text: 'Here it is' }],
      ...extra,
    });
    const automationOf = (extra: object, status = 'live') =>
      insertAutomation({
        organizationId: team.organization.id,
        channelAccountId: kept.channel_account_id,
        status,
        steps: steps(extra),
      } as Parameters<typeof insertAutomation>[0]);
    const guide = await automationOf({ email: { on: true, wordings: ['Your email?'] } });
    await automationOf({ phone: { on: true, wordings: ['Your phone?'] } });
    await automationOf({ email: { on: true, wordings: ['Email?'] } }, 'paused');
    await automationOf({});
    await insertAutomationBackfill({
      organizationId: team.organization.id,
      channelAccountId: kept.channel_account_id,
      automationId: guide.id,
    });
    // An opening DM the read already queued, still waiting.
    const commenter = await insertContact({
      organizationId: team.organization.id,
      instagramAccountId: kept.id,
    });
    const queued = await insertInstagramMessage({
      run: await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: guide.id,
        contactId: commenter.id,
      }),
      channelAccountId: kept.channel_account_id,
      message_type: 'opening_message',
      message_number: null,
      lane: 'slow',
      channel: 'private_reply',
      status: 'waiting',
      reason: null,
    });
    const conditions: SegmentConditions = {
      op: 'and',
      items: [{ field: 'tags', match: 'any', values: ['vip'] }],
    };
    await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: team.organization.public_id }),
      callback: async (databaseHandle) => {
        const repository = new BroadcastRepository(databaseHandle as RequestScopedPostgresDatabase);
        const insert = (name: string) =>
          repository.insert({
            organizationId: team.organization.id,
            channelAccount: { id: kept.channel_account_id, channel: 'instagram' },
            name,
            values: { conditions, messages: [{ kind: 'text', wait_minutes: 0, text: 'Hello' }] },
            createdByUserId: null,
          });
        const scheduled = await insert('Spring drop');
        await insert('Draft');
        await repository.markSent({
          organizationId: team.organization.id,
          broadcastId: scheduled.id,
          values: {
            status: 'scheduled',
            mode: 'scheduled',
            conditions,
            scheduledAt: new Date(Date.now() + DAY),
            endsAt: null,
            isStarted: false,
          },
          updatedByUserId: null,
        });
      },
    });
    // 1,500 DMs this month: within Creator's 10,000, over Free's 1,000.
    await setMonthCount({ organizationId: team.organization.id, count: 1500 });

    const moved = await post(`/billing/subscriptions/${subscriptionId}/change-plan`, {
      plan_id: catalog.free.public_id,
      keep_channel_account_ids: [kept.public_id],
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await planStops()).toEqual([null, null]);

    await stripeAtPeriodEnd({
      type: 'customer.subscription.deleted',
      status: 'canceled',
      priceId: 'price_creator_monthly',
    });
    const result = await runHandedPlanChange('moved_down');

    // One account kept; the month over Free's limit starts plan_limit on it at once (AC-23.9).
    expect(await planStops()).toEqual(['plan_downgrade', 'plan_limit']);
    expect(older.public_id).not.toBe(kept.public_id);
    expect(result).toMatchObject({
      cancelledBroadcastCount: 1,
      failedBackfillCount: 1,
      questionStepsOffCount: 3,
    });
    // Scheduled broadcasts end cancelled · plan_feature_off; the draft stays (AC-23.5).
    const broadcasts = await operatorQuery<
      { name: string; status: string; cancel_reason: string | null }[]
    >`
      SELECT name, status, cancel_reason FROM app.broadcasts
      WHERE organization_id = ${team.organization.id} ORDER BY id`;
    expect(broadcasts).toEqual([
      { name: 'Spring drop', status: 'cancelled', cancel_reason: 'plan_feature_off' },
      { name: 'Draft', status: 'draft', cancel_reason: null },
    ]);
    // The unfinished past-comments read ends failed · plan_feature_off (AC-23.6).
    const reads = await operatorQuery<{ status: string; fail_reason: string | null }[]>`
      SELECT status, fail_reason FROM app.automation_backfills WHERE automation_id = ${guide.id}`;
    expect(reads).toEqual([{ status: 'failed', fail_reason: 'plan_feature_off' }]);
    // … and the opening DM it already queued still goes (still waiting on the kept account).
    const [queuedNow] = await operatorQuery<{ status: string }[]>`
      SELECT status FROM app.instagram_messages WHERE public_id = ${queued.public_id}`;
    expect(queuedNow?.status).toBe('waiting');
    // Nothing is deleted and no automation is stopped (AC-23.7, D57).
    const automations = await operatorQuery<
      { status: string; deleted_at: Date | null; steps: object }[]
    >`
      SELECT status, deleted_at, steps FROM app.automations
      WHERE organization_id = ${team.organization.id} ORDER BY id`;
    expect(automations.map((row) => [row.status, row.deleted_at])).toEqual([
      ['live', null],
      ['live', null],
      ['paused', null],
      ['live', null],
    ]);
    expect(automations[0]?.steps).toMatchObject({ email: { on: true } });

    // One notice and one email to the billing people: "Moved to Free: … off in 3 automations" (AC-23.8).
    const notices = async () =>
      operatorQuery<{ user_id: number; message: string; data: Record<string, unknown> }[]>`
        SELECT user_id::int AS user_id, message, data FROM notify.notifications
        WHERE organization_id = ${team.organization.id} AND type = 'subscription.updated'
          AND data->>'automations_count' IS NOT NULL
        ORDER BY id`;
    const told = await notices();
    expect(told.map((row) => row.user_id)).toContain(team.owner.id);
    expect(told.map((row) => row.user_id)).not.toContain(team.editor.id);
    expect(new Set(told.map((row) => row.user_id)).size).toBe(told.length);
    expect(told[0]?.message).toBe(
      'Moved to Free: email and phone steps are off in 3 automations. Upgrade to switch them on again.',
    );
    expect(told.every((row) => (row.data.channels as string[]).includes('email'))).toBe(true);
    // The task again (a replay) tells nothing twice and changes nothing.
    await expect(runHandedPlanChange('moved_down')).resolves.toMatchObject({ movedCount: 0 });
    expect(await notices()).toHaveLength(told.length);
  });
});
