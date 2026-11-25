import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { META_GRAPH_BASE_URL } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertAutomationRun } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { AutomationReplyStateRepository } from '@/domains/app/sub-domains/automation/automation-reply-state.repository.js';
import { AutomationReplyStateService } from '@/domains/app/sub-domains/automation/automation-reply-state.service.js';
import {
  insertInstagramMessage,
  readInstagramMessages,
} from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import { insertLanes } from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import {
  buildLaneHarness,
  type LaneHarness,
  type LaneHarnessAccount,
  readLaneRow,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-lane-harness.factory.js';
import { InstagramReplyLaneRules } from '@/domains/app/sub-domains/instagram-sending/instagram-reply-lane.service.js';
import { replyBoxOffsetMilliseconds } from '@/domains/app/sub-domains/instagram-sending/instagram-send-pace.util.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const LINES = ['Sent you a DM', 'Check your inbox', 'Look in your DMs'];

/**
 * The reply lane's rules in the real send core (feat-instagram-dm-sending routes-final § 6.10 WC-6;
 * plan §29; D32, D57, P134; ROUTE row R43 — AC-17.7): "Reply like a person" OFF posts at once, ON by
 * its automation's box and the account's 20-second gap, never its last line, `@username` first; the
 * hide after the reply; a failed hide changes nothing else; a plan without PRO works as OFF with the
 * first line. Meta via nock only.
 */
describe('InstagramReplyLaneRules (database)', () => {
  let organization: { id: number; public_id: string };
  let account: LaneHarnessAccount;
  let harness: LaneHarness;
  let switches: Record<string, boolean> | null;
  let random: number;
  let contactId: number;

  async function automationWith(overrides: { isLikePerson: boolean; hourLimit?: number }) {
    return insertAutomation({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      status: 'live',
      is_public_reply_enabled: true,
      public_reply_texts: LINES,
      is_public_reply_mention_enabled: true,
      is_reply_like_person_enabled: overrides.isLikePerson,
      public_reply_hour_limit: overrides.hourLimit ?? null,
      is_hide_comment_after_direct_message_enabled: true,
    });
  }

  /** A comment run whose DM went, with its waiting public reply and (optionally) its hide. */
  async function waitingReply({
    automationId,
    commentId,
    withHide = false,
    withReply = true,
  }: {
    automationId: number;
    commentId: string;
    withHide?: boolean;
    withReply?: boolean;
  }) {
    const run = await insertAutomationRun({
      organizationId: organization.id,
      automationId,
      contactId,
      trigger_type: 'comment',
      trigger_instagram_comment_id: commentId,
      trigger_instagram_media_id: '17800000000000001',
      status: 'waiting',
      current_step: 'comment_reply',
      waiting_for: 'opening_message_button',
      isOpenKeyLeftOut: true,
    });
    const common = {
      run,
      channelAccountId: account.channel_account_id,
      message_number: null,
      lane: 'reply',
      is_counted_as_direct_message: false,
      status: 'waiting',
      reason: null,
      not_before: new Date(Date.now() - 1_000),
    } as const;
    const reply = withReply
      ? await insertInstagramMessage({
          ...common,
          message_type: 'public_reply',
          channel: 'comment_reply',
        })
      : null;
    const hide = withHide
      ? await insertInstagramMessage({
          ...common,
          message_type: 'hide_comment',
          channel: 'comment_hide',
        })
      : null;
    return { run, reply, hide };
  }

  async function setReplyState({
    automationId,
    boxStart,
    lastTextNumber,
    waitingCount = 1,
  }: {
    automationId: number;
    boxStart: Date | null;
    lastTextNumber: number | null;
    waitingCount?: number;
  }) {
    await operatorQuery`
      INSERT INTO app.automation_reply_states
        (organization_id, automation_id, channel_account_id, box_start, last_text_number, waiting_count)
      VALUES (${organization.id}, ${automationId}, ${account.channel_account_id}, ${boxStart}, ${lastTextNumber}, ${waitingCount})
      ON CONFLICT (organization_id, automation_id) DO UPDATE
        SET box_start = excluded.box_start, last_text_number = excluded.last_text_number,
            waiting_count = excluded.waiting_count`;
  }

  async function readReplyState(automationId: number) {
    const [row] = await operatorQuery<
      { box_start: Date | null; last_text_number: number | null; waiting_count: number }[]
    >`
      SELECT box_start, last_text_number, waiting_count FROM app.automation_reply_states
      WHERE organization_id = ${organization.id} AND automation_id = ${automationId}`;
    return row;
  }

  /**
   * A box start of an automation (360 s boxes, 10 an hour) whose hashed second passed a moment ago
   * while the box still runs — so its one reply is due now.
   */
  function dueBoxStart(automationId: number): Date {
    const box = 360_000;
    const now = Date.now();
    for (let secondsAgo = 1; secondsAgo < 359; secondsAgo += 1) {
      const boxStart = new Date(now - secondsAgo * 1_000);
      const dueAt =
        boxStart.getTime() +
        replyBoxOffsetMilliseconds({ automationId, boxStart, boxMilliseconds: box });
      if (dueAt <= now - 200) return boxStart;
    }
    throw new Error('no due box start found');
  }

  function metaReplies(
    commentId: string,
    bodies: unknown[] = [],
    status = 200,
    body: object = { id: `reply.${commentId}` },
  ) {
    return nock(META_GRAPH_BASE_URL)
      .post(`/v27.0/${commentId}/replies`, (sent) => {
        bodies.push(sent);
        return true;
      })
      .query(true)
      .reply(status, body);
  }

  function metaHides(commentId: string, status = 200, body: object = { success: true }) {
    return nock(META_GRAPH_BASE_URL)
      .post(`/v27.0/${commentId}`)
      .query((query) => query.hide === 'true')
      .reply(status, body);
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
    contactId = (
      await insertContact({
        organizationId: organization.id,
        instagramAccountId: account.id,
        full_name: 'Riya',
        username: 'riya.k',
      })
    ).id;
    switches = { reply_like_person: true };
    random = 0;
    harness = buildLaneHarness({
      organization,
      account,
      laneRules: (messageService) => ({
        reply: new InstagramReplyLaneRules({
          messageService,
          replyStateService: new AutomationReplyStateService(new AutomationReplyStateRepository()),
          canUseReplyLikePerson: async () => switches?.reply_like_person === true,
          random: () => random,
        }),
      }),
    });
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('OFF: the reply goes at once with @username and never the last line, then the hide; neither moves the gap (AC-17.7)', async () => {
    const automation = await automationWith({ isLikePerson: false });
    await setReplyState({ automationId: automation.id, boxStart: null, lastTextNumber: 1 });
    const { reply, hide } = await waitingReply({
      automationId: automation.id,
      commentId: '17900000000000011',
      withHide: true,
    });
    const bodies: unknown[] = [];
    const replied = metaReplies('17900000000000011', bodies);
    const hidden = metaHides('17900000000000011');
    await harness.turn('reply');
    expect(replied.isDone()).toBe(true);
    // Reply first, then hide: the hide waits while the reply is not ended.
    expect(hidden.isDone()).toBe(false);
    expect(bodies).toEqual([{ message: '@riya.k Check your inbox' }]);
    expect(await readReplyState(automation.id)).toMatchObject({
      last_text_number: 2,
      waiting_count: 0,
    });
    await harness.turn('reply');
    expect(hidden.isDone()).toBe(true);
    const rows = await readInstagramMessages(organization.id);
    expect(rows.map((row) => [row.public_id, row.status])).toEqual([
      [reply!.public_id, 'sent'],
      [hide!.public_id, 'sent'],
    ]);
    expect(rows[0]!.instagram_message_id).toBe('reply.17900000000000011');
    expect(
      (await readLaneRow({ organizationId: organization.id, account, lane: 'reply' })).last_sent_at,
    ).toBeNull();
    expect(harness.recorded.map((input) => [input.step, input.result])).toEqual([
      ['public_reply', 'sent'],
      ['hide_comment', 'sent'],
    ]);
  });

  it('ON: waits for its box second, then posts and moves the box and the gap clock (AC-17.7, D32)', async () => {
    const automation = await automationWith({ isLikePerson: true, hourLimit: 10 });
    await waitingReply({ automationId: automation.id, commentId: '17900000000000021' });
    const early = metaReplies('17900000000000021');
    // No reply state yet: its first box starts now, its one reply at the box's hashed second.
    await harness.turn('reply');
    const state = await readReplyState(automation.id);
    const boxStart = state!.box_start!;
    const offset = replyBoxOffsetMilliseconds({
      automationId: automation.id,
      boxStart,
      boxMilliseconds: 360_000,
    });
    if (offset > 300) {
      expect(early.isDone()).toBe(false);
      const lane = await readLaneRow({ organizationId: organization.id, account, lane: 'reply' });
      expect(lane.next_run_at!.getTime()).toBe(boxStart.getTime() + offset);
      expect(lane.wait_reason).toBe('box');
    }
    nock.cleanAll();
    const dueStart = dueBoxStart(automation.id);
    await setReplyState({ automationId: automation.id, boxStart: dueStart, lastTextNumber: null });
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET next_run_at = now()
      WHERE channel_account_id = ${account.channel_account_id} AND lane = 'reply'`;
    const replied = metaReplies('17900000000000021');
    await harness.turn('reply');
    expect(replied.isDone()).toBe(true);
    expect((await readReplyState(automation.id))!.box_start!.getTime()).toBe(
      dueStart.getTime() + 360_000,
    );
    const lane = await readLaneRow({ organizationId: organization.id, account, lane: 'reply' });
    expect(lane.last_sent_at).not.toBeNull();
  });

  it('ON: two automations never reply within 20 seconds of each other on one account (AC-17.7)', async () => {
    const automation = await automationWith({ isLikePerson: true, hourLimit: 10 });
    await waitingReply({ automationId: automation.id, commentId: '17900000000000031' });
    await setReplyState({
      automationId: automation.id,
      boxStart: dueBoxStart(automation.id),
      lastTextNumber: null,
    });
    const lastOn = new Date(Date.now() - 5_000);
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET last_sent_at = ${lastOn}
      WHERE channel_account_id = ${account.channel_account_id} AND lane = 'reply'`;
    const replied = metaReplies('17900000000000031');
    await harness.turn('reply');
    expect(replied.isDone()).toBe(false);
    const lane = await readLaneRow({ organizationId: organization.id, account, lane: 'reply' });
    expect(lane.next_run_at!.getTime()).toBe(lastOn.getTime() + 20_000);
  });

  it('a failed hide is failed and changes nothing else; a hide of a gone comment is skipped (AC-17.7, plan §33.7)', async () => {
    const automation = await automationWith({ isLikePerson: false });
    await waitingReply({
      automationId: automation.id,
      commentId: '17900000000000041',
      withReply: false,
      withHide: true,
    });
    metaHides('17900000000000041', 400, { error: { code: 100, error_subcode: 9, message: 'x' } });
    await harness.turn('reply');
    const [failed] = await readInstagramMessages(organization.id);
    expect(failed).toMatchObject({ status: 'failed', reason: 'bad_text' });
    const lane = await readLaneRow({ organizationId: organization.id, account, lane: 'reply' });
    expect(lane.stop_reason).toBeNull();
    expect(harness.recorded.map((input) => [input.step, input.result])).toEqual([
      ['hide_comment', 'failed'],
    ]);
    await waitingReply({
      automationId: automation.id,
      commentId: '17900000000000042',
      withReply: false,
      withHide: true,
    });
    metaHides('17900000000000042', 400, { error: { code: 100, error_subcode: 33, message: 'x' } });
    nock(META_GRAPH_BASE_URL)
      .get('/v27.0/17900000000000042')
      .query(true)
      .reply(400, { error: { code: 100, error_subcode: 33, message: 'gone' } });
    await harness.turn('reply');
    expect((await readInstagramMessages(organization.id))[1]).toMatchObject({
      status: 'skipped',
      reason: 'deleted_comment',
    });
  });

  it('on a plan without PRO an ON automation works as OFF with its first line only (D57)', async () => {
    switches = { reply_like_person: false };
    random = 0.99;
    const automation = await automationWith({ isLikePerson: true, hourLimit: 10 });
    await setReplyState({ automationId: automation.id, boxStart: null, lastTextNumber: 1 });
    await waitingReply({ automationId: automation.id, commentId: '17900000000000051' });
    const bodies: unknown[] = [];
    const replied = metaReplies('17900000000000051', bodies);
    await harness.turn('reply');
    expect(replied.isDone()).toBe(true);
    expect(bodies).toEqual([{ message: '@riya.k Sent you a DM' }]);
    expect(
      (await readLaneRow({ organizationId: organization.id, account, lane: 'reply' })).last_sent_at,
    ).toBeNull();
  });
});
