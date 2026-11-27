import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { META_GRAPH_BASE_URL } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertAutomationRun } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  insertInstagramOutgoingMessage,
  readInstagramOutgoingMessages,
} from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/__tests__/factories/instagram-outgoing-message.factory.js';
import { insertLanes } from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import {
  buildLaneHarness,
  type LaneHarness,
  type LaneHarnessAccount,
  readLaneRow,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-lane-harness.factory.js';
import { InstagramSendComposeService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-compose.service.js';
import { InstagramSlowLaneRules } from '@/domains/app/sub-domains/instagram-sending/instagram-slow-lane.service.js';
import { InstagramSendLaneRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.repository.js';
import { InstagramSendLaneService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.service.js';
import { InstagramSendStopRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-stop.repository.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * The slow lane's rules in the real send core (feat-instagram-dm-sending routes-final § 6.10 WC-5,
 * § 6.A.10; plan §28; ROUTE row R43 — AC-17.1, AC-17.3, AC-17.4; launch AC-7.19): the opening DM as
 * a private reply to her comment with its text read at the last moment, one per box at least 1.5 s
 * apart, the 4 : 1 mix, the checks again, the 24-hour person rule, the plain-text fallback, the
 * comment check before `deleted_comment` and the stop test's 3 turns. Meta via nock only.
 */
describe('InstagramSlowLaneRules (database)', () => {
  let organization: { id: number; public_id: string };
  let account: LaneHarnessAccount;
  let automationId: number;
  let harness: LaneHarness;
  let fastTickets: Array<{ instagramMessagePublicId: string }>;
  let random: number;

  const igUserId = () => `1784${account.channel_account_id}`;
  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });

  async function contactWith(
    overrides: Omit<
      Parameters<typeof insertContact>[0],
      'organizationId' | 'instagramAccountId'
    > = {},
  ) {
    return insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      full_name: 'Riya',
      username: 'riya.k',
      ...overrides,
    });
  }

  /** A comment run and its waiting opening private reply, the comment `minutesAgo` old. */
  async function waitingOpening({
    contactId,
    minutesAgo = 1,
    commentId = '17900000000000001',
    messageType = 'opening_message',
  }: {
    contactId: number;
    minutesAgo?: number;
    commentId?: string;
    messageType?: 'opening_message' | 'email_question';
  }) {
    const commentAt = new Date(Date.now() - minutesAgo * MINUTE);
    const run = await insertAutomationRun({
      organizationId: organization.id,
      automationId,
      contactId,
      trigger_type: 'comment',
      trigger_instagram_comment_id: commentId,
      trigger_instagram_media_id: '17800000000000001',
      trigger_occurred_at: commentAt,
      status: 'running',
      current_step: 'comment_reply',
      waiting_for: null,
      waiting_since_at: null,
    });
    return insertInstagramOutgoingMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: messageType,
      message_number: null,
      lane: 'slow',
      channel: 'private_reply',
      is_counted_as_direct_message: true,
      status: 'waiting',
      reason: null,
      trigger_occurred_at: commentAt,
      not_before: commentAt,
    });
  }

  function metaSends(answers: Array<{ status: number; body: object }>, bodies: unknown[] = []) {
    let scope = nock(META_GRAPH_BASE_URL);
    for (const answer of answers) {
      scope = scope
        .post(`/v27.0/${igUserId()}/messages`, (body) => {
          bodies.push(body);
          return true;
        })
        .query(true)
        .reply(answer.status, answer.body);
    }
    return scope;
  }

  beforeEach(async () => {
    await cleanupDatabase();
    nock.cleanAll();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    await insertLanes({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
    });
    const automation = await insertAutomation({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      status: 'live',
      steps: {
        hello: {
          on: true,
          versions: [
            {
              text: 'Hi {name}! Want the guide?',
              buttons: [{ title: 'Send me the guide', action: 'next' }],
            },
          ],
        },
        email: { on: true, wordings: [''] },
      },
    });
    automationId = automation.id;
    fastTickets = [];
    random = 0.5;
    harness = buildLaneHarness({
      organization,
      account,
      laneRules: (messageService) => ({
        slow: new InstagramSlowLaneRules({
          messageService,
          composeService: new InstagramSendComposeService({ translate: (key) => `t:${key}` }),
          enqueueFastMessage: async (ticket) => {
            fastTickets.push(ticket);
          },
          random: () => random,
        }),
      }),
    });
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('sends the opening DM as a private reply to her comment, {name} filled, the next box booked at least 1.5 s later (AC-17.1, AC-17.3)', async () => {
    const contact = await contactWith();
    const message = await waitingOpening({ contactId: contact.id });
    const bodies: unknown[] = [];
    const meta = metaSends([{ status: 200, body: { message_id: 'mid.open.1' } }], bodies);
    const before = Date.now();
    await harness.turn('slow');
    expect(meta.isDone()).toBe(true);
    expect(bodies[0]).toEqual({
      recipient: { comment_id: '17900000000000001' },
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: 'Hi Riya! Want the guide?',
            buttons: [
              {
                type: 'postback',
                title: 'Send me the guide',
                payload: expect.stringMatching(/^aut_.+::run_.+$/),
              },
            ],
          },
        },
      },
    });
    const [sent] = await readInstagramOutgoingMessages(organization.id);
    expect(sent).toMatchObject({ public_id: message.public_id, status: 'sent' });
    const lane = await readLaneRow({ organizationId: organization.id, account, lane: 'slow' });
    // A new account opens 150 an hour for its first 7 days (D5): 24-second boxes; this send opened
    // a box, the next one follows it.
    const box = 24_000;
    const boxStart = lane.box_start!.getTime();
    expect(boxStart).toBeGreaterThanOrEqual(before + box - 1_000);
    expect(lane.next_run_at!.getTime()).toBeGreaterThanOrEqual(boxStart);
    expect(lane.next_run_at!.getTime()).toBeLessThan(boxStart + box);
    expect(lane.next_run_at!.getTime() - lane.last_sent_at!.getTime()).toBeGreaterThanOrEqual(
      1_500,
    );
    expect(lane.pick_count).toBe(1);
    expect(harness.recorded).toEqual([expect.objectContaining({ step: 'hello', result: 'sent' })]);
  });

  it('paces an account past its first 7 days at 600 an hour: 6-second boxes (AC-17.1, D5)', async () => {
    await operatorQuery`
      UPDATE app.channel_accounts SET connected_at = now() - interval '8 days'
      WHERE id = ${account.channel_account_id}`;
    const contact = await contactWith();
    await waitingOpening({ contactId: contact.id });
    metaSends([{ status: 200, body: { message_id: 'mid.open.1' } }]);
    await harness.turn('slow');
    const lane = await readLaneRow({ organizationId: organization.id, account, lane: 'slow' });
    const boxStart = lane.box_start!.getTime();
    expect(boxStart - lane.last_sent_at!.getTime()).toBe(6_000);
    // random 0.5 → the middle of the next box.
    expect(lane.next_run_at!.getTime()).toBe(boxStart + 3_000);
  });

  it('never sends two in one box: a ticket before the box second sends nothing and the lane sleeps until it (AC-17.1)', async () => {
    const first = await contactWith();
    const second = await contactWith({ username: 'aman' });
    await waitingOpening({ contactId: first.id });
    await waitingOpening({ contactId: second.id, commentId: '17900000000000002' });
    metaSends([{ status: 200, body: { message_id: 'mid.open.1' } }]);
    await harness.turn('slow');
    const booked = (await readLaneRow({ organizationId: organization.id, account, lane: 'slow' }))
      .next_run_at!;
    const early = metaSends([{ status: 200, body: { message_id: 'mid.open.2' } }]);
    await harness.turn('slow');
    expect(early.isDone()).toBe(false);
    const lane = await readLaneRow({ organizationId: organization.id, account, lane: 'slow' });
    expect(lane.next_run_at!.getTime()).toBe(booked.getTime());
    expect(lane.wait_reason).toBe('box');
    expect(
      (await readInstagramOutgoingMessages(organization.id)).map((row) => row.status).sort(),
    ).toEqual(['sent', 'waiting']);
  });

  it('mixes new and old comments 4 : 1: place 5 takes the oldest (plan §28.2)', async () => {
    const contact = await contactWith();
    const other = await contactWith({ username: 'old.one' });
    await waitingOpening({ contactId: contact.id, minutesAgo: 1 });
    const old = await waitingOpening({
      contactId: other.id,
      minutesAgo: 5 * 60,
      commentId: '17900000000000009',
    });
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET pick_count = 4
      WHERE channel_account_id = ${account.channel_account_id} AND lane = 'slow'`;
    const bodies: Array<{ recipient: unknown }> = [];
    metaSends([{ status: 200, body: { message_id: 'mid.old' } }], bodies);
    await harness.turn('slow');
    expect(bodies[0]?.recipient).toEqual({ comment_id: '17900000000000009' });
    const rows = await readInstagramOutgoingMessages(organization.id);
    expect(rows.find((row) => row.public_id === old.public_id)?.status).toBe('sent');
    expect(
      (await readLaneRow({ organizationId: organization.id, account, lane: 'slow' })).pick_count,
    ).toBe(5);
  });

  it('holds a second opening private reply to her within 24 hours until they pass; a hand-sent DM does not reset it (AC-17.4, launch AC-7.19)', async () => {
    const openedAt = new Date(Date.now() - 2 * HOUR);
    const contact = await contactWith({
      last_opening_message_at: openedAt,
      // Her owner wrote to her by hand since: the echo moves `last_message_sent_at`, never the rule.
      last_message_sent_at: new Date(Date.now() - 10 * MINUTE),
    });
    const message = await waitingOpening({ contactId: contact.id });
    const meta = metaSends([{ status: 200, body: { message_id: 'mid.never' } }]);
    await harness.turn('slow');
    expect(meta.isDone()).toBe(false);
    const [held] = await readInstagramOutgoingMessages(organization.id);
    expect(held).toMatchObject({ public_id: message.public_id, status: 'waiting' });
    expect(held!.not_before!.getTime()).toBe(openedAt.getTime() + 24 * HOUR);
    // The lane sleeps until her 24 hours pass.
    const lane = await readLaneRow({ organizationId: organization.id, account, lane: 'slow' });
    expect(lane.next_run_at!.getTime()).toBe(openedAt.getTime() + 24 * HOUR);
    expect(lane.wait_reason).toBe('not_before');
  });

  it('checks each pick again: a comment past 7 days − 30 minutes expires, an opted-out person is skipped, the engine told (plan §28.1 step 7)', async () => {
    const stale = await contactWith();
    const optedOut = await contactWith({ username: 'gone', opted_out_at: new Date() });
    await waitingOpening({ contactId: stale.id, minutesAgo: 7 * 24 * 60 });
    await waitingOpening({ contactId: optedOut.id, commentId: '17900000000000003' });
    const meta = metaSends([{ status: 200, body: { message_id: 'mid.never' } }]);
    await harness.turn('slow');
    expect(meta.isDone()).toBe(false);
    const rows = await readInstagramOutgoingMessages(organization.id);
    expect(rows.map((row) => [row.status, row.reason])).toEqual([
      ['expired', 'expired'],
      ['skipped', 'opted_out'],
    ]);
    expect(harness.recorded.map((input) => [input.result, input.reason])).toEqual(
      expect.arrayContaining([
        ['skipped', 'expired'],
        ['skipped', 'opted_out'],
      ]),
    );
  });

  it('moves the opening to the fast lane as a DM when her window opened meanwhile, outside the slow lane (AC-17.3)', async () => {
    const contact = await contactWith({ last_direct_message_received_at: new Date() });
    const message = await waitingOpening({ contactId: contact.id });
    const meta = metaSends([{ status: 200, body: { message_id: 'mid.never' } }]);
    await harness.turn('slow');
    expect(meta.isDone()).toBe(false);
    const [moved] = await readInstagramOutgoingMessages(organization.id);
    expect(moved).toMatchObject({ lane: 'fast', channel: 'direct', status: 'waiting' });
    expect(fastTickets).toEqual([
      expect.objectContaining({ instagramMessagePublicId: message.public_id, tries: 0 }),
    ]);
  });

  it('sends the email question once as plain text, the default text when the wording is empty (P133, fix F2 AF-4)', async () => {
    const contact = await contactWith();
    await waitingOpening({ contactId: contact.id, messageType: 'email_question' });
    const bodies: Array<{ message: unknown }> = [];
    const meta = metaSends([{ status: 200, body: { message_id: 'mid.plain' } }], bodies);
    await harness.turn('slow');
    expect(meta.isDone()).toBe(true);
    expect(bodies.map((body) => body.message)).toEqual([
      { text: 't:common:automationMessages.emailQuestion' },
    ]);
    expect((await readInstagramOutgoingMessages(organization.id))[0]?.status).toBe('sent');
  });

  it('reads the comment once before a deleted_comment: gone → skipped, still there → bad text (plan §33.7)', async () => {
    const contact = await contactWith();
    const other = await contactWith({ username: 'second' });
    await waitingOpening({ contactId: contact.id, commentId: '17900000000000004' });
    metaSends([{ status: 400, body: { error: { code: 100, error_subcode: 33, message: 'x' } } }]);
    nock(META_GRAPH_BASE_URL)
      .get('/v27.0/17900000000000004')
      .query(true)
      .reply(400, { error: { code: 100, error_subcode: 33, message: 'gone' } });
    await harness.turn('slow');
    expect((await readInstagramOutgoingMessages(organization.id))[0]).toMatchObject({
      status: 'skipped',
      reason: 'deleted_comment',
    });
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET next_run_at = now(), last_sent_at = NULL
      WHERE channel_account_id = ${account.channel_account_id} AND lane = 'slow'`;
    await waitingOpening({ contactId: other.id, commentId: '17900000000000005' });
    metaSends([{ status: 400, body: { error: { code: 100, error_subcode: 33, message: 'x' } } }]);
    nock(META_GRAPH_BASE_URL)
      .get('/v27.0/17900000000000005')
      .query(true)
      .reply(200, { id: '17900000000000005', hidden: false });
    await harness.turn('slow');
    expect((await readInstagramOutgoingMessages(organization.id))[1]).toMatchObject({
      status: 'failed',
      reason: 'bad_text',
    });
  });

  it('tests a stopped lane up to 3 turns when the answer is about that person, then waits the stop time again (plan §33.4)', async () => {
    for (let index = 0; index < 4; index += 1) {
      const contact = await contactWith({ username: `person${index}` });
      await waitingOpening({ contactId: contact.id, commentId: `1790000000000010${index}` });
    }
    await operatorQuery`
      UPDATE app.instagram_send_lanes
      SET state = 'stopped', stop_reason = 'too_fast', stop_count = 1,
          stop_until = now() - interval '1 minute', next_run_at = NULL
      WHERE channel_account_id = ${account.channel_account_id} AND lane = 'slow'`;
    const stopUntilOf = async () =>
      (await readLaneRow({ organizationId: organization.id, account, lane: 'slow' })).stop_until!;
    for (let testTurn = 1; testTurn <= 3; testTurn += 1) {
      metaSends([{ status: 400, body: { error: { code: 551, message: 'person' } } }]);
      await harness.turn('slow');
      // The next test ticket comes at the stop's end, past the 1.5 s gap.
      await operatorQuery`
        UPDATE app.instagram_send_lanes SET last_sent_at = NULL
        WHERE channel_account_id = ${account.channel_account_id} AND lane = 'slow'`;
      const stopUntil = await stopUntilOf();
      if (testTurn < 3) expect(stopUntil.getTime()).toBeLessThan(Date.now());
      else expect(stopUntil.getTime()).toBeGreaterThan(Date.now() + 10 * MINUTE);
    }
    const statuses = (await readInstagramOutgoingMessages(organization.id)).map(
      (row) => row.status,
    );
    expect(statuses.filter((status) => status === 'skipped')).toHaveLength(3);
    expect(statuses.filter((status) => status === 'waiting')).toHaveLength(1);
  });

  it('lists today\'s "chat closed" skips per automation for route 63 (SN14)', async () => {
    const contact = await contactWith();
    const message = await waitingOpening({ contactId: contact.id });
    await operatorQuery`
      UPDATE app.instagram_outgoing_messages SET status = 'skipped', reason = 'window_closed', updated_at = now()
      WHERE public_id = ${message.public_id}`;
    const lines = await harness.messageService.listWindowClosedByAutomation({
      scope: scope(),
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
    });
    expect(lines).toEqual([{ automation_id: expect.stringMatching(/^aut_/), count: 1 }]);
  });

  it('settles the claimed message when an organization delete stops the lanes mid-turn, and picks nothing after (R6 × R61, CA8)', async () => {
    const first = await contactWith();
    const second = await contactWith({ username: 'second.one' });
    const openings = [
      await waitingOpening({ contactId: first.id, minutesAgo: 2 }),
      await waitingOpening({ contactId: second.id, commentId: '17900000000000002', minutesAgo: 1 }),
    ];
    const laneService = new InstagramSendLaneService(
      new InstagramSendLaneRepository(),
      new InstagramSendStopRepository(),
    );
    const composed: string[] = [];
    harness.beforeCompose.value = async (message) => {
      composed.push(message.public_id);
      // The organization delete's Instagram erase commits its lane stop while this turn holds a claim.
      await laneService.stopLanes({
        scope: scope(),
        organizationId: organization.id,
        channelAccountId: account.channel_account_id,
      });
    };
    const meta = metaSends([
      { status: 200, body: { message_id: 'mid.claimed' } },
      { status: 200, body: { message_id: 'mid.never' } },
    ]);

    await harness.turn('slow');
    harness.beforeCompose.value = null;

    const byId = new Map(
      (await readInstagramOutgoingMessages(organization.id)).map((row) => [row.public_id, row]),
    );
    // One message claimed and composed in the turn; it settles, the other stays waiting.
    expect(composed).toHaveLength(1);
    const left = openings.find((opening) => opening.public_id !== composed[0])!;
    expect(byId.get(composed[0]!)).toMatchObject({ status: 'sent' });
    expect(byId.get(left.public_id)).toMatchObject({ status: 'waiting' });
    const lane = await readLaneRow({ organizationId: organization.id, account, lane: 'slow' });
    expect(lane).toMatchObject({ state: 'stopped', working_turn: null, next_run_at: null });
    expect(lane.sending_count).toBe(0);
    expect(harness.enqueued).toEqual([]);

    // A late ticket of the stopped lane claims no turn: nothing else is picked or sent.
    await harness.turn('slow');
    expect(
      (await readInstagramOutgoingMessages(organization.id)).find(
        (row) => row.public_id === left.public_id,
      ),
    ).toMatchObject({ status: 'waiting' });
    expect(meta.pendingMocks()).toHaveLength(1);
  });
});
