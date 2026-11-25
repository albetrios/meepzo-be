import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import type { RepairDutyContext } from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  META_GRAPH_BASE_URL,
  META_GRAPH_VERSION,
  sendInstagramMessage,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  type TestAssignedAccount,
  channelConnectCallbackPath,
  channelConnectStartPath,
  channelReconnectPath,
  connectInstagramAccountsThroughRoutes,
  mockMetaLogin,
  nextClientBusinessId,
  readChannelConnectionRows,
  readStateFromLoginUrl,
} from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import {
  type ChannelConnectionTokenCheckServices,
  processChannelConnectionTokenCheckJob,
} from '@/domains/app/sub-domains/channel-connection/workers/channel-connection-token-check.processor.js';
import { channelAccountPath } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
  readInstagramAccountRows,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
  type InstagramReconnectNoticeJobData,
  closeInstagramReconnectNoticeQueue,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.queue.js';
import { INSTAGRAM_ACCOUNT_SETUP_JOB_NAME } from '@/domains/app/sub-domains/instagram-account/queues/instagram-account-tasks.queue.js';
import { processInstagramReconnectNoticeJob } from '@/domains/app/sub-domains/instagram-account/workers/instagram-reconnect-notice.processor.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertAutomationRun } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { insertContact } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  insertLanes,
  readLaneRows,
  readStopRows,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import {
  insertInstagramMessage,
  readInstagramMessages,
} from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import { InstagramMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.service.js';
import { InstagramSendCoreService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-core.service.js';
import {
  type InstagramRepairFastTicket,
  type InstagramRepairLaneTicket,
  InstagramSendingRepairService,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending-repair.service.js';
import type { InstagramSendLane } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import type {
  InstagramSendLaneRules,
  InstagramSendTicketContext,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { INSTAGRAM_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const GRAPH_PATH = `/${META_GRAPH_VERSION}`;

const TOKEN_REFUSED = {
  error: {
    message: 'Error validating access token: The user has not authorized application.',
    type: 'OAuthException',
    code: 190,
    error_subcode: 458,
  },
};

/** A ticket put back by the core (BullMQ's `DelayedError` in a real worker). */
class TicketReturned extends Error {
  constructor(readonly delayMilliseconds: number) {
    super('ticket returned');
  }
}

const context: InstagramSendTicketContext = {
  jobId: 'reconnect-flow',
  runInDatabaseSlot: (callback) => callback(),
  returnTicket: async (delayMilliseconds) => {
    throw new TicketReturned(delayMilliseconds);
  },
};

let accountSequence = 0;

/** A fresh assigned Instagram account (unique per call). */
function nextAccount(): TestAssignedAccount {
  accountSequence += 1;
  const suffix = `${Date.now()}${accountSequence}`.slice(-11).padStart(11, '0');
  return { id: `17841${suffix}`, username: `flow.${suffix}` };
}

/** One connected account as the flow uses it. */
interface FlowAccount {
  assigned: TestAssignedAccount;
  instagramAccountId: number;
  channelAccountId: number;
  publicId: string;
  automationId: number;
}

/**
 * Flow — a token error, the reconnect, the lanes waking (feat-instagram-dm-sending ROUTE row R60,
 * AC-25.1–AC-25.7; routes-final § 1 MC6, MC10, MC11, MCC6, § 6 SN5, SN6; WC-13, WC-15, WC-34, WC-46;
 * P54). One team organization with its connections made through routes 1–3, end to end over the
 * built code: the send core with its real access read, gate, sending state and break port
 * (`ChannelConnectionService.markConnectionBroken` → every account `error`, their lanes stopped, one
 * reconnect notice job each), the reconnect-notice job, the daily token check, the repair duties
 * (lost turns with the 5-minute spread, the 7-day expiry), the reconnect (routes 40 and 2) and the
 * disconnect (route 8) through `fastify.inject`. The lanes' own message pick is a test plug (the
 * oldest waiting message of the lane); the Meta wire is nock.
 */
describe('Flow: a token error, the reconnect, the lanes waking (R60)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let core: InstagramSendCoreService;
  let laneTickets: InstagramRepairLaneTicket[];
  let fastTickets: InstagramRepairFastTicket[];
  let repair: InstagramSendingRepairService;
  const noticeQueue = new Queue<InstagramReconnectNoticeJobData>(
    INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
    { connection: getBullMQConnectionOptions(), prefix: getBullMQKeyPrefix() },
  );
  const tasksQueue = new Queue(INSTAGRAM_TASKS_QUEUE_NAME, {
    connection: getBullMQConnectionOptions(),
    prefix: getBullMQKeyPrefix(),
  });

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: team.organization.public_id });
  const repairContext = (): RepairDutyContext => ({
    now: new Date(),
    isBudgetSpent: () => false,
  });

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
            requestId: 'reconnect-flow',
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
      gateService: domain.instagramSendGateService,
      // The real access read: the account's and its connection's status and the stored token.
      accessService: domain.instagramSendAccessService,
      attachmentService: {
        findOrUploadAttachment: async () => ({ status: 'unusable' }),
        forgetAttachment: async () => true,
      },
      sendingStateService: domain.sendingStateService,
      readMonthLimit: (target) => domain.messageMonthCountService.readMonthLimit(target),
      // The real break port, as the app container wires it (MC11, CA4).
      breakPort: {
        markConnectionBroken: (input) =>
          domain.channelConnectionService.markConnectionBroken(input),
        markAccountBroken: (input) => domain.channelAccountService.markAccountBroken(input),
      },
      laneRules: { slow: rulesOf('slow'), reply: rulesOf('reply'), fast: rulesOf('fast') },
      producers: { enqueueLaneTurn: async () => {}, enqueueFastMessage: async () => {} },
      sleep: async () => {},
    });
  }

  /** Connects these accounts to one business through routes 1–3; each gets its lanes and automation. */
  async function connect(
    assigned: TestAssignedAccount[],
    clientBusinessId = nextClientBusinessId(),
  ): Promise<{
    channelConnectionPublicId: string;
    clientBusinessId: string;
    accounts: FlowAccount[];
  }> {
    const connected = await connectInstagramAccountsThroughRoutes({
      app,
      token: team.ownerToken,
      accounts: assigned,
      clientBusinessId,
    });
    const rows = await readInstagramAccountRows(team.organization.id);
    const accounts: FlowAccount[] = [];
    for (const account of assigned) {
      const row = rows.find((candidate) => candidate.instagram_user_id === account.id);
      if (row === undefined) throw new Error(`account ${account.id} was not connected`);
      const channelAccountId = Number(row.channel_account_id);
      await insertLanes({ organizationId: team.organization.id, channelAccountId });
      const automation = await insertAutomation({
        organizationId: team.organization.id,
        channelAccountId,
        status: 'live',
      });
      accounts.push({
        assigned: account,
        instagramAccountId: Number(row.id),
        channelAccountId,
        publicId: row.public_id,
        automationId: automation.id,
      });
    }
    return { ...connected, accounts };
  }

  /** A waiting message of a new person's run on the account (slow: an opening DM; fast: a DM). */
  async function waitingMessage(
    account: FlowAccount,
    lane: 'slow' | 'fast',
    values: Partial<Parameters<typeof insertInstagramMessage>[0]> = {},
  ) {
    const contact = await insertContact({
      organizationId: team.organization.id,
      instagramAccountId: account.instagramAccountId,
      last_direct_message_received_at: new Date(),
    });
    const run = await insertAutomationRun({
      organizationId: team.organization.id,
      automationId: account.automationId,
      contactId: contact.id,
    });
    return insertInstagramMessage({
      run,
      channelAccountId: account.channelAccountId,
      ...(lane === 'slow'
        ? {
            message_type: 'opening_message',
            message_number: null,
            lane: 'slow',
            channel: 'private_reply',
          }
        : { lane: 'fast', channel: 'direct' }),
      is_counted_as_direct_message: true,
      status: 'waiting',
      reason: null,
      ...values,
    });
  }

  /** One slow-lane turn of the account, through the core. */
  async function slowTurn(account: FlowAccount): Promise<void> {
    const lanes = await readLaneRows(account.channelAccountId);
    const slow = lanes.find((lane) => lane.lane === 'slow');
    try {
      await core.workLaneTurn({
        ticket: {
          organizationPublicId: team.organization.public_id,
          channelAccountPublicId: account.publicId,
          lane: 'slow',
          turnNumber: Number(slow?.turn_number ?? 0),
        },
        scope: scope(),
        context,
      });
    } catch (error) {
      if (!(error instanceof TicketReturned)) throw error;
    }
  }

  function metaAnswers(account: FlowAccount, status: 200 | 400) {
    return nock(META_GRAPH_BASE_URL)
      .post(`${GRAPH_PATH}/${account.assigned.id}/messages`)
      .query(true)
      .reply(status, status === 200 ? { message_id: `mid.${account.assigned.id}` } : TOKEN_REFUSED);
  }

  async function statusOf(publicId: string): Promise<string | undefined> {
    const rows = await readInstagramMessages(team.organization.id);
    return rows.find((row) => row.public_id === publicId)?.status;
  }

  async function accountStatus(account: FlowAccount): Promise<string | undefined> {
    const rows = await readInstagramAccountRows(team.organization.id);
    return rows.find((row) => row.public_id === account.publicId)?.connection_status;
  }

  async function connectionStatus(channelConnectionPublicId: string): Promise<string | undefined> {
    const rows = await readChannelConnectionRows(team.organization.id);
    return rows.find((row) => row.public_id === channelConnectionPublicId)?.status;
  }

  async function noticeJobs() {
    return noticeQueue.getJobs(['waiting', 'delayed', 'prioritized', 'active', 'completed']);
  }

  async function setupJobAccounts(): Promise<string[]> {
    const jobs = await tasksQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    return jobs
      .filter((job) => job.name === INSTAGRAM_ACCOUNT_SETUP_JOB_NAME)
      .map((job) => String(job.data.taskInput?.channelAccountPublicId));
  }

  /** Routes 40 and 2 for this connection, Meta answering with this business and these accounts. */
  async function reconnect({
    channelConnectionPublicId,
    clientBusinessId,
    assigned,
  }: {
    channelConnectionPublicId: string;
    clientBusinessId: string;
    assigned: TestAssignedAccount[];
  }): Promise<InjectHttpResult> {
    const start = await injectAuthenticated(app, {
      method: 'POST',
      url: channelReconnectPath(channelConnectionPublicId),
      token: team.ownerToken,
    });
    expect(start.statusCode, start.body).toBe(200);
    const state = readStateFromLoginUrl(
      (start.json() as { data: { login_url: string } }).data.login_url,
    );
    mockMetaLogin({ clientBusinessId, assignedAccounts: assigned });
    return injectAuthenticated(app, {
      method: 'POST',
      url: channelConnectCallbackPath(),
      token: team.ownerToken,
      payload: { code: 'AQB-reconnect-flow#_', state },
      headers: { 'x-idempotency-key': `channel-connect:${state}` },
    });
  }

  /** The daily token check of one connection (WC-34), Meta answering with these assigned accounts. */
  function tokenCheck(channelConnectionPublicId: string, assigned: TestAssignedAccount[]) {
    const graph = nock(META_GRAPH_BASE_URL)
      .get(`${GRAPH_PATH}/me/assigned_instagram_accounts`)
      .query(true)
      .reply(200, { data: assigned });
    for (const account of assigned) {
      graph.get(`${GRAPH_PATH}/${account.id}`).query(true).reply(200, {
        id: account.id,
        username: account.username,
        followers_count: 10,
      });
    }
    const services: ChannelConnectionTokenCheckServices = {
      connectionService: app.appDomain.channelConnectionService,
      accountPort: app.appDomain.channelAccountService,
      usageService: app.appDomain.channelConnectionUsageService,
    };
    return processChannelConnectionTokenCheckJob({
      jobData: { organizationPublicId: team.organization.public_id, channelConnectionPublicId },
      services,
      requestId: 'reconnect-flow',
    });
  }

  beforeAll(async () => {
    await initializeI18nextForBackgroundWork();
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await closeInstagramReconnectNoticeQueue();
    await noticeQueue.close();
    await tasksQueue.close();
  });

  beforeEach(async () => {
    await noticeQueue.obliterate({ force: true });
    await tasksQueue.obliterate({ force: true });
    await cleanupDatabase();
    await seedAllPermissions();
    nock.cleanAll();
    team = await createInstagramTeam();
    const plan = await createTestPlan({
      features: { ...CREATOR_PLAN_FEATURES, channel_accounts_max: 6 },
      priceMonthly: '29.00',
      priceYearly: '276.00',
    });
    await createTestSubscription({
      organizationId: team.organization.id,
      planId: plan.id,
      status: 'ACTIVE',
    });
    core = buildCore();
    laneTickets = [];
    fastTickets = [];
    repair = new InstagramSendingRepairService({
      messageService: new InstagramMessageService({
        recordRunMessageResult: async () => undefined,
        recordBroadcastMessageResult: async () => undefined,
      }),
      gateService: { readGateOneCount: async () => 0 },
      addLaneTurns: async (tickets) => {
        laneTickets.push(...tickets);
        return { added: tickets.length };
      },
      addFastMessages: async (tickets) => {
        fastTickets.push(...tickets);
        return { added: tickets.length };
      },
      runInDatabaseSlot: (callback) => callback(),
    });
  });

  afterEach(async () => {
    nock.cleanAll();
    await metaGraphCircuit.reset();
  });

  it('the token error breaks the connection and all its accounts once, one notice each, waiting stays waiting until its 7 days end, other connections keep sending (AC-25.1, AC-25.2, AC-25.4)', async () => {
    const portfolio = await connect([nextAccount(), nextAccount()]);
    const [first, sister] = portfolio.accounts as [FlowAccount, FlowAccount];
    const other = await connect([nextAccount()]);
    const [elsewhere] = other.accounts as [FlowAccount];
    const firstMessage = await waitingMessage(first, 'slow');
    const sisterMessage = await waitingMessage(sister, 'slow');
    const oldMessage = await waitingMessage(sister, 'slow', {
      trigger_occurred_at: new Date(Date.now() - 7 * DAY),
    });
    const elsewhereMessage = await waitingMessage(elsewhere, 'slow');

    // AC-25.1 — the app was removed from the portfolio: the next send gets Meta's 190.
    const refused = metaAnswers(first, 400);
    await slowTurn(first);
    expect(refused.isDone()).toBe(true);
    expect(await connectionStatus(portfolio.channelConnectionPublicId)).toBe('error');
    expect(await accountStatus(first)).toBe('error');
    expect(await accountStatus(sister)).toBe('error');
    for (const account of [first, sister]) {
      const lanes = await readLaneRows(account.channelAccountId);
      expect(lanes.map((lane) => [lane.state, lane.stop_reason])).toEqual(
        lanes.map(() => ['stopped', 'login_expired']),
      );
    }
    // The failed message is not lost: it waits for the reconnect.
    expect(await statusOf(firstMessage.public_id)).toBe('waiting');

    // The other connection's account keeps sending.
    expect(await connectionStatus(other.channelConnectionPublicId)).toBe('connected');
    expect(await accountStatus(elsewhere)).toBe('connected');
    const accepted = metaAnswers(elsewhere, 200);
    await slowTurn(elsewhere);
    expect(accepted.isDone()).toBe(true);
    expect(await statusOf(elsewhereMessage.public_id)).toBe('sent');

    // AC-25.2 — one notice job per affected account, not one per failed message: a stopped lane
    // makes no new call, and a second break of the same connection changes nothing.
    const untouched = metaAnswers(sister, 400);
    await slowTurn(sister);
    expect(untouched.isDone()).toBe(false);
    nock.cleanAll();
    await expect(
      app.appDomain.channelConnectionService.markConnectionBroken({
        scope: scope(),
        channelConnection: {
          organizationId: team.organization.id,
          channelConnectionId: Number(
            (await readChannelConnectionRows(team.organization.id)).find(
              (row) => row.public_id === portfolio.channelConnectionPublicId,
            )?.id,
          ),
        },
        lastCheckError: 'auth (code 190, subcode 458, HTTP 400)',
        requestId: 'reconnect-flow-again',
      }),
    ).resolves.toBe(false);
    const jobs = await noticeJobs();
    expect(jobs.map((job) => job.data.instagramAccountPublicId).sort()).toEqual(
      [first.publicId, sister.publicId].sort(),
    );
    const services = {
      membershipService: app.tenancyDomain.membershipService,
      organizationSettingsService: app.tenancyDomain.organizationSettingsService,
      notificationService: app.notifyDomain.notificationService,
    };
    for (const job of jobs) {
      await expect(
        processInstagramReconnectNoticeJob({ jobData: job.data, services }),
      ).resolves.toMatchObject({ outcome: 'sent' });
      // Told once: the same job again sends nothing.
      await expect(
        processInstagramReconnectNoticeJob({ jobData: job.data, services }),
      ).resolves.toEqual({ outcome: 'deduplicated' });
    }
    const notices = await operatorQuery<
      Array<{ user_id: string; type: string; title: string; data: { channels?: string[] } }>
    >`
      SELECT user_id, type, title, data FROM notify.notifications
      WHERE organization_id = ${team.organization.id} AND type = 'instagram.reconnect_required'`;
    const ownerNotices = notices.filter((notice) => Number(notice.user_id) === team.owner.id);
    // The Owner: one banner-notice per account (in the app and by email), whatever the failed sends.
    expect(ownerNotices).toHaveLength(2);
    for (const notice of ownerNotices) {
      expect(notice.title).toBe('Reconnect Instagram');
      expect(notice.data.channels).toEqual(['in_app', 'email']);
    }

    // AC-25.4 — while `error`, the repair hands out no turn of the broken accounts, so waiting
    // messages stay waiting; the one whose 7 days end is expired.
    await repair.repairLostTurns(repairContext());
    expect(
      laneTickets.filter((ticket) =>
        [first.publicId, sister.publicId].includes(ticket.channelAccountPublicId),
      ),
    ).toEqual([]);
    expect((await repair.expireWaitingMessages(repairContext())).done).toBe(1);
    expect(await statusOf(oldMessage.public_id)).toBe('expired');
    expect(await statusOf(sisterMessage.public_id)).toBe('waiting');
    expect(await statusOf(firstMessage.public_id)).toBe('waiting');
  });

  it('an account moved to another portfolio breaks alone and its sisters keep sending (AC-25.3)', async () => {
    const portfolio = await connect([nextAccount(), nextAccount()]);
    const [kept, moved] = portfolio.accounts as [FlowAccount, FlowAccount];
    const keptMessage = await waitingMessage(kept, 'slow');
    const movedMessage = await waitingMessage(moved, 'slow');

    await expect(
      tokenCheck(portfolio.channelConnectionPublicId, [kept.assigned]),
    ).resolves.toMatchObject({ outcome: 'checked', missingCount: 1 });

    expect(await connectionStatus(portfolio.channelConnectionPublicId)).toBe('connected');
    expect(await accountStatus(moved)).toBe('error');
    expect(await accountStatus(kept)).toBe('connected');
    expect(
      (await readLaneRows(moved.channelAccountId)).every(
        (lane) => lane.stop_reason === 'account_not_shared',
      ),
    ).toBe(true);
    expect((await noticeJobs()).map((job) => job.data.instagramAccountPublicId)).toEqual([
      moved.publicId,
    ]);

    const accepted = metaAnswers(kept, 200);
    await slowTurn(kept);
    expect(accepted.isDone()).toBe(true);
    expect(await statusOf(keptMessage.public_id)).toBe('sent');
    const notCalled = metaAnswers(moved, 200);
    await slowTurn(moved);
    expect(notCalled.isDone()).toBe(false);
    expect(await statusOf(movedMessage.public_id)).toBe('waiting');
  });

  it('a reconnect with the same portfolio brings the connection and its accounts back, ends their login stops, subscribes again and the waiting DMs go spread over 5 minutes (AC-25.5)', async () => {
    const portfolio = await connect([nextAccount(), nextAccount()]);
    const [first, sister] = portfolio.accounts as [FlowAccount, FlowAccount];
    const slowMessage = await waitingMessage(first, 'slow');
    const fastMessages = [];
    for (let index = 0; index < 4; index += 1) {
      fastMessages.push(
        await waitingMessage(sister, 'fast', { not_before: new Date(Date.now() - 10 * MINUTE) }),
      );
    }

    metaAnswers(first, 400);
    await slowTurn(first);
    expect(await connectionStatus(portfolio.channelConnectionPublicId)).toBe('error');
    // While broken, the repair hands out nothing for these accounts.
    await repair.repairLostTurns(repairContext());
    expect(fastTickets).toEqual([]);
    await tasksQueue.obliterate({ force: true });

    const response = await reconnect({
      channelConnectionPublicId: portfolio.channelConnectionPublicId,
      clientBusinessId: portfolio.clientBusinessId,
      assigned: [first.assigned, sister.assigned],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as { data: { is_reconnect: boolean } }).data.is_reconnect).toBe(true);
    expect(await connectionStatus(portfolio.channelConnectionPublicId)).toBe('connected');
    expect(await accountStatus(first)).toBe('connected');
    expect(await accountStatus(sister)).toBe('connected');
    for (const account of [first, sister]) {
      const lanes = await readLaneRows(account.channelAccountId);
      expect(lanes.every((lane) => lane.stop_reason === null)).toBe(true);
      const stops = await readStopRows(account.channelAccountId);
      expect(stops.filter((stop) => stop.reason === 'login_expired')).toEqual([
        expect.objectContaining({ ended_by: 'owner', ended_at: expect.any(Date) }),
      ]);
    }
    // The webhook subscription again: one account set-up task per reconnected account (R40).
    expect((await setupJobAccounts()).sort()).toEqual([first.publicId, sister.publicId].sort());

    // The repair wakes the lanes: the waiting fast DMs come back spread over 5 minutes.
    await repair.repairLostTurns(repairContext());
    const sisterTickets = fastTickets.filter(
      (ticket) => ticket.channelAccountPublicId === sister.publicId,
    );
    expect(sisterTickets.map((ticket) => ticket.instagramMessagePublicId).sort()).toEqual(
      fastMessages.map((message) => message.public_id).sort(),
    );
    const delays = sisterTickets.map((ticket) => ticket.delayMilliseconds ?? -1);
    expect(delays.every((delay) => delay >= 0 && delay < 5 * MINUTE)).toBe(true);
    expect(new Set(delays).size).toBe(delays.length);
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(MINUTE);

    // The slow lane is ready again and its waiting opening DM goes.
    const accepted = metaAnswers(first, 200);
    await slowTurn(first);
    expect(accepted.isDone()).toBe(true);
    expect(await statusOf(slowMessage.public_id)).toBe('sent');
  });

  it('reconnecting from the portfolio an account moved to moves it there and it sends again; a revoked account is not brought back (AC-25.6, AC-25.7)', async () => {
    const portfolio = await connect([nextAccount(), nextAccount(), nextAccount()]);
    const [moving, revoked, staying] = portfolio.accounts as [
      FlowAccount,
      FlowAccount,
      FlowAccount,
    ];
    const movingMessage = await waitingMessage(moving, 'slow');

    // The owner disconnected one account (route 8; Meta's unsubscribe is best effort).
    nock(META_GRAPH_BASE_URL)
      .delete(`${GRAPH_PATH}/${revoked.assigned.id}/subscribed_apps`)
      .query(true)
      .reply(200, { success: true })
      .post(`${GRAPH_PATH}/${revoked.assigned.id}/messenger_profile`)
      .query(true)
      .reply(200, { result: 'success' })
      .delete(`${GRAPH_PATH}/${revoked.assigned.id}/messenger_profile`)
      .query(true)
      .reply(200, { result: 'success' });
    const disconnect = await injectAuthenticated(app, {
      method: 'DELETE',
      url: channelAccountPath(revoked.publicId),
      token: team.ownerToken,
    });
    expect(disconnect.statusCode, disconnect.body).toBe(204);
    expect(await accountStatus(revoked)).toBe('revoked');
    nock.cleanAll();

    // The moving account left the portfolio: the daily check breaks it alone (account_not_shared).
    await tokenCheck(portfolio.channelConnectionPublicId, [staying.assigned]);
    expect(await accountStatus(moving)).toBe('error');

    // AC-25.7 — a reconnect of the old portfolio that still lists the revoked account leaves it revoked.
    const again = await reconnect({
      channelConnectionPublicId: portfolio.channelConnectionPublicId,
      clientBusinessId: portfolio.clientBusinessId,
      assigned: [staying.assigned, revoked.assigned],
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(
      (again.json() as { data: { reconnected_account_ids: string[] } }).data
        .reconnected_account_ids,
    ).toEqual([staying.publicId]);
    expect(await accountStatus(revoked)).toBe('revoked');

    // AC-25.6 — connecting the portfolio the account moved to (route 1 then 2) moves it there.
    const start = await injectAuthenticated(app, {
      method: 'POST',
      url: channelConnectStartPath(),
      token: team.ownerToken,
    });
    expect(start.statusCode, start.body).toBe(200);
    const state = readStateFromLoginUrl(
      (start.json() as { data: { login_url: string } }).data.login_url,
    );
    const newBusiness = nextClientBusinessId();
    mockMetaLogin({ clientBusinessId: newBusiness, assignedAccounts: [moving.assigned] });
    const moved = await injectAuthenticated(app, {
      method: 'POST',
      url: channelConnectCallbackPath(),
      token: team.ownerToken,
      payload: { code: 'AQB-moved-portfolio#_', state },
      headers: { 'x-idempotency-key': `channel-connect:${state}` },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const movedData = (
      moved.json() as {
        data: { channel_connection: { id: string }; reconnected_account_ids: string[] };
      }
    ).data;
    expect(movedData.reconnected_account_ids).toEqual([moving.publicId]);
    expect(movedData.channel_connection.id).not.toBe(portfolio.channelConnectionPublicId);
    expect(await accountStatus(moving)).toBe('connected');
    expect(await accountStatus(revoked)).toBe('revoked');
    const [movedRow] = await operatorQuery<Array<{ public_id: string }>>`
      SELECT connections.public_id FROM app.channel_accounts AS accounts
      JOIN app.channel_connections AS connections
        ON connections.organization_id = accounts.organization_id
       AND connections.id = accounts.channel_connection_id
      WHERE accounts.id = ${moving.channelAccountId}`;
    expect(movedRow?.public_id).toBe(movedData.channel_connection.id);

    // It sends again, on the new connection's token.
    const accepted = metaAnswers(moving, 200);
    await slowTurn(moving);
    expect(accepted.isDone()).toBe(true);
    expect(await statusOf(movingMessage.public_id)).toBe('sent');
  });
});
