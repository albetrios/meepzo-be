import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import type { InstagramMediaGraphItem } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { AutomationRepository } from '@/domains/app/sub-domains/automation/automation.repository.js';
import type { AutomationFixtureRow } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.queue.js';
import { INSTAGRAM_WEBHOOK_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import type { InjectHttpResult } from '@/tests/helpers/test-http-inject.helper.js';
import {
  type FakeInstagram,
  type InstagramCommentFlow,
  type TestInstagramPerson,
  instagramFailure,
} from './instagram-comment-flow.helper.js';
import {
  DEFAULT_WINDOW,
  InstagramNextPostFlow,
  NEXT_POST_KEYWORD,
  countToldPeople,
  createGate,
  failNextLink,
  inWorkerProcess,
  untilASessionWaitsForALock,
} from './instagram-next-post-flow.helper.js';

/** One minute, in hours. */
const ONE_MINUTE = 1 / 60;
/** The expiry check's interval (D9), in hours. */
const _FIFTEEN_MINUTES = 15 * ONE_MINUTE;

/** What an expiry check answers when nothing is due. */
const _NOTHING_DUE = { scanned: 0, expired: 0, failedOrganizationCount: 0 };

/**
 * The "next post" flow end to end (ROUTE row R17 — AC-10.1 to AC-10.9; routes-final § 3.A AU9,
 * AU15, AU27, § 3.B AU16, § 4.A WH13): a waiting automation made through route 12, a comment on a
 * new post delivered signed over HTTP (route 17), the account's processing job (R14) that stores
 * the post, links it and has the same comment answered by the run engine (R10), and the 15-minute
 * expiry check. The database, auth, permissions, queues and every app service are real; Instagram
 * is a fake that records every call (nock stays on: no network).
 */
describe('Instagram "next post" linking flow (e2e)', () => {
  let app: FastifyInstance;
  let flow: InstagramNextPostFlow;
  let comments: InstagramCommentFlow;
  let instagram: FakeInstagram;
  let jordan: TestInstagramPerson;
  let sam: TestInstagramPerson;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    await initializeI18nextForBackgroundWork();
  });

  afterAll(async () => {
    for (const queueName of [INSTAGRAM_WEBHOOK_QUEUE_NAME, INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME]) {
      const queue = new Queue(queueName, {
        connection: getBullMQConnectionOptions(),
        prefix: getBullMQKeyPrefix(),
      });
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    flow = await InstagramNextPostFlow.open(app);
    ({ comments } = flow);
    ({ instagram } = comments);
    jordan = instagram.person('jordan.lee');
    sam = instagram.person('sam.rivera');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    nock.cleanAll();
    await metaGraphCircuit.reset();
    // Instagram takes one private reply per comment — the flow never sends a second one.
    expect(instagram.commentsAnsweredPrivatelyTwice()).toEqual([]);
  });

  /** The person comments on the post with the keyword, and the account's job runs. */
  function commentOn({
    postId,
    person = jordan,
    text = NEXT_POST_KEYWORD,
  }: {
    postId: string;
    person?: TestInstagramPerson;
    text?: string;
  }): Promise<string> {
    return comments.commentAndProcess({ person, postId, text });
  }

  /** A comment log's automation, status and reason — what each matching automation did. */
  async function answersOf(commentId: string) {
    return (await comments.logsOf(commentId)).map((log) => ({
      automationId: log.automation_id,
      status: log.overall_status,
      reason: log.ignored_reason,
    }));
  }

  /** The one answer of a comment: the automation's run completed, nothing else matched. */
  function answeredBy(automation: AutomationFixtureRow) {
    return { automationId: automation.id, status: 'completed', reason: null };
  }

  /** A match that did not answer because another automation did. */
  function leftTo(automation: AutomationFixtureRow) {
    return { automationId: automation.id, status: 'ignored', reason: 'comment_already_answered' };
  }

  /** A refused request's status and reason. */
  function refusalOf(response: InjectHttpResult): string {
    const { error } = response.json() as { error?: { reason?: string } };
    return `${response.statusCode} ${error?.reason}`;
  }

  /** How often the flow read a post from Instagram. */
  function postReads(postId: string): number {
    return instagram.calls.filter(
      (call) => call.kind === 'post_read' && call.instagramMediaId === postId,
    ).length;
  }

  /** The Instagram media ids of the connected account's stored posts. */
  async function storedPostIds(): Promise<string[]> {
    return (await comments.storedPosts()).map((post) => post.instagram_media_id);
  }

  describe('the first comment on a post published inside the window', () => {
    it('links the waiting automation, stores the post and is answered by it — in the worker process too (AC-10.1, AC-10.2, AC-10.9)', async () => {
      const anyPost = await comments.createFinalMessageAutomation({
        name: 'Every post',
        keywords: [],
      });
      const nextPost = await flow.createNextPostAutomation({ name: 'Launch day' });
      const toldBefore = await countToldPeople();
      const publishedAt = flow.hoursFromNow(-1);
      const postId = flow.publishPost(publishedAt);

      // Meta's delivery stores the comment; nothing links before it is processed.
      const commentId = await comments.comment({
        person: jordan,
        postId,
        text: 'The GUIDE please',
      });
      await flow.expectStillWaiting(nextPost);
      expect(await flow.listedNames('waiting')).toEqual(['Launch day']);

      expect(await inWorkerProcess(() => comments.processEvents())).toEqual({
        outcome: 'drained',
        processedEventCount: 1,
        skippedEventCount: 0,
        failedEventCount: 0,
      });

      // Linked: the status, the post and the time; its window stays.
      const linked = await flow.rowOf(nextPost);
      expect(linked).toMatchObject({
        status: 'live',
        target_scope: 'next',
        next_post_status: 'linked',
        target_instagram_media_id: postId,
        next_post_linked_at: linked.updated_at,
        target_starts_at: nextPost.target_starts_at,
      });
      expect(linked.updated_at.getTime()).toBeGreaterThan(nextPost.updated_at.getTime());

      // The post is stored, once.
      expect(await comments.storedPosts()).toEqual([
        expect.objectContaining({ instagram_media_id: postId, published_at: publishedAt }),
      ]);

      // The same comment is matched after the link: the just-linked one answers, not the older one.
      expect(await answersOf(commentId)).toEqual(
        expect.arrayContaining([answeredBy(nextPost), leftTo(anyPost)]),
      );
      expect(await comments.onlyRunOf(nextPost)).toMatchObject({
        status: 'completed',
        trigger_instagram_media_id: postId,
        trigger_instagram_comment_id: commentId,
      });
      expect(await comments.runsOf(anyPost)).toEqual([]);
      expect(instagram.directMessages).toEqual([
        expect.objectContaining({ recipient: { comment_id: commentId } }),
      ]);
      expect(await comments.eventOf(`comment:${commentId}`)).toMatchObject({
        status: 'processed',
        error_message: null,
      });

      // The team sees it when the page is read again; nobody is told (D11).
      expect(await flow.readAsTheTeam(nextPost)).toMatchObject({
        next_post_status: 'linked',
        target_instagram_media_id: postId,
        next_post_linked_at: linked.updated_at.toISOString(),
      });
      expect(await flow.listedNames('linked')).toEqual(['Launch day']);
      expect(await flow.listedNames('waiting')).toEqual([]);
      expect(await countToldPeople()).toBe(toldBefore);
    });

    it.each([
      { moment: 'at the start', hours: DEFAULT_WINDOW.startHours, isInside: true },
      {
        moment: 'a minute before the end',
        hours: DEFAULT_WINDOW.endHours - ONE_MINUTE,
        isInside: true,
      },
      {
        moment: 'a minute before the start',
        hours: DEFAULT_WINDOW.startHours - ONE_MINUTE,
        isInside: false,
      },
      // No end date since feat-instagram-dm-sending P12: a post after the launch's end still links.
      { moment: 'long after the old end', hours: DEFAULT_WINDOW.endHours + 1, isInside: true },
    ])(
      'a post published $moment: inside the window = $isInside (AC-10.1, AC-10.7)',
      async ({ hours, isInside }) => {
        const nextPost = await flow.createNextPostAutomation({ name: 'Launch day' });
        const postId = flow.publishPost(flow.hoursFromNow(hours));

        const commentId = await commentOn({ postId });

        if (isInside) {
          await flow.expectLinkedTo({ automation: nextPost, postId });
          expect(await answersOf(commentId)).toEqual([answeredBy(nextPost)]);
        } else {
          // Still waiting: it answers nothing — no run and no comment log.
          await flow.expectStillWaiting(nextPost);
          expect(instagram.directMessages).toEqual([]);
        }
        expect(await storedPostIds()).toEqual([postId]);
        expect(await comments.eventOf(`comment:${commentId}`)).toMatchObject({
          status: 'processed',
        });
      },
    );

    it('takes one post only — a later post of the same window is neither taken nor answered (AC-10.1)', async () => {
      const nextPost = await flow.createNextPostAutomation({ name: 'Launch day' });
      const firstPostId = flow.publishPost(flow.hoursFromNow(-1));
      const laterPostId = flow.publishPost(flow.hoursFromNow(-0.5));

      // Both comments wait for one job, which works through them in order.
      const firstCommentId = await comments.comment({
        person: jordan,
        postId: firstPostId,
        text: NEXT_POST_KEYWORD,
      });
      const laterCommentId = await comments.comment({
        person: sam,
        postId: laterPostId,
        text: NEXT_POST_KEYWORD,
      });
      expect(await comments.processEvents()).toMatchObject({ processedEventCount: 2 });

      await flow.expectLinkedTo({ automation: nextPost, postId: firstPostId });
      expect(await answersOf(firstCommentId)).toEqual([answeredBy(nextPost)]);
      expect(await answersOf(laterCommentId)).toEqual([]);
      expect(await storedPostIds()).toEqual([firstPostId, laterPostId]);
    });

    it('also links a post an earlier comment stored, without reading it from Instagram again (AC-10.1, AC-10.9)', async () => {
      const postId = flow.publishPost(flow.hoursFromNow(-1));
      await commentOn({ postId });
      expect(await storedPostIds()).toEqual([postId]);
      const nextPost = await flow.createNextPostAutomation({ name: 'Launch day' });

      const commentId = await commentOn({ postId, person: sam });

      await flow.expectLinkedTo({ automation: nextPost, postId });
      expect(await answersOf(commentId)).toEqual([answeredBy(nextPost)]);
      expect(await storedPostIds()).toEqual([postId]);
      expect(postReads(postId)).toBe(1);
    });
  });

  describe('a linked automation', () => {
    it('keeps its post: every later comment is answered, edits included, and the post stays stored once (AC-10.1, AC-10.9)', async () => {
      const nextPost = await flow.createNextPostAutomation({ name: 'Launch day' });
      const postId = flow.publishPost(flow.hoursFromNow(-1));
      await commentOn({ postId });
      const linked = await flow.rowOf(nextPost);

      // A page opened before the link is out of date; the window and the target are fixed now,
      // anything else still changes.
      const openedBefore = await flow.save({
        automation: nextPost,
        body: { name: 'Too late', expected_updated_at: nextPost.updated_at.toISOString() },
      });
      expect(refusalOf(openedBefore)).toBe('409 record_changed');
      const movedWindow = await flow.save({ automation: nextPost, body: { target_scope: 'any' } });
      expect(refusalOf(movedWindow)).toBe('409 next_post_already_linked');
      await comments.editAutomation({
        automation: nextPost,
        body: { name: 'Launch day, renamed' },
      });
      const commentId = await commentOn({ postId, person: sam });

      expect(await answersOf(commentId)).toEqual([answeredBy(nextPost)]);
      expect(await flow.rowOf(nextPost)).toMatchObject({
        name: 'Launch day, renamed',
        next_post_status: 'linked',
        target_instagram_media_id: postId,
        next_post_linked_at: linked.next_post_linked_at,
      });
      expect(await storedPostIds()).toEqual([postId]);
      expect(postReads(postId)).toBe(1);
    });

    it('a retried comment links nothing again, reads nothing again and is answered once (AC-10.1, AC-10.9)', async () => {
      const nextPost = await flow.createNextPostAutomation({ name: 'Launch day' });
      const postId = flow.publishPost(flow.hoursFromNow(-1));
      instagram.failNext({ kind: 'direct_message', failure: instagramFailure.throttled() });
      const commentId = await comments.comment({
        person: jordan,
        postId,
        text: NEXT_POST_KEYWORD,
      });

      await expect(comments.processEvents()).rejects.toThrow();
      const linked = await flow.rowOf(nextPost);
      expect(linked).toMatchObject({
        next_post_status: 'linked',
        target_instagram_media_id: postId,
      });
      expect(await comments.processEvents()).toMatchObject({ processedEventCount: 1 });

      expect(await flow.rowOf(nextPost)).toMatchObject({
        next_post_status: 'linked',
        target_instagram_media_id: postId,
        next_post_linked_at: linked.next_post_linked_at,
        updated_at: linked.updated_at,
      });
      expect(await answersOf(commentId)).toEqual([answeredBy(nextPost)]);
      expect(instagram.directMessages).toHaveLength(1);
      expect(await storedPostIds()).toEqual([postId]);
      expect(postReads(postId)).toBe(1);
    });
  });

  describe('a post that was targeted before (AC-10.3)', () => {
    it.each(['live', 'inactive'])(
      'set to it by a "specific" automation (%s) — never taken; the next new post is',
      async (status) => {
        const postId = flow.publishPost(flow.hoursFromNow(-1));
        const specific = await comments.createFinalMessageAutomation({
          name: 'Set to the post',
          status,
          keywords: [NEXT_POST_KEYWORD],
          target_scope: 'specific',
          target_instagram_media_id: postId,
        });
        const nextPost = await flow.createNextPostAutomation({ name: 'Launch day' });

        const commentId = await commentOn({ postId });

        await flow.expectStillWaiting(nextPost);
        expect(await answersOf(commentId)).toEqual(status === 'live' ? [answeredBy(specific)] : []);

        const newPostId = flow.publishPost(flow.hoursFromNow(-0.5));
        const newCommentId = await commentOn({ postId: newPostId, person: sam });
        await flow.expectLinkedTo({ automation: nextPost, postId: newPostId });
        expect(await answersOf(newCommentId)).toEqual([answeredBy(nextPost)]);
      },
    );

    it('linked by an earlier "next post" automation — never taken by a later one; the next new post is', async () => {
      const earlier = await flow.createNextPostAutomation({ name: 'First launch' });
      const postId = flow.publishPost(flow.hoursFromNow(-1));
      await commentOn({ postId });
      await flow.expectLinkedTo({ automation: earlier, postId });
      // The same keyword and window: the linked one no longer clashes.
      const later = await flow.createNextPostAutomation({ name: 'Second launch' });

      const commentId = await commentOn({ postId, person: sam });

      await flow.expectStillWaiting(later);
      expect(await answersOf(commentId)).toEqual([answeredBy(earlier)]);

      const newPostId = flow.publishPost(flow.hoursFromNow(-0.5));
      const newCommentId = await commentOn({ postId: newPostId, person: sam });
      await flow.expectLinkedTo({ automation: later, postId: newPostId });
      await flow.expectLinkedTo({ automation: earlier, postId });
      expect(await answersOf(newCommentId)).toEqual([answeredBy(later)]);
    });
  });

  describe('two waiting automations whose windows hold the post (AC-10.4, AQ4)', () => {
    it('both link to it; for a comment both match the older one answers, each answers its own keyword', async () => {
      const anyPost = await comments.createFinalMessageAutomation({
        name: 'Every post',
        keywords: [],
      });
      const older = await flow.createNextPostAutomation({
        name: 'Older, window opened later',
        window: { startHours: -1.5, endHours: 48 },
      });
      const newer = await flow.createNextPostAutomation({
        name: 'Newer, window opened earlier',
        keywords: ['price'],
      });
      const postId = flow.publishPost(flow.hoursFromNow(-1));

      const bothId = await commentOn({ postId, text: 'the guide and the price?' });

      await flow.expectLinkedTo({ automation: older, postId });
      await flow.expectLinkedTo({ automation: newer, postId });
      // One statement: the same moment for both.
      expect((await flow.rowOf(newer)).next_post_linked_at).toEqual(
        (await flow.rowOf(older)).next_post_linked_at,
      );
      const answers = await answersOf(bothId);
      expect(answers).toHaveLength(3);
      expect(answers).toEqual(
        expect.arrayContaining([answeredBy(older), leftTo(newer), leftTo(anyPost)]),
      );
      expect(await comments.runsOf(newer)).toEqual([]);

      const priceId = await commentOn({ postId, person: sam, text: 'what is the price?' });
      expect(await answersOf(priceId)).toEqual(
        expect.arrayContaining([answeredBy(newer), leftTo(anyPost)]),
      );
      expect(instagram.directMessages).toHaveLength(2);
      expect(await storedPostIds()).toEqual([postId]);
      expect(postReads(postId)).toBe(1);
    });
  });

  describe("only the post's own account's live automations (AC-10.5, AU27)", () => {
    it('an inactive draft, a paused and a deleted automation never link; a draft turned live takes a later post only', async () => {
      const live = await flow.createNextPostAutomation({ name: 'Live' });
      const draft = await flow.createNextPostAutomation({ name: 'Draft', status: 'inactive' });
      const paused = await flow.createNextPostAutomation({ name: 'Paused', keywords: ['price'] });
      await comments.editAutomation({ automation: paused, body: { status: 'inactive' } });
      const deleted = await flow.createNextPostAutomation({ name: 'Deleted', keywords: ['size'] });
      await comments.deleteAutomation(deleted);
      const postId = flow.publishPost(flow.hoursFromNow(-1));

      const commentId = await commentOn({ postId, text: 'guide, price and size' });

      await flow.expectLinkedTo({ automation: live, postId });
      expect(await answersOf(commentId)).toEqual([answeredBy(live)]);
      for (const untouched of [draft, paused, deleted]) await flow.expectStillWaiting(untouched);

      // Live now — but that post is taken.
      await comments.editAutomation({ automation: draft, body: { status: 'live' } });
      await commentOn({ postId, person: sam });
      await flow.expectStillWaiting(draft);
      const newPostId = flow.publishPost(flow.hoursFromNow(-0.5));
      await commentOn({ postId: newPostId, person: sam });
      await flow.expectLinkedTo({ automation: draft, postId: newPostId });
    });

    it("another account's automations never link — the organization's former account, another organization's account", async () => {
      const formerAccount = await flow.createNextPostAutomation({ name: 'Former account' });
      await comments.disconnectAccount();
      await comments.connectAccount();
      const connectedAccount = await flow.createNextPostAutomation({ name: 'Connected account' });
      const otherTeam = await InstagramNextPostFlow.open(app);
      const otherTeamAutomation = await otherTeam.createNextPostAutomation({ name: 'Other team' });
      const postId = flow.publishPost(flow.hoursFromNow(-1));

      const commentId = await commentOn({ postId });

      await flow.expectLinkedTo({ automation: connectedAccount, postId });
      expect(await answersOf(commentId)).toEqual([answeredBy(connectedAccount)]);
      for (const untouched of [formerAccount, otherTeamAutomation]) {
        await flow.expectStillWaiting(untouched);
      }

      // The other team's own post links its own automation, and only that.
      const otherPostId = otherTeam.publishPost(otherTeam.hoursFromNow(-1));
      await otherTeam.comments.commentAndProcess({
        person: otherTeam.comments.instagram.person('alex.kim'),
        postId: otherPostId,
        text: NEXT_POST_KEYWORD,
      });
      await otherTeam.expectLinkedTo({ automation: otherTeamAutomation, postId: otherPostId });
      await flow.expectLinkedTo({ automation: connectedAccount, postId });
      await flow.expectStillWaiting(formerAccount);
    });
  });

  describe('a post read or a link that fails (AC-10.6, D18)', () => {
    /** Makes the next read of a commented post fail, or answer `item`. */
    function nextPostRead(outcome: { failure: unknown } | { item: InstagramMediaGraphItem }): void {
      vi.spyOn(instagram.processingClient, 'readInstagramMediaItem').mockImplementationOnce(
        async () => {
          if ('failure' in outcome) throw outcome.failure;
          return outcome.item;
        },
      );
    }

    it.each([
      { failure: 'Instagram is busy', outcome: { failure: instagramFailure.throttled() } },
      { failure: 'Instagram is down', outcome: { failure: instagramFailure.serverError() } },
      { failure: 'no answer comes back', outcome: { failure: instagramFailure.timeout() } },
      {
        failure: 'the answer has no publish time',
        outcome: { item: { id: '18000000000000001', media_type: 'IMAGE' } },
      },
    ])(
      'the post read fails ($failure): nothing links, the comment is answered, the next comment links',
      async ({ outcome }) => {
        const nextPost = await flow.createNextPostAutomation({ name: 'Launch day' });
        const anyPost = await comments.createFinalMessageAutomation({
          name: 'Every post',
          keywords: [],
        });
        const postId = flow.publishPost(flow.hoursFromNow(-1));
        nextPostRead(outcome);

        const commentId = await commentOn({ postId });

        await flow.expectStillWaiting(nextPost);
        expect(await answersOf(commentId)).toEqual([answeredBy(anyPost)]);
        expect(await comments.eventOf(`comment:${commentId}`)).toMatchObject({
          status: 'processed',
          attempt_count: 1,
          error_message: null,
        });
        expect(await storedPostIds()).toEqual([]);

        const nextCommentId = await commentOn({ postId, person: sam });
        await flow.expectLinkedTo({ automation: nextPost, postId });
        expect(await answersOf(nextCommentId)).toEqual(
          expect.arrayContaining([answeredBy(nextPost), leftTo(anyPost)]),
        );
        expect(await storedPostIds()).toEqual([postId]);
      },
    );

    it.each(['refused_by_the_database', 'after_the_rows_changed'] as const)(
      'the link fails (%s): undone alone — the post is kept, the comment answered, the next comment links',
      async (failure) => {
        const nextPost = await flow.createNextPostAutomation({ name: 'Launch day' });
        const anyPost = await comments.createFinalMessageAutomation({
          name: 'Every post',
          keywords: [],
        });
        const postId = flow.publishPost(flow.hoursFromNow(-1));
        const warnings = vi.spyOn(logger, 'warn');
        failNextLink(failure);

        const commentId = await commentOn({ postId });

        await flow.expectStillWaiting(nextPost);
        expect(await storedPostIds()).toEqual([postId]);
        expect(await answersOf(commentId)).toEqual([answeredBy(anyPost)]);
        expect(await comments.eventOf(`comment:${commentId}`)).toMatchObject({
          status: 'processed',
          attempt_count: 1,
          error_message: null,
        });
        expect(warnings).toHaveBeenCalledWith(
          expect.objectContaining({ eventKey: `comment:${commentId}` }),
          'app.instagram_webhook.next_post_link_failed',
        );

        const nextCommentId = await commentOn({ postId, person: sam });
        await flow.expectLinkedTo({ automation: nextPost, postId });
        expect(await answersOf(nextCommentId)).toEqual(
          expect.arrayContaining([answeredBy(nextPost), leftTo(anyPost)]),
        );
        expect(postReads(postId)).toBe(1);
      },
    );

    it('a token Instagram refuses on the post read breaks the account and fails the event — the one exception (D44)', async () => {
      const nextPost = await flow.createNextPostAutomation({ name: 'Launch day' });
      await comments.createFinalMessageAutomation({ name: 'Every post', keywords: [] });
      const postId = flow.publishPost(flow.hoursFromNow(-1));
      nextPostRead({ failure: instagramFailure.deadToken() });

      const commentId = await commentOn({ postId });

      expect(await comments.eventOf(`comment:${commentId}`)).toMatchObject({
        status: 'failed',
        error_message: 'instagram_api:190',
      });
      expect(await comments.connectionStatus()).toBe('error');
      await flow.expectStillWaiting(nextPost);
      expect(await comments.runs()).toEqual([]);
      expect(await answersOf(commentId)).toEqual([]);
    });
  });

  describe('an automation that waits or expired (AC-10.7)', () => {
    it('waiting: a comment on an older post goes to the "any post" automation and leaves it no log', async () => {
      const nextPost = await flow.createNextPostAutomation({ name: 'Launch day', keywords: [] });
      const anyPost = await comments.createFinalMessageAutomation({
        name: 'Every post',
        keywords: [],
      });
      const postId = flow.publishPost(flow.hoursFromNow(DEFAULT_WINDOW.startHours - 1));

      const commentId = await commentOn({ postId, text: 'anything at all' });

      expect(await answersOf(commentId)).toEqual([answeredBy(anyPost)]);
      await flow.expectStillWaiting(nextPost);
    });
  });

  describe('a link and a save take turns inside one organization (D26)', () => {
    /** Starts a save and works through the waiting comment while the save is not committed yet. */
    async function processWhileSaving(save: Parameters<InstagramNextPostFlow['save']>[0]) {
      const isSaved = createGate();
      const mayCommit = createGate();
      const update = AutomationRepository.prototype.update;
      vi.spyOn(AutomationRepository.prototype, 'update').mockImplementationOnce(
        async function holdSave(this: AutomationRepository, input) {
          const row = await update.call(this, input);
          isSaved.open();
          await mayCommit.opened;
          return row;
        },
      );
      const saved = flow.save(save);
      await isSaved.opened;
      const processed = comments.processEvents();
      await untilASessionWaitsForALock().finally(mayCommit.open);
      expect((await saved).statusCode).toBe(200);
      expect(await processed).toMatchObject({ processedEventCount: 1 });
    }

    it('a save that sets another automation to the post first: the link waits for it and leaves the post (AC-10.3)', async () => {
      const nextPost = await flow.createNextPostAutomation({ name: 'Launch day' });
      const other = await comments.createFinalMessageAutomation({ name: 'Other', keywords: [] });
      const postId = flow.publishPost(flow.hoursFromNow(-1));
      const commentId = await comments.comment({ person: jordan, postId, text: NEXT_POST_KEYWORD });

      await processWhileSaving({
        automation: other,
        body: { target_scope: 'specific', target_instagram_media_id: postId },
      });

      expect(await answersOf(commentId)).toEqual([answeredBy(other)]);
      await flow.expectStillWaiting(nextPost);
    });

    it('the link first: the save waits for it and finds the automation linked', async () => {
      const nextPost = await flow.createNextPostAutomation({ name: 'Launch day' });
      const postId = flow.publishPost(flow.hoursFromNow(-1));
      const isLinked = createGate();
      const mayCommit = createGate();
      const linkNextPost = AutomationRepository.prototype.linkNextPost;
      vi.spyOn(AutomationRepository.prototype, 'linkNextPost').mockImplementationOnce(
        async function holdLink(this: AutomationRepository, input) {
          const linkedPublicIds = await linkNextPost.call(this, input);
          isLinked.open();
          await mayCommit.opened;
          return linkedPublicIds;
        },
      );

      const commented = commentOn({ postId });
      await isLinked.opened;
      const saved = flow.save({ automation: nextPost, body: { target_scope: 'any' } });
      await untilASessionWaitsForALock().finally(mayCommit.open);

      expect(refusalOf(await saved)).toBe('409 next_post_already_linked');
      expect(await answersOf(await commented)).toEqual([answeredBy(nextPost)]);
      expect(await flow.rowOf(nextPost)).toMatchObject({
        target_instagram_media_id: postId,
        target_starts_at: nextPost.target_starts_at,
      });
    });

    it('two posts at the same moment: one automation takes exactly one of them', async () => {
      const nextPost = await flow.createNextPostAutomation({ name: 'Launch day' });
      const publishedAt = flow.hoursFromNow(-1);
      const postIds = [flow.publishPost(publishedAt), flow.publishPost(publishedAt)];

      // One job per account works one comment at a time, so the race is made on the link itself.
      const links = await Promise.all(
        postIds.map((postId) =>
          app.appDomain.automationService.linkNextPostAutomations({
            scope: PRINCIPAL_SCOPE.JOB({
              organizationPublicId: comments.team.organization.public_id,
            }),
            channelAccountPublicId: comments.account.publicId,
            instagramMediaId: postId,
            publishedAt,
          }),
        ),
      );

      const winners = postIds.filter((_, index) => links[index]?.includes(nextPost.public_id));
      expect(winners).toHaveLength(1);
      await flow.expectLinkedTo({ automation: nextPost, postId: winners[0] as string });
    });
  });
});
