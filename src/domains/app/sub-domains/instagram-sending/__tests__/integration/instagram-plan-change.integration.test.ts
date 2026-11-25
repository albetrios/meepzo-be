import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { env } from '@/shared/config/env.config.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
  STUDIO_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationBackfill,
  readAutomationBackfillRows,
} from '@/domains/app/sub-domains/automation/automation-backfill/__tests__/factories/automation-backfill.factory.js';
import { BroadcastRepository } from '@/domains/app/sub-domains/broadcast/broadcast.repository.js';
import type { SegmentConditions } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import { CHANNEL_ACCOUNT_PLAN_STOP_REASON } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import { createRetentionChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  insertLanes,
  readStopRows,
  setMonthCount,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import type { InstagramPlanChangeTaskInput } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-plan-change.job.schema.js';
import { runInstagramPlanChangeTask } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-plan-change.processor.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { getOperatorDatabase, operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createDomainContainers, type DomainContainers } from '@/worker-containers.js';

const DAY = 24 * 60 * 60 * 1000;
type TestAccount = Awaited<ReturnType<typeof insertInstagramAccount>>;

/**
 * feat-instagram-dm-sending ROUTE row R52 — the plan change and the month wake (routes-final § 8
 * BL6, BL8, § 1B CA3, § 6 SN8, SNC7; WC-37, WC-38): the accounts' plan stops against real Postgres
 * and the app's real services, in the organization's job scope — a move down stops the accounts
 * over the new limit (the kept, else the oldest, stay) and turns off exactly the switches it lacks
 * (AC-9.11, AC-8.7); a move up clears `plan_downgrade` and re-derives `plan_limit` (AC-11.6); a plan
 * that ended stops every account (AC-11.8, AC-11.9) and picking a plan wakes them (AC-11.10); the
 * new month ends `plan_limit` (AC-10.9).
 */
describe('Instagram plan change (R52, WC-37, WC-38)', () => {
  let containers: DomainContainers;
  let team: InstagramTeamFixture;
  let creator: { id: number };
  let studio: { id: number };
  let accounts: TestAccount[];
  const readOnlyEnforced = env.BILLING_READ_ONLY_ENFORCED;

  beforeAll(() => {
    containers = createDomainContainers();
  });

  afterAll(async () => {
    env.BILLING_READ_ONLY_ENFORCED = readOnlyEnforced;
    await cleanupDatabase();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
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
    studio = await createTestPlan({
      name: `Studio ${randomUUID()}`,
      priceMonthly: '79.00',
      priceYearly: '756.00',
      features: STUDIO_PLAN_FEATURES,
    });
    team = await createInstagramTeam();
    accounts = [];
    for (let index = 0; index < 3; index += 1) {
      const account = await insertInstagramAccount({ organizationId: team.organization.id });
      await insertLanes({
        organizationId: team.organization.id,
        channelAccountId: account.channel_account_id,
      });
      accounts.push(account);
    }
  });

  function run(
    taskInput: Partial<InstagramPlanChangeTaskInput> & Pick<InstagramPlanChangeTaskInput, 'change'>,
  ) {
    const app = containers.appDomain;
    return runInstagramPlanChangeTask({
      services: {
        channelAccountService: app.channelAccountService,
        laneService: app.instagramSendLaneService,
        broadcastService: app.broadcastService,
        automationBackfillService: app.automationBackfillService,
      },
      organizationPublicId: team.organization.public_id,
      taskInput: { keptChannelAccountPublicIds: null, ...taskInput },
      runInDatabaseSlot: (callback) => callback(),
    });
  }

  async function stops(): Promise<Array<string | null>> {
    const rows = await operatorQuery<Array<{ id: string; plan_stop_reason: string | null }>>`
      SELECT id, plan_stop_reason FROM app.channel_accounts
      WHERE organization_id = ${team.organization.id} ORDER BY connected_at, id`;
    return rows.map((row) => row.plan_stop_reason);
  }

  async function setStop(account: TestAccount, reason: string | null, stoppedAt = new Date()) {
    await operatorQuery`
      UPDATE app.channel_accounts SET plan_stop_reason = ${reason},
        plan_stopped_at = ${reason === null ? null : stoppedAt}
      WHERE id = ${account.channel_account_id}`;
  }

  async function subscribe(planId: number, values: { status?: string; periodEnd?: Date } = {}) {
    const row = await createTestSubscription({
      organizationId: team.organization.id,
      planId,
      createdByUserId: team.owner.id,
    });
    const periodEnd = values.periodEnd ?? new Date(Date.now() + 20 * DAY);
    await getOperatorDatabase()
      .update(subscriptions)
      .set({
        status: values.status ?? 'ACTIVE',
        current_period_start: new Date(periodEnd.getTime() - 30 * DAY),
        current_period_end: periodEnd,
      })
      .where(eq(subscriptions.id, row.id));
    return row;
  }

  it('a move down to Free keeps the oldest account and stops the others with plan_downgrade; a repeat changes nothing', async () => {
    const result = await run({ change: 'moved_down' });

    expect(result).toMatchObject({ movedCount: 2, wokenCount: 0 });
    expect(await stops()).toEqual([null, 'plan_downgrade', 'plan_downgrade']);
    const history = await readStopRows(accounts[1]?.channel_account_id ?? 0);
    expect(history).toEqual([
      expect.objectContaining({ lane: 'all', reason: 'plan_downgrade', ended_at: null }),
    ]);
    await expect(run({ change: 'moved_down' })).resolves.toMatchObject({ movedCount: 0 });
  });

  it('a move down keeps the account the owner picked, not the oldest (BL6)', async () => {
    await run({
      change: 'moved_down',
      keptChannelAccountPublicIds: [accounts[2]?.public_id ?? ''],
    });
    expect(await stops()).toEqual(['plan_downgrade', 'plan_downgrade', null]);
  });

  it('a move up clears every plan_downgrade up to the new limit and wakes those accounts (AC-11.6)', async () => {
    await run({ change: 'moved_down' });
    await subscribe(studio.id);

    const result = await run({ change: 'upgraded' });

    expect(result).toMatchObject({ movedCount: 2, wokenCount: 2 });
    expect(await stops()).toEqual([null, null, null]);
    const history = await readStopRows(accounts[1]?.channel_account_id ?? 0);
    expect(history[0]).toMatchObject({ reason: 'plan_downgrade' });
    expect(history[0]?.ended_at).not.toBeNull();
  });

  it('a move up keeps plan_limit while the month is still over the new limit, and ends it when it is under (AC-11.6)', async () => {
    // 20 000 this month: over Creator's 10 000, under Studio's 50 000.
    await setMonthCount({ organizationId: team.organization.id, count: 20_000 });
    await setStop(accounts[0] as TestAccount, 'plan_limit');
    const row = await subscribe(creator.id);

    await run({ change: 'upgraded' });
    expect(await stops()).toEqual(['plan_limit', 'plan_limit', 'plan_limit']);

    await getOperatorDatabase()
      .update(subscriptions)
      .set({ plan_id: studio.id })
      .where(eq(subscriptions.id, row.id));
    await expect(run({ change: 'upgraded' })).resolves.toMatchObject({ wokenCount: 3 });
    expect(await stops()).toEqual([null, null, null]);
  });

  it('a plan that ended stops every account with plan_ended; picking a plan ends it and re-derives plan_limit (AC-11.8–AC-11.10)', async () => {
    const row = await subscribe(creator.id, {
      status: 'PAST_DUE',
      periodEnd: new Date(Date.now() - (env.BILLING_DUNNING_GRACE_DAYS + 1) * DAY),
    });
    await setStop(accounts[0] as TestAccount, 'plan_limit');
    await setMonthCount({ organizationId: team.organization.id, count: 999_999 });

    await run({ change: 'plan_ended' });
    expect(await stops()).toEqual(['plan_ended', 'plan_ended', 'plan_ended']);
    const lanes = await operatorQuery<Array<{ state: string }>>`
      SELECT state FROM app.instagram_send_lanes WHERE channel_account_id = ${accounts[1]?.channel_account_id ?? 0}`;
    expect(lanes.every((lane) => lane.state === 'stopped')).toBe(true);

    // The backup's look while the plan has still ended changes nothing.
    await expect(run({ change: 'backup' })).resolves.toMatchObject({ movedCount: 0 });

    await operatorQuery`
      UPDATE billing.subscriptions SET status = 'ACTIVE',
        current_period_start = now() - interval '1 day', current_period_end = now() + interval '29 days'
      WHERE id = ${row.id}`;
    const resumed = await run({ change: 'resumed' });

    // The month is still full: the weaker stop comes back on every account — never forgotten (CA3).
    expect(await stops()).toEqual(['plan_limit', 'plan_limit', 'plan_limit']);
    expect(resumed).toMatchObject({ movedCount: 3, wokenCount: 3 });
    const history = await readStopRows(accounts[1]?.channel_account_id ?? 0);
    expect(history.find((stop) => stop.reason === 'plan_ended')?.ended_at).not.toBeNull();
  });

  it('the backup finds an organization still holding plan_ended and ends it once the plan is live', async () => {
    for (const account of accounts) await setStop(account, 'plan_ended');
    const due = await runGlobalRetentionWorkerJob((databaseHandle) =>
      createRetentionChannelAccountRepository(databaseHandle).listOrganizationsHoldingPlanStop({
        reason: CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_ENDED,
        isMonthTurned: false,
        afterOrganizationId: 0,
        limit: 500,
      }),
    );
    expect(due.map((row) => row.organizationPublicId)).toEqual([team.organization.public_id]);

    await run({ change: 'backup' });
    // Free never ends: the organization is on Free, one account in its plan.
    expect(await stops()).toEqual([null, 'plan_downgrade', 'plan_downgrade']);
  });

  it('the new month in the organization time zone ends plan_limit and wakes the lanes (AC-10.9)', async () => {
    await subscribe(studio.id);
    const lastMonth = new Date(Date.now() - 40 * DAY);
    for (const account of accounts) await setStop(account, 'plan_limit', lastMonth);
    // Another organization stopped this month is not due.
    const other = await createInstagramTeam();
    const otherAccount = await insertInstagramAccount({ organizationId: other.organization.id });
    await operatorQuery`
      UPDATE app.channel_accounts SET plan_stop_reason = 'plan_limit', plan_stopped_at = now()
      WHERE id = ${otherAccount.channel_account_id}`;

    const due = await runGlobalRetentionWorkerJob((databaseHandle) =>
      createRetentionChannelAccountRepository(databaseHandle).listOrganizationsHoldingPlanStop({
        reason: CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_LIMIT,
        isMonthTurned: true,
        afterOrganizationId: 0,
        limit: 500,
      }),
    );
    expect(due.map((row) => row.organizationPublicId)).toEqual([team.organization.public_id]);
    expect(due[0]?.month).toMatch(/^\d{4}-\d{2}$/);

    const woken = await run({ change: 'month_wake' });
    expect(woken).toMatchObject({ movedCount: 3, wokenCount: 3 });
    expect(await stops()).toEqual([null, null, null]);
  });

  it('a move down turns off exactly the lost switches: scheduled broadcasts cancelled, unfinished reads failed (AC-9.11, AC-8.7)', async () => {
    const account = accounts[0] as TestAccount;
    const automation = await insertAutomation({
      organizationId: team.organization.id,
      channelAccountId: account.channel_account_id,
    } as Parameters<typeof insertAutomation>[0]);
    const backfill = await insertAutomationBackfill({
      organizationId: team.organization.id,
      channelAccountId: account.channel_account_id,
      automationId: automation.id,
    });
    const conditions: SegmentConditions = {
      op: 'and',
      items: [{ field: 'tags', match: 'any', values: ['vip'] }],
    };
    const [scheduledId, draftId] = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: team.organization.public_id }),
      callback: async (databaseHandle) => {
        const repository = new BroadcastRepository(databaseHandle as RequestScopedPostgresDatabase);
        const insert = (name: string) =>
          repository.insert({
            organizationId: team.organization.id,
            channelAccount: { id: account.channel_account_id, channel: 'instagram' },
            name,
            values: { conditions, messages: [{ kind: 'text', wait_minutes: 0, text: 'Hello' }] },
            createdByUserId: null,
          });
        const scheduled = await insert('Spring drop');
        const draft = await insert('Draft');
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
        return [scheduled.id, draft.id];
      },
    });

    const result = await run({ change: 'moved_down' });

    expect(result).toMatchObject({ cancelledBroadcastCount: 1, failedBackfillCount: 1 });
    const broadcasts = await operatorQuery<
      Array<{ id: string; status: string; cancel_reason: string | null }>
    >`
      SELECT id, status, cancel_reason FROM app.broadcasts WHERE organization_id = ${team.organization.id} ORDER BY id`;
    expect(broadcasts.find((row) => Number(row.id) === scheduledId)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'plan_feature_off',
    });
    expect(broadcasts.find((row) => Number(row.id) === draftId)?.status).toBe('draft');
    const [read] = await readAutomationBackfillRows(automation.id);
    expect(read).toMatchObject({
      id: backfill.id,
      status: 'failed',
      fail_reason: 'plan_feature_off',
    });
  });

  it('a move up or a plan end leaves broadcasts and reads alone', async () => {
    await subscribe(studio.id);
    await expect(run({ change: 'upgraded' })).resolves.toMatchObject({
      cancelledBroadcastCount: 0,
      failedBackfillCount: 0,
    });
  });
});
