import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type DomainEvent, eventBus } from '@/core/events/event-bus.js';
import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import { env } from '@/shared/config/env.config.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import {
  type PlanStateChangedPayload,
  SUBSCRIPTION_EVENT,
} from '@/domains/billing/sub-domains/subscription/events/subscription.events.js';
import { createRetentionSubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';
import { processSubscriptionPlanStateCheckJob } from '@/domains/billing/sub-domains/subscription/workers/subscription-plan-state-check.processor.js';
import { instagramPlanChangeJobId } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-plan-change.job.schema.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { getOperatorDatabase, operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createDomainContainers, type DomainContainers } from '@/worker-containers.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * feat-instagram-dm-sending ROUTE row R52 — routes-final § 8.B BL17, BL24 (BLC10, BLC13; WC-59):
 * the plan-state check against real Postgres — a grace that ended emits `plan_ended` keyed once by
 * its period end (AC-11.8, without any Stripe event), a trial gets its 3-day and 1-day notices once
 * each, a subscription on a switched-off plan row gets one email and one `moved_down` however often
 * the check runs (AC-11.3), and the sweep finds exactly the due rows. Stripe is never called: the
 * check has no payment-provider dependency.
 */
describe('Subscription plan-state check (R52, WC-59)', () => {
  let containers: DomainContainers;
  let team: InstagramTeamFixture;
  let creator: { id: number; public_id: string };
  let growth: { id: number; public_id: string };
  const events: PlanStateChangedPayload[] = [];
  const readOnlyEnforced = env.BILLING_READ_ONLY_ENFORCED;

  beforeAll(async () => {
    await initializeI18nextForBackgroundWork();
    containers = createDomainContainers();
    eventBus.on({
      eventType: SUBSCRIPTION_EVENT.PLAN_STATE_CHANGED,
      handler: async (event: DomainEvent<unknown>) => {
        events.push(event.payload as PlanStateChangedPayload);
      },
    });
  });

  afterAll(async () => {
    env.BILLING_READ_ONLY_ENFORCED = readOnlyEnforced;
    await cleanupDatabase();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    events.length = 0;
    env.BILLING_READ_ONLY_ENFORCED = true;
    await getOperatorDatabase().update(plans).set({ is_active: false });
    await createTestPlan({
      name: `Free ${randomUUID()}`,
      priceMonthly: '0.00',
      priceYearly: '0.00',
      features: FREE_PLAN_FEATURES,
    });
    creator = await createTestPlan({
      name: `Creator ${randomUUID()}`,
      priceMonthly: '29.00',
      priceYearly: '276.00',
      features: CREATOR_PLAN_FEATURES,
    });
    growth = await createTestPlan({
      name: `Growth ${randomUUID()}`,
      priceMonthly: '99.00',
      priceYearly: '990.00',
      features: FREE_PLAN_FEATURES,
      isActive: false,
    });
    team = await createInstagramTeam();
  });

  /** One subscription of the team, then its status and dates as the case needs. */
  async function subscriptionOf(values: {
    planId: number;
    status: string;
    periodEnd: Date;
    trialEnd?: Date | null;
  }) {
    const row = await createTestSubscription({
      organizationId: team.organization.id,
      planId: values.planId,
      createdByUserId: team.owner.id,
    });
    await getOperatorDatabase()
      .update(subscriptions)
      .set({
        status: values.status,
        current_period_start: new Date(values.periodEnd.getTime() - 30 * DAY),
        current_period_end: values.periodEnd,
        trial_end: values.trialEnd ?? null,
      })
      .where(eq(subscriptions.id, row.id));
    return row;
  }

  function check(subscriptionPublicId: string, now = new Date()) {
    return processSubscriptionPlanStateCheckJob({
      jobData: { organizationPublicId: team.organization.public_id, subscriptionPublicId },
      services: {
        subscriptionService: containers.billingDomain.subscriptionService,
        notificationService: containers.notifyDomain.notificationService,
        membershipService: containers.tenancyDomain.membershipService,
        organizationSettingsService: containers.tenancyDomain.organizationSettingsService,
      },
      now,
    });
  }

  async function notices() {
    return operatorQuery<Array<{ user_id: string; type: string; data: { dedupe_key?: string } }>>`
      SELECT user_id, type, data FROM notify.notifications
      WHERE organization_id = ${team.organization.id} ORDER BY id`;
  }

  async function sweep() {
    return runGlobalRetentionWorkerJob((databaseHandle) =>
      createRetentionSubscriptionRepository(databaseHandle).listPlanStateCheckDue({
        dunningGraceDays: env.BILLING_DUNNING_GRACE_DAYS,
        lookbackDays: 7,
        trialNoticeMaxDays: 3,
        afterId: 0,
        limit: 500,
      }),
    );
  }

  it('a grace that ended emits plan_ended once in effect: every run carries the same plan-change job id (AC-11.8)', async () => {
    const periodEnd = new Date(Date.now() - (env.BILLING_DUNNING_GRACE_DAYS + 1) * DAY);
    const row = await subscriptionOf({ planId: creator.id, status: 'PAST_DUE', periodEnd });

    expect((await sweep()).map((due) => due.subscriptionPublicId)).toEqual([row.public_id]);
    await expect(check(row.public_id)).resolves.toEqual({
      outcome: 'checked',
      findings: [{ kind: 'grace_ended', did: 'emitted' }],
    });
    await check(row.public_id);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      organizationPublicId: team.organization.public_id,
      change: 'plan_ended',
      previous: { state: 'grace', plan_public_id: creator.public_id },
      current: { state: 'read_only' },
      change_key: String(periodEnd.getTime()),
    });
    const jobIds = events.map((event) =>
      instagramPlanChangeJobId({
        organizationPublicId: event.organizationPublicId,
        change: event.change,
        changeKey: event.change_key ?? '',
      }),
    );
    expect(new Set(jobIds).size).toBe(1);
    expect(await notices()).toHaveLength(0);
  });

  it('a grace still running is neither swept nor found', async () => {
    const row = await subscriptionOf({
      planId: creator.id,
      status: 'PAST_DUE',
      periodEnd: new Date(Date.now() - 3 * DAY),
    });
    expect(await sweep()).toEqual([]);
    await expect(check(row.public_id)).resolves.toEqual({ outcome: 'checked', findings: [] });
    expect(events).toHaveLength(0);
  });

  it('a trial gets its 3-day notice and its 1-day notice once each, to the billing recipients', async () => {
    const trialEnd = new Date(Date.now() + 2.5 * DAY);
    const row = await subscriptionOf({
      planId: creator.id,
      status: 'TRIALING',
      periodEnd: trialEnd,
      trialEnd,
    });

    expect((await sweep()).map((due) => due.subscriptionPublicId)).toEqual([row.public_id]);
    await check(row.public_id);
    await check(row.public_id);
    const threeDay = await notices();
    // Owner and Admin hold subscription:manage; the Editor and the Viewer do not.
    expect(threeDay.map((notice) => Number(notice.user_id)).sort()).toHaveLength(2);
    expect(threeDay.every((notice) => notice.type === 'billing.trial_ending')).toBe(true);
    expect(threeDay[0]?.data.dedupe_key).toBe(`trial-ending:${row.public_id}:3`);
    expect(threeDay.map((notice) => Number(notice.user_id))).toContain(team.owner.id);
    expect(threeDay.map((notice) => Number(notice.user_id))).not.toContain(team.editor.id);

    const dayBefore = new Date(trialEnd.getTime() - 12 * 60 * 60 * 1000);
    await check(row.public_id, dayBefore);
    await check(row.public_id, dayBefore);
    const all = await notices();
    expect(all).toHaveLength(4);
    expect(
      all.slice(2).every((notice) => notice.data.dedupe_key === `trial-ending:${row.public_id}:1`),
    ).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('a switched-off plan row gets one email and one moved_down however often the check runs (AC-11.3)', async () => {
    const row = await subscriptionOf({
      planId: growth.id,
      status: 'ACTIVE',
      periodEnd: new Date(Date.now() + 20 * DAY),
    });

    expect((await sweep()).map((due) => due.subscriptionPublicId)).toEqual([row.public_id]);
    await expect(check(row.public_id)).resolves.toEqual({
      outcome: 'checked',
      findings: [{ kind: 'legacy_plan', did: 'emitted' }],
    });
    await expect(check(row.public_id)).resolves.toEqual({
      outcome: 'checked',
      findings: [{ kind: 'legacy_plan', did: 'deduplicated' }],
    });
    await check(row.public_id);

    const sent = await notices();
    expect(sent).toHaveLength(2);
    expect(sent.every((notice) => notice.type === 'billing.plan_choice_required')).toBe(true);
    expect(sent[0]?.data.dedupe_key).toBe(`plan-choice:${row.public_id}`);
    expect(events).toEqual([
      expect.objectContaining({
        change: 'moved_down',
        previous: { state: 'active', plan_public_id: growth.public_id },
        current: { state: 'active', plan_public_id: growth.public_id },
        features: FREE_PLAN_FEATURES,
        kept_channel_account_public_ids: null,
        change_key: row.public_id,
      }),
    ]);
    // Stripe untouched: the row is as it was.
    const [after] = await getOperatorDatabase()
      .select({ status: subscriptions.status, plan_id: subscriptions.plan_id })
      .from(subscriptions)
      .where(eq(subscriptions.id, row.id));
    expect(after).toEqual({ status: 'ACTIVE', plan_id: growth.id });
  });

  it('a missing subscription is skipped', async () => {
    await expect(check('sub_missing00000000000000')).resolves.toEqual({
      outcome: 'skipped',
      reason: 'subscription_missing',
    });
  });
});
