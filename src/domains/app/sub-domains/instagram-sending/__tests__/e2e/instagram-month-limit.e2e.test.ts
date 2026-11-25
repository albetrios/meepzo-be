import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import {
  FREE_PLAN_FEATURES,
  STUDIO_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  META_GRAPH_BASE_URL,
  sendInstagramMessage,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertAutomationRun } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  APP_USAGE_PATH,
  insertLanes,
  readLaneRows,
  readStopRows,
  setMonthCount,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import {
  insertInstagramMessage,
  readInstagramMessages,
} from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import { InstagramMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.service.js';
import { InstagramSendCoreService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-core.service.js';
import { InstagramSendLaneRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.repository.js';
import type { InstagramSendLane } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import { planStopHoldsLane } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.util.js';
import type {
  InstagramSendAccess,
  InstagramSendLaneRules,
  InstagramSendTicketContext,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { setCachedMessageMonthCount } from '@/domains/app/sub-domains/instagram-sending/message-month-count.cache.js';
import { runInstagramPlanChangeTask } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-plan-change.processor.js';
import { runInstagramSendingRepairDuty } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-repair.processor.js';
import { INSTAGRAM_REPAIR_MONTH_WAKE_JOB_NAME } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-repair.constants.js';
import { runMessageMonthNoticeCheckJob } from '@/domains/app/sub-domains/instagram-sending/workers/message-month-notice-check.processor.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

/** The month-wake tasks the repair duty hands `instagram-database-tasks` (captured, not queued). */
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

type TestAccount = Awaited<ReturnType<typeof insertInstagramAccount>>;
type TestRun = Awaited<ReturnType<typeof insertAutomationRun>>;

/** A ticket put back by the core (BullMQ's `DelayedError` in a real worker). */
class TicketReturned extends Error {
  constructor(readonly delayMilliseconds: number) {
    super('ticket returned');
  }
}

const context: InstagramSendTicketContext = {
  jobId: 'month-limit-flow',
  runInDatabaseSlot: (callback) => callback(),
  returnTicket: async (delayMilliseconds) => {
    throw new TicketReturned(delayMilliseconds);
  },
};

/**
 * Flow — the month limit: 80 %, 100 %, the new month (feat-instagram-dm-sending ROUTE row R57,
 * AC-22.1–AC-22.9; routes-final § 6 SN3, SN8, SNC7, § 11.D UNC9; WC-15, WC-37, WC-56). A Free
 * organization (1,000 DMs a month) with two accounts, end to end over the built code: billing's real
 * plan read for the limit, the app's real gate (its month claim and the 80 % / 100 % notice after the
 * commit), lane service, month count, notices, plan-change task and month-wake repair duty, route 64
 * through `fastify.inject`. The lanes' own message pick is a test plug (the oldest waiting message of
 * the lane) and the account's access a fixed token; the Meta wire is nock.
 */
describe('Flow: the month limit — 80 %, 100 %, the new month (R57)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let studio: { id: number };
  let subscriptionId: number;
  let accountA: TestAccount;
  let accountB: TestAccount;
  let runA: TestRun;
  let runB: TestRun;
  let core: InstagramSendCoreService;
  const automationIds = new Map<number, number>();
  const token = encryptFieldSecret('EAAG-month-limit-flow');

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: team.organization.public_id });

  function accessOf(target: TestAccount): InstagramSendAccess {
    return {
      channelAccount: {
        organizationId: team.organization.id,
        channelAccountId: target.channel_account_id,
      },
      channelAccountPublicId: target.public_id,
      channelConnection: { organizationId: team.organization.id, channelConnectionId: 7 },
      channelConnectionPublicId: 'chc_ccccccccccccccccccccc',
      clientBusinessId: '5550001',
      instagramUserId: `1784${target.channel_account_id}`,
      encryptedAccessToken: token,
      isSendable: true,
    };
  }

  function rulesOf(lane: InstagramSendLane): InstagramSendLaneRules {
    return {
      readLimits: async () => ({ hourLimit: 600, personHourLimit: null }),
      pickNextMessage: async ({ target }) => {
        const [next] = await operatorQuery<
          { public_id: string; automation_run_started_at: Date }[]
        >`
          SELECT public_id, automation_run_started_at FROM app.instagram_messages
          WHERE channel_account_id = ${target.channelAccountId} AND lane = ${lane} AND status = 'waiting'
          ORDER BY id LIMIT 1`;
        return next === undefined
          ? { key: null, nextRunAt: null, waitReason: null }
          : {
              key: {
                organizationId: team.organization.id,
                publicId: next.public_id,
                automationRunStartedAt: next.automation_run_started_at,
              },
            };
      },
      composeMessage: async ({ message }) => ({
        kind: 'send',
        uploadPublicId: null,
        call: async ({ access, recordUsage }) => {
          const sent = await sendInstagramMessage({
            encryptedAccessToken: access.encryptedAccessToken ?? '',
            instagramUserId: access.instagramUserId,
            recipient:
              message.channel === 'private_reply'
                ? { comment_id: '17900000000000001' }
                : { id: '9001' },
            message: { text: 'Here is the link' },
            requestId: 'month-limit-flow',
            recordUsage,
          });
          return { instagramMessageId: sent.messageId };
        },
      }),
    };
  }

  function buildCore(): InstagramSendCoreService {
    const domain = app.appDomain;
    return new InstagramSendCoreService({
      laneService: domain.instagramSendLaneService,
      messageService: new InstagramMessageService({
        recordRunMessageResult: async () => undefined,
        recordBroadcastMessageResult: async () => undefined,
      }),
      // The real gate: the month claim against Postgres and the 80 % / 100 % notice (WC-56).
      gateService: domain.instagramSendGateService,
      accessService: {
        readSendAccess: async ({ channelAccountPublicId }) =>
          accessOf(channelAccountPublicId === accountB.public_id ? accountB : accountA),
        readSendPace: async () => ({ pace: 'normal', waitUntil: null }),
        buildUsageRecorder: () => undefined,
      },
      attachmentService: {
        findOrUploadAttachment: async () => ({ status: 'unusable' }),
        forgetAttachment: async () => true,
      },
      sendingStateService: domain.sendingStateService,
      // Billing's real plan read: Free's 1,000 a month, Studio's after the upgrade.
      readMonthLimit: (target) => domain.messageMonthCountService.readMonthLimit(target),
      breakPort: {
        markConnectionBroken: async () => true,
        markAccountBroken: async () => true,
      },
      laneRules: { slow: rulesOf('slow'), reply: rulesOf('reply'), fast: rulesOf('fast') },
      producers: { enqueueLaneTurn: async () => {}, enqueueFastMessage: async () => {} },
      sleep: async () => {},
    });
  }

  function metaAccepts(target: TestAccount, times = 1) {
    return nock(META_GRAPH_BASE_URL)
      .post(`/v27.0/1784${target.channel_account_id}/messages`)
      .query(true)
      .times(times)
      .reply(200, { message_id: 'mid.flow' });
  }

  async function turn(lane: 'slow' | 'reply', target: TestAccount) {
    const rows = await new InstagramSendLaneRepository().listByAccount({
      organizationId: team.organization.id,
      channelAccountId: target.channel_account_id,
    });
    const row = rows.find((candidate) => candidate.lane === lane);
    await core.workLaneTurn({
      ticket: {
        organizationPublicId: team.organization.public_id,
        channelAccountPublicId: target.public_id,
        lane,
        turnNumber: row?.turn_number ?? 0,
      },
      scope: scope(),
      context,
    });
  }

  /** A new person's run on the account's automation (one opening DM per run). */
  async function newRun(target: TestAccount): Promise<TestRun> {
    const contact = await insertContact({
      organizationId: team.organization.id,
      instagramAccountId: target.id,
      last_direct_message_received_at: new Date(),
    });
    return insertAutomationRun({
      organizationId: team.organization.id,
      automationId: automationIds.get(target.channel_account_id) ?? 0,
      contactId: contact.id,
    });
  }

  async function waitingMessage(
    target: TestAccount,
    targetRun: TestRun | null = null,
    values: Partial<Parameters<typeof insertInstagramMessage>[0]> = {},
  ) {
    return insertInstagramMessage({
      run: targetRun ?? (await newRun(target)),
      channelAccountId: target.channel_account_id,
      message_type: 'opening_message',
      message_number: null,
      lane: 'slow',
      channel: 'private_reply',
      is_counted_as_direct_message: true,
      status: 'waiting',
      reason: null,
      ...values,
    });
  }

  async function monthUsed(): Promise<number> {
    const [row] = await operatorQuery<{ used: number }[]>`
      SELECT COALESCE(sum(count), 0)::int AS used FROM app.message_month_counts
      WHERE organization_id = ${team.organization.id}
        AND month_start = (SELECT date_trunc('month', now() AT TIME ZONE timezone)::date
                           FROM tenancy.organizations WHERE id = ${team.organization.id})`;
    return Number(row?.used ?? 0);
  }

  async function planStops(): Promise<Array<string | null>> {
    const rows = await operatorQuery<{ plan_stop_reason: string | null }[]>`
      SELECT plan_stop_reason FROM app.channel_accounts
      WHERE organization_id = ${team.organization.id} ORDER BY id`;
    return rows.map((row) => row.plan_stop_reason);
  }

  async function monthNotices() {
    return operatorQuery<{ user_id: number; message: string; data: Record<string, unknown> }[]>`
      SELECT user_id::int AS user_id, message, data FROM notify.notifications
      WHERE organization_id = ${team.organization.id} AND type = 'billing.usage_threshold'
      ORDER BY id`;
  }

  async function statusOf(publicId: string): Promise<string | undefined> {
    const rows = await readInstagramMessages(team.organization.id);
    return rows.find((row) => row.public_id === publicId)?.status;
  }

  function planChange(change: 'upgraded' | 'month_wake') {
    const domain = app.appDomain;
    return runInstagramPlanChangeTask({
      services: {
        channelAccountService: domain.channelAccountService,
        laneService: domain.instagramSendLaneService,
        broadcastService: domain.broadcastService,
        automationBackfillService: domain.automationBackfillService,
      },
      organizationPublicId: team.organization.public_id,
      taskInput: { change, keptChannelAccountPublicIds: null },
      runInDatabaseSlot: (callback) => callback(),
    });
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    nock.cleanAll();
    handedTasks.length = 0;
    team = await createInstagramTeam();
    await operatorQuery`
      UPDATE tenancy.organizations SET timezone = 'Asia/Kolkata' WHERE id = ${team.organization.id}`;
    const free = await createTestPlan({
      name: 'Free',
      priceMonthly: '0.00',
      priceYearly: '0.00',
      // Free's 1,000 DMs a month; two accounts so "every account" has more than one (AC-22.2).
      features: { ...FREE_PLAN_FEATURES, channel_accounts_max: 2 },
    });
    studio = await createTestPlan({
      name: 'Studio',
      priceMonthly: '79.00',
      priceYearly: '756.00',
      features: STUDIO_PLAN_FEATURES,
    });
    subscriptionId = (
      await createTestSubscription({
        organizationId: team.organization.id,
        planId: free.id,
        status: 'ACTIVE',
      })
    ).id;
    accountA = await insertInstagramAccount({ organizationId: team.organization.id });
    accountB = await insertInstagramAccount({ organizationId: team.organization.id });
    const runs: TestRun[] = [];
    for (const target of [accountA, accountB]) {
      await insertLanes({
        organizationId: team.organization.id,
        channelAccountId: target.channel_account_id,
      });
      const contact = await insertContact({
        organizationId: team.organization.id,
        instagramAccountId: target.id,
        last_direct_message_received_at: new Date(),
      });
      const automation = await insertAutomation({
        organizationId: team.organization.id,
        channelAccountId: target.channel_account_id,
        status: 'live',
      });
      automationIds.set(target.channel_account_id, automation.id);
      runs.push(
        await insertAutomationRun({
          organizationId: team.organization.id,
          automationId: automation.id,
          contactId: contact.id,
        }),
      );
    }
    [runA, runB] = runs as [TestRun, TestRun];
    core = buildCore();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('820 of 1,000: one notice and email per person, once (AC-22.1)', async () => {
    await setMonthCount({ organizationId: team.organization.id, count: 820 });
    const service = app.appDomain.messageMonthNoticeService;

    const checked = await runMessageMonthNoticeCheckJob({ monthNotice: service });
    expect(checked).toMatchObject({ checkedCount: 1, failedCount: 0 });
    const rows = await monthNotices();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((row) => row.user_id)).toEqual(
      expect.arrayContaining([team.owner.id, team.editor.id]),
    );
    expect(rows.map((row) => row.user_id)).not.toContain(team.viewer.id);
    expect(new Set(rows.map((row) => row.user_id)).size).toBe(rows.length);
    expect(rows.every((row) => row.data.percent === 80)).toBe(true);
    expect(rows.every((row) => (row.data.channels as string[]).includes('email'))).toBe(true);
    expect(rows[0]?.message).toContain('820 of 1,000 DMs');

    // A send that stays inside 80 % tells nothing more.
    await waitingMessage(accountA, runA);
    metaAccepts(accountA);
    await turn('slow', accountA);
    expect(await monthUsed()).toBe(821);
    await runMessageMonthNoticeCheckJob({ monthNotice: service });
    expect(await monthNotices()).toHaveLength(rows.length);
  });

  it('the 1,000th DM stops slow, fast and broadcast on every account; replies still go; a tap and 40 opening DMs wait (AC-22.2, AC-22.3)', async () => {
    await setMonthCount({ organizationId: team.organization.id, count: 999 });
    const last = await waitingMessage(accountA, runA);
    metaAccepts(accountA);
    await turn('slow', accountA);

    expect(await statusOf(last.public_id)).toBe('sent');
    expect(await monthUsed()).toBe(1000);
    expect(await planStops()).toEqual(['plan_limit', 'plan_limit']);
    // The account's plan stop holds slow, fast and broadcast; the reply lane goes on (D62).
    const held = (['slow', 'reply', 'fast', 'broadcast'] as const).filter((lane) =>
      planStopHoldsLane({ planStopReason: 'plan_limit', lane }),
    );
    expect(held).toEqual(['slow', 'fast', 'broadcast']);
    for (const target of [accountA, accountB]) {
      const history = await readStopRows(target.channel_account_id);
      expect(history.map((row) => row.reason)).toContain('plan_limit');
      expect(history.every((row) => row.ended_at === null)).toBe(true);
    }
    // The 100 % notice, told after the claim that reached it.
    const reached = (await monthNotices()).filter((row) => row.data.percent === 100);
    expect(reached.map((row) => row.user_id)).toEqual(
      expect.arrayContaining([team.owner.id, team.editor.id]),
    );

    // 40 opening DMs and a tap's answer wait; none is sent.
    const openings = [];
    for (let index = 0; index < 40; index += 1) openings.push(await waitingMessage(accountB));
    const tapAnswer = await waitingMessage(accountB, runB, {
      message_type: 'message',
      message_number: 1,
      lane: 'fast',
      channel: 'direct',
    });
    const never = metaAccepts(accountB, 41);
    await turn('slow', accountB);
    await core
      .sendFastMessage({
        ticket: {
          organizationPublicId: team.organization.public_id,
          channelAccountPublicId: accountB.public_id,
          instagramMessagePublicId: tapAnswer.public_id,
          automationRunStartedAt: tapAnswer.automation_run_started_at.toISOString(),
          tries: 0,
        },
        scope: scope(),
        context,
      })
      .catch((error: unknown) => {
        if (!(error instanceof TicketReturned)) throw error;
      });
    expect(never.isDone()).toBe(false);
    expect(await statusOf(tapAnswer.public_id)).toBe('waiting');
    for (const opening of openings) expect(await statusOf(opening.public_id)).toBe('waiting');
    expect(await monthUsed()).toBe(1000);
    nock.cleanAll();

    // The reply lane is not held: the public reply of a DM already sent still goes, uncounted.
    const reply = await waitingMessage(accountA, runA, {
      message_type: 'public_reply',
      lane: 'reply',
      channel: 'comment_reply',
      is_counted_as_direct_message: false,
    });
    metaAccepts(accountA);
    await turn('reply', accountA);
    expect(await statusOf(reply.public_id)).toBe('sent');
    expect(await monthUsed()).toBe(1000);
  });

  it('two accounts sending at the same moment push the count no further than the DMs on their way (AC-22.4)', async () => {
    await setMonthCount({ organizationId: team.organization.id, count: 998 });
    for (let index = 0; index < 3; index += 1) {
      await waitingMessage(accountA);
      await waitingMessage(accountB);
    }
    metaAccepts(accountA, 3);
    metaAccepts(accountB, 3);

    // Each account's slow lane works its turns while the other does (two lanes, one month).
    const work = async (target: TestAccount) => {
      for (let index = 0; index < 3; index += 1) await turn('slow', target);
    };
    await Promise.all([work(accountA), work(accountB)]);

    const used = await monthUsed();
    expect(used).toBeGreaterThanOrEqual(1000);
    // Over the limit by at most the one DM the other account had on its way.
    expect(used).toBeLessThanOrEqual(1001);
    expect(await planStops()).toEqual(['plan_limit', 'plan_limit']);
    const sent = (await readInstagramMessages(team.organization.id)).filter(
      (row) => row.status === 'sent',
    );
    expect(sent).toHaveLength(used - 998);
  });

  it('the new month in the organization time zone: the month-wake repair finds it, the stops end, the waiting DMs go (AC-22.6)', async () => {
    await setMonthCount({ organizationId: team.organization.id, count: 1000 });
    await waitingMessage(accountA, runA);
    await turn('slow', accountA);
    expect(await planStops()).toEqual(['plan_limit', 'plan_limit']);
    const waiting = await waitingMessage(accountB, runB, {
      trigger_occurred_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });

    // Not due while the month is the one the stop started in.
    await runInstagramSendingRepairDuty({ duty: INSTAGRAM_REPAIR_MONTH_WAKE_JOB_NAME });
    expect(handedTasks).toHaveLength(0);

    // The month turns in Asia/Kolkata: last month keeps its count, the stop started before 00:00.
    await operatorQuery`
      UPDATE app.message_month_counts SET month_start = (month_start - interval '1 month')::date
      WHERE organization_id = ${team.organization.id}`;
    await operatorQuery`
      UPDATE app.channel_accounts
      SET plan_stopped_at = (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') - interval '1 minute'
      WHERE organization_id = ${team.organization.id}`;
    expect(await monthUsed()).toBe(0);

    const repaired = await runInstagramSendingRepairDuty({
      duty: INSTAGRAM_REPAIR_MONTH_WAKE_JOB_NAME,
    });
    expect(repaired).toMatchObject({ addedCount: 1, isBudgetSpent: false });
    expect(handedTasks).toEqual([
      expect.objectContaining({
        jobName: 'month-wake',
        organizationPublicId: team.organization.public_id,
        taskInput: { change: 'month_wake', keptChannelAccountPublicIds: null },
      }),
    ]);

    const woken = await planChange('month_wake');
    expect(woken).toMatchObject({ movedCount: 2, wokenCount: 2 });
    expect(await planStops()).toEqual([null, null]);
    expect((await readLaneRows(accountB.channel_account_id)).map((lane) => lane.state)).toEqual([
      'ready',
      'ready',
      'ready',
      'ready',
    ]);
    metaAccepts(accountB);
    await turn('slow', accountB);
    expect(await statusOf(waiting.public_id)).toBe('sent');
    expect(await monthUsed()).toBe(1);
    // A second wake changes nothing; the repair finds nobody due any more.
    await expect(planChange('month_wake')).resolves.toMatchObject({ movedCount: 0 });
    handedTasks.length = 0;
    await runInstagramSendingRepairDuty({ duty: INSTAGRAM_REPAIR_MONTH_WAKE_JOB_NAME });
    expect(handedTasks).toHaveLength(0);
  });

  it('an upgrade above the count ends the stop at once and wakes the lanes (AC-22.7)', async () => {
    await setMonthCount({ organizationId: team.organization.id, count: 1000 });
    await waitingMessage(accountA, runA);
    await turn('slow', accountA);
    expect(await planStops()).toEqual(['plan_limit', 'plan_limit']);

    await operatorQuery`
      UPDATE billing.subscriptions SET plan_id = ${studio.id} WHERE id = ${subscriptionId}`;
    await expect(planChange('upgraded')).resolves.toMatchObject({ movedCount: 2, wokenCount: 2 });
    expect(await planStops()).toEqual([null, null]);

    metaAccepts(accountA);
    await turn('slow', accountA);
    expect(await monthUsed()).toBe(1001);
  });

  it('Redis saying "full" never stops a send that Postgres allows (AC-22.9)', async () => {
    await setMonthCount({ organizationId: team.organization.id, count: 10 });
    const [month] = await operatorQuery<{ month_start: string; resets_on: string }[]>`
      SELECT date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date::text AS month_start,
             (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 month')::date::text AS resets_on`;
    await setCachedMessageMonthCount({
      organizationPublicId: team.organization.public_id,
      month: { monthStart: month!.month_start, resetsOn: month!.resets_on, used: 1000 },
    });
    // The meter reads the Redis copy …
    const meter = await injectAuthenticated(app, { url: APP_USAGE_PATH, token: team.ownerToken });
    expect(meter.statusCode).toBe(200);
    expect(
      (meter.json() as { data: { direct_messages: { used: number } } }).data.direct_messages.used,
    ).toBe(1000);

    // … the send decides from Postgres.
    const message = await waitingMessage(accountA, runA);
    metaAccepts(accountA);
    await turn('slow', accountA);
    expect(await statusOf(message.public_id)).toBe('sent');
    expect(await monthUsed()).toBe(11);
    expect(await planStops()).toEqual([null, null]);
  });
});
