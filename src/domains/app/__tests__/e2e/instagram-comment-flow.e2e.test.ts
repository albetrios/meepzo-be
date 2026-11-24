import { Queue } from 'bullmq';
import { readChannelAccountPublicIdOfInstagramAccount } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_MINUTE,
} from '@/shared/constants/ttl.constants.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import { AutomationCommentLogRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.repository.js';
import { runAutomationRunWaitExpiryJob } from '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-wait-expiry.processor.js';
import { INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.queue.js';
import { INSTAGRAM_WEBHOOK_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationCommentLog,
  insertAutomationRun,
  nextInstagramObjectId,
  readRunEventTrail,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  type FakeInstagram,
  InstagramCommentFlow,
  type TestInstagramPerson,
  instagramFailure,
} from './instagram-comment-flow.helper.js';

/**
 * The comment flow end to end (ROUTE row R15 — AC-8.1 to AC-8.28; routes-final § 3.B, § 4.A.10): a
 * comment delivered signed over HTTP to Meta's route 17, stored once, worked through by the
 * account's processing job (R14) and answered by the run engine (R10), with the team's account,
 * settings and automations made through their own routes (1, 3, 4, 12, 14, 15). The database, auth,
 * permissions, queues and every app service are real; Instagram is a fake that records every call
 * (nock stays on: no network), and the reply-safety draws are fixed.
 */
describe('Instagram comment automation flow (e2e)', () => {
  let app: FastifyInstance;
  let flow: InstagramCommentFlow;
  let instagram: FakeInstagram;
  let jordan: TestInstagramPerson;
  let postId: string;
  /** Readers of the two queues the flow adds to — never a worker. */
  let processingQueue: Queue;
  let reconnectNoticeQueue: Queue;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    await initializeI18nextForBackgroundWork();
    processingQueue = new Queue(INSTAGRAM_WEBHOOK_QUEUE_NAME, {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
    });
    reconnectNoticeQueue = new Queue(INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME, {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
    });
  });

  afterAll(async () => {
    for (const queue of [processingQueue, reconnectNoticeQueue]) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    flow = await InstagramCommentFlow.open(app);
    instagram = flow.instagram;
    jordan = instagram.person('jordan.lee');
    postId = nextInstagramObjectId();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    nock.cleanAll();
    await metaGraphCircuit.reset();
    // Instagram takes one private reply per comment — the flow never sends a second one.
    expect(instagram.commentsAnsweredPrivatelyTwice()).toEqual([]);
  });

  /** The jobs of `queue` that belong to this test's team. */
  async function jobsOfTeam(queue: Queue): Promise<unknown[]> {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
    return jobs
      .map((job) => job.data as { organizationPublicId?: string })
      .filter((data) => data.organizationPublicId === flow.team.organization.public_id);
  }

  const followRequestMessage = {
    text: 'Follow us first',
    following_button_title: "I'm following",
    profile_button_title: 'Our profile',
  };

  describe('one comment, every step', () => {
    it('public reply → opening button → follow → email → phone → final message (AC-8.1, AC-8.16–AC-8.20, AC-8.22, AC-8.23, AC-8.25)', async () => {
      const links = [
        { title: 'The guide', url: 'https://shop.example.com/guide' },
        { title: 'The shop', url: 'https://shop.example.com' },
        { title: 'Support', url: 'https://shop.example.com/support' },
      ];
      const automation = await flow.createAutomation({
        name: 'Spring guide',
        keywords: ['guide'],
        tags: ['spring', 'lead'],
        is_public_reply_enabled: true,
        public_reply_texts: ['Sent — check your messages!'],
        opening_message: { text: 'Thanks for your comment!', button_title: 'Send it' },
        is_follow_required: true,
        follow_request_message: followRequestMessage,
        is_email_collection_enabled: true,
        email_request_message: { text: 'Where do we send it?' },
        is_phone_collection_enabled: true,
        phone_request_message: { text: 'And your phone number?' },
        final_message: { text: 'Here is your guide', links },
      });
      instagram.followAnswers.push(false, false, true);

      // The comment: stored once and queued, the account's job added.
      const commentId = await flow.comment({ person: jordan, postId, text: 'The GUIDE please!' });
      expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({
        status: 'queued',
        contact_instagram_user_id: jordan.instagramUserId,
      });
      expect(await jobsOfTeam(processingQueue)).toEqual([
        expect.objectContaining({
          channelAccountPublicId: await readChannelAccountPublicIdOfInstagramAccount(
            flow.account.id,
          ),
        }),
      ]);

      expect(await flow.processEvents()).toEqual({
        outcome: 'drained',
        processedEventCount: 1,
        skippedEventCount: 0,
        failedEventCount: 0,
      });

      // The contact with its profile, the post, one run, one log.
      expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({
        status: 'processed',
        attempt_count: 1,
        error_message: null,
      });
      const contact = await flow.contactOf(jordan);
      expect(contact).toMatchObject({
        username: 'jordan.lee',
        full_name: 'Jordan Lee',
        followers_count: 42,
        email: null,
        phone: null,
        last_direct_message_received_at: null,
      });
      expect((await flow.storedPosts()).map((post) => post.instagram_media_id)).toEqual([postId]);
      const run = await flow.onlyRunOf(automation);
      expect(run).toMatchObject({
        contact_id: contact.id,
        trigger_type: 'comment',
        trigger_instagram_media_id: postId,
        trigger_instagram_comment_id: commentId,
        trigger_text: 'The GUIDE please!',
        status: 'waiting',
        waiting_for: 'opening_message_button',
        sending_message_kind: null,
        last_instagram_event_key: `comment:${commentId}`,
      });
      expect(instagram.publicReplies).toEqual([
        expect.objectContaining({
          instagramCommentId: commentId,
          text: 'Sent — check your messages!',
        }),
      ]);
      // Nobody messaged before: the opening message is the private reply to the comment.
      expect(instagram.directMessages).toEqual([
        expect.objectContaining({
          recipient: { comment_id: commentId },
          message: {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'button',
                text: 'Thanks for your comment!',
                buttons: [
                  {
                    type: 'postback',
                    title: 'Send it',
                    payload: `${automation.public_id}::${run.public_id}`,
                  },
                ],
              },
            },
          },
        }),
      ]);
      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({
          automation_id: automation.id,
          automation_name: 'Spring guide',
          automation_run_id: run.id,
          contact_id: contact.id,
          instagram_media_id: postId,
          comment_text: 'The GUIDE please!',
          commenter_username: 'jordan.lee',
          public_reply_status: 'sent',
          public_reply_text: 'Sent — check your messages!',
          opening_dm_status: 'waiting',
          overall_status: 'waiting',
          waiting_for: 'opening_message_button',
        }),
      ]);
      expect((await flow.readAutomation(automation.public_id)).last_triggered_at).not.toBeNull();

      const lastSentTimes = [(await flow.contactOf(jordan)).last_message_sent_at];

      // The click: not following, so the follow request goes and the run waits.
      await flow.clickLastButton(jordan);
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'waiting',
        waiting_for: 'follow',
        current_step: 'follow_check',
      });
      const followRequest = instagram.directMessages.at(-1);
      expect(followRequest?.recipient).toEqual({ id: jordan.instagramUserId });
      expect(JSON.stringify(followRequest?.message)).toContain(
        `https://www.instagram.com/${flow.account.username}`,
      );
      lastSentTimes.push((await flow.contactOf(jordan)).last_message_sent_at);

      // "I'm following", but Instagram says no: the request goes again.
      await flow.clickLastButton(jordan);
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'waiting',
        waiting_for: 'follow',
      });
      expect(instagram.directMessages).toHaveLength(3);
      expect(await flow.contactOf(jordan)).toMatchObject({ is_following_account: false });
      lastSentTimes.push((await flow.contactOf(jordan)).last_message_sent_at);

      // "I'm following" again, and Instagram says yes: the email question with its quick reply.
      await flow.clickLastButton(jordan);
      expect(await flow.contactOf(jordan)).toMatchObject({ is_following_account: true });
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
      });
      expect(instagram.directMessages.at(-1)).toMatchObject({
        recipient: { id: jordan.instagramUserId },
        message: {
          text: 'Where do we send it?',
          quick_replies: [{ content_type: 'user_email' }],
        },
      });
      lastSentTimes.push((await flow.contactOf(jordan)).last_message_sent_at);

      // The email, tapped on Instagram's own quick reply: saved lowercased with its time.
      await flow.answer({
        person: jordan,
        text: 'Jordan@Example.com',
        quickReplyPayload: 'Jordan@Example.com',
      });
      const withEmail = await flow.contactOf(jordan);
      expect(withEmail.email).toBe('jordan@example.com');
      expect(withEmail.email_collected_at).not.toBeNull();
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'waiting',
        waiting_for: 'phone',
      });
      expect(instagram.directMessages.at(-1)?.message).toEqual({
        text: 'And your phone number?',
        quick_replies: [{ content_type: 'user_phone_number' }],
      });
      lastSentTimes.push(withEmail.last_message_sent_at);

      // The phone, normalised: the final message with its three links, and the run completes.
      const phoneEventKey = await flow.answer({ person: jordan, text: '+91 98765-43210' });
      const finished = await flow.contactOf(jordan);
      expect(finished).toMatchObject({ phone: '+919876543210', tags: ['spring', 'lead'] });
      expect(finished.phone_collected_at).not.toBeNull();
      lastSentTimes.push(finished.last_message_sent_at);
      expect(instagram.directMessages.at(-1)?.message).toEqual({
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: 'Here is your guide',
            buttons: links.map((link) => ({ type: 'web_url', title: link.title, url: link.url })),
          },
        },
      });
      const completed = await flow.onlyRunOf(automation);
      expect(completed).toMatchObject({
        status: 'completed',
        current_step: 'final_dm',
        waiting_for: null,
        last_instagram_event_key: phoneEventKey,
      });
      expect(completed.completed_at).not.toBeNull();
      expect((await flow.readAutomation(automation.public_id)).completed_run_count).toBe(1);
      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({
          overall_status: 'completed',
          public_reply_status: 'sent',
          opening_dm_status: 'done',
          follow_status: 'done',
          email_status: 'done',
          email_received: 'jordan@example.com',
          phone_status: 'done',
          phone_received: '+919876543210',
          final_dm_status: 'sent',
          current_step: 'final_dm',
          failed_step: null,
          error_type: null,
        }),
      ]);

      // The whole history: every status change, and the email and phone collected (AC-8.23).
      expect(await readRunEventTrail(run.id)).toEqual([
        'status_changed:running',
        'status_changed:waiting',
        'status_changed:running',
        'status_changed:waiting',
        'status_changed:running',
        'status_changed:waiting',
        'status_changed:running',
        'status_changed:waiting',
        'status_changed:running',
        'email_received:-',
        'status_changed:waiting',
        'status_changed:running',
        'phone_received:-',
        'status_changed:completed',
      ]);
      // The last-message-sent time moved after every DM (AC-8.23).
      const sentTimes = lastSentTimes.map((time) => time?.getTime() ?? 0);
      expect(sentTimes).toHaveLength(6);
      expect(new Set(sentTimes).size).toBe(6);
      expect([...sentTimes].sort((left, right) => left - right)).toEqual(sentTimes);
      // A random 200–1000 ms pause went right before every send, and only there (AC-8.25).
      const sendKinds = ['direct_message', 'public_reply'];
      const pauses = instagram.calls.filter((call) => call.kind === 'pause');
      expect(pauses).toHaveLength(
        instagram.countOf('direct_message') + instagram.countOf('public_reply'),
      );
      for (const [index, call] of instagram.calls.entries()) {
        if (sendKinds.includes(call.kind)) expect(instagram.calls[index - 1]?.kind).toBe('pause');
      }
      for (const { milliseconds } of pauses) {
        expect(milliseconds).toBeGreaterThanOrEqual(200);
        expect(milliseconds).toBeLessThanOrEqual(1000);
      }
      // The profile and the post were read once each, for the new contact and the new post.
      expect(instagram.countOf('profile_read')).toBe(1);
      expect(instagram.countOf('post_read')).toBe(1);
    });
  });

  describe('which automation answers a comment', () => {
    it('a keyword matches when the lowercased comment contains it; no keywords match every comment (AC-8.2)', async () => {
      const automation = await flow.createFinalMessageAutomation({
        keywords: ['price'],
        is_public_reply_enabled: true,
        public_reply_texts: ['Sent!'],
      });

      const unmatchedId = await flow.commentAndProcess({ person: jordan, postId, text: 'Lovely' });

      // Nothing matched: the contact and the post are still kept, and nothing is logged or sent.
      expect(await flow.eventOf(`comment:${unmatchedId}`)).toMatchObject({ status: 'processed' });
      expect((await flow.contactOf(jordan)).username).toBe('jordan.lee');
      expect(await flow.storedPosts()).toHaveLength(1);
      expect(await flow.runs()).toEqual([]);
      expect(await flow.logsOf(unmatchedId)).toEqual([]);
      expect(instagram.countOf('direct_message')).toBe(0);
      expect(instagram.countOf('public_reply')).toBe(0);

      const matchedId = await flow.commentAndProcess({
        person: jordan,
        postId,
        text: 'what is the PRICEtag?',
      });
      expect(await flow.logsOf(matchedId)).toHaveLength(1);
      expect((await flow.onlyRunOf(automation)).status).toBe('completed');
      // The post was stored by the first comment; the second read nothing again (AC-8.1).
      expect(await flow.storedPosts()).toHaveLength(1);
      expect(instagram.countOf('post_read')).toBe(1);

      const everyComment = await flow.createFinalMessageAutomation({
        name: 'Every comment',
        keywords: [],
        target_scope: 'specific',
        target_instagram_media_id: postId,
        is_public_reply_enabled: true,
        public_reply_texts: ['Thank you!'],
      });
      const anyTextId = await flow.commentAndProcess({ person: jordan, postId, text: 'anything' });
      expect((await flow.onlyRunOf(everyComment)).status).toBe('completed');
      expect(await flow.logsOf(anyTextId)).toHaveLength(1);

      // The account's own public reply comes back as a comment: it is never answered.
      const echoId = nextInstagramObjectId();
      await flow.commentAndProcess({
        person: { instagramUserId: flow.account.instagramUserId, username: flow.account.username },
        postId,
        text: 'Thank you!',
        commentId: echoId,
      });
      expect(await flow.eventOf(`comment:${echoId}`)).toMatchObject({
        status: 'skipped',
        skip_reason: 'own_comment',
      });
      expect(await flow.logsOf(echoId)).toEqual([]);
    });

    it("only the commented post's account's automations count — another account's and another post's never run and get no log (AC-8.3)", async () => {
      const formerAccount = flow.account;
      const formerAutomation = await flow.createFinalMessageAutomation({
        name: 'Former account',
        keywords: [],
      });
      await flow.disconnectAccount();
      await flow.connectAccount();
      const otherPost = await flow.createFinalMessageAutomation({
        name: 'Another post',
        keywords: [],
        target_scope: 'specific',
        target_instagram_media_id: nextInstagramObjectId(),
      });
      const thisPost = await flow.createFinalMessageAutomation({
        name: 'This post',
        keywords: [],
        target_scope: 'specific',
        target_instagram_media_id: postId,
      });

      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'hello' });

      expect((await flow.onlyRunOf(thisPost)).status).toBe('completed');
      expect((await flow.logsOf(commentId)).map((log) => log.automation_id)).toEqual([thisPost.id]);
      for (const untouched of [formerAutomation, otherPost]) {
        expect(await flow.runsOf(untouched)).toEqual([]);
        expect((await flow.readAutomation(untouched.public_id)).last_triggered_at).toBeNull();
      }
      // A comment for the disconnected account is not even stored.
      const lateId = await flow.comment({
        person: jordan,
        postId,
        text: 'hello',
        instagramUserId: formerAccount.instagramUserId,
      });
      expect(await flow.eventOf(`comment:${lateId}`)).toBeUndefined();
    });

    it('the oldest automation set to the post runs, even when an older "any post" one matches; every other match is ignored (AC-8.4, AC-8.6)', async () => {
      const anyPost = await flow.createFinalMessageAutomation({
        name: 'Any post',
        keywords: ['guide'],
      });
      const onPost = { target_scope: 'specific', target_instagram_media_id: postId };
      const otherKeyword = await flow.createFinalMessageAutomation({
        ...onPost,
        name: 'Other keyword',
        keywords: ['price'],
      });
      const oldest = await flow.createFinalMessageAutomation({
        ...onPost,
        name: 'Oldest on the post',
        keywords: ['guide'],
      });
      const newer = await flow.createFinalMessageAutomation({
        ...onPost,
        name: 'Newer on the post',
        keywords: [],
      });

      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });

      expect((await flow.onlyRunOf(oldest)).status).toBe('completed');
      const logs = await flow.logsOf(commentId);
      expect(logs).toHaveLength(3);
      expect(logs.find((log) => log.automation_id === oldest.id)).toMatchObject({
        overall_status: 'completed',
        ignored_reason: null,
      });
      for (const ignored of [anyPost, newer]) {
        expect(logs.find((log) => log.automation_id === ignored.id)).toMatchObject({
          overall_status: 'ignored',
          ignored_reason: 'comment_already_answered',
          automation_run_id: null,
          error_type: null,
        });
        expect(await flow.runsOf(ignored)).toEqual([]);
      }
      expect(await flow.runsOf(otherKeyword)).toEqual([]);
      expect(instagram.directMessages).toHaveLength(1);
    });

    it('a "next post" automation this very comment links to the post counts as set to it (AC-8.4)', async () => {
      const now = Date.now();
      const anyPost = await flow.createFinalMessageAutomation({ name: 'Any post', keywords: [] });
      const nextPost = await flow.createFinalMessageAutomation({
        name: 'Next post',
        keywords: ['guide'],
        target_scope: 'next',
        next_post_starts_at: new Date(now - MILLISECONDS_PER_HOUR).toISOString(),
        next_post_ends_at: new Date(now + MILLISECONDS_PER_DAY).toISOString(),
      });
      instagram.publishedAtByPost.set(postId, new Date(now - MILLISECONDS_PER_MINUTE));

      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });

      expect(await flow.readAutomation(nextPost.public_id)).toMatchObject({
        next_post_status: 'linked',
        target_instagram_media_id: postId,
      });
      expect((await flow.onlyRunOf(nextPost)).status).toBe('completed');
      expect(await flow.logOf({ commentId, automation: anyPost })).toMatchObject({
        overall_status: 'ignored',
        ignored_reason: 'comment_already_answered',
      });
    });

    it('only when no post-linked automation matches does the oldest matching "any post" one run (AC-8.5, AC-8.6)', async () => {
      const now = Date.now();
      const waitingNextPost = await flow.createFinalMessageAutomation({
        name: 'A later post',
        keywords: [],
        target_scope: 'next',
        next_post_starts_at: new Date(now + MILLISECONDS_PER_HOUR).toISOString(),
        next_post_ends_at: new Date(now + MILLISECONDS_PER_DAY).toISOString(),
      });
      const onPostOtherKeyword = await flow.createFinalMessageAutomation({
        name: 'On the post, other keyword',
        keywords: ['price'],
        target_scope: 'specific',
        target_instagram_media_id: postId,
      });
      const oldest = await flow.createFinalMessageAutomation({
        name: 'Oldest any post',
        keywords: ['guide'],
      });
      const newer = await flow.createFinalMessageAutomation({
        name: 'Newer any post',
        keywords: [],
      });

      const commentId = await flow.commentAndProcess({
        person: jordan,
        postId,
        text: 'the guide!',
      });

      expect((await flow.onlyRunOf(oldest)).status).toBe('completed');
      expect((await flow.logsOf(commentId)).map((log) => log.automation_id).sort()).toEqual(
        [oldest.id, newer.id].sort(),
      );
      expect(await flow.logOf({ commentId, automation: newer })).toMatchObject({
        overall_status: 'ignored',
        ignored_reason: 'comment_already_answered',
      });
      for (const untouched of [waitingNextPost, onPostOtherKeyword]) {
        expect(await flow.runsOf(untouched)).toEqual([]);
      }
      expect(await flow.readAutomation(waitingNextPost.public_id)).toMatchObject({
        next_post_status: 'waiting',
        target_instagram_media_id: null,
      });
    });
  });

  describe('a comment handled again', () => {
    it('a retried comment goes on with the chosen run, never chooses again and repeats no message (AC-8.7, AC-8.13, AC-8.24)', async () => {
      const chosen = await flow.createAutomation({
        name: 'Chosen',
        keywords: ['guide'],
        is_public_reply_enabled: true,
        public_reply_texts: ['One', 'Two'],
      });
      const ignored = await flow.createAutomation({ name: 'Ignored', keywords: ['guide'] });
      instagram.failNext({ kind: 'direct_message', failure: instagramFailure.throttled() });
      const commentId = await flow.comment({ person: jordan, postId, text: 'guide' });

      await expect(flow.processEvents()).rejects.toThrow();

      expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({
        status: 'queued',
        attempt_count: 1,
      });
      const started = await flow.onlyRunOf(chosen);
      expect(started).toMatchObject({
        status: 'running',
        current_step: 'comment_reply',
        sending_message_kind: null,
      });
      // The chosen comment log is `started` and stands (AC-8.1); the public reply went once.
      expect(await flow.logOf({ commentId, automation: chosen })).toMatchObject({
        overall_status: 'started',
        public_reply_status: 'sent',
        opening_dm_status: 'off',
      });

      // Meanwhile an automation set to this very post appears: a new choice would take it.
      const rival = await flow.createAutomation({
        name: 'Rival',
        keywords: [],
        target_scope: 'specific',
        target_instagram_media_id: postId,
      });
      await flow.processEvents();

      expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({
        status: 'processed',
        attempt_count: 2,
      });
      expect(await flow.onlyRunOf(chosen)).toMatchObject({
        id: started.id,
        status: 'waiting',
        waiting_for: 'opening_message_button',
      });
      expect(await flow.logOf({ commentId, automation: rival })).toBeUndefined();
      expect(await flow.runsOf(rival)).toEqual([]);
      expect(await flow.logOf({ commentId, automation: ignored })).toMatchObject({
        overall_status: 'ignored',
        ignored_reason: 'comment_already_answered',
      });
      expect(instagram.publicReplies).toHaveLength(1);
      expect(instagram.directMessages).toHaveLength(1);
      expect(instagram.countOf('direct_message')).toBe(2);
    });

    it('a repeat delivery changes nothing — not even after the event itself was cleaned up (AC-8.7, AC-8.13)', async () => {
      const automation = await flow.createAutomation({
        keywords: ['guide'],
        is_public_reply_enabled: true,
        public_reply_texts: ['One', 'Two'],
      });
      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });
      await flow.clickLastButton(jordan);
      const settled = await flow.onlyRunOf(automation);
      expect(settled.status).toBe('completed');
      const callCount = instagram.calls.length;

      // Meta delivers it again: stored once, so nothing waits.
      await flow.comment({ person: jordan, postId, text: 'guide', commentId });
      expect(await flow.processEvents()).toMatchObject({ processedEventCount: 0 });

      // Much later, the stored event gone (30 days): handled again, and still nothing happens.
      await flow.removeEvent(`comment:${commentId}`);
      await flow.comment({ person: jordan, postId, text: 'guide', commentId });
      expect(await flow.processEvents()).toMatchObject({ processedEventCount: 1 });

      expect(instagram.calls).toHaveLength(callCount);
      expect(await flow.onlyRunOf(automation)).toEqual(settled);
      expect(await flow.logsOf(commentId)).toHaveLength(1);
      expect((await flow.readAutomation(automation.public_id)).completed_run_count).toBe(1);
    });
  });

  describe('a comment that meets a run', () => {
    it('this automation already waits → already_waiting, and nothing is sent (AC-8.8)', async () => {
      const automation = await flow.createAutomation({ keywords: ['guide'] });
      await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });
      const callCount = instagram.calls.length;

      const secondId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide!' });

      expect(await flow.logsOf(secondId)).toEqual([
        expect.objectContaining({
          overall_status: 'ignored',
          ignored_reason: 'already_waiting',
          automation_run_id: null,
        }),
      ]);
      expect((await flow.onlyRunOf(automation)).status).toBe('waiting');
      expect(instagram.calls).toHaveLength(callCount);
    });

    it("this automation's own run waiting for the email is already_waiting too — only another automation's is asked again (AC-8.8, AC-8.9, D14)", async () => {
      const automation = await flow.createFinalMessageAutomation({
        keywords: ['catalog'],
        is_email_collection_enabled: true,
      });
      await flow.commentAndProcess({ person: jordan, postId, text: 'catalog' });
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
      });
      const callCount = instagram.calls.length;

      const secondId = await flow.commentAndProcess({ person: jordan, postId, text: 'catalog?' });

      expect(await flow.logsOf(secondId)).toEqual([
        expect.objectContaining({ overall_status: 'ignored', ignored_reason: 'already_waiting' }),
      ]);
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
        queued_automations: [],
      });
      expect(instagram.calls).toHaveLength(callCount);
    });

    it('this automation is running → run_in_progress (AC-8.8)', async () => {
      const automation = await flow.createAutomation({ keywords: ['guide'] });
      // The person is known; a run of this automation is still running for them.
      await flow.commentAndProcess({ person: jordan, postId, text: 'hello' });
      await insertAutomationRun({
        organizationId: flow.team.organization.id,
        automationId: automation.id,
        contactId: (await flow.contactOf(jordan)).id,
        status: 'running',
        current_step: 'comment_reply',
        waiting_for: null,
        waiting_since_at: null,
      });

      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });

      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({ overall_status: 'ignored', ignored_reason: 'run_in_progress' }),
      ]);
      expect((await flow.onlyRunOf(automation)).status).toBe('running');
      expect(instagram.countOf('direct_message')).toBe(0);
    });

    it('its last run completed or failed → previous_run_final, no second run (AC-8.8, D14)', async () => {
      const completed = await flow.createFinalMessageAutomation({ keywords: ['guide'] });
      const failed = await flow.createFinalMessageAutomation({ keywords: ['price'] });
      await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });
      instagram.failNext({
        kind: 'direct_message',
        failure: instagramFailure.outsideMessagingWindow(),
      });
      await flow.commentAndProcess({ person: jordan, postId, text: 'price' });
      expect((await flow.onlyRunOf(completed)).status).toBe('completed');
      expect((await flow.onlyRunOf(failed)).status).toBe('failed');
      const callCount = instagram.calls.length;

      const again = [
        await flow.commentAndProcess({ person: jordan, postId, text: 'guide again' }),
        await flow.commentAndProcess({ person: jordan, postId, text: 'price again' }),
      ];

      for (const commentId of again) {
        expect(await flow.logsOf(commentId)).toEqual([
          expect.objectContaining({
            overall_status: 'ignored',
            ignored_reason: 'previous_run_final',
            automation_run_id: null,
          }),
        ]);
      }
      expect(await flow.runs()).toHaveLength(2);
      expect(instagram.calls).toHaveLength(callCount);
    });

    it('after a cancelled run (the 7-day wait) a new comment starts a new one (AC-8.8)', async () => {
      const automation = await flow.createAutomation({ keywords: ['guide'] });
      const firstId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });
      await runAutomationRunWaitExpiryJob({
        runService: app.appDomain.automationRunService,
        now: new Date(Date.now() + 8 * MILLISECONDS_PER_DAY),
      });
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'wait_expired',
      });
      expect(await flow.logsOf(firstId)).toEqual([
        expect.objectContaining({ overall_status: 'cancelled', waiting_for: null }),
      ]);

      const secondId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });

      const runs = await flow.runsOf(automation);
      expect(runs.map((run) => run.status)).toEqual(['cancelled', 'completed']);
      expect(await flow.logsOf(secondId)).toEqual([
        expect.objectContaining({ automation_run_id: runs[1]?.id, ignored_reason: null }),
      ]);
    });

    it("another automation's run waits for the email: the question goes again, the new automation is saved once (AC-8.9)", async () => {
      const emailFirst = await flow.createFinalMessageAutomation({
        keywords: ['catalog'],
        is_email_collection_enabled: true,
        email_request_message: { text: 'Your email, please' },
      });
      const second = await flow.createAutomation({
        keywords: ['guide'],
        is_public_reply_enabled: true,
        public_reply_texts: ['Sent!'],
      });
      const emailQuestion = {
        text: 'Your email, please',
        quick_replies: [{ content_type: 'user_email' }],
      };
      const firstId = await flow.commentAndProcess({ person: jordan, postId, text: 'catalog' });
      expect(await flow.onlyRunOf(emailFirst)).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
      });

      const secondId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });
      const thirdId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide!!' });

      // The question again, each time as the private reply to the new comment (D18).
      expect(
        instagram.directMessages.map(({ recipient, message }) => ({ recipient, message })),
      ).toEqual(
        [firstId, secondId, thirdId].map((commentId) => ({
          recipient: { comment_id: commentId },
          message: emailQuestion,
        })),
      );
      expect(instagram.countOf('public_reply')).toBe(0);
      const waiting = await flow.onlyRunOf(emailFirst);
      expect(waiting).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
        sending_message_kind: null,
      });
      expect(waiting.queued_automations).toEqual([
        {
          automation_id: second.public_id,
          queued_at: expect.any(String),
          trigger: {
            type: 'comment',
            instagram_media_id: postId,
            instagram_comment_id: secondId,
            text: 'guide',
          },
        },
      ]);
      for (const commentId of [secondId, thirdId]) {
        expect(await flow.logsOf(commentId)).toEqual([
          expect.objectContaining({
            automation_id: second.id,
            overall_status: 'ignored',
            ignored_reason: 'waiting_for_other_email',
            automation_run_id: null,
          }),
        ]);
      }
      expect(await flow.runsOf(second)).toEqual([]);
    });

    it('a question Instagram could not take for now is asked again by the retry, once (AC-8.9, AC-8.24)', async () => {
      const emailFirst = await flow.createFinalMessageAutomation({
        keywords: ['catalog'],
        is_email_collection_enabled: true,
      });
      const second = await flow.createAutomation({ keywords: ['guide'] });
      await flow.commentAndProcess({ person: jordan, postId, text: 'catalog' });
      instagram.failNext({ kind: 'direct_message', failure: instagramFailure.throttled() });
      const commentId = await flow.comment({ person: jordan, postId, text: 'guide' });

      await expect(flow.processEvents()).rejects.toThrow();
      expect(instagram.directMessages).toHaveLength(1);
      await flow.processEvents();

      expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({
        status: 'processed',
        attempt_count: 2,
      });
      expect(instagram.directMessages).toHaveLength(2);
      expect(instagram.directMessages[1]?.recipient).toEqual({ comment_id: commentId });
      const waiting = await flow.onlyRunOf(emailFirst);
      expect(waiting).toMatchObject({ status: 'waiting', waiting_for: 'email' });
      expect(waiting.queued_automations).toEqual([
        expect.objectContaining({ automation_id: second.public_id }),
      ]);
      expect(await flow.logsOf(commentId)).toHaveLength(1);
    });

    it('when the email arrives each saved automation starts in order, its email step skipped; one no longer live, deleted or already run is skipped (AC-8.10, AC-8.21)', async () => {
      const alreadyRan = await flow.createFinalMessageAutomation({
        name: 'Already ran',
        keywords: ['gift'],
      });
      await flow.commentAndProcess({ person: jordan, postId, text: 'gift' });
      const emailFirst = await flow.createFinalMessageAutomation({
        name: 'Email first',
        keywords: ['catalog'],
        is_email_collection_enabled: true,
        final_message: { text: 'The catalog' },
      });
      const earlier = await flow.createAutomation({
        name: 'Earlier',
        keywords: ['guide'],
        is_email_collection_enabled: true,
        final_message: { text: 'The guide' },
      });
      const turnedOff = await flow.createAutomation({ name: 'Turned off', keywords: ['price'] });
      const deleted = await flow.createAutomation({ name: 'Deleted', keywords: ['sale'] });
      const later = await flow.createFinalMessageAutomation({
        name: 'Later',
        keywords: ['coupon'],
        final_message: { text: 'The coupon' },
      });
      await flow.commentAndProcess({ person: jordan, postId, text: 'catalog' });
      const commentIds = {
        earlier: await flow.commentAndProcess({ person: jordan, postId, text: 'guide' }),
        turnedOff: await flow.commentAndProcess({ person: jordan, postId, text: 'price' }),
        deleted: await flow.commentAndProcess({ person: jordan, postId, text: 'sale' }),
        alreadyRan: await flow.commentAndProcess({ person: jordan, postId, text: 'gift' }),
        later: await flow.commentAndProcess({ person: jordan, postId, text: 'coupon' }),
      };
      expect((await flow.onlyRunOf(emailFirst)).queued_automations).toHaveLength(5);
      await flow.editAutomation({ automation: turnedOff, body: { status: 'inactive' } });
      await flow.deleteAutomation(deleted);
      const sentBefore = instagram.directMessages.length;

      await flow.answer({ person: jordan, text: ' Jordan@Example.com ' });

      expect((await flow.contactOf(jordan)).email).toBe('jordan@example.com');
      expect(await flow.onlyRunOf(emailFirst)).toMatchObject({
        status: 'completed',
        queued_automations: [],
      });
      // In order: the answered run, then each saved automation — nobody is asked for the email.
      expect(instagram.directMessages.slice(sentBefore).map(({ message }) => message)).toEqual([
        { text: 'The catalog' },
        { text: 'The guide' },
        { text: 'The coupon' },
      ]);
      const startedRuns = {
        earlier: await flow.onlyRunOf(earlier),
        later: await flow.onlyRunOf(later),
      };
      expect(startedRuns.earlier.id).toBeLessThan(startedRuns.later.id);
      expect(startedRuns.earlier).toMatchObject({
        status: 'completed',
        trigger_type: 'comment',
        trigger_instagram_comment_id: commentIds.earlier,
        trigger_text: 'guide',
      });
      expect(await flow.logsOf(commentIds.earlier)).toEqual([
        expect.objectContaining({
          overall_status: 'completed',
          ignored_reason: null,
          automation_run_id: startedRuns.earlier.id,
          email_status: 'skipped',
        }),
      ]);
      expect(await flow.logsOf(commentIds.later)).toEqual([
        expect.objectContaining({
          overall_status: 'completed',
          ignored_reason: null,
          automation_run_id: startedRuns.later.id,
        }),
      ]);
      for (const commentId of [commentIds.turnedOff, commentIds.deleted, commentIds.alreadyRan]) {
        expect(await flow.logsOf(commentId)).toEqual([
          expect.objectContaining({
            overall_status: 'ignored',
            ignored_reason: 'waiting_for_other_email',
            automation_run_id: null,
          }),
        ]);
      }
      expect(await flow.runsOf(turnedOff)).toEqual([]);
      expect(await flow.runsOf(deleted)).toEqual([]);
      expect(await flow.runsOf(alreadyRan)).toHaveLength(1);
    });
  });

  describe('public reply safety', () => {
    it('off: every chosen comment gets a public reply, never the last text again (AC-8.11, AC-8.12)', async () => {
      await flow.createAutomation({
        keywords: [],
        is_public_reply_enabled: true,
        public_reply_texts: ['One', 'Two', 'Three'],
      });
      flow.safetyDraws.push(2, 1, 1, 0, 0);

      for (const username of ['ana', 'ben', 'cleo', 'dev', 'eli']) {
        await flow.commentAndProcess({ person: instagram.person(username), postId, text: 'hi' });
      }

      const texts = instagram.publicReplies.map((reply) => reply.text);
      expect(texts).toHaveLength(5);
      for (const [index, text] of texts.entries()) {
        if (index > 0) expect(text).not.toBe(texts[index - 1]);
      }
    });

    it('on: duplicate → random → hour limit → gap, the first that applies is saved, and the DM always goes (AC-8.11, AC-8.15)', async () => {
      const replying = await flow.createAutomation({
        name: 'Replying',
        keywords: ['guide'],
        is_public_reply_enabled: true,
        public_reply_texts: ['One', 'Two'],
      });
      const safety = {
        is_public_reply_safety_enabled: true,
        public_reply_chance_percent: 100,
        public_reply_hour_limit: 1,
        public_reply_gap_min_seconds: 3600,
        public_reply_gap_max_seconds: 3600,
      };
      await flow.changeSettings(safety);
      const firstId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });
      expect(await flow.logOf({ commentId: firstId, automation: replying })).toMatchObject({
        public_reply_status: 'sent',
        public_reply_skip_reason: null,
      });

      /** A new person's comment under changed settings: its saved skip reason, and its DM. */
      async function skipReasonWith(settings: Record<string, unknown>) {
        await flow.changeSettings(settings);
        const person = instagram.person(`person.${instagram.calls.length}`);
        const commentId = await flow.commentAndProcess({ person, postId, text: 'guide' });
        const log = await flow.logOf({ commentId, automation: replying });
        expect(log).toMatchObject({ public_reply_status: 'skipped', opening_dm_status: 'waiting' });
        expect(instagram.directMessages.at(-1)?.recipient).toEqual({ comment_id: commentId });
        return log?.public_reply_skip_reason;
      }

      // Every later rule applies too each time; the first in the order is the one saved.
      expect(await skipReasonWith({ public_reply_chance_percent: 0 })).toBe('random');
      expect(await skipReasonWith({ public_reply_chance_percent: 100 })).toBe('hour_limit');
      expect(await skipReasonWith({ public_reply_hour_limit: 60 })).toBe('gap');
      expect(instagram.publicReplies).toHaveLength(1);

      // A comment that already got a public reply: its automation starts late (behind an email),
      // and the reply is skipped as a duplicate although every other rule applies as well.
      await flow.changeSettings({ public_reply_chance_percent: 0, public_reply_hour_limit: 1 });
      await flow.createFinalMessageAutomation({
        name: 'Email first',
        keywords: ['catalog'],
        is_email_collection_enabled: true,
      });
      const asked = instagram.person('asked.first');
      await flow.commentAndProcess({ person: asked, postId, text: 'catalog' });
      const repliedId = await flow.commentAndProcess({ person: asked, postId, text: 'guide' });
      const elsewhere = await insertAutomation({
        organizationId: flow.team.organization.id,
        instagramAccountId: flow.account.id,
      });
      await insertAutomationCommentLog({
        organizationId: flow.team.organization.id,
        automationId: elsewhere.id,
        contactId: (await flow.contactOf(asked)).id,
        instagram_comment_id: repliedId,
        public_reply_status: 'sent',
        public_reply_text: 'One',
        public_reply_at: new Date(),
      });
      await flow.answer({ person: asked, text: 'asked@example.com' });
      expect(await flow.logOf({ commentId: repliedId, automation: replying })).toMatchObject({
        overall_status: 'completed',
        public_reply_status: 'skipped',
        public_reply_skip_reason: 'duplicate',
      });
      expect(instagram.publicReplies).toHaveLength(1);
    });

    it.each([
      ['refused', instagramFailure.outsideMessagingWindow, 'instagram_api'],
      ['throttled', instagramFailure.throttled, 'instagram_api'],
      ['left without an answer', instagramFailure.timeout, 'network'],
    ])(
      'a public reply %s is saved as failed and the flow goes on (AC-8.14)',
      async (_label, failure, errorType) => {
        const automation = await flow.createAutomation({
          keywords: ['guide'],
          is_public_reply_enabled: true,
          public_reply_texts: ['Sent!'],
        });
        instagram.failNext({ kind: 'public_reply', failure: failure() });

        const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });

        expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({
          status: 'processed',
          attempt_count: 1,
        });
        expect(await flow.logsOf(commentId)).toEqual([
          expect.objectContaining({
            public_reply_status: 'failed',
            public_reply_text: null,
            error_type: errorType,
            overall_status: 'waiting',
            opening_dm_status: 'waiting',
          }),
        ]);
        expect(await flow.onlyRunOf(automation)).toMatchObject({
          status: 'waiting',
          waiting_for: 'opening_message_button',
          sending_message_kind: null,
        });
        expect(instagram.countOf('public_reply')).toBe(1);
        expect(instagram.directMessages).toHaveLength(1);
      },
    );
  });

  describe('the opening message (AC-8.16)', () => {
    it('is skipped when the contact got a DM in the last 24 hours, and sent again after that', async () => {
      await flow.createFinalMessageAutomation({ name: 'First', keywords: ['gift'] });
      const recent = await flow.createAutomation({ name: 'Recent', keywords: ['guide'] });
      const muchLater = await flow.createAutomation({ name: 'Much later', keywords: ['price'] });
      await flow.commentAndProcess({ person: jordan, postId, text: 'gift' });

      const recentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });

      expect((await flow.onlyRunOf(recent)).status).toBe('completed');
      expect(await flow.logsOf(recentId)).toEqual([
        expect.objectContaining({ opening_dm_status: 'skipped', final_dm_status: 'sent' }),
      ]);
      // Still no DM from this person: the final message is the private reply to this comment.
      expect(instagram.directMessages.at(-1)?.recipient).toEqual({ comment_id: recentId });

      await flow.updateContact({
        person: jordan,
        values: { last_message_sent_at: new Date(Date.now() - 25 * MILLISECONDS_PER_HOUR) },
      });
      const laterId = await flow.commentAndProcess({ person: jordan, postId, text: 'price' });
      expect(await flow.onlyRunOf(muchLater)).toMatchObject({
        status: 'waiting',
        waiting_for: 'opening_message_button',
      });
      expect(await flow.logsOf(laterId)).toEqual([
        expect.objectContaining({ opening_dm_status: 'waiting' }),
      ]);
    });

    it('off, the run goes straight on; a person who messaged in the last 24 hours gets a normal DM', async () => {
      // A comment automation's opening message always has its button (AQ2) — with it off, the first
      // message is the next step's.
      const automation = await flow.createFinalMessageAutomation({
        keywords: ['guide'],
        is_dm_keyword_trigger_enabled: false,
        final_message: { text: 'Here you go' },
      });
      await flow.answer({ person: jordan, text: 'hello there' });

      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });

      expect(
        instagram.directMessages.map(({ recipient, message }) => ({ recipient, message })),
      ).toEqual([{ recipient: { id: jordan.instagramUserId }, message: { text: 'Here you go' } }]);
      expect((await flow.onlyRunOf(automation)).status).toBe('completed');
      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({ opening_dm_status: 'off', final_dm_status: 'sent' }),
      ]);
    });
  });

  describe('the follow, email and phone steps', () => {
    it('a contact who already follows is not asked; one Instagram will not tell about is (AC-8.17)', async () => {
      const automation = await flow.createFinalMessageAutomation({
        keywords: [],
        is_follow_required: true,
        follow_request_message: followRequestMessage,
      });
      const follower = instagram.person('a.follower');
      instagram.followAnswers.push(true, null);

      const followerId = await flow.commentAndProcess({ person: follower, postId, text: 'hi' });
      const unknownId = await flow.commentAndProcess({ person: jordan, postId, text: 'hi' });

      expect(await flow.logsOf(followerId)).toEqual([
        expect.objectContaining({ follow_status: 'skipped', overall_status: 'completed' }),
      ]);
      expect((await flow.contactOf(follower)).is_following_account).toBe(true);
      expect(await flow.logsOf(unknownId)).toEqual([
        expect.objectContaining({ follow_status: 'waiting', waiting_for: 'follow' }),
      ]);
      expect((await flow.runsOf(automation)).map((run) => run.status)).toEqual([
        'completed',
        'waiting',
      ]);
      // The request, with both its buttons, is the private reply to the comment.
      const request = instagram.directMessages.at(-1);
      expect(request?.recipient).toEqual({ comment_id: unknownId });
      expect(request?.message.attachment?.payload.buttons).toEqual([
        {
          type: 'postback',
          title: "I'm following",
          payload: expect.stringMatching(/^aut_.+::run_.+$/),
        },
        {
          type: 'web_url',
          title: 'Our profile',
          url: `https://www.instagram.com/${flow.account.username}`,
        },
      ]);
    });

    it('a wrong email gets the wrong-email text with the quick reply and the run keeps waiting — also when the first try could not go (AC-8.19, AC-8.24)', async () => {
      const automation = await flow.createFinalMessageAutomation({
        keywords: ['catalog'],
        is_email_collection_enabled: true,
      });
      await flow.commentAndProcess({ person: jordan, postId, text: 'catalog' });
      const wrongEmailText = {
        text: 'Please provide a valid email address. Use the button below to share your email.',
        quick_replies: [{ content_type: 'user_email' }],
      };

      await flow.answer({ person: jordan, text: 'not an email' });

      expect(instagram.directMessages.at(-1)).toMatchObject({
        recipient: { id: jordan.instagramUserId },
        message: wrongEmailText,
      });
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
        sending_message_kind: null,
      });
      expect((await flow.contactOf(jordan)).email).toBeNull();

      // Instagram is busy at the first try: the retry sends the text, once.
      instagram.failNext({ kind: 'direct_message', failure: instagramFailure.serverError() });
      const eventKey = await flow.directMessage({ person: jordan, text: 'still @ wrong' });
      await expect(flow.processEvents()).rejects.toThrow();
      expect(instagram.directMessages).toHaveLength(2);
      await flow.processEvents();
      expect(await flow.eventOf(eventKey)).toMatchObject({ status: 'processed', attempt_count: 2 });
      expect(instagram.directMessages).toHaveLength(3);
      expect(instagram.directMessages.at(-1)?.message).toEqual(wrongEmailText);
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
      });

      await flow.answer({ person: jordan, text: 'JORDAN@EXAMPLE.COM' });
      expect((await flow.contactOf(jordan)).email).toBe('jordan@example.com');
      expect((await flow.onlyRunOf(automation)).status).toBe('completed');
    });

    it('a phone answer without 10 to 15 digits sends nothing and the run keeps waiting (AC-8.20)', async () => {
      const automation = await flow.createFinalMessageAutomation({
        keywords: ['call'],
        is_phone_collection_enabled: true,
      });
      await flow.commentAndProcess({ person: jordan, postId, text: 'call me' });
      expect(await flow.onlyRunOf(automation)).toMatchObject({ waiting_for: 'phone' });
      const callCount = instagram.calls.length;

      for (const text of ['12345', 'tomorrow', '1234567890123456']) {
        await flow.answer({ person: jordan, text });
      }

      expect(instagram.calls).toHaveLength(callCount);
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'waiting',
        waiting_for: 'phone',
      });
      expect((await flow.contactOf(jordan)).phone).toBeNull();

      await flow.answer({ person: jordan, text: '(987) 654-3210' });
      expect((await flow.contactOf(jordan)).phone).toBe('9876543210');
      expect((await flow.onlyRunOf(automation)).status).toBe('completed');
    });

    it('the email and phone steps are skipped when the contact already has them (AC-8.21)', async () => {
      await flow.createFinalMessageAutomation({
        keywords: ['catalog'],
        is_email_collection_enabled: true,
        is_phone_collection_enabled: true,
      });
      const second = await flow.createFinalMessageAutomation({
        keywords: ['guide'],
        is_email_collection_enabled: true,
        is_phone_collection_enabled: true,
      });
      await flow.commentAndProcess({ person: jordan, postId, text: 'catalog' });
      await flow.answer({ person: jordan, text: 'jordan@example.com' });
      await flow.answer({ person: jordan, text: '9876543210' });
      const sentBefore = instagram.directMessages.length;

      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });

      expect(instagram.directMessages).toHaveLength(sentBefore + 1);
      expect((await flow.onlyRunOf(second)).status).toBe('completed');
      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({
          email_status: 'skipped',
          phone_status: 'skipped',
          final_dm_status: 'sent',
          overall_status: 'completed',
        }),
      ]);
    });

    it('a completed run is counted, and tags the contact with the automation name when it has no tags (AC-8.22)', async () => {
      const automation = await flow.createFinalMessageAutomation({
        name: 'Summer sale',
        keywords: [],
        tags: [],
        final_message: { text: 'Enjoy' },
      });
      const other = instagram.person('another.person');

      await flow.commentAndProcess({ person: jordan, postId, text: 'hi' });
      await flow.commentAndProcess({ person: other, postId, text: 'hi' });

      expect((await flow.contactOf(jordan)).tags).toEqual(['Summer sale']);
      expect((await flow.contactOf(other)).tags).toEqual(['Summer sale']);
      expect((await flow.readAutomation(automation.public_id)).completed_run_count).toBe(2);
      // Without links the final message is plain text.
      expect(instagram.directMessages.map(({ message }) => message)).toEqual([
        { text: 'Enjoy' },
        { text: 'Enjoy' },
      ]);
    });
  });

  describe('crashes and failed sends', () => {
    it('a crash after a DM went but before it was saved fails the step — never sent again (AC-8.24)', async () => {
      const automation = await flow.createAutomation({ keywords: ['guide'] });
      vi.spyOn(app.appDomain.contactService, 'recordContactMessageSent').mockRejectedValueOnce(
        new Error('connection terminated unexpectedly'),
      );
      const commentId = await flow.comment({ person: jordan, postId, text: 'guide' });

      await expect(flow.processEvents()).rejects.toThrow('connection terminated unexpectedly');
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'running',
        sending_message_kind: 'opening_message',
      });
      await flow.processEvents();

      expect(instagram.countOf('direct_message')).toBe(1);
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'failed',
        sending_message_kind: 'opening_message',
        error_message: 'network:send_outcome_unknown',
      });
      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({
          overall_status: 'failed',
          failed_step: 'opening_dm',
          error_type: 'network',
          error_reason: 'send_outcome_unknown',
        }),
      ]);
      // The handling finished: the run carries the failure, not the event.
      expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({ status: 'processed' });
    });

    it('a crash after a public reply went but before it was saved marks it failed and goes on — never sent again (AC-8.13, AC-8.24)', async () => {
      const automation = await flow.createAutomation({
        keywords: ['guide'],
        is_public_reply_enabled: true,
        public_reply_texts: ['One', 'Two'],
      });
      const update = AutomationCommentLogRepository.prototype.update;
      let hasCrashed = false;
      vi.spyOn(AutomationCommentLogRepository.prototype, 'update').mockImplementation(function (
        this: AutomationCommentLogRepository,
        input,
      ) {
        if (!hasCrashed && input.changes.public_reply_status === 'sent') {
          hasCrashed = true;
          return Promise.reject(new Error('connection terminated unexpectedly'));
        }
        return update.call(this, input);
      });
      const commentId = await flow.comment({ person: jordan, postId, text: 'guide' });

      await expect(flow.processEvents()).rejects.toThrow('connection terminated unexpectedly');
      await flow.processEvents();

      expect(instagram.countOf('public_reply')).toBe(1);
      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({
          public_reply_status: 'failed',
          error_reason: 'send_outcome_unknown',
          opening_dm_status: 'waiting',
          overall_status: 'waiting',
        }),
      ]);
      expect((await flow.onlyRunOf(automation)).status).toBe('waiting');
    });

    it('a crash after everything was saved but before the event was marked repeats nothing (AC-8.24)', async () => {
      const automation = await flow.createAutomation({
        keywords: ['guide'],
        is_public_reply_enabled: true,
        public_reply_texts: ['One', 'Two'],
      });
      vi.spyOn(
        app.appDomain.instagramWebhookEventService,
        'markEventProcessed',
      ).mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
      const commentId = await flow.comment({ person: jordan, postId, text: 'guide' });

      await expect(flow.processEvents()).rejects.toThrow('connection terminated unexpectedly');
      const saved = await flow.onlyRunOf(automation);
      expect(saved.status).toBe('waiting');
      const callCount = instagram.calls.length;
      await flow.processEvents();

      expect(instagram.calls).toHaveLength(callCount);
      expect(await flow.onlyRunOf(automation)).toEqual(saved);
      expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({ status: 'processed' });
    });

    it('a send that got no answer fails its step and is never sent again (AC-8.24)', async () => {
      const automation = await flow.createFinalMessageAutomation({ keywords: ['guide'] });
      instagram.failNext({ kind: 'direct_message', failure: instagramFailure.timeout() });

      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });
      await flow.processEvents();

      expect(instagram.countOf('direct_message')).toBe(1);
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'failed',
        sending_message_kind: 'final_message',
        error_message: 'network:send_outcome_unknown',
      });
      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({
          overall_status: 'failed',
          failed_step: 'final_dm',
          error_type: 'network',
        }),
      ]);
      expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({
        status: 'processed',
        attempt_count: 1,
      });
    });

    it('a temporary failure is retried, and on the fifth try the run fails instead of staying open (AC-8.24, D16)', async () => {
      const automation = await flow.createFinalMessageAutomation({ keywords: ['guide'] });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        instagram.failNext({ kind: 'direct_message', failure: instagramFailure.serverError() });
      }
      const commentId = await flow.comment({ person: jordan, postId, text: 'guide' });

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await expect(flow.processEvents()).rejects.toThrow();
        expect((await flow.onlyRunOf(automation)).status).toBe('running');
      }
      await flow.processEvents();

      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'failed',
        error_message: 'instagram_api:2/-',
        sending_message_kind: null,
      });
      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({
          overall_status: 'failed',
          error_type: 'instagram_api',
          http_status: 500,
          error_code: 2,
        }),
      ]);
      expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({
        status: 'processed',
        attempt_count: 5,
      });
      expect(instagram.directMessages).toEqual([]);
      expect(instagram.countOf('direct_message')).toBe(5);
    });

    it('a needed message refused for good fails the run, with the error on the run and its comment log (AC-8.26)', async () => {
      const automation = await flow.createAutomation({ keywords: ['guide'] });
      instagram.failNext({
        kind: 'direct_message',
        failure: instagramFailure.outsideMessagingWindow(),
      });

      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });

      const run = await flow.onlyRunOf(automation);
      expect(run).toMatchObject({
        status: 'failed',
        error_message: 'instagram_api:10/2534022',
        sending_message_kind: null,
      });
      expect(run.failed_at).not.toBeNull();
      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({
          overall_status: 'failed',
          failed_step: 'opening_dm',
          error_type: 'instagram_api',
          http_status: 400,
          error_code: 10,
          error_subcode: 2_534_022,
          error_message: 'instagram_api:10/2534022',
          fbtrace_id: 'trace-fixture',
        }),
      ]);
      expect(await readRunEventTrail(run.id)).toEqual([
        'status_changed:running',
        'status_changed:failed',
      ]);
      // The refusal is this send's: the account stays connected and the event is processed.
      expect(await flow.connectionStatus()).toBe('connected');
      expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({ status: 'processed' });
      expect((await flow.readAutomation(automation.public_id)).completed_run_count).toBe(0);
      expect(instagram.countOf('direct_message')).toBe(1);
    });

    it('a token error marks the account broken, starts one reconnect notice and fails the run; later comments wait for nobody (AC-8.27)', async () => {
      const automation = await flow.createAutomation({ keywords: ['guide'] });
      instagram.failNext({ kind: 'direct_message', failure: instagramFailure.deadToken() });

      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });

      expect(await flow.connectionStatus()).toBe('error');
      expect(await jobsOfTeam(reconnectNoticeQueue)).toEqual([
        expect.objectContaining({
          instagramAccountPublicId: flow.account.publicId,
          connectionStatus: 'error',
        }),
      ]);
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'failed',
        error_message: 'token:190/-',
      });
      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({
          overall_status: 'failed',
          failed_step: 'opening_dm',
          error_type: 'token',
          error_code: 190,
        }),
      ]);
      expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({
        status: 'failed',
        error_message: 'instagram_api:token',
      });

      const laterId = await flow.commentAndProcess({
        person: instagram.person('later.person'),
        postId,
        text: 'guide',
      });
      expect(await flow.eventOf(`comment:${laterId}`)).toMatchObject({
        status: 'skipped',
        skip_reason: 'account_disconnected',
      });
      expect(await jobsOfTeam(reconnectNoticeQueue)).toHaveLength(1);
      expect(instagram.countOf('direct_message')).toBe(1);
    });

    it('a token error on the public reply breaks the account too and fails the run (AC-8.27)', async () => {
      const automation = await flow.createAutomation({
        keywords: ['guide'],
        is_public_reply_enabled: true,
        public_reply_texts: ['Sent!'],
      });
      instagram.failNext({ kind: 'public_reply', failure: instagramFailure.deadToken() });

      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });

      expect(await flow.connectionStatus()).toBe('error');
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'failed',
        error_message: 'token:190/-',
      });
      expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({
        status: 'failed',
        error_message: 'instagram_api:token',
      });
      expect(instagram.countOf('direct_message')).toBe(0);
    });
  });

  describe('the default texts and the plain-text fallback (AC-8.28)', () => {
    it('a message left empty uses its English default; a refused quick reply goes again as plain text', async () => {
      const automation = await flow.createFinalMessageAutomation({
        keywords: ['catalog'],
        is_email_collection_enabled: true,
        email_request_message: null,
        is_phone_collection_enabled: true,
        phone_request_message: null,
      });
      const emailQuestion = 'Please share your email to continue!';
      const phoneQuestion = 'Please share your phone number to continue!';
      instagram.failNext({ kind: 'direct_message', failure: instagramFailure.quickReplyRefused() });

      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'catalog' });

      expect(instagram.calls.filter((call) => call.kind === 'direct_message')).toEqual([
        {
          kind: 'direct_message',
          recipient: { comment_id: commentId },
          message: { text: emailQuestion, quick_replies: [{ content_type: 'user_email' }] },
          isDelivered: false,
        },
        {
          kind: 'direct_message',
          recipient: { comment_id: commentId },
          message: { text: emailQuestion },
          isDelivered: true,
        },
      ]);
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
        sending_message_kind: null,
      });

      await flow.answer({ person: jordan, text: 'wrong' });
      expect(instagram.directMessages.at(-1)?.message).toEqual({
        text: 'Please provide a valid email address. Use the button below to share your email.',
        quick_replies: [{ content_type: 'user_email' }],
      });

      instagram.failNext({ kind: 'direct_message', failure: instagramFailure.quickReplyRefused() });
      await flow.answer({ person: jordan, text: 'jordan@example.com' });
      expect(instagram.directMessages.at(-1)).toMatchObject({
        recipient: { id: jordan.instagramUserId },
        message: { text: phoneQuestion },
      });
      expect(instagram.directMessages.at(-1)?.message.quick_replies).toBeUndefined();
      expect(await flow.onlyRunOf(automation)).toMatchObject({
        status: 'waiting',
        waiting_for: 'phone',
      });
      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({ email_status: 'done', phone_status: 'waiting' }),
      ]);
    });
  });
});
