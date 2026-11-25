import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import { CONTACT_BULK_ACTIONS_PATH } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { CONTACT_BULK_ACTION_JOB_NAME } from '@/domains/app/sub-domains/contact/queues/contact-bulk-action.job.schema.js';
import { INSTAGRAM_DATABASE_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-database-tasks.queue.js';
import { processInstagramTagEventIntakeJob } from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-tag-event-intake.processor.js';
import {
  type AutomationFixtureRow,
  automationActionPath,
  insertAutomation,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { nextInstagramObjectId } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { getOperatorDatabase, operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { InstagramCommentFlow, type TestInstagramPerson } from './instagram-comment-flow.helper.js';
import { InstagramSendDriver } from './instagram-send-flow.helper.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** A hello with a "Send it" button, then one message — the shape every automation here sends. */
function helloSteps({ text, versions }: { text: string; versions?: string[] }) {
  return {
    hello: {
      on: true,
      nudge: true,
      versions: (versions ?? [`${text} hello`]).map((hello) => ({
        text: hello,
        buttons: [{ title: 'Send it', action: 'next' }],
      })),
    },
    messages: [{ kind: 'text', wait_minutes: 0, text: `${text} message` }],
  };
}

/**
 * Flow — every other way to start (feat-instagram-dm-sending ROUTE row R55, AC-20.1–AC-20.11; plan
 * §4, §9, §16 Riya examples 14, 16, 17, 21): DMs, starter-question taps, story replies, mentions,
 * ig.me refs, ads, tags and the broadcast button (P224's `broadcast_tap`), each signed to route 17
 * (or added through route 21), taken in by intake (or the tag intake) and answered through the
 * app's real sending port and send core; only Instagram is faked (nock).
 */
describe('Flow — every other way to start (e2e)', () => {
  let app: FastifyInstance;
  let flow: InstagramCommentFlow;
  let driver: InstagramSendDriver;
  let riya: TestInstagramPerson;

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
  });

  afterEach(async () => {
    driver.restore();
    nock.cleanAll();
    await metaGraphCircuit.reset();
  });

  /** A live automation of `trigger_type` that answers with `name`'s hello. */
  function automationOf(name: string, columns: Record<string, unknown>) {
    return flow.createAutomation({
      name,
      steps: helloSteps({ text: name }),
      ...columns,
    });
  }

  /** The hello texts Instagram took, in order. */
  function hellosSent(): Array<string | undefined> {
    return driver.directMessages.map(InstagramSendDriver.textOf);
  }

  /** Riya writes `text` (optionally a story reply), then intake runs and the lanes drain. */
  async function riyaWrites(text: string, extra: Record<string, unknown> = {}): Promise<void> {
    await driver.deliverMessaging({
      person: riya,
      item: { message: { mid: `m_${randomUUID()}`, text, ...extra } },
    });
    await driver.drain({ passTime: true });
  }

  /** The day passed for her once keys (`dm:<day>`, `ref:<day>`, …): her runs' keys moved a day back. */
  async function nextDay(): Promise<void> {
    await operatorQuery`
      UPDATE app.automation_runs SET once_key = once_key || ':yesterday'
      WHERE organization_id = ${flow.team.organization.id}`;
  }

  describe('the match order (AC-20.1, AC-20.2, AC-20.3, AC-20.10)', () => {
    it('a story reply to S1 is answered by the story automation of S1, not the DM keyword that also starts from story replies (AC-20.1)', async () => {
      const storyId = nextInstagramObjectId();
      await automationOf('ST1', {
        trigger_type: 'story_reply',
        target_scope: 'specific',
        target_instagram_story_id: storyId,
      });
      await automationOf('PRICE', {
        trigger_type: 'dm_keyword',
        keywords: ['price'],
        also_start_from: ['story_reply'],
      });
      await riyaWrites('PRICE', {
        reply_to: { story: { id: storyId, url: 'https://example.com/story' } },
      });
      expect(hellosSent()).toEqual(['ST1 hello']);
    });

    it('a starter-question tap is answered by its starter automation, not the DM keyword in it (AC-20.2)', async () => {
      await automationOf('PRICES', {
        trigger_type: 'starter_question',
        starter_questions: ['Prices?'],
      });
      await automationOf('PRICE', { trigger_type: 'dm_keyword', keywords: ['prices'] });
      await driver.deliverMessaging({
        person: riya,
        item: {
          postback: { mid: `m_${randomUUID()}`, title: 'Prices?', payload: 'starter:Prices?' },
        },
      });
      await driver.drain({ passTime: true });
      expect(hellosSent()).toEqual(['PRICES hello']);
    });

    it('"PRICE" twice on one day: the first runs, the second sends nothing and the search ends there; the next day it runs again (AC-20.3)', async () => {
      const price = await automationOf('PRICE', {
        trigger_type: 'dm_keyword',
        keywords: ['price'],
      });
      await automationOf('ANSWER', {
        trigger_type: 'default_reply',
        default_reply_mode: 'every_time',
      });
      await riyaWrites('PRICE');
      await driver.tapLastButton(riya);
      await driver.drain({ passTime: true });
      expect((await flow.runsOf(price))[0]).toMatchObject({ status: 'completed' });

      await riyaWrites('PRICE');
      // Held by its once key — and "no other automation answered" does not answer it either.
      expect(hellosSent()).toEqual(['PRICE hello', 'PRICE message']);
      expect(await flow.runsOf(price)).toHaveLength(1);

      await nextDay();
      await riyaWrites('PRICE');
      expect(await flow.runsOf(price)).toHaveLength(2);
      expect(hellosSent().at(-1)).toBe('PRICE hello');
    });

    it('a starter question of a paused automation is plain text at the keyword level (AC-20.10)', async () => {
      await automationOf('PRICES', {
        trigger_type: 'starter_question',
        starter_questions: ['Prices?'],
        status: 'paused',
      });
      await automationOf('PRICE', { trigger_type: 'dm_keyword', keywords: ['prices'] });
      await driver.deliverMessaging({
        person: riya,
        item: {
          postback: { mid: `m_${randomUUID()}`, title: 'Prices?', payload: 'starter:Prices?' },
        },
      });
      await driver.drain({ passTime: true });
      expect(hellosSent()).toEqual(['PRICE hello']);
    });
  });

  describe('the nudge, refs and ads (AC-20.4, AC-20.5, AC-20.6)', () => {
    it('a story reply gets the hello in the fast lane; with no tap the nudge goes 60 minutes later with the same version; a tap after it counts for that version; a tap before it cancels it (AC-20.4)', async () => {
      const story = await flow.createAutomation({
        name: 'STORY',
        trigger_type: 'story_reply',
        steps: helloSteps({ text: 'STORY', versions: ['Version A', 'Version B'] }),
      });
      await riyaWrites('love it', {
        reply_to: { story: { id: nextInstagramObjectId(), url: 'https://example.com/s' } },
      });
      const [hello] = await driver.messages();
      expect(hello).toMatchObject({
        message_type: 'opening_message',
        lane: 'fast',
        status: 'sent',
      });
      const nudge = (await driver.messages()).find((row) => row.message_type === 'nudge');
      expect(nudge, JSON.stringify(nudge)).toMatchObject({
        status: 'waiting',
        version_number: hello!.version_number,
      });
      const nudgeWait = nudge!.not_before!.getTime() - hello!.created_at.getTime();
      expect(nudgeWait).toBeGreaterThanOrEqual(59 * MINUTE);
      expect(nudgeWait).toBeLessThanOrEqual(61 * MINUTE);

      // An hour goes by with no tap: the nudge goes, the same hello once more.
      await driver.drain({ passTime: true, horizonMilliseconds: 2 * HOUR });
      expect(hellosSent()).toEqual([
        driver.directMessages[0] && InstagramSendDriver.textOf(driver.directMessages[0]),
        InstagramSendDriver.textOf(driver.directMessages[0]!),
      ]);
      await driver.tapLastButton(riya);
      await driver.drain({ passTime: true });
      const [run] = await flow.runsOf(story);
      expect(run).toMatchObject({ status: 'completed' });
      const [counts] = await operatorQuery<Array<{ taps_by_version: Record<string, number> }>>`
        SELECT taps_by_version FROM app.automation_counts WHERE automation_id = ${story.id}
          AND taps > 0`;
      expect(counts?.taps_by_version).toEqual({ [`hello.${hello!.version_number}`]: 1 });

      // Another story reply the tap answers before the nudge: the nudge is cancelled.
      const other = flow.instagram.person('sam');
      await driver.deliverMessaging({
        person: other,
        item: {
          message: {
            mid: `m_${randomUUID()}`,
            text: 'nice',
            reply_to: { story: { id: nextInstagramObjectId(), url: 'https://example.com/s' } },
          },
        },
      });
      await driver.drain({ passTime: true });
      await driver.tapLastButton(other);
      await driver.drain({ passTime: true });
      // Its hour comes: she wrote after it was made, so it is cancelled, never sent (P412).
      const sentBefore = driver.directMessages.length;
      await driver.drain({ passTime: true, horizonMilliseconds: 2 * HOUR });
      expect(driver.directMessages).toHaveLength(sentBefore);
      const samContact = await flow.contactOf(other);
      const samNudge = (await driver.messages()).find(
        (row) => row.contact_id === samContact.id && row.message_type === 'nudge',
      );
      expect(samNudge?.status).toBe('cancelled');
    });

    it('a QR ref starts its automation at once; again the same day sends nothing; the next day it runs again (AC-20.5)', async () => {
      const counter = await automationOf('COUNTER', {
        trigger_type: 'ref_link',
        ref_code: 'counter',
      });
      const scan = async () => {
        await driver.deliverMessaging({
          person: riya,
          item: { referral: { ref: 'counter', source: 'SHORTLINK', type: 'OPEN_THREAD' } },
        });
      };
      await scan();
      const [hello] = await driver.messages();
      expect(hello).toMatchObject({ lane: 'fast', status: 'waiting' });
      expect(hello!.not_before!.getTime() - hello!.created_at.getTime()).toBeLessThan(3_000);
      await driver.drain({ passTime: true });
      expect(hellosSent()).toEqual(['COUNTER hello']);
      await driver.tapLastButton(riya);
      await driver.drain({ passTime: true });
      expect((await flow.runsOf(counter))[0]).toMatchObject({ status: 'completed' });

      // Held by its once key `ref:<day>`, not by an open run.
      await scan();
      await driver.drain({ passTime: true });
      expect(await flow.runsOf(counter)).toHaveLength(1);

      await nextDay();
      await scan();
      await driver.drain({ passTime: true });
      expect(await flow.runsOf(counter)).toHaveLength(2);
    });

    it('"Send message" on an ad with its ready text: the ad automation answers despite another automation\'s keyword in the text; a second tap that week sends nothing (AC-20.6)', async () => {
      const ad = await automationOf('AD1203', { trigger_type: 'ad_message', ad_id: '1203' });
      await automationOf('AVAILABLE', { trigger_type: 'dm_keyword', keywords: ['available'] });
      const tapAd = () =>
        riyaWrites('Hi! Is this available?', {
          referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '1203' },
        });
      await tapAd();
      expect(hellosSent()).toEqual(['AD1203 hello']);
      await tapAd();
      expect(hellosSent()).toEqual(['AD1203 hello']);
      expect(await flow.runsOf(ad)).toHaveLength(1);
    });
  });

  describe('what never starts, and the quiet after the owner typed (AC-20.7, AC-20.8, AC-20.11)', () => {
    it('a reaction, an edited message, a read receipt or our own echo never starts an automation (AC-20.7)', async () => {
      await automationOf('ANY', {
        trigger_type: 'default_reply',
        default_reply_mode: 'every_time',
      });
      await automationOf('PRICE', { trigger_type: 'dm_keyword', keywords: ['price'] });
      const mid = `m_${randomUUID()}`;
      for (const item of [
        { reaction: { mid, action: 'react', reaction: 'love', emoji: '❤' } },
        { message_edit: { mid, text: 'PRICE', num_edit: 1 } },
        { read: { mid } },
      ]) {
        await driver.deliverMessaging({ person: riya, item });
      }
      await flow.deliver({
        messaging: [
          {
            sender: { id: flow.account.instagramUserId },
            recipient: { id: riya.instagramUserId },
            timestamp: Date.now(),
            message: { mid: `m_${randomUUID()}`, text: 'PRICE', is_echo: true },
          },
        ],
      });
      await flow.processEvents();
      await driver.drain({ passTime: true });
      expect(driver.calls).toEqual([]);
      expect(await flow.runs()).toEqual([]);
    });

    it('after the owner typed to Riya by hand, "no other automation answered" sends her nothing for 6 hours; other people are not affected (AC-20.8)', async () => {
      // "No other automation answered" with no hello: each run ends with its message.
      const fallback = await flow.createAutomation({
        name: 'ANSWER',
        trigger_type: 'default_reply',
        default_reply_mode: 'every_time',
        steps: { messages: [{ kind: 'text', wait_minutes: 0, text: 'We will answer soon' }] },
      });
      const sam = flow.instagram.person('sam');
      await riyaWrites('hello');
      await driver.deliverMessaging({
        person: sam,
        item: { message: { mid: `m_${randomUUID()}`, text: 'hello' } },
      });
      await driver.drain({ passTime: true });
      const runsBefore = (await flow.runsOf(fallback)).length;

      // The owner types to her by hand: an echo of a message we never sent.
      await flow.deliver({
        messaging: [
          {
            sender: { id: flow.account.instagramUserId },
            recipient: { id: riya.instagramUserId },
            timestamp: Date.now(),
            message: { mid: `m_owner_${randomUUID()}`, text: 'Hi Riya, it is me', is_echo: true },
          },
        ],
      });
      await flow.processEvents();
      await riyaWrites('thanks');
      await driver.deliverMessaging({
        person: sam,
        item: { message: { mid: `m_${randomUUID()}`, text: 'more please' } },
      });
      await driver.drain({ passTime: true });

      const riyaContact = await flow.contactOf(riya);
      const runs = (await flow.runsOf(fallback)).slice(runsBefore);
      expect(runs.some((run) => run.contact_id === riyaContact.id)).toBe(false);
      const samContact = await flow.contactOf(sam);
      expect(runs.some((run) => run.contact_id === samContact.id)).toBe(true);
    });

    it('a way to start whose Meta test has not passed — story repost, ad comments, Live comments — cannot go live, so it never starts a run (AC-20.11)', async () => {
      for (const triggerType of ['story_repost', 'ad_comment', 'live_comment'] as const) {
        const draft = await insertAutomation({
          organizationId: flow.team.organization.id,
          channelAccountId: flow.account.channelAccountId,
          name: triggerType,
          trigger_type: triggerType,
          keywords: ['link'],
          ...(triggerType === 'ad_comment' ? { ad_id: '1203' } : {}),
          steps: helloSteps({ text: triggerType }) as AutomationFixtureRow['steps'],
        });
        const response = await goLive(draft);
        expect(response.statusCode, `${triggerType}: ${response.body}`).toBe(409);
        expect((await flow.readAutomation(draft.public_id)).status).toBe('draft');
      }
      expect(await flow.runs()).toEqual([]);
    });
  });

  describe('tags and the broadcast button (AC-20.9; P224 broadcast_tap)', () => {
    it('tagging 1,200 contacts "vip" saves 1,200 tag events in pieces of 500; only the open windows get the VIP hello, the rest start nothing (window_closed) (AC-20.9)', async () => {
      const vip = await automationOf('VIP', { trigger_type: 'tag_added', trigger_tag: 'vip' });
      await insertContacts({ count: 1_200, openWindowCount: 90 });
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: CONTACT_BULK_ACTIONS_PATH,
        token: flow.team.ownerToken,
        headers: { 'x-idempotency-key': `bulk-${randomUUID()}` },
        payload: {
          channel_account_id: flow.account.publicId,
          action: 'add_tag',
          tag: 'vip',
          filter: {},
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(await runQueuedTasks(CONTACT_BULK_ACTION_JOB_NAME)).toBe(3);

      const [events] = await operatorQuery<Array<{ total: string }>>`
        SELECT count(*)::text AS total FROM app.contact_tag_events
        WHERE organization_id = ${flow.team.organization.id} AND tag = 'vip'`;
      expect(Number(events?.total)).toBe(1_200);

      await runTagIntake();
      await driver.drain({ passTime: true });
      const runs = await flow.runsOf(vip);
      expect(runs).toHaveLength(90);
      expect(driver.directMessages).toHaveLength(90);
      expect(new Set(hellosSent())).toEqual(new Set(['VIP hello']));
    });

    it("a broadcast button starts the automation it names for her and adds 1 to the broadcast's taps (P224)", async () => {
      const guide = await automationOf('GUIDE', {
        trigger_type: 'dm_keyword',
        keywords: ['guide'],
      });
      await riyaWrites('hello there');
      const [broadcast] = await getOperatorDatabase()
        .insert(broadcasts)
        .values({
          public_id: generatePublicId('broadcast'),
          organization_id: flow.team.organization.id,
          channel_account_id: flow.account.channelAccountId,
          name: 'New guide',
          status: 'sending',
          mode: 'now',
          conditions: { op: 'and', items: [] },
          messages: [{ kind: 'text', wait_minutes: 0, text: 'New guide is out' }],
          start_automation_id: guide.id,
          started_at: new Date(),
        })
        .returning();
      await driver.deliverMessaging({
        person: riya,
        item: {
          postback: {
            mid: `m_${randomUUID()}`,
            title: 'Get it',
            payload: `${broadcast!.public_id}::${generatePublicId('instagramMessage')}`,
          },
        },
      });
      await driver.drain({ passTime: true });

      const [run] = await flow.runsOf(guide);
      expect(run).toMatchObject({ trigger_type: 'dm_keyword' });
      expect(hellosSent()).toContain('GUIDE hello');
      const [numbers] = await operatorQuery<Array<{ taps: number }>>`
        SELECT taps FROM app.broadcasts WHERE id = ${broadcast!.id}`;
      expect(numbers?.taps).toBe(1);
    });
  });

  /** Inserts `count` contacts of the account, the first `openWindowCount` with her window open. */
  async function insertContacts({
    count,
    openWindowCount,
  }: {
    count: number;
    openWindowCount: number;
  }): Promise<void> {
    await operatorQuery`
      WITH made AS (
        INSERT INTO app.contacts (public_id, organization_id, channel_account_id, instagram_user_id, first_seen_at)
        SELECT 'con_' || lpad(to_hex(n), 21, '0'), ${flow.team.organization.id},
          ${flow.account.channelAccountId}, (9100000000000000 + n)::text, now()
        FROM generate_series(1, ${count}) AS n
        RETURNING id, instagram_user_id
      )
      INSERT INTO app.contact_activities (contact_id, organization_id, channel_account_id,
        last_message_received_at, last_direct_message_received_at)
      SELECT id, ${flow.team.organization.id}, ${flow.account.channelAccountId}, now(),
        CASE WHEN instagram_user_id::bigint - 9100000000000000 <= ${openWindowCount}
          THEN now() - interval '2 hours' ELSE now() - interval '3 days' END
      FROM made`;
  }

  /** Runs the queued database-heavy tasks named `jobName` of this team until none is left. */
  async function runQueuedTasks(jobName: string): Promise<number> {
    const queue = new Queue(INSTAGRAM_DATABASE_TASKS_QUEUE_NAME, {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
    });
    const handler = app.appDomain.instagramSendWork.taskHandlers[jobName];
    let ran = 0;
    try {
      for (;;) {
        const jobs = (await queue.getJobs(['waiting', 'prioritized', 'delayed'])).filter(
          (job) =>
            job.name === jobName &&
            job.data.organizationPublicId === flow.team.organization.public_id,
        );
        if (jobs.length === 0) return ran;
        for (const job of jobs) {
          await handler?.run({
            organizationPublicId: job.data.organizationPublicId,
            taskInput: handler.inputSchema.parse(job.data.taskInput),
            context: {
              jobId: String(job.id),
              runInDatabaseSlot: (callback) => callback(),
              returnTicket: async () => {
                throw new Error('not returned');
              },
            },
          });
          await job.remove();
          ran += 1;
        }
      }
    } finally {
      await queue.close();
    }
  }

  /** The tag intake (WC-27): every contact with an undone tag event, in pieces of 500. */
  async function runTagIntake(): Promise<void> {
    const rows = await operatorQuery<Array<{ public_id: string }>>`
      SELECT DISTINCT c.public_id FROM app.contact_tag_events e
      JOIN app.contacts c ON c.id = e.contact_id AND c.organization_id = e.organization_id
      WHERE e.organization_id = ${flow.team.organization.id} AND e.done_at IS NULL`;
    const publicIds = rows.map((row) => row.public_id);
    for (let start = 0; start < publicIds.length; start += 500) {
      await processInstagramTagEventIntakeJob({
        jobData: {
          organizationPublicId: flow.team.organization.public_id,
          contactPublicIds: publicIds.slice(start, start + 500),
        },
        services: { ...app.appDomain, organizationService: app.tenancyDomain.organizationService },
        jobId: `tag-intake-${start}`,
      });
    }
  }

  /** Route 32 for `automation`. */
  function goLive(automation: AutomationFixtureRow) {
    return injectAuthenticated(app, {
      method: 'POST',
      url: automationActionPath({ automationPublicId: automation.public_id, action: 'go-live' }),
      token: flow.team.ownerToken,
      headers: { 'x-idempotency-key': `go-live-${automation.public_id}-${randomUUID()}` },
    });
  }
});
