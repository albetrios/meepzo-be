import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { nextInstagramObjectId } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { automationActionPath } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { organizationChannelAccountPath } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { runAutomationRunWaitExpiryJob } from '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-wait-expiry.processor.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { InstagramCommentFlow, type TestInstagramPerson } from './instagram-comment-flow.helper.js';
import { InstagramSendDriver } from './instagram-send-flow.helper.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const HOUR = 3_600_000;

/** GUIDE's four email wordings (plan §16 example 7). */
const EMAIL_WORDINGS = [
  'Your email?',
  'Where should I send it?',
  'Drop your email',
  'Which email is yours?',
];

/** "Reply like a person" needs three reply lines (AU7, `chk_automations_live_public_reply`). */
const REPLY_LINES = ['Check your inbox', 'Sent you a DM', 'Look in your DMs'];

/**
 * Flow — a comment becomes a DM (feat-instagram-dm-sending ROUTE row R54, AC-19.1–AC-19.13; plan
 * §16 Riya examples 1, 2, 4, 5, 7, 8, 9, 19, 20, 22): a comment signed to route 17, intake's comment
 * job, the match, the engine's waiting messages through Instagram's real sending port, then the
 * real send core worked ticket by ticket — the slow, reply and fast lanes, the gates, the counts and
 * the one result save telling the engine. Only Instagram is faked: every Graph call is nocked.
 */
