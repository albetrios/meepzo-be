import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import type { ChannelMessageResultInput } from '@/domains/app/app.channel-ports.js';
import {
  META_GRAPH_BASE_URL,
  sendInstagramMessage,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { MetaUsageDecision } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-usage.util.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertAutomationRun } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  insertInstagramMessage,
  readInstagramMessages,
  readInstagramSendAttempts,
} from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import {
  insertLanes,
  readStopRows,
  setMonthCount,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import { InstagramMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.service.js';
import {
  type InstagramSendBreakPort,
  InstagramSendCoreService,
} from '@/domains/app/sub-domains/instagram-sending/instagram-send-core.service.js';
import { InstagramSendGateService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-gate.service.js';
import { InstagramSendLaneRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.repository.js';
import { InstagramSendLaneService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.service.js';
import { InstagramSendStopRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-stop.repository.js';
import { SendingStateService } from '@/domains/app/sub-domains/instagram-sending/sending-state.service.js';
import type {
  InstagramSendAccess,
  InstagramSendLaneRules,
  InstagramSendTicketContext,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import type { InstagramSendLane } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type TestAccount = Awaited<ReturnType<typeof insertInstagramAccount>>;
type TestRun = Awaited<ReturnType<typeof insertAutomationRun>>;

/** A ticket put back by the core (BullMQ's `DelayedError` in a real worker). */
class TicketReturned extends Error {
  constructor(readonly delayMilliseconds: number) {
    super('ticket returned');
  }
}

const context: InstagramSendTicketContext = {
  jobId: 'test-ticket',
  runInDatabaseSlot: (callback) => callback(),
  returnTicket: async (delayMilliseconds) => {
    throw new TicketReturned(delayMilliseconds);
  },
};

/**
 * The send core against the database (feat-instagram-dm-sending routes-final § 6 SN3–SN5, SN8, SN23;
 * SNC3, SNC4, SNC7 — ROUTE row R42; AC-17.8–AC-17.12, AC-17.16, AC-17.17; D17). The lanes' own
 * rules are a test plug (R43–R45 build the real ones): the slow and reply lanes pick the next
 * waiting message and send it as a private reply or a direct message through the real Meta client,
 * whose wire is nock. The lanes, gates, counts, result save, stops and the global row are the real
 * services in the organization's job scope (`pnpm test:rls-role` safe).
 */
describe('InstagramSendCoreService (database)', () => {
  let organization: { id: number; public_id: string };
  let account: TestAccount;
  let sisterAccount: TestAccount;
  let run: TestRun;
  let pace: MetaUsageDecision;
  let monthLimit: number | null;
  let recorded: ChannelMessageResultInput[];
  let breaks: Array<{ kind: string; input: unknown }>;
  let enqueued: Array<{ lane: string; turnNumber: number; delayMilliseconds?: number | undefined }>;
  let core: InstagramSendCoreService;
  let laneService: InstagramSendLaneService;
  let sendingState: SendingStateService;

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });
  const token = encryptFieldSecret('EAAG-send-core');

  function accessOf(target: TestAccount): InstagramSendAccess {
    return {
      channelAccount: {
        organizationId: organization.id,
        channelAccountId: target.channel_account_id,
      },
      channelAccountPublicId: target.public_id,
      channelConnection: { organizationId: organization.id, channelConnectionId: 7 },
      channelConnectionPublicId: 'chc_ccccccccccccccccccccc',
      clientBusinessId: '5550001',
      instagramUserId: `1784${target.channel_account_id}`,
      encryptedAccessToken: token,
      isSendable: true,
    };
  }

  /** The test plug of a lane: the oldest waiting message of the lane, sent through the real client. */
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
                organizationId: organization.id,
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
            requestId: 'send-core-test',
            recordUsage,
          });
          return { instagramMessageId: sent.messageId };
        },
      }),
    };
  }

  function buildCore(
    overrides: Partial<ConstructorParameters<typeof InstagramSendCoreService>[0]> = {},
  ): InstagramSendCoreService {
    const messageService = new InstagramMessageService({
      recordRunMessageResult: async (input) => {
        recorded.push(input);
      },
      recordBroadcastMessageResult: async () => undefined,
    });
    const breakPort: InstagramSendBreakPort = {
      markConnectionBroken: async (input) => {
        breaks.push({ kind: 'connection', input });
        return true;
      },
      markAccountBroken: async (input) => {
        breaks.push({ kind: 'account', input });
        return true;
      },
    };
    return new InstagramSendCoreService({
      laneService,
      messageService,
      gateService: new InstagramSendGateService({ laneService, redis: null }),
      accessService: {
        readSendAccess: async ({ channelAccountPublicId }) =>
          accessOf(channelAccountPublicId === sisterAccount.public_id ? sisterAccount : account),
        readSendPace: async () => pace,
        buildUsageRecorder: () => undefined,
      },
      attachmentService: {
        findOrUploadAttachment: async () => ({ status: 'unusable' }),
        forgetAttachment: async () => true,
      },
      sendingStateService: sendingState,
      readMonthLimit: async () => monthLimit,
      breakPort,
      laneRules: { slow: rulesOf('slow'), reply: rulesOf('reply'), fast: rulesOf('fast') },
      producers: {
        enqueueLaneTurn: async (input) => {
          enqueued.push(input);
        },
        enqueueFastMessage: async () => {},
      },
      sleep: async () => {},
      ...overrides,
    });
  }

  async function waitingOpeningMessage(target: TestAccount = account, targetRun: TestRun = run) {
    return insertInstagramMessage({
      run: targetRun,
      channelAccountId: target.channel_account_id,
      message_type: 'opening_message',
      message_number: null,
      lane: 'slow',
      channel: 'private_reply',
      is_counted_as_direct_message: true,
      status: 'waiting',
      reason: null,
    });
  }

  async function laneRow(target: TestAccount, lane: InstagramSendLane) {
    const rows = await new InstagramSendLaneRepository().listByAccount({
      organizationId: organization.id,
      channelAccountId: target.channel_account_id,
    });
    return rows.find((row) => row.lane === lane)!;
  }

  async function turn(lane: 'slow' | 'reply', target: TestAccount = account) {
    const row = await laneRow(target, lane);
    await core.workLaneTurn({
      ticket: {
        organizationPublicId: organization.public_id,
        channelAccountPublicId: target.public_id,
        lane,
        turnNumber: row.turn_number,
      },
      scope: scope(),
      context,
    });
  }

  function metaAnswers(
    status: number,
    body: object,
    igUserId = `1784${account.channel_account_id}`,
  ) {
    return nock(META_GRAPH_BASE_URL)
      .post(`/v27.0/${igUserId}/messages`)
      .query(true)
      .reply(status, body);
  }

  async function monthUsed(): Promise<number> {
    const [row] = await operatorQuery<{ used: number }[]>`
      SELECT COALESCE(sum(count), 0)::int AS used FROM app.message_month_counts
      WHERE organization_id = ${organization.id}`;
    return Number(row?.used ?? 0);
  }

  async function minuteCount(target: TestAccount = account): Promise<number> {
    const [row] = await operatorQuery<{ total: number }[]>`
      SELECT COALESCE(sum(count), 0)::int AS total FROM app.instagram_send_minute_counts
      WHERE channel_account_id = ${target.channel_account_id}`;
    return Number(row?.total ?? 0);
  }

  beforeEach(async () => {
    await cleanupDatabase();
    nock.cleanAll();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    sisterAccount = await insertInstagramAccount({ organizationId: organization.id });
    for (const target of [account, sisterAccount]) {
      await insertLanes({
        organizationId: organization.id,
        channelAccountId: target.channel_account_id,
      });
    }
    const contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      last_direct_message_received_at: new Date(),
    });
    const automation = await insertAutomation({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      status: 'live',
    });
    run = await insertAutomationRun({
      organizationId: organization.id,
      automationId: automation.id,
      contactId: contact.id,
    });
    pace = { pace: 'normal', waitUntil: null };
    monthLimit = 1000;
    recorded = [];
    breaks = [];
    enqueued = [];
    laneService = new InstagramSendLaneService(
      new InstagramSendLaneRepository(),
      new InstagramSendStopRepository(),
    );
    sendingState = new SendingStateService();
    core = buildCore();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('sends one message a turn: the minute and month counts in the claim, sent, the engine told, the next turn queued (AC-17.8, AC-17.17)', async () => {
    const message = await waitingOpeningMessage();
    const meta = metaAnswers(200, { recipient_id: '9001', message_id: 'mid.sent.1' });
    await turn('slow');
    expect(meta.isDone()).toBe(true);
    const [saved] = await readInstagramMessages(organization.id);
    expect(saved).toMatchObject({
      public_id: message.public_id,
      status: 'sent',
      instagram_message_id: 'mid.sent.1',
    });
    expect(await minuteCount()).toBe(1);
    expect(await monthUsed()).toBe(1);
    const [attempt] = await readInstagramSendAttempts(organization.id);
    expect(attempt).toMatchObject({ result_group: 'sent', count_group: 'open', lane: 'slow' });
    expect(recorded).toHaveLength(1);
    const slow = await laneRow(account, 'slow');
    expect(slow).toMatchObject({ state: 'sleeping', working_turn: null, turn_number: 1 });
    expect(enqueued).toContainEqual(expect.objectContaining({ lane: 'slow', turnNumber: 1 }));
  });

  it('counts a public reply in no month (AC-17.17)', async () => {
    await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: 'public_reply',
      message_number: null,
      lane: 'reply',
      channel: 'comment_reply',
      is_counted_as_direct_message: false,
      status: 'waiting',
      reason: null,
    });
    nock(META_GRAPH_BASE_URL)
      .post(/\/v27\.0\/\d+\/messages/)
      .query(true)
      .reply(200, { message_id: 'mid.reply' });
    await turn('reply');
    expect(await monthUsed()).toBe(0);
    expect(await minuteCount()).toBe(1);
  });

  it('counts a hide and a follow check in no month, as count group none (AC-17.17)', async () => {
    await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: 'hide_comment',
      message_number: null,
      lane: 'reply',
      channel: 'comment_hide',
      is_counted_as_direct_message: false,
      status: 'waiting',
      reason: null,
    });
    nock(META_GRAPH_BASE_URL)
      .post(/\/v27\.0\/\d+\/messages/)
      .query(true)
      .reply(200, { message_id: 'mid.hide' });
    await turn('reply');
    const followCheck = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: 'follow_check',
      message_number: null,
      lane: 'fast',
      channel: null,
      is_counted_as_direct_message: false,
      status: 'waiting',
      reason: null,
    });
    nock(META_GRAPH_BASE_URL)
      .post(/\/v27\.0\/\d+\/messages/)
      .query(true)
      .reply(200, { message_id: 'mid.follow' });
    await core.sendFastMessage({
      ticket: {
        organizationPublicId: organization.public_id,
        channelAccountPublicId: account.public_id,
        instagramMessagePublicId: followCheck.public_id,
        automationRunStartedAt: followCheck.automation_run_started_at.toISOString(),
        tries: 0,
      },
      scope: scope(),
      context,
    });
    const attempts = await readInstagramSendAttempts(organization.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.count_group)).toEqual(['none', 'none']);
    expect(await monthUsed()).toBe(0);
  });

  it('holds the hour limit from Postgres alone, also for two claims racing in one minute (AC-17.8)', async () => {
    // Two list messages of one run in the fast lane: one fast hour place left.
    const [first, second] = await Promise.all(
      [1, 2].map((messageNumber) =>
        insertInstagramMessage({
          run,
          channelAccountId: account.channel_account_id,
          message_number: messageNumber,
          status: 'waiting',
          reason: null,
        }),
      ),
    );
    const gate = new InstagramSendGateService({ laneService, redis: null });
    const claims = await Promise.all(
      [first!, second!].map((message) =>
        gate.claimSend({
          scope: scope(),
          key: {
            organizationId: organization.id,
            publicId: message.public_id,
            automationRunStartedAt: message.automation_run_started_at,
          },
          lane: 'fast',
          channel: 'direct',
          countGroup: 'fast',
          hourLimit: 1,
          personHourLimit: null,
          monthLimit: null,
        }),
      ),
    );
    expect(claims.filter((claim) => claim.kind === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === 'refused')).toEqual([
      { kind: 'refused', reason: 'hour_limit' },
    ]);
    expect(await minuteCount()).toBe(1);
  });

  it('stops at the month limit: the claim refuses, every account takes plan_limit, the reply lane goes on (SN8, P3)', async () => {
    monthLimit = 5;
    await setMonthCount({ organizationId: organization.id, count: 5 });
    await waitingOpeningMessage();
    const meta = metaAnswers(200, { message_id: 'mid.never' });
    await turn('slow');
    expect(meta.isDone()).toBe(false);
    const [kept] = await readInstagramMessages(organization.id);
    expect(kept?.status).toBe('waiting');
    const accounts = await operatorQuery<{ plan_stop_reason: string | null }[]>`
      SELECT plan_stop_reason FROM app.channel_accounts WHERE organization_id = ${organization.id}`;
    expect(accounts.map((row) => row.plan_stop_reason)).toEqual(['plan_limit', 'plan_limit']);
    expect(await laneRow(account, 'slow')).toMatchObject({ state: 'stopped' });
    expect((await readStopRows(account.channel_account_id)).map((row) => row.reason)).toContain(
      'plan_limit',
    );
    // The reply lane is not held by plan_limit (D62): its public reply still goes.
    await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: 'public_reply',
      message_number: null,
      lane: 'reply',
      channel: 'comment_reply',
      is_counted_as_direct_message: false,
      status: 'waiting',
      reason: null,
    });
    nock(META_GRAPH_BASE_URL)
      .post(/\/v27\.0\/\d+\/messages/)
      .query(true)
      .reply(200, { message_id: 'mid.reply' });
    await turn('reply');
    const statuses = (await readInstagramMessages(organization.id)).map((row) => row.status);
    expect(statuses).toEqual(['waiting', 'sent']);
  });

  it('starts the plan stop with the DM that fills the month (SN8)', async () => {
    monthLimit = 1;
    await waitingOpeningMessage();
    metaAnswers(200, { message_id: 'mid.last' });
    await turn('slow');
    expect((await readInstagramMessages(organization.id))[0]?.status).toBe('sent');
    const [row] = await operatorQuery<{ plan_stop_reason: string | null }[]>`
      SELECT plan_stop_reason FROM app.channel_accounts WHERE id = ${account.channel_account_id}`;
    expect(row?.plan_stop_reason).toBe('plan_limit');
  });

  it('saves an unclear answer as unknown and never sends it again (AC-17.9, D17)', async () => {
    await waitingOpeningMessage();
    nock(META_GRAPH_BASE_URL)
      .post(/\/v27\.0\/\d+\/messages/)
      .query(true)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await turn('slow');
    const [saved] = await readInstagramMessages(organization.id);
    expect(saved?.status).toBe('unknown');
    expect(await monthUsed()).toBe(1);
    const second = metaAnswers(200, { message_id: 'mid.twice' });
    await turn('slow');
    await turn('slow');
    expect(second.isDone()).toBe(false);
    expect((await readInstagramMessages(organization.id))[0]?.status).toBe('unknown');
  });

  it('retries a failed result save inside the send and, when it keeps failing, leaves the message sending (SN4, AC-17.9)', async () => {
    await waitingOpeningMessage();
    metaAnswers(200, { message_id: 'mid.lost-save' });
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    let saves = 0;
    core = buildCore({
      messageService: {
        saveSendResult: async () => {
          saves += 1;
          throw deadlock;
        },
      },
    });
    await turn('slow');
    expect(saves).toBe(4);
    const [stuck] = await readInstagramMessages(organization.id);
    expect(stuck?.status).toBe('sending');
    // A later ticket finds it not waiting: never sent again by itself.
    const again = metaAnswers(200, { message_id: 'mid.again' });
    await turn('slow');
    expect(again.isDone()).toBe(false);
  });

  it('a block on the slow lane stops the account, not its sister; a passed test the next day ends it at half speed (AC-17.10)', async () => {
    await waitingOpeningMessage();
    metaAnswers(400, { error: { code: 368 } });
    await turn('slow');
    const [back] = await readInstagramMessages(organization.id);
    expect(back).toMatchObject({ status: 'waiting', tries: 0 });
    expect(await monthUsed()).toBe(0);
    expect(await minuteCount()).toBe(0);
    for (const lane of ['slow', 'reply', 'fast', 'broadcast'] as const) {
      expect((await laneRow(account, lane)).stop_reason).toBe('blocked');
    }
    const blocked = await laneRow(account, 'slow');
    expect(blocked.stop_until!.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    for (const lane of ['slow', 'reply', 'fast', 'broadcast'] as const) {
      expect((await laneRow(sisterAccount, lane)).stop_reason).toBeNull();
    }
    // Sending starts again by itself: the stopped lane's ticket waits for the stop's end.
    expect(enqueued).toContainEqual(expect.objectContaining({ lane: 'slow' }));
    // The next day: the stop's time is over, one test DM goes, the stop ends, half speed for 24 h.
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET stop_until = now() - interval '1 minute'
      WHERE channel_account_id = ${account.channel_account_id}`;
    metaAnswers(200, { message_id: 'mid.test' });
    await turn('slow');
    expect((await readInstagramMessages(organization.id))[0]?.status).toBe('sent');
    const freed = await laneRow(account, 'slow');
    expect(freed.stop_reason).toBeNull();
    expect(freed.half_speed_until!.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(freed.testing_lane).toBeNull();
    expect((await readStopRows(account.channel_account_id)).at(-1)).toMatchObject({
      reason: 'blocked',
      ended_by: 'test',
    });
  });

  it('too fast stops only that lane; code 4 with a subcode only that lane; code 4 alone from 2 accounts stops every account (AC-17.11)', async () => {
    await waitingOpeningMessage();
    metaAnswers(400, { error: { code: 613 } });
    await turn('slow');
    expect((await laneRow(account, 'slow')).stop_reason).toBe('too_fast');
    expect((await laneRow(account, 'fast')).stop_reason).toBeNull();

    await operatorQuery`
      UPDATE app.instagram_send_lanes SET stop_reason = NULL, stop_until = NULL, stop_count = 0, stop_error_code = NULL,
        stop_error_subcode = NULL, state = 'ready'
      WHERE channel_account_id = ${account.channel_account_id}`;
    metaAnswers(400, { error: { code: 4, error_subcode: 1_390_008 } });
    await turn('slow');
    expect((await laneRow(account, 'slow')).stop_reason).toBe('account_flagged');
    expect((await laneRow(account, 'reply')).stop_reason).toBeNull();

    await sendingState.ensureSendingState({ environmentId: 'test' });
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET stop_reason = NULL, stop_until = NULL, stop_count = 0, stop_error_code = NULL,
        stop_error_subcode = NULL, state = 'ready'
      WHERE channel_account_id = ${account.channel_account_id}`;
    metaAnswers(400, { error: { code: 4 } });
    await turn('slow');
    // One account alone: that lane, as too fast.
    expect((await laneRow(account, 'slow')).stop_reason).toBe('too_fast');
    expect(await sendingState.readAllAccountsStop()).toBeNull();
    // A second account within 5 minutes: every account.
    const sisterContact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: sisterAccount.id,
      last_direct_message_received_at: new Date(),
    });
    const sisterAutomation = await insertAutomation({
      organizationId: organization.id,
      channelAccountId: sisterAccount.channel_account_id,
      status: 'live',
    });
    const sisterRun = await insertAutomationRun({
      organizationId: organization.id,
      automationId: sisterAutomation.id,
      contactId: sisterContact.id,
    });
    await waitingOpeningMessage(sisterAccount, sisterRun);
    metaAnswers(400, { error: { code: 4 } }, `1784${sisterAccount.channel_account_id}`);
    await turn('slow', sisterAccount);
    expect(await sendingState.readAllAccountsStop()).toMatchObject({ reason: 'app_limit' });
  });

  it('a token error breaks the connection — every account of it — at once (AC-17.12)', async () => {
    await waitingOpeningMessage();
    metaAnswers(401, { error: { code: 190, error_subcode: 463 } });
    await turn('slow');
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({
      kind: 'connection',
      input: { channelConnection: { organizationId: organization.id, channelConnectionId: 7 } },
    });
    expect((await readInstagramMessages(organization.id))[0]).toMatchObject({
      status: 'waiting',
      tries: 0,
    });
  });

  it('waits at 95 % of Meta usage and makes no call (AC-17.16)', async () => {
    await waitingOpeningMessage();
    const waitUntil = new Date(Date.now() + 15 * 60_000);
    pace = { pace: 'wait', waitUntil };
    const meta = metaAnswers(200, { message_id: 'mid.never' });
    await turn('slow');
    expect(meta.isDone()).toBe(false);
    const slow = await laneRow(account, 'slow');
    expect(slow.state).toBe('sleeping');
    expect(slow.next_run_at?.getTime()).toBe(waitUntil.getTime());
  });

  it('doubles the box at 80 % of Meta usage (AC-17.16)', async () => {
    await waitingOpeningMessage();
    pace = { pace: 'slow', waitUntil: null };
    metaAnswers(200, { message_id: 'mid.slow' });
    const before = Date.now();
    await turn('slow');
    const slow = await laneRow(account, 'slow');
    // 600 an hour → a 6 s box, doubled.
    expect(slow.next_run_at!.getTime() - before).toBeGreaterThanOrEqual(12_000);
  });

  it('sends a fast message under its own ticket and finishes a gone one', async () => {
    const message = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      status: 'waiting',
      reason: null,
    });
    metaAnswers(200, { message_id: 'mid.fast' });
    const ticket = {
      organizationPublicId: organization.public_id,
      channelAccountPublicId: account.public_id,
      instagramMessagePublicId: message.public_id,
      automationRunStartedAt: message.automation_run_started_at.toISOString(),
      tries: 0,
    };
    await core.sendFastMessage({ ticket, scope: scope(), context });
    expect((await readInstagramMessages(organization.id))[0]?.status).toBe('sent');
    await core.sendFastMessage({ ticket, scope: scope(), context });
    expect(await readInstagramSendAttempts(organization.id)).toHaveLength(1);
  });

  it('logs and finishes a ticket of a lane without rules (R43–R45)', async () => {
    await waitingOpeningMessage();
    core = buildCore({ laneRules: {} });
    await turn('slow');
    expect(await laneRow(account, 'slow')).toMatchObject({ state: 'ready', turn_number: 0 });
    expect((await readInstagramMessages(organization.id))[0]?.status).toBe('waiting');
  });
});
