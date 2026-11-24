import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { INSTAGRAM_WEBHOOK_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { nextInstagramObjectId } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  InstagramMessageFlow,
  PERSON,
  directMessageAutomation,
  refusedSend,
  storyReplyAutomation,
  throttledSend,
} from './instagram-message-flow.helper.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * A DM, a story reply and a button click, end to end (launch ROUTE R16, AC-9.1–AC-9.14): the
 * account connected, its settings and automations saved over the real routes, Meta's events
 * delivered signed to route 17, the account's processing job run through the real processor, run
 * engine and contact service — with a fake Instagram client that records every call — and the
 * contact, the run, its history, the automation's counters and the event's status read back from
 * the database. No comment log is ever written here: those belong to comment runs (§ 3.B).
 */

const OTHER_PERSON = '17841400000000888';
const THIRD_PERSON = '17841400000000999';

/** A run's history from the start to its final DM with nothing to wait for. */
const STRAIGHT_THROUGH_TRAIL = ['status_changed:running', 'status_changed:completed'];

describe('Instagram message flow — DMs, story replies and button clicks (e2e)', () => {
  let app: FastifyInstance;
  let flow: InstagramMessageFlow;
  /** The queue route 17 adds the processing jobs to — emptied at the end, never worked here. */
  let processingQueue: Queue;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    processingQueue = new Queue(INSTAGRAM_WEBHOOK_QUEUE_NAME, {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
    });
  });

  afterAll(async () => {
    await processingQueue.obliterate({ force: true });
    await processingQueue.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    flow = await InstagramMessageFlow.start(app);
  });

  afterEach(async () => {
    expect(await flow.commentLogCount()).toBe(0);
    vi.restoreAllMocks();
    nock.cleanAll();
    await metaGraphCircuit.reset();
  });

  describe('a whole conversation', () => {
    it('keyword, opening button, follow, email and phone to the final message — one run, its whole history (AC-9.1, AC-9.3, AC-9.4, AC-9.7, AC-9.8, AC-9.11)', async () => {
      const automation = await flow.createAutomation(
        directMessageAutomation({
          name: 'Spring catalog',
          tags: ['spring'],
          is_opening_message_enabled: true,
          opening_message: { text: 'Welcome!', button_title: 'Get it' },
          is_follow_required: true,
          follow_request_message: {
            text: 'Follow us first',
            following_button_title: "I'm following",
            profile_button_title: 'Profile',
          },
          is_email_collection_enabled: true,
          email_request_message: { text: 'Your email?' },
          is_phone_collection_enabled: true,
          phone_request_message: { text: 'Your phone?' },
        }),
      );

      // The keyword: the contact first (with its profile), then the opening message as a normal DM.
      const [opening] = await flow.receive(flow.directMessage({ text: 'CATALOG please' }));
      expect(opening).toMatchObject({
        recipient: { id: PERSON },
        text: 'Welcome!',
        buttonTitles: ['Get it'],
      });
      expect(await flow.contact()).toMatchObject({
        username: 'jordan.lee',
        full_name: 'Jordan Lee',
        followers_count: 42,
        email: null,
        is_following_account: null,
      });
      const run = await flow.runOf(automation);
      expect(run).toMatchObject({
        contact_id: (await flow.contact()).id,
        trigger_type: 'dm',
        trigger_text: 'CATALOG please',
        status: 'waiting',
        waiting_for: 'opening_message_button',
      });
      expect(opening?.postbackPayloads).toEqual([`${automation}::${run.public_id}`]);

      // The opening button: not following yet — the follow request, with the profile link.
      flow.instagram.followAnswers.push(false);
      const [followRequest] = await flow.receive(
        flow.buttonClick({ payload: opening?.postbackPayloads[0] }),
      );
      expect(followRequest).toMatchObject({
        text: 'Follow us first',
        buttonTitles: ["I'm following", 'Profile'],
        linkUrls: [expect.stringContaining('https://www.instagram.com/')],
      });
      expect(await flow.runOf(automation)).toMatchObject({ waiting_for: 'follow' });

      // "I'm following" while Instagram says no: asked again.
      flow.instagram.followAnswers.push(false);
      const [askedAgain] = await flow.receive(
        flow.buttonClick({ payload: followRequest?.postbackPayloads[0] }),
      );
      expect(askedAgain?.text).toBe('Follow us first');
      expect(await flow.runOf(automation)).toMatchObject({ waiting_for: 'follow' });
      expect((await flow.contact()).is_following_account).toBe(false);

      // Following now: the email question with Instagram's email quick reply.
      flow.instagram.followAnswers.push(true);
      const [emailQuestion] = await flow.receive(
        flow.buttonClick({ payload: askedAgain?.postbackPayloads[0] }),
      );
      expect(emailQuestion).toMatchObject({ text: 'Your email?', quickReplyTypes: ['user_email'] });
      expect((await flow.contact()).is_following_account).toBe(true);

      // A wrong email is answered with the default wrong-email text; the run keeps waiting.
      const [wrongEmail] = await flow.receive(flow.directMessage({ text: 'later' }));
      expect(wrongEmail).toMatchObject({
        text: 'Please provide a valid email address. Use the button below to share your email.',
        quickReplyTypes: ['user_email'],
      });
      expect(await flow.runOf(automation)).toMatchObject({ waiting_for: 'email' });

      const [phoneQuestion] = await flow.receive(
        flow.directMessage({ text: 'Share email', quickReplyPayload: 'Jordan@Example.com' }),
      );
      expect(phoneQuestion).toMatchObject({
        text: 'Your phone?',
        quickReplyTypes: ['user_phone_number'],
      });

      // Not a phone number: nothing is sent, the run keeps waiting.
      expect(await flow.receive(flow.directMessage({ text: '12' }))).toEqual([]);
      expect(await flow.runOf(automation)).toMatchObject({ waiting_for: 'phone' });

      const [finalMessage] = await flow.receive(
        flow.directMessage({ text: 'Share phone', quickReplyPayload: '+1 (415) 555-0100' }),
      );
      expect(finalMessage).toMatchObject({
        text: 'Here is the catalog',
        buttonTitles: ['Open'],
        linkUrls: ['https://shop.example.com/catalog'],
      });

      const completed = await flow.runOf(automation);
      expect(completed).toMatchObject({
        id: run.id,
        status: 'completed',
        current_step: 'final_dm',
        error_message: null,
        sending_message_kind: null,
      });
      expect(await flow.trailOf(completed)).toEqual([
        'status_changed:running',
        'status_changed:waiting', // the opening button
        'status_changed:running',
        'status_changed:waiting', // the follow request
        'status_changed:running',
        'status_changed:waiting', // the follow request again
        'status_changed:running',
        'status_changed:waiting', // the email question
        'status_changed:running',
        'email_received:-',
        'status_changed:waiting', // the phone question
        'status_changed:running',
        'phone_received:-',
        'status_changed:completed',
      ]);
      const contact = await flow.contact();
      expect(contact).toMatchObject({
        email: 'jordan@example.com',
        phone: '+14155550100',
        tags: ['spring'],
      });
      expect(contact.last_message_sent_at).toBeInstanceOf(Date);
      expect(contact.last_direct_message_received_at).toBeInstanceOf(Date);
      expect(await flow.automation(automation)).toMatchObject({
        last_triggered_at: expect.any(Date),
      });
      const events = await flow.events();
      expect(events.map((event) => event.event_kind)).toEqual([
        'message',
        'postback',
        'postback',
        'postback',
        'message',
        'message',
        'message',
        'message',
      ]);
      expect(events.every((event) => event.status === 'processed')).toBe(true);
      expect(await flow.connectionStatus()).toBe('connected');
      // The profile is read once, for the new contact; every send goes to the person.
      expect(flow.instagram.calls.filter((call) => call.name === 'read_profile')).toHaveLength(1);
      expect(flow.instagram.calls.every((call) => call.target === PERSON)).toBe(true);
    });
  });

  describe('a keyword DM and the automation that answers it', () => {
    it('only the oldest live automation with the DM keyword trigger on and the keyword answers, whatever its trigger (AC-9.1, AC-9.2)', async () => {
      const commentAutomation = {
        status: 'live',
        trigger_type: 'comment',
        opening_message: { text: 'Hello from the comment automation', button_title: 'Get it' },
        final_message: { text: 'Here it is' },
      };
      const older = {
        withoutKeywords: await flow.createAutomation({
          ...commentAutomation,
          name: 'No keywords',
          keywords: [],
        }),
        storyWithoutKeywords: await flow.createAutomation(
          storyReplyAutomation({ is_dm_keyword_trigger_enabled: true }),
        ),
        triggerOff: await flow.createAutomation({
          ...commentAutomation,
          name: 'DM trigger off',
          keywords: ['catalog'],
          is_dm_keyword_trigger_enabled: false,
        }),
        inactive: await flow.createAutomation(directMessageAutomation({ status: 'inactive' })),
        otherKeyword: await flow.createAutomation(directMessageAutomation({ keywords: ['price'] })),
        deleted: await flow.createAutomation(directMessageAutomation()),
      };
      await flow.deleteAutomation(older.deleted);
      const chosen = await flow.createAutomation({
        ...commentAutomation,
        name: 'Oldest match',
        keywords: ['brochure', 'catalog'],
      });
      const younger = await flow.createAutomation(directMessageAutomation());

      const sent = await flow.receive(flow.directMessage({ text: 'Is the CATALOG out?' }));

      expect(sent).toEqual([
        expect.objectContaining({
          recipient: { id: PERSON },
          text: 'Hello from the comment automation',
        }),
      ]);
      const runs = await flow.runs();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        automation_id: (await flow.automation(chosen)).id,
        trigger_type: 'dm',
        trigger_instagram_comment_id: null,
        waiting_for: 'opening_message_button',
      });
      expect((await flow.automation(chosen)).last_triggered_at).toBeInstanceOf(Date);
      for (const untouched of [...Object.values(older), younger]) {
        expect(await flow.automation(untouched)).toMatchObject({
          last_triggered_at: null,
        });
      }
    });

    it('an automation with no keywords never answers a DM — the contact is still recorded (AC-9.2)', async () => {
      await flow.createAutomation({
        name: 'Every comment',
        status: 'live',
        trigger_type: 'comment',
        keywords: [],
        is_dm_keyword_trigger_enabled: true,
        opening_message: { text: 'Hi', button_title: 'Get it' },
        final_message: { text: 'Here it is' },
      });
      await flow.createAutomation(storyReplyAutomation({ is_dm_keyword_trigger_enabled: true }));

      expect(await flow.receive(flow.directMessage({ text: 'hello there' }))).toEqual([]);

      expect(await flow.runs()).toEqual([]);
      expect(await flow.contact()).toMatchObject({ username: 'jordan.lee', tags: [] });
      expect(flow.instagram.calls.map((call) => call.name)).toEqual(['read_profile']);
    });

    it('a messages change is a DM: it starts a run, and it answers a waiting one (AC-9.5)', async () => {
      const automation = await flow.createAutomation(
        directMessageAutomation({ is_email_collection_enabled: true }),
      );

      const [question] = await flow.receive(flow.messagesChange({ text: 'catalog' }));
      expect(question).toMatchObject({
        recipient: { id: PERSON },
        quickReplyTypes: ['user_email'],
      });
      expect(await flow.runOf(automation)).toMatchObject({
        trigger_type: 'dm',
        trigger_text: 'catalog',
        waiting_for: 'email',
      });

      await flow.receive(flow.messagesChange({ text: 'jordan@example.com' }));

      expect((await flow.runOf(automation)).status).toBe('completed');
      expect((await flow.contact()).email).toBe('jordan@example.com');
      expect((await flow.events()).map((event) => event.event_kind)).toEqual([
        'message',
        'message',
      ]);
    });

    it('a DM starts no second run while one is open or after a completed or failed one; a cancelled one allows it (AC-9.12)', async () => {
      const automation = await flow.createAutomation(
        directMessageAutomation({
          is_opening_message_enabled: true,
          opening_message: { text: 'Welcome!', button_title: 'Get it' },
        }),
      );
      const failing = await flow.createAutomation(directMessageAutomation({ keywords: ['price'] }));
      const younger = await flow.createAutomation(
        directMessageAutomation({ keywords: ['catalog', 'price'] }),
      );

      // Cancelled (seven days without a click): the next DM starts a new run.
      await flow.receive(flow.directMessage({ text: 'catalog' }));
      expect(await flow.cancelExpiredWaits()).toBe(1);
      await flow.ageLastSentMessage();
      const [opening] = await flow.receive(flow.directMessage({ text: 'catalog' }));
      expect((await flow.runsOf(automation)).map((run) => run.status)).toEqual([
        'cancelled',
        'waiting',
      ]);

      // Open: nothing new, and the younger match is not tried instead.
      expect(await flow.receive(flow.directMessage({ text: 'catalog' }))).toEqual([]);
      // Completed.
      await flow.receive(flow.buttonClick({ payload: opening?.postbackPayloads[0] }));
      expect(await flow.receive(flow.directMessage({ text: 'catalog' }))).toEqual([]);
      expect((await flow.runsOf(automation)).map((run) => run.status)).toEqual([
        'cancelled',
        'completed',
      ]);

      // Failed.
      flow.instagram.sendFailures.push(refusedSend());
      await flow.receive(flow.directMessage({ text: 'price' }));
      expect(await flow.receive(flow.directMessage({ text: 'price' }))).toEqual([]);
      expect((await flow.runsOf(failing)).map((run) => run.status)).toEqual(['failed']);

      expect(await flow.runsOf(younger)).toEqual([]);
    });
  });

  describe('a DM that answers a waiting question', () => {
    it('is taken by the email wait first, then the phone wait, and starts no run — even with a keyword in it (AC-9.3)', async () => {
      const keywordAutomation = await flow.createAutomation(
        directMessageAutomation({ name: 'Example keyword', keywords: ['example', '555'] }),
      );
      const phoneAutomation = await flow.createAutomation(
        directMessageAutomation({ keywords: ['call'], is_phone_collection_enabled: true }),
      );
      const emailAutomation = await flow.createAutomation(
        storyReplyAutomation({ is_email_collection_enabled: true }),
      );
      // The phone wait is the older one; the email wait goes first all the same.
      await flow.receive(flow.directMessage({ text: 'call me' }));
      await flow.receive(flow.storyReply({ storyId: nextInstagramObjectId(), text: 'love it' }));
      expect(await flow.runOf(phoneAutomation)).toMatchObject({ waiting_for: 'phone' });
      expect(await flow.runOf(emailAutomation)).toMatchObject({ waiting_for: 'email' });

      // A keyword DM is read as the (wrong) email: asked again, no run.
      const [askedAgain] = await flow.receive(flow.directMessage({ text: 'an example' }));
      expect(askedAgain?.quickReplyTypes).toEqual(['user_email']);

      await flow.receive(flow.directMessage({ text: 'jordan@example.com' }));
      expect((await flow.runOf(emailAutomation)).status).toBe('completed');
      expect(await flow.runOf(phoneAutomation)).toMatchObject({ waiting_for: 'phone' });

      await flow.receive(flow.directMessage({ text: '+1 415 555 0100' }));
      expect((await flow.runOf(phoneAutomation)).status).toBe('completed');
      expect(await flow.contact()).toMatchObject({
        email: 'jordan@example.com',
        phone: '+14155550100',
      });
      expect(await flow.trailOf(await flow.runOf(emailAutomation))).toContain('email_received:-');
      expect(await flow.trailOf(await flow.runOf(phoneAutomation))).toContain('phone_received:-');
      expect(await flow.runsOf(keywordAutomation)).toEqual([]);

      // Nothing waits any more: the same words start the keyword's automation now.
      await flow.receive(flow.directMessage({ text: 'an example' }));
      expect(await flow.trailOf(await flow.runOf(keywordAutomation))).toEqual(
        STRAIGHT_THROUGH_TRAIL,
      );
    });

    it.each([
      [
        'the email quick reply, before the typed text',
        { text: 'Share my email', quickReplyPayload: 'Jordan@Example.com' },
      ],
      ['an attachment without text', { attachmentEmail: 'JORDAN@example.com' }],
      [
        'an attachment, before the typed text',
        { text: 'here', attachmentEmail: 'jordan@example.com' },
      ],
      ['the typed text', { text: '  Jordan@Example.com ' }],
    ])('reads the email from %s (AC-9.4)', async (_source, answer) => {
      const automation = await flow.createAutomation(
        directMessageAutomation({ is_email_collection_enabled: true }),
      );
      await flow.receive(flow.directMessage({ text: 'catalog' }));

      const [finalMessage] = await flow.receive(flow.directMessage(answer));

      expect(finalMessage?.text).toBe('Here is the catalog');
      const contact = await flow.contact();
      expect(contact.email).toBe('jordan@example.com');
      expect(contact.email_collected_at).toBeInstanceOf(Date);
      const run = await flow.runOf(automation);
      expect(run.status).toBe('completed');
      expect(await flow.trailOf(run)).toEqual([
        'status_changed:running',
        'status_changed:waiting',
        'status_changed:running',
        'email_received:-',
        'status_changed:completed',
      ]);
    });
  });

  describe('a story reply', () => {
    it('starts the oldest matching story automation — this story or any, no keywords matching every reply (AC-9.6)', async () => {
      const story = nextInstagramObjectId();
      const otherStory = nextInstagramObjectId();
      const notStoryAutomations = [
        await flow.createAutomation({
          name: 'Every comment',
          status: 'live',
          trigger_type: 'comment',
          keywords: [],
          opening_message: { text: 'Hi', button_title: 'Get it' },
          final_message: { text: 'Here it is' },
        }),
        await flow.createAutomation(directMessageAutomation({ keywords: ['price'] })),
        await flow.createAutomation(storyReplyAutomation({ status: 'inactive' })),
      ];
      const thisStory = await flow.createAutomation(
        storyReplyAutomation({
          name: 'This story',
          target_scope: 'specific',
          target_instagram_story_id: story,
          keywords: ['price'],
          final_message: { text: 'This story answers' },
        }),
      );
      const _anyStory = await flow.createAutomation(
        storyReplyAutomation({ name: 'Any story', final_message: { text: 'Any story answers' } }),
      );
      const youngerAnyStory = await flow.createAutomation(
        storyReplyAutomation({ name: 'Younger', keywords: ['price'] }),
      );

      const [keywordOnThisStory] = await flow.receive(
        flow.storyReply({ storyId: story, text: 'What is the PRICE?' }),
      );
      const [otherTextOnThisStory] = await flow.receive(
        flow.storyReply({ storyId: story, text: 'Love it', from: OTHER_PERSON }),
      );
      const [keywordOnOtherStory] = await flow.receive(
        flow.storyReply({ storyId: otherStory, text: 'price?', from: THIRD_PERSON }),
      );

      expect(keywordOnThisStory).toMatchObject({
        recipient: { id: PERSON },
        text: 'This story answers',
      });
      expect(otherTextOnThisStory).toMatchObject({
        recipient: { id: OTHER_PERSON },
        text: 'Any story answers',
      });
      expect(keywordOnOtherStory).toMatchObject({
        recipient: { id: THIRD_PERSON },
        text: 'Any story answers',
      });
      const run = await flow.runOf(thisStory);
      expect(run).toMatchObject({
        trigger_type: 'story_reply',
        trigger_instagram_story_id: story,
        trigger_text: 'What is the PRICE?',
        status: 'completed',
      });
      expect(await flow.trailOf(run)).toEqual(STRAIGHT_THROUGH_TRAIL);
      expect((await flow.contact(OTHER_PERSON)).tags).toEqual(['Any story']);
      for (const silent of [...notStoryAutomations, youngerAnyStory]) {
        expect(await flow.runsOf(silent)).toEqual([]);
      }
      expect((await flow.events()).map((event) => event.event_kind)).toEqual([
        'story_reply',
        'story_reply',
        'story_reply',
      ]);
    });

    it('once its story has expired, an automation set to it simply stops matching (AC-9.6)', async () => {
      const expiredStory = nextInstagramObjectId();
      const automation = await flow.createAutomation(
        storyReplyAutomation({
          target_scope: 'specific',
          target_instagram_story_id: expiredStory,
        }),
      );
      await flow.receive(flow.storyReply({ storyId: expiredStory, text: 'in time' }));

      // The story is gone; the replies that arrive are to the account's next stories.
      expect(
        await flow.receive(
          flow.storyReply({ storyId: nextInstagramObjectId(), text: 'late', from: OTHER_PERSON }),
        ),
      ).toEqual([]);

      const runs = await flow.runsOf(automation);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ trigger_text: 'in time', status: 'completed' });
      expect((await flow.automation(automation)).status).toBe('live');
      expect((await flow.contact(OTHER_PERSON)).username).toBe('jordan.lee');
    });

    it('starts no second run while one is open or after a completed or failed one (AC-9.12)', async () => {
      const [openStory, failedStory] = [nextInstagramObjectId(), nextInstagramObjectId()];
      const automation = await flow.createAutomation(
        storyReplyAutomation({
          target_scope: 'specific',
          target_instagram_story_id: openStory,
          is_opening_message_enabled: true,
          opening_message: { text: 'Welcome!', button_title: 'Get it' },
        }),
      );
      const failing = await flow.createAutomation(
        storyReplyAutomation({ target_scope: 'specific', target_instagram_story_id: failedStory }),
      );
      const reply = (storyId: string) =>
        flow.receive(flow.storyReply({ storyId, text: 'love it' }));

      const [opening] = await reply(openStory);
      expect(await reply(openStory)).toEqual([]);
      await flow.receive(flow.buttonClick({ payload: opening?.postbackPayloads[0] }));
      expect((await flow.runOf(automation)).status).toBe('completed');
      expect(await reply(openStory)).toEqual([]);

      flow.instagram.sendFailures.push(refusedSend());
      await reply(failedStory);
      expect((await flow.runOf(failing)).status).toBe('failed');
      expect(await reply(failedStory)).toEqual([]);

      expect(await flow.runs()).toHaveLength(2);
    });

    it('behind a run waiting for the email: saved on it once, the question asked again, started when the email arrives (AC-9.13)', async () => {
      const emailAutomation = await flow.createAutomation(
        directMessageAutomation({ is_email_collection_enabled: true }),
      );
      const storyAutomation = await flow.createAutomation(
        storyReplyAutomation({ is_email_collection_enabled: true }),
      );
      const [question] = await flow.receive(flow.directMessage({ text: 'catalog' }));
      const story = nextInstagramObjectId();

      const firstReply = await flow.receive(flow.storyReply({ storyId: story, text: 'love it' }));
      const secondReply = await flow.receive(flow.storyReply({ storyId: story, text: 'again' }));

      // The same email question, as a normal DM, once per reply.
      expect(firstReply).toEqual([question]);
      expect(secondReply).toEqual([question]);
      const waiting = await flow.runOf(emailAutomation);
      expect(waiting).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
        sending_message_kind: null,
        queued_automations: [
          {
            automation_id: storyAutomation,
            queued_at: expect.any(String),
            trigger: { type: 'story_reply', instagram_story_id: story, text: 'love it' },
          },
        ],
      });
      expect(await flow.runsOf(storyAutomation)).toEqual([]);

      const answered = await flow.receive(flow.directMessage({ text: 'jordan@example.com' }));

      expect(answered.map((message) => message.text)).toEqual([
        'Here is the catalog',
        'Thanks for your story reply',
      ]);
      expect(await flow.runOf(emailAutomation)).toMatchObject({
        status: 'completed',
        queued_automations: [],
      });
      // The story's run starts as the reply would have started it, its email step skipped.
      const storyRun = await flow.runOf(storyAutomation);
      expect(storyRun).toMatchObject({
        trigger_type: 'story_reply',
        trigger_instagram_story_id: story,
        trigger_text: 'love it',
        status: 'completed',
      });
      expect(await flow.trailOf(storyRun)).toEqual(STRAIGHT_THROUGH_TRAIL);
    });
  });

  // The launch's opening message without a button (AC-9.7) has no counterpart since P2 — a hello
  // always carries its "sends your next step" button; the rebuilt engine (ROUTE row R14) proves
  // the hello's lanes.

  describe('a button click', () => {
    /** A DM automation whose flow waits for its opening button, and the payload it sent. */
    async function startWaitingForOpeningButton(
      overrides: Record<string, unknown> = {},
    ): Promise<{ automation: string; payload: string | undefined }> {
      const automation = await flow.createAutomation(
        directMessageAutomation({
          is_opening_message_enabled: true,
          opening_message: { text: 'Welcome!', button_title: 'Get it' },
          ...overrides,
        }),
      );
      const [opening] = await flow.receive(flow.directMessage({ text: 'catalog' }));
      return { automation, payload: opening?.postbackPayloads[0] };
    }

    it("continues a story reply's run waiting for its opening button (AC-9.8)", async () => {
      const automation = await flow.createAutomation(
        storyReplyAutomation({
          is_opening_message_enabled: true,
          opening_message: { text: 'Welcome!', button_title: 'Get it' },
        }),
      );
      const [opening] = await flow.receive(
        flow.storyReply({ storyId: nextInstagramObjectId(), text: 'love it' }),
      );
      expect(await flow.runOf(automation)).toMatchObject({ waiting_for: 'opening_message_button' });

      const [finalMessage] = await flow.receive(
        flow.buttonClick({ payload: opening?.postbackPayloads[0] }),
      );

      expect(finalMessage?.text).toBe('Thanks for your story reply');
      expect((await flow.runOf(automation)).status).toBe('completed');
    });

    it('on a completed run is ignored and sends nothing (AC-9.9)', async () => {
      const { automation, payload } = await startWaitingForOpeningButton();
      await flow.receive(flow.buttonClick({ payload }));
      const completed = await flow.runOf(automation);
      expect(completed.status).toBe('completed');

      expect(await flow.receive(flow.buttonClick({ payload }))).toEqual([]);

      expect(await flow.runOf(automation)).toEqual(completed);
    });

    it('on a failed run is ignored and sends nothing (AC-9.9)', async () => {
      const { automation, payload } = await startWaitingForOpeningButton();
      flow.instagram.sendFailures.push(refusedSend());
      await flow.receive(flow.buttonClick({ payload }));
      const failed = await flow.runOf(automation);
      expect(failed.status).toBe('failed');

      expect(await flow.receive(flow.buttonClick({ payload }))).toEqual([]);

      expect(await flow.runOf(automation)).toEqual(failed);
    });

    it('on a run cancelled after seven days is ignored and sends nothing (AC-9.9)', async () => {
      const { automation, payload } = await startWaitingForOpeningButton();
      expect(await flow.cancelExpiredWaits()).toBe(1);
      const cancelled = await flow.runOf(automation);
      expect(cancelled).toMatchObject({ status: 'cancelled', cancel_reason: 'wait_expired' });

      expect(await flow.receive(flow.buttonClick({ payload }))).toEqual([]);

      expect(await flow.runOf(automation)).toEqual(cancelled);
    });

    it('on a run of a deleted automation is ignored and sends nothing (AC-9.9)', async () => {
      const { automation, payload } = await startWaitingForOpeningButton();
      await flow.deleteAutomation(automation);
      const cancelled = await flow.runOf(automation);
      expect(cancelled).toMatchObject({ status: 'cancelled', cancel_reason: 'automation_deleted' });

      expect(await flow.receive(flow.buttonClick({ payload }))).toEqual([]);

      expect(await flow.runOf(automation)).toEqual(cancelled);
    });

    it("on another account's run — the team's old account, or another team's — is ignored and sends nothing (AC-9.9)", async () => {
      const { automation, payload } = await startWaitingForOpeningButton();
      const waiting = await flow.runOf(automation);
      const otherTeam = await InstagramMessageFlow.start(app);

      expect(await otherTeam.receive(otherTeam.buttonClick({ payload }))).toEqual([]);
      expect(await otherTeam.runs()).toEqual([]);

      await flow.disconnect();
      await flow.connect();
      expect(await flow.receive(flow.buttonClick({ payload }))).toEqual([]);

      // The old account's run is left waiting (IQ1); the new account only got a contact.
      expect(await flow.runs()).toEqual([waiting]);
      expect((await flow.contact()).id).not.toBe(waiting.contact_id);
    });

    it('with a payload this engine never sent, or naming another automation, moves nothing (AC-9.9)', async () => {
      const { automation, payload } = await startWaitingForOpeningButton();
      const other = await flow.createAutomation(directMessageAutomation({ keywords: ['price'] }));
      const waiting = await flow.runOf(automation);

      expect(await flow.receive(flow.buttonClick({ payload: 'ice-breaker' }))).toEqual([]);
      expect(
        await flow.receive(flow.buttonClick({ payload: `${other}::${waiting.public_id}` })),
      ).toEqual([]);
      // The same button clicked by somebody else.
      expect(await flow.receive(flow.buttonClick({ payload, from: OTHER_PERSON }))).toEqual([]);

      expect(await flow.runs()).toEqual([waiting]);
    });

    it('while another run of the contact waits for an email: the question again, the clicked run unmoved until the email is in (AC-9.10)', async () => {
      const { automation, payload } = await startWaitingForOpeningButton({
        is_email_collection_enabled: true,
      });
      const emailAutomation = await flow.createAutomation(
        storyReplyAutomation({ is_email_collection_enabled: true }),
      );
      const [question] = await flow.receive(
        flow.storyReply({ storyId: nextInstagramObjectId(), text: 'love it' }),
      );
      expect(question?.quickReplyTypes).toEqual(['user_email']);
      const clicked = await flow.runOf(automation);

      expect(await flow.receive(flow.buttonClick({ payload }))).toEqual([question]);

      expect(await flow.runOf(automation)).toEqual(clicked);
      expect(await flow.runOf(emailAutomation)).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
        sending_message_kind: null,
        queued_automations: [],
      });

      // The email in: that run goes first; the button then moves the clicked run, its email known.
      await flow.receive(flow.directMessage({ text: 'jordan@example.com' }));
      expect((await flow.runOf(emailAutomation)).status).toBe('completed');
      expect(await flow.runOf(automation)).toEqual(clicked);
      const [finalMessage] = await flow.receive(flow.buttonClick({ payload }));
      expect(finalMessage?.text).toBe('Here is the catalog');
      expect((await flow.runOf(automation)).status).toBe('completed');
    });

    it('is the only thing that confirms a follow — a typed message never does (AC-9.11)', async () => {
      const automation = await flow.createAutomation(
        directMessageAutomation({
          is_follow_required: true,
          follow_request_message: {
            text: 'Follow us first',
            following_button_title: "I'm following",
            profile_button_title: 'Profile',
          },
        }),
      );
      flow.instagram.followAnswers.push(false);
      const [followRequest] = await flow.receive(flow.directMessage({ text: 'catalog' }));
      const waiting = await flow.runOf(automation);
      expect(waiting).toMatchObject({ status: 'waiting', waiting_for: 'follow' });

      flow.instagram.followAnswers.push(true);
      for (const text of ["I'm following", 'catalog', 'done!']) {
        expect(await flow.receive(flow.directMessage({ text }))).toEqual([]);
      }
      expect(await flow.runOf(automation)).toEqual(waiting);
      expect(flow.instagram.calls.filter((call) => call.name === 'read_follow')).toHaveLength(1);
      expect((await flow.contact()).is_following_account).toBe(false);

      const [finalMessage] = await flow.receive(
        flow.buttonClick({ payload: followRequest?.postbackPayloads[0] }),
      );
      expect(finalMessage?.text).toBe('Here is the catalog');
      expect((await flow.runOf(automation)).status).toBe('completed');
      expect((await flow.contact()).is_following_account).toBe(true);
    });
  });

  describe('a run that fails', () => {
    it.each(['dm', 'story_reply'] as const)(
      "keeps a %s run's error when the rest of the event's handling is undone, and is never sent again (AC-9.14)",
      async (triggerType) => {
        const automation = await flow.createAutomation(
          triggerType === 'dm' ? directMessageAutomation() : storyReplyAutomation(),
        );
        flow.instagram.sendFailures.push(refusedSend());
        // The database goes away right after the run failed: the event is not marked.
        vi.spyOn(
          app.appDomain.instagramWebhookEventService,
          'markEventProcessed',
        ).mockRejectedValueOnce(new Error('connection lost'));
        await flow.deliver(
          triggerType === 'dm'
            ? flow.directMessage({ text: 'catalog' })
            : flow.storyReply({ storyId: nextInstagramObjectId(), text: 'love it' }),
        );

        await expect(flow.runJob()).rejects.toThrow('connection lost');

        const failed = await flow.runOf(automation);
        expect(failed).toMatchObject({
          trigger_type: triggerType,
          status: 'failed',
          error_message: 'instagram_api:10/2534022',
          sending_message_kind: null,
        });
        expect(failed.failed_at).toBeInstanceOf(Date);
        expect(await flow.trailOf(failed)).toEqual([
          'status_changed:running',
          'status_changed:failed',
        ]);
        expect(await flow.latestEvent()).toMatchObject({ status: 'queued', attempt_count: 1 });

        // The retry finds the run failed: nothing is sent, the error stays, the event ends.
        expect(await flow.runJob()).toMatchObject({ processedEventCount: 1 });
        expect(await flow.runOf(automation)).toEqual(failed);
        expect(await flow.latestEvent()).toMatchObject({ status: 'processed', attempt_count: 2 });
        expect(flow.instagram.calls.filter((call) => call.name === 'send_message')).toHaveLength(1);
        expect(flow.instagram.sentMessages).toEqual([]);
        expect(await flow.connectionStatus()).toBe('connected');
      },
    );

    it.each(['button click', 'story reply', 'wrong email'] as const)(
      'asks the email question again on the retry when Instagram throttled it — after a %s (AC-9.10, AC-9.13, D16)',
      async (askedBy) => {
        const story = nextInstagramObjectId();
        const openingAutomation = await flow.createAutomation(
          directMessageAutomation({
            is_opening_message_enabled: true,
            opening_message: { text: 'Welcome!', button_title: 'Get it' },
          }),
        );
        const queuedAutomation = await flow.createAutomation(
          storyReplyAutomation({ target_scope: 'specific', target_instagram_story_id: story }),
        );
        const emailAutomation = await flow.createAutomation(
          storyReplyAutomation({ is_email_collection_enabled: true }),
        );
        const [opening] = await flow.receive(flow.directMessage({ text: 'catalog' }));
        await flow.receive(flow.storyReply({ storyId: nextInstagramObjectId(), text: 'love it' }));
        const clicked = await flow.runOf(openingAutomation);
        const delivered = {
          'button click': () => flow.buttonClick({ payload: opening?.postbackPayloads[0] }),
          'story reply': () => flow.storyReply({ storyId: story, text: 'me too' }),
          'wrong email': () => flow.directMessage({ text: 'not an email' }),
        }[askedBy]();

        flow.instagram.sendFailures.push(throttledSend());
        await flow.deliver(delivered);
        await expect(flow.runJob()).rejects.toThrow();
        expect(await flow.latestEvent()).toMatchObject({ status: 'queued', attempt_count: 1 });
        expect(await flow.runOf(emailAutomation)).toMatchObject({
          status: 'waiting',
          waiting_for: 'email',
          sending_message_kind: null,
        });

        const sentBefore = flow.instagram.sentMessages.length;
        expect(await flow.runJob()).toMatchObject({ processedEventCount: 1 });

        expect(flow.instagram.sentMessages.slice(sentBefore)).toEqual([
          expect.objectContaining({
            recipient: { id: PERSON },
            quickReplyTypes: ['user_email'],
          }),
        ]);
        expect(await flow.latestEvent()).toMatchObject({ status: 'processed', attempt_count: 2 });
        const waiting = await flow.runOf(emailAutomation);
        expect(waiting).toMatchObject({
          status: 'waiting',
          waiting_for: 'email',
          sending_message_kind: null,
        });
        // Saved once, however often the event was handled; the clicked run never moved.
        expect(waiting.queued_automations).toHaveLength(askedBy === 'story reply' ? 1 : 0);
        expect(await flow.runsOf(queuedAutomation)).toEqual([]);
        expect(await flow.runOf(openingAutomation)).toEqual(clicked);
      },
    );

    it('keeps its error when another run of the same event is retried (AC-9.14)', async () => {
      const emailAutomation = await flow.createAutomation(
        directMessageAutomation({ is_email_collection_enabled: true }),
      );
      const queuedAutomation = await flow.createAutomation(storyReplyAutomation());
      await flow.receive(flow.directMessage({ text: 'catalog' }));
      await flow.receive(flow.storyReply({ storyId: nextInstagramObjectId(), text: 'love it' }));

      // The email in: the answered run's final DM is refused, the queued run's one throttled.
      flow.instagram.sendFailures.push(refusedSend(), throttledSend());
      await flow.deliver(flow.directMessage({ text: 'jordan@example.com' }));
      await expect(flow.runJob()).rejects.toThrow();

      const failed = await flow.runOf(emailAutomation);
      expect(failed).toMatchObject({
        status: 'failed',
        error_message: 'instagram_api:10/2534022',
      });
      expect(await flow.runOf(queuedAutomation)).toMatchObject({
        status: 'running',
        sending_message_kind: null,
      });
      expect(await flow.latestEvent()).toMatchObject({ status: 'queued', attempt_count: 1 });

      const sentBefore = flow.instagram.sentMessages.length;
      expect(await flow.runJob()).toMatchObject({ processedEventCount: 1 });

      // Only the throttled run goes on; the email was kept; the failed run keeps its error.
      expect(flow.instagram.sentMessages.slice(sentBefore).map((sent) => sent.text)).toEqual([
        'Thanks for your story reply',
      ]);
      expect(await flow.runOf(emailAutomation)).toEqual(failed);
      expect((await flow.runOf(queuedAutomation)).status).toBe('completed');
      expect((await flow.contact()).email).toBe('jordan@example.com');
    });
  });
});