describe('Flow — a comment becomes a DM (e2e)', () => {
  let app: FastifyInstance;
  let flow: InstagramCommentFlow;
  let driver: InstagramSendDriver;
  let riya: TestInstagramPerson;
  let postId: string;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    await initializeI18nextForBackgroundWork();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    flow = await InstagramCommentFlow.open(app, { sending: 'app' });
    // Creator: every PRO switch on — the email ask, "Reply like a person", the hide (P83).
    const plan = await createTestPlan({
      features: CREATOR_PLAN_FEATURES,
      priceMonthly: '29.00',
      priceYearly: '276.00',
    });
    await createTestSubscription({
      organizationId: flow.team.organization.id,
      planId: plan.id,
      status: 'ACTIVE',
    });
    driver = new InstagramSendDriver(app, flow);
    driver.mockInstagram();
    riya = flow.instagram.person('riya');
    postId = nextInstagramObjectId();
  });

  afterEach(async () => {
    driver.restore();
    nock.cleanAll();
    await metaGraphCircuit.reset();
  });

  /** GUIDE: a hello with a "Send me the guide" button, then one message; any column overridden. */
  function guide(columns: Record<string, unknown> = {}) {
    return flow.createAutomation({
      name: 'GUIDE',
      keywords: ['guide'],
      opening_message: { text: 'Hi! Want the guide?', button_title: 'Send me the guide' },
      final_message: { text: 'Here is the guide' },
      ...columns,
    });
  }

  /** Riya comments and intake runs, then every lane drains. */
  async function riyaComments(text: string, onPost = postId): Promise<string> {
    const commentId = await flow.commentAndProcess({ person: riya, postId: onPost, text });
    await driver.drain({ passTime: true });
    return commentId;
  }

  async function monthCount(): Promise<number> {
    const [row] = await operatorQuery<Array<{ total: string }>>`
      SELECT coalesce(sum(count), 0)::text AS total FROM app.message_month_counts
      WHERE organization_id = ${flow.team.organization.id}`;
    return Number(row?.total ?? 0);
  }

  async function automationCounts(automationId: number) {
    const [row] = await operatorQuery<
      Array<{ runs_started: string; taps: string; typed_answers: string }>
    >`
      SELECT coalesce(sum(runs_started), 0)::text AS runs_started, coalesce(sum(taps), 0)::text AS taps,
        coalesce(sum(typed_answers), 0)::text AS typed_answers
      FROM app.automation_counts WHERE automation_id = ${automationId}`;
    return {
      runsStarted: Number(row?.runs_started ?? 0),
      taps: Number(row?.taps ?? 0),
      typedAnswers: Number(row?.typed_answers ?? 0),
    };
  }

  describe('the opening DM by lane (AC-19.1, AC-19.2)', () => {
    it('window closed: the opening DM waits in the slow lane and goes as a private reply; with "Reply like a person" ON the public reply goes after it under her comment (AC-19.1)', async () => {
      await guide({
        is_public_reply_enabled: true,
        public_reply_texts: REPLY_LINES,
        is_public_reply_mention_enabled: true,
        is_reply_like_person_enabled: true,
      });
      const commentId = await flow.commentAndProcess({ person: riya, postId, text: 'GUIDE' });

      const [opening] = await driver.messages();
      expect(opening).toMatchObject({
        message_type: 'opening_message',
        lane: 'slow',
        channel: 'private_reply',
        status: 'waiting',
      });
      await driver.drain({ passTime: true });

      expect(driver.calls.map((call) => call.kind)).toEqual(['direct_message', 'public_reply']);
      expect(driver.directMessages[0]?.body.recipient).toEqual({ comment_id: commentId });
      expect(driver.calls[1]?.path).toBe(`${commentId}/replies`);
      expect(REPLY_LINES.map((line) => `@riya ${line}`)).toContain(driver.calls[1]?.body.message);
      const messages = await driver.messages();
      expect(messages.find((row) => row.message_type === 'public_reply')).toMatchObject({
        lane: 'reply',
        status: 'sent',
      });
      expect(await monthCount()).toBe(1);
    });

    it('window open: the opening message goes as a normal DM in the fast lane, outside the opening-DM limit, and counts 1 DM in the month (AC-19.2)', async () => {
      await guide();
      await flow.directMessage({ person: riya, text: 'hello there' });
      await flow.processEvents();
      await flow.updateContact({
        person: riya,
        values: { last_direct_message_received_at: new Date(Date.now() - 16 * HOUR) },
      });
      await flow.commentAndProcess({ person: riya, postId, text: 'GUIDE' });

      const [opening] = await driver.messages();
      expect(opening).toMatchObject({ lane: 'fast', channel: 'direct', status: 'waiting' });
      // About a second: the save picks 0.5–2 s (§30.12) — `created_at` is its unit's start.
      const delay = opening!.not_before!.getTime() - opening!.created_at.getTime();
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThan(3_000);
      await driver.drain({ passTime: true });

      expect(driver.directMessages).toHaveLength(1);
      expect(driver.directMessages[0]?.body.recipient).toEqual({ id: riya.instagramUserId });
      // Not the slow lane's: its hour of opening DMs (the 600) is untouched.
      const [slow] = await operatorQuery<Array<{ last_sent_at: Date | null }>>`
        SELECT last_sent_at FROM app.instagram_send_lanes
        WHERE channel_account_id = ${flow.account.channelAccountId} AND lane = 'slow'`;
      expect(slow?.last_sent_at ?? null).toBeNull();
      expect(await monthCount()).toBe(1);
    });
  });

  describe('her tap and her answers (AC-19.3, AC-19.4, AC-19.5, AC-19.10)', () => {
    /**
     * GUIDE with an email ask in four wordings and its tag step. The step names its tags: an empty
     * one is refused at go-live (routes-final CT9), so the launch's "the automation's name" is gone.
     */
    const emailGuide = () =>
      guide({
        steps: {
          hello: {
            on: true,
            versions: [
              {
                text: 'Hi! Want the guide?',
                buttons: [{ title: 'Send me the guide', action: 'next' }],
              },
            ],
          },
          email: { on: true, wordings: EMAIL_WORDINGS },
          messages: [{ kind: 'text', wait_minutes: 0, text: 'Here is the guide' }],
          tags: { on: true, list: ['guide-lead'] },
        },
      });

    it('a tap asks for her email 0.5–2 s later; her email is followed by message 1 within 0.5–2 s; the tag step adds the name and the run completes (AC-19.3, AC-19.10)', async () => {
      const automation = await emailGuide();
      await riyaComments('GUIDE');
      expect(await automationCounts(automation.id)).toMatchObject({ runsStarted: 1 });

      await driver.tapLastButton(riya);
      const ask = (await driver.messages()).find((row) => row.message_type === 'email_question');
      expect(ask).toBeDefined();
      const askDelay = ask!.not_before!.getTime() - ask!.created_at.getTime();
      expect(askDelay).toBeGreaterThanOrEqual(400);
      expect(askDelay).toBeLessThanOrEqual(2_100);
      await driver.drain({ passTime: true });
      expect(EMAIL_WORDINGS).toContain(InstagramSendDriver.textOf(driver.directMessages.at(-1)!));
      expect(await automationCounts(automation.id)).toMatchObject({ taps: 1, typedAnswers: 0 });

      await flow.answer({ person: riya, text: 'riya@gmail.com' });
      const first = (await driver.messages()).find((row) => row.message_number === 1);
      expect(first).toMatchObject({ lane: 'fast', status: 'waiting' });
      const firstDelay = first!.not_before!.getTime() - first!.created_at.getTime();
      expect(firstDelay).toBeLessThanOrEqual(2_100);
      await driver.drain({ passTime: true });

      expect(InstagramSendDriver.textOf(driver.directMessages.at(-1)!)).toBe('Here is the guide');
      expect((await flow.contactOf(riya)).email).toBe('riya@gmail.com');
      const [run] = await flow.runsOf(automation);
      expect(run).toMatchObject({ status: 'completed' });
      expect((await flow.contactOf(riya)).tags).toEqual(['guide-lead']);
    });

    it('"yes send" typed instead of a tap moves the run on and counts a typed answer (AC-19.4)', async () => {
      const automation = await guide();
      await riyaComments('GUIDE');
      await flow.answer({ person: riya, text: 'yes send' });
      await driver.drain({ passTime: true });

      expect(InstagramSendDriver.textOf(driver.directMessages.at(-1)!)).toBe('Here is the guide');
      expect(await automationCounts(automation.id)).toMatchObject({ taps: 0, typedAnswers: 1 });
      expect((await flow.runsOf(automation))[0]).toMatchObject({ status: 'completed' });
    });

    it('a wrong email three times gets three "ask again" wordings, then no more asks; a right one two days later is saved and message 1 goes (AC-19.5)', async () => {
      const automation = await emailGuide();
      await riyaComments('GUIDE');
      await driver.tapLastButton(riya);
      await driver.drain({ passTime: true });
      const asksBefore = driver.directMessages.length;

      for (const wrong of ['riya at gmail', 'riya@gmail', 'hello', 'ok']) {
        await flow.answer({ person: riya, text: wrong });
        await driver.drain({ passTime: true });
      }
      // Each ask again picks another wording than the one she got last (plan §5.8).
      const asks = driver.directMessages.slice(asksBefore - 1).map(InstagramSendDriver.textOf);
      expect(asks).toHaveLength(4);
      for (const [index, text] of asks.entries()) {
        expect(EMAIL_WORDINGS).toContain(text);
        if (index > 0) expect(text).not.toBe(asks[index - 1]);
      }
      expect((await flow.runsOf(automation))[0]).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
      });

      await flow.updateContact({
        person: riya,
        values: { last_direct_message_received_at: new Date(Date.now() - 48 * HOUR) },
      });
      await flow.answer({ person: riya, text: 'riya@gmail.com' });
      await driver.drain({ passTime: true });
      expect((await flow.contactOf(riya)).email).toBe('riya@gmail.com');
      expect(InstagramSendDriver.textOf(driver.directMessages.at(-1)!)).toBe('Here is the guide');
      expect((await flow.runsOf(automation))[0]).toMatchObject({ status: 'completed' });
    });
  });

  describe('the replacement rule and "every time" (AC-19.6, AC-19.7; P35)', () => {
    it('a comment on a second post cancels her open run (replaced) with its waiting messages and starts a new one; a second comment on that post is ignored once_per_post (AC-19.6)', async () => {
      const automation = await guide({ is_email_collection_enabled: true });
      await riyaComments('GUIDE');
      const [first] = await flow.runsOf(automation);
      expect(first).toMatchObject({ status: 'waiting', waiting_for: 'opening_message_button' });

      const secondPost = nextInstagramObjectId();
      await flow.commentAndProcess({ person: riya, postId: secondPost, text: 'GUIDE' });
      const runs = await flow.runsOf(automation);
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'replaced' });
      expect(runs[1]).toMatchObject({ trigger_instagram_media_id: secondPost });
      expect(['running', 'waiting']).toContain(runs[1]!.status);
      const firstRunMessages = (await driver.messages()).filter(
        (row) => row.automation_run_id === first!.id,
      );
      expect(firstRunMessages.every((row) => row.status !== 'waiting')).toBe(true);
      await driver.drain({ passTime: true });

      const again = await flow.commentAndProcess({
        person: riya,
        postId: secondPost,
        text: 'GUIDE again',
      });
      expect(await flow.runsOf(automation)).toHaveLength(2);
      expect(await flow.logOf({ commentId: again, automation })).toMatchObject({
        overall_status: 'ignored',
        ignored_reason: 'once_per_post',
      });
    });

    it('with once per person per post OFF, her second comment on the same post the next day starts a new run once the first ended, and with her window open its hello goes as a normal DM (AC-19.7)', async () => {
      await operatorQuery`
        UPDATE app.instagram_account_settings SET is_once_per_person_per_post_enabled = false
        WHERE channel_account_id = ${flow.account.channelAccountId}`;
      const automation = await guide();
      await riyaComments('PRICE GUIDE');
      await driver.tapLastButton(riya);
      await driver.drain({ passTime: true });
      expect((await flow.runsOf(automation))[0]).toMatchObject({ status: 'completed' });
      const sentBefore = driver.directMessages.length;

      await riyaComments('GUIDE');
      const runs = await flow.runsOf(automation);
      expect(runs).toHaveLength(2);
      const hello = (await driver.messages()).find(
        (row) => row.automation_run_id === runs[1]!.id && row.message_type === 'opening_message',
      );
      expect(hello).toMatchObject({ lane: 'fast', channel: 'direct', status: 'sent' });
      expect(driver.directMessages[sentBefore]?.body.recipient).toEqual({
        id: riya.instagramUserId,
      });
    });
  });

  describe('the public reply and the hide (AC-19.8, AC-19.9)', () => {
    const hidingGuide = () =>
      guide({
        is_public_reply_enabled: true,
        public_reply_texts: ['Check your inbox'],
        is_hide_comment_after_direct_message_enabled: true,
      });

    it('the hide goes after the public reply (AC-19.8)', async () => {
      await hidingGuide();
      const commentId = await riyaComments('GUIDE');
      expect(driver.calls.map((call) => [call.kind, call.path])).toEqual([
        ['direct_message', `${flow.account.instagramAppUserId}/messages`],
        ['public_reply', `${commentId}/replies`],
        ['hide_comment', commentId],
      ]);
      expect(driver.calls[2]?.body).toMatchObject({ hide: 'true' });
    });

    it('a hide that fails leaves her DM and the public reply as they are (AC-19.8)', async () => {
      const automation = await hidingGuide();
      driver.refuseNext({ kind: 'hide_comment', code: 100 });
      const commentId = await riyaComments('GUIDE');

      expect(driver.calls.map((call) => call.kind)).toEqual([
        'direct_message',
        'public_reply',
        'hide_comment',
      ]);
      const byType = Object.fromEntries(
        (await driver.messages()).map((row) => [row.message_type, row]),
      );
      expect(byType.opening_message).toMatchObject({ status: 'sent' });
      expect(byType.public_reply).toMatchObject({ status: 'sent' });
      expect(byType.hide_comment).toMatchObject({ status: 'failed' });
      expect(await flow.logOf({ commentId, automation })).toMatchObject({
        opening_dm_status: 'sent',
        public_reply_status: 'sent',
      });
      expect((await flow.runsOf(automation))[0]).toMatchObject({
        status: 'waiting',
        waiting_for: 'opening_message_button',
      });
    });

    it('"Reply like a person" OFF and ON on one account: the OFF reply goes right after its DM and moves nothing of the ON automation\'s gap and box (AC-19.9)', async () => {
      await guide({ is_public_reply_enabled: true, public_reply_texts: ['Check your inbox'] });
      const price = await flow.createAutomation({
        name: 'PRICE',
        keywords: ['price'],
        is_public_reply_enabled: true,
        public_reply_texts: REPLY_LINES,
        is_reply_like_person_enabled: true,
        public_reply_hour_limit: 30,
      });
      const other = flow.instagram.person('sam');
      const riyaComment = await flow.commentAndProcess({ person: riya, postId, text: 'GUIDE' });
      await driver.drain({ passTime: true });

      // GUIDE (OFF): DM then its reply at once — the paced lane's columns untouched.
      expect(driver.calls.map((call) => call.kind)).toEqual(['direct_message', 'public_reply']);
      expect(driver.calls[1]?.path).toBe(`${riyaComment}/replies`);
      const [replyLane] = await operatorQuery<
        Array<{ last_sent_at: Date | null; pick_count: number }>
      >`
        SELECT last_sent_at, pick_count FROM app.instagram_send_lanes
        WHERE channel_account_id = ${flow.account.channelAccountId} AND lane = 'reply'`;
      expect(replyLane).toMatchObject({ last_sent_at: null });
      const [priceBox] = await operatorQuery<Array<{ box_start: Date | null }>>`
        SELECT box_start FROM app.automation_reply_states WHERE automation_id = ${price.id}`;
      expect(priceBox?.box_start ?? null).toBeNull();

      // PRICE (ON): its reply waits for a second of its 120-second box (3600 ÷ 30), then goes.
      const otherComment = await flow.commentAndProcess({
        person: other,
        postId: nextInstagramObjectId(),
        text: 'PRICE',
      });
      await driver.drain();
      const pricePending = (await driver.messages()).find(
        (row) => row.automation_id === price.id && row.message_type === 'public_reply',
      );
      expect(pricePending).toMatchObject({ lane: 'reply', status: 'waiting' });
      await driver.drain({ passTime: true });
      expect(driver.calls.at(-1)).toMatchObject({
        kind: 'public_reply',
        path: `${otherComment}/replies`,
      });
      expect(REPLY_LINES.map((line) => `@sam ${line}`)).toContain(
        driver.calls.at(-1)?.body.message,
      );
    });
  });

  describe('stop word, the 7-day wait and a private account (AC-19.11, AC-19.12, AC-19.13)', () => {
    it('"STOP!" skips her waiting messages and cancels her open runs; a story reply later sends nothing; a keyword comment a week later starts her again (AC-19.11)', async () => {
      const automation = await guide();
      await flow.createAutomation({
        name: 'STORY',
        trigger_type: 'story_reply',
        keywords: [],
      });
      // Her hello waits in the slow lane (not drained yet) when she writes the stop word.
      await flow.commentAndProcess({ person: riya, postId, text: 'GUIDE' });
      await flow.answer({ person: riya, text: 'STOP!' });

      expect((await flow.contactOf(riya)).opted_out_at).not.toBeNull();
      expect((await driver.messages())[0]).toMatchObject({
        status: 'skipped',
        reason: 'opted_out',
      });
      expect((await flow.runsOf(automation))[0]).toMatchObject({ status: 'cancelled' });
      await driver.drain({ passTime: true });
      expect(driver.directMessages).toHaveLength(0);

      await driver.deliverMessaging({
        person: riya,
        item: {
          message: {
            mid: `m_story_${nextInstagramObjectId()}`,
            text: 'love this',
            reply_to: { story: { id: nextInstagramObjectId(), url: 'https://example.com/s' } },
          },
        },
      });
      await driver.drain({ passTime: true });
      expect(driver.directMessages).toHaveLength(0);

      // A week later her keyword comment starts her again.
      await flow.updateContact({
        person: riya,
        values: { last_direct_message_received_at: new Date(Date.now() - 7 * 24 * HOUR) },
      });
      await riyaComments('GUIDE', nextInstagramObjectId());
      expect((await flow.contactOf(riya)).opted_out_at).toBeNull();
      expect(driver.directMessages).toHaveLength(1);
      expect(driver.directMessages[0]?.body.recipient).toHaveProperty('comment_id');
    });

    it('a run still waiting 7 days after it started is cancelled wait_expired, and she may start that automation again (AC-19.12)', async () => {
      const automation = await guide();
      await riyaComments('GUIDE');
      const result = await runAutomationRunWaitExpiryJob({
        runService: app.appDomain.automationRunService,
        now: new Date(Date.now() + 7 * 24 * HOUR + 60_000),
      });
      expect(result.cancelled).toBe(1);
      // A week went by: her 24-hour opening rule (D8) is long over.
      await flow.updateContact({
        person: riya,
        values: { last_opening_message_at: new Date(Date.now() - 7 * 24 * HOUR) },
      });
      expect((await flow.runsOf(automation))[0]).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'wait_expired',
      });

      await riyaComments('GUIDE', nextInstagramObjectId());
      const runs = await flow.runsOf(automation);
      expect(runs).toHaveLength(2);
      expect(runs[1]).toMatchObject({ status: 'waiting', waiting_for: 'opening_message_button' });
    });

    it('on a private account a comment automation gets the go-live warning and the account carries the private flag the banner reads (AC-19.13)', async () => {
      await operatorQuery`
        UPDATE app.instagram_accounts SET is_private = true
        WHERE channel_account_id = ${flow.account.channelAccountId}`;
      const draft = await flow.createAutomation({ status: 'paused' });
      const goLive = await injectAuthenticated(app, {
        method: 'POST',
        url: automationActionPath({ automationPublicId: draft.public_id, action: 'go-live' }),
        token: flow.team.ownerToken,
        headers: { 'x-idempotency-key': `go-live-${draft.public_id}` },
      });
      expect(goLive.statusCode, goLive.body).toBe(200);
      expect((goLive.json() as { meta: { warnings: unknown[] } }).meta.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ reason: 'account_private' })]),
      );
      const account = await injectAuthenticated(app, {
        method: 'GET',
        url: await organizationChannelAccountPath(flow.team.organization.id),
        token: flow.team.ownerToken,
      });
      expect(account.statusCode, account.body).toBe(200);
      expect(JSON.stringify(account.json())).toContain('"is_private":true');
    });
  });

  describe('a refused text, the 24-hour opening rule and the account test (carry-overs of R42–R44, R53)', () => {
    it('5 refused texts in a row on one automation stop it (bad_text) and tell its owners once; it then sends nothing (plan §33.1, AU3)', async () => {
      const automation = await guide();
      for (let index = 0; index < 5; index += 1) {
        driver.refuseNext({ kind: 'direct_message', code: 100 });
        await flow.commentAndProcess({
          person: flow.instagram.person(`fan${index}`),
          postId,
          text: 'GUIDE',
        });
        await driver.drain({ passTime: true });
      }
      const stopped = await flow.readAutomation(automation.public_id);
      expect(stopped).toMatchObject({ stopped_reason: 'bad_text' });
      expect(stopped.stopped_at).not.toBeNull();
      const notices = await operatorQuery<Array<{ type: string; data: Record<string, unknown> }>>`
        SELECT type, data FROM notify.notifications WHERE organization_id = ${flow.team.organization.id}
          AND type = 'automation.stopped'`;
      expect(notices.length).toBeGreaterThanOrEqual(1);
      expect(notices.every((notice) => notice.data.problem === 'refused_text')).toBe(true);
      const failed = (await driver.messages()).filter((row) => row.status === 'failed');
      expect(failed).toHaveLength(5);
      expect(failed.every((row) => row.reason === 'bad_text')).toBe(true);

      // A stopped automation sends nothing until its text is fixed (AU3): no run, no call.
      const callsBefore = driver.calls.length;
      await riyaComments('GUIDE');
      expect(driver.calls).toHaveLength(callsBefore);
      expect(await flow.runsOf(automation)).toHaveLength(5);
    });

    it("a hand-sent DM's echo does not reset the 24-hour opening rule: a comment 2 hours after her last opening DM waits in the slow lane (launch AC-7.19, D8)", async () => {
      await guide();
      await riyaComments('GUIDE');
      expect(driver.directMessages).toHaveLength(1);
      await flow.updateContact({
        person: riya,
        values: { last_opening_message_at: new Date(Date.now() - 2 * HOUR) },
      });
      await flow.deliver({
        messaging: [
          {
            sender: { id: flow.account.instagramUserId },
            recipient: { id: riya.instagramUserId },
            timestamp: Date.now(),
            message: {
              mid: `m_echo_${nextInstagramObjectId()}`,
              text: 'hi from the team',
              is_echo: true,
            },
          },
        ],
      });
      await flow.processEvents();
      await flow.createAutomation({ name: 'PRICE', keywords: ['price'] });
      await riyaComments('PRICE', nextInstagramObjectId());

      expect(driver.directMessages).toHaveLength(1);
      expect((await driver.messages()).at(-1)).toMatchObject({
        message_type: 'opening_message',
        lane: 'slow',
        status: 'waiting',
      });
    });

    it('after a block, at most 3 test turns that only tell about a person are tried before the stop waits its time again (TEST_MAX_TURNS, plan §33.4)', async () => {
      await guide();
      const fans = [0, 1, 2, 3].map((index) => flow.instagram.person(`fan${index}`));
      driver.refuseNext({ kind: 'direct_message', code: 368 });
      for (const fan of fans) {
        await flow.commentAndProcess({ person: fan, postId, text: 'GUIDE' });
      }
      await driver.drain({ passTime: true });
      const laneOf = async () => {
        const [row] = await operatorQuery<
          Array<{ stop_reason: string | null; stop_until: Date | null }>
        >`SELECT stop_reason, stop_until FROM app.instagram_send_lanes
          WHERE channel_account_id = ${flow.account.channelAccountId} AND lane = 'slow'`;
        return row!;
      };
      expect(await laneOf()).toMatchObject({ stop_reason: 'blocked' });
      expect(driver.directMessages).toHaveLength(1);

      // The next day the block's time is over: each slow test DM answers "that person" (code 551);
      // a test says nothing about the account, so the next turn tests again — at most 3 turns.
      for (let index = 0; index < 3; index += 1) {
        driver.refuseNext({ kind: 'direct_message', code: 551 });
        await operatorQuery`
          UPDATE app.instagram_send_lanes SET stop_until = LEAST(stop_until, now() - interval '1 minute')
          WHERE channel_account_id = ${flow.account.channelAccountId}`;
        await driver.passTime();
        await driver.workLaneTurn('slow');
      }

      expect(driver.directMessages).toHaveLength(1 + 3);
      const held = await laneOf();
      expect(held.stop_reason).toBe('blocked');
      expect(held.stop_until!.getTime()).toBeGreaterThan(Date.now());
      const statuses = (await driver.messages()).map((row) => row.status).sort();
      expect(statuses).toEqual(['skipped', 'skipped', 'skipped', 'waiting']);
    });
  });
});
