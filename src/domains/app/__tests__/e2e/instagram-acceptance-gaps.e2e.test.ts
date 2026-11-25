import {
  CHANNEL_ACCOUNTS_PATH,
  organizationChannelAccountPath,
} from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
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
import {
  META_GRAPH_VERSION,
  META_GRAPH_BASE_URL,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  channelConnectCallbackPath,
  channelConnectStartPath,
  connectInstagramAccountsThroughRoutes,
  mockMetaLogin,
  nextClientBusinessId,
  readStateFromLoginUrl,
} from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import { env, getEnv } from '@/shared/config/env.config.js';
import { MILLISECONDS_PER_HOUR } from '@/shared/constants/ttl.constants.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import { INSTAGRAM_WEBHOOK_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { processChannelConnectionTokenCheckJob } from '@/domains/app/sub-domains/channel-connection/workers/channel-connection-token-check.processor.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import {
  AUTOMATIONS_PATH,
  type AutomationFixtureRow,
  automationActionPath,
  automationPath,
  commentAutomationBody,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { nextInstagramObjectId } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { readAccountContactRows } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  TEST_INSTAGRAM_LONG_LIVED_TOKEN,
  buildInstagramProfile,
  createInstagramTeam,
  endPaidPlanWithoutPaying,
  readInstagramAccountRows,
  readInstagramTokenCiphertexts,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  countStoredEvents,
  deauthorizeOnInstagram,
  deliverButtonClick,
  deliverHandSentEcho,
  disconnectOverRoute,
  readAutomationState,
  reconnectSameAccount,
  runOfPerson,
} from './instagram-acceptance-gaps.helper.js';
import {
  type FakeInstagram,
  InstagramCommentFlow,
  type TestInstagramPerson,
} from './instagram-comment-flow.helper.js';
import { captureLogLines } from './instagram-retention-erasure.helper.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The acceptance rules that cross two features, end to end (launch acceptance AC-2.15, AC-2.24,
 * AC-5.20, AC-5.24, AC-7.19): a disconnect and a reconnect around a waiting run, a read-only plan
 * and an inactive automation around open and new runs, a DM the team sends by hand around the
 * 24-hour opening-message rule, and the log lines of everything that handles the Instagram token.
 * The database, auth, permissions, queues and every app service are real; the run engine's
 * Instagram is the recording fake of the comment flow, the rest of Instagram is nocked.
 */
describe('Instagram acceptance across features (e2e)', () => {
  let app: FastifyInstance;
  let flow: InstagramCommentFlow;
  let instagram: FakeInstagram;
  let jordan: TestInstagramPerson;
  let casey: TestInstagramPerson;
  let postId: string;
  /** The queue route 17 adds the processing jobs to — emptied at the end, never worked here. */
  let processingQueue: Queue;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    await initializeI18nextForBackgroundWork();
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
    flow = await InstagramCommentFlow.open(app);
    // The email ask is PRO (D35): the run engine reads the plan's switch at run time (AU26, R14).
    await useCreatorPlan(flow.team.organization.id);
    instagram = flow.instagram;
    jordan = instagram.person('jordan.lee');
    casey = instagram.person('casey.doe');
    postId = nextInstagramObjectId();
  });

  afterEach(async () => {
    nock.cleanAll();
    await metaGraphCircuit.reset();
    // Instagram takes one private reply per comment — the flow never sends a second one.
    expect(instagram.commentsAnsweredPrivatelyTwice()).toEqual([]);
  });

  /** A live automation that sends its opening button, then asks for the email. */
  const emailAutomation = {
    name: 'Guide',
    keywords: ['guide'],
    is_email_collection_enabled: true,
    email_request_message: { text: 'Your email?' },
  };

  /** A person's run waits for its opening button, another's for the email it asked for. */
  async function leaveTwoRunsWaiting(): Promise<AutomationFixtureRow> {
    const automation = await flow.createAutomation(emailAutomation);
    await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });
    await flow.commentAndProcess({ person: casey, postId, text: 'guide' });
    await flow.clickLastButton(casey);
    expect(await runOfPerson({ flow, automation, person: jordan })).toMatchObject({
      status: 'waiting',
      waiting_for: 'opening_message_button',
    });
    expect(await runOfPerson({ flow, automation, person: casey })).toMatchObject({
      status: 'waiting',
      waiting_for: 'email',
    });
    return automation;
  }

  /**
   * Both waiting runs go on to their final message: a click and an answer, then an answer. Once the
   * plan lost its PRO switches (`isEmailAskOff`, D57, AU26) the email ask is skipped: the click goes
   * straight on, and a run waiting for her email moves on at her next message.
   */
  async function finishBothRuns(
    automation: AutomationFixtureRow,
    { isEmailAskOff = false }: { isEmailAskOff?: boolean } = {},
  ): Promise<void> {
    const waiting = await runOfPerson({ flow, automation, person: jordan });
    await deliverButtonClick({ flow, automation, run: waiting, person: jordan });
    await flow.processEvents();
    if (!isEmailAskOff) {
      expect(await runOfPerson({ flow, automation, person: jordan })).toMatchObject({
        id: waiting.id,
        status: 'waiting',
        waiting_for: 'email',
      });
      await flow.answer({ person: jordan, text: 'jordan@example.com' });
    }
    await flow.answer({ person: casey, text: 'casey@example.com' });

    for (const person of [jordan, casey]) {
      expect(await runOfPerson({ flow, automation, person })).toMatchObject({
        status: 'completed',
        waiting_for: null,
        cancel_reason: null,
        error_message: null,
      });
      expect(instagram.directMessages.at(person === casey ? -1 : -2)).toMatchObject({
        recipient: { id: person.instagramUserId },
      });
    }
  }

  /** Gives the team Creator's features — every PRO switch on (P83). */
  async function useCreatorPlan(organizationId: number): Promise<void> {
    const plan = await createTestPlan({
      features: CREATOR_PLAN_FEATURES,
      priceMonthly: '29.00',
      priceYearly: '276.00',
    });
    await createTestSubscription({ organizationId, planId: plan.id, status: 'ACTIVE' });
  }

  function errorOf(response: InjectHttpResult): { reason?: string } {
    return (response.json() as { error: { reason?: string } }).error;
  }

  describe('a disconnect and a reconnect (AC-2.15, D24)', () => {
    it.each([
      { way: 'a disconnect (route 4)', disconnect: disconnectOverRoute },
      { way: "Meta's deauthorize (route 7)", disconnect: deauthorizeOnInstagram },
    ])(
      '$way cancels no run and leaves every automation live; the waiting runs go on once the same account is back',
      async ({ disconnect }) => {
        const automation = await leaveTwoRunsWaiting();
        const draft = await flow.createAutomation({ name: 'Draft', status: 'inactive' });
        const before = await readAutomationState(flow);
        const accountPublicId = flow.account.publicId;

        await disconnect({ app, flow });

        expect(await flow.connectionStatus()).toBe('revoked');
        expect(await readInstagramTokenCiphertexts(flow.team.organization.id)).toEqual([]);
        expect(await readAutomationState(flow)).toEqual(before);
        expect((await flow.readAutomation(automation.public_id)).status).toBe('live');
        expect((await flow.readAutomation(draft.public_id)).status).toBe('paused');

        // Nothing runs while no account is connected: the click reaches nobody.
        const storedEvents = await countStoredEvents(flow);
        const sentBefore = instagram.calls.length;
        await deliverButtonClick({
          flow,
          automation,
          run: await runOfPerson({ flow, automation, person: jordan }),
          person: jordan,
        });
        await flow.processEvents();
        expect(await countStoredEvents(flow)).toBe(storedEvents);
        expect(instagram.calls).toHaveLength(sentBefore);
        expect(await readAutomationState(flow)).toEqual(before);

        const reconnected = await reconnectSameAccount({ app, flow });

        expect(reconnected).toMatchObject({
          is_new_connection: false,
          instagram_account: { id: accountPublicId, connection_status: 'connected' },
        });
        expect(await readAutomationState(flow)).toEqual(before);

        // Each waiting run's next event — a click, an answer — goes on with that very run.
        await finishBothRuns(automation);
        // And the automations are live again for new people.
        const morgan = instagram.person('morgan.kim');
        await flow.commentAndProcess({ person: morgan, postId, text: 'guide' });
        expect(await runOfPerson({ flow, automation, person: morgan })).toMatchObject({
          status: 'waiting',
          waiting_for: 'opening_message_button',
        });
      },
    );
  });

  describe('a read-only plan (AC-5.20, AQ8, D27)', () => {
    const enforced = env.ORGANIZATION_READ_ONLY_ENFORCED_EXCEPT_BILLING;

    afterEach(() => {
      env.ORGANIZATION_READ_ONLY_ENFORCED_EXCEPT_BILLING = enforced;
    });

    it('refuses go-live while live automations run on: waiting runs finish and a new comment starts one', async () => {
      const automation = await leaveTwoRunsWaiting();
      // The team's Creator plan ends unpaid too (the suite gives every team Creator — R14).
      await operatorQuery`
        UPDATE billing.subscriptions SET status = 'CANCELED',
          current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 day'
        WHERE organization_id = ${flow.team.organization.id}`;
      await endPaidPlanWithoutPaying(flow.team.organization.id);
      env.ORGANIZATION_READ_ONLY_ENFORCED_EXCEPT_BILLING = true;

      // feat-instagram-dm-sending P10 (AU4 (1)): only go-live is refused; a draft may still be saved.
      const asOwner = { token: flow.team.ownerToken };
      const draft = await injectAuthenticated(app, {
        ...asOwner,
        method: 'POST',
        url: AUTOMATIONS_PATH,
        payload: commentAutomationBody({ channelAccountPublicId: flow.account.publicId }),
        headers: { 'x-idempotency-key': `acceptance-gaps-${randomUUID()}` },
      });
      expect(draft.statusCode).toBe(200);
      const refused = await injectAuthenticated(app, {
        ...asOwner,
        method: 'POST',
        url: automationActionPath({
          automationPublicId: (draft.json() as { data: { id: string } }).data.id,
          action: 'go-live',
        }),
      });
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).reason).toBe('organization_read_only');
      const read = await injectAuthenticated(app, {
        ...asOwner,
        url: automationPath(automation.public_id),
      });
      expect(read.statusCode).toBe(200);

      // The plan ended: its PRO email ask is skipped at run time (D57, AU26).
      await finishBothRuns(automation, { isEmailAskOff: true });

      const morgan = instagram.person('morgan.kim');
      const commentId = await flow.commentAndProcess({
        person: morgan,
        postId,
        text: 'the guide please',
      });
      expect(await flow.eventOf(`comment:${commentId}`)).toMatchObject({
        status: 'processed',
        skip_reason: null,
        error_message: null,
      });
      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({ automation_id: automation.id, opening_dm_status: 'sent' }),
      ]);
      expect(await runOfPerson({ flow, automation, person: morgan })).toMatchObject({
        status: 'waiting',
        waiting_for: 'opening_message_button',
      });
      expect(instagram.directMessages.at(-1)?.recipient).toEqual({ comment_id: commentId });
      await flow.clickLastButton(morgan);
      await flow.answer({ person: morgan, text: 'morgan@example.com' });
      expect(await runOfPerson({ flow, automation, person: morgan })).toMatchObject({
        status: 'completed',
      });
      expect(await flow.readAutomation(automation.public_id)).toMatchObject({
        name: automation.name,
        status: 'live',
        deleted_at: null,
      });
    });
  });

  describe('an automation turned inactive (AC-5.24, AU14)', () => {
    it('starts no new run and lets its open runs finish', async () => {
      const automation = await leaveTwoRunsWaiting();
      const before = await readAutomationState(flow);

      await flow.editAutomation({ automation, body: { status: 'inactive' } });

      // The edit itself moves no run.
      const inactive = await flow.readAutomation(automation.public_id);
      expect(inactive.status).toBe('paused');
      const after = await readAutomationState(flow);
      expect({ ...after, automations: [] }).toEqual({ ...before, automations: [] });

      // No new run: not on a comment, not on a DM — and none for a person with an open run.
      const morgan = instagram.person('morgan.kim');
      const sentBefore = instagram.directMessages.length;
      const commentId = await flow.commentAndProcess({ person: morgan, postId, text: 'guide' });
      const eventKey = await flow.answer({ person: morgan, text: 'guide' });
      const secondComment = await flow.commentAndProcess({
        person: jordan,
        postId,
        text: 'guide again',
      });
      for (const key of [`comment:${commentId}`, eventKey, `comment:${secondComment}`]) {
        expect(await flow.eventOf(key)).toMatchObject({ status: 'processed' });
      }
      expect(await flow.logsOf(commentId)).toEqual([]);
      expect(await flow.logsOf(secondComment)).toEqual([]);
      expect(instagram.directMessages).toHaveLength(sentBefore);
      expect((await flow.runsOf(automation)).map((run) => run.id)).toEqual(
        before.runs.map((run) => run.id),
      );
      expect((await flow.readAutomation(automation.public_id)).last_triggered_at).toEqual(
        inactive.last_triggered_at,
      );

      // The open runs finish, each to its final message.
      await finishBothRuns(automation);
      expect((await flow.readAutomation(automation.public_id)).status).toBe('paused');

      // Live again (its email ask is PRO — the team's Creator plan, P83), the very comment that
      // started nothing starts a run.
      await flow.editAutomation({ automation, body: { status: 'live' } });
      await flow.commentAndProcess({ person: morgan, postId, text: 'guide' });
      expect(await runOfPerson({ flow, automation, person: morgan })).toMatchObject({
        status: 'waiting',
      });
    });
  });

  describe('a DM the team sends by hand (AC-7.19, WQ4, D28)', () => {
    const handSentText = 'Hi, this is the shop writing by hand';

    /** Our own last DM to Jordan went `hoursAgo` hours ago; the contact as it is then. */
    async function ownDirectMessageSentHoursAgo(hoursAgo: number) {
      await flow.createFinalMessageAutomation({ name: 'Gift', keywords: ['gift'] });
      await flow.commentAndProcess({ person: jordan, postId, text: 'gift' });
      await flow.updateContact({
        person: jordan,
        values: { last_message_sent_at: new Date(Date.now() - hoursAgo * MILLISECONDS_PER_HOUR) },
      });
      return flow.contactOf(jordan);
    }

    /**
     * The echo comes in, is saved `received` (feat-instagram-dm-sending R17, WHC5 — the owner's
     * quiet time), and the job marks it processed with nothing done until intake per kind (R38).
     */
    async function receiveEcho(person: TestInstagramPerson): Promise<void> {
      const sentBefore = instagram.calls.length;
      const eventKey = await deliverHandSentEcho({ flow, person, text: handSentText });
      expect(await flow.processEvents()).toEqual({
        outcome: 'drained',
        processedEventCount: 1,
        skippedEventCount: 0,
        failedEventCount: 0,
      });
      expect(await flow.eventOf(eventKey)).toMatchObject({
        event_kind: 'echo',
        status: 'processed',
        skip_reason: null,
        contact_instagram_user_id: person.instagramUserId,
        attempt_count: 1,
        error_message: null,
      });
      expect(instagram.calls).toHaveLength(sentBefore);
    }

    it('25 hours after our last DM: the echo moves nothing, so a comment gets the opening message', async () => {
      const contact = await ownDirectMessageSentHoursAgo(25);
      const guide = await flow.createAutomation({ name: 'Guide', keywords: ['guide'] });
      const before = await readAutomationState(flow);

      await receiveEcho(jordan);

      // The whole contact — `last_message_sent_at` with it — and every run are as they were.
      expect(await flow.contactOf(jordan)).toEqual(contact);
      expect(await readAutomationState(flow)).toEqual(before);

      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });
      expect(await flow.logsOf(commentId)).toEqual([
        expect.objectContaining({ automation_id: guide.id, opening_dm_status: 'sent' }),
      ]);
      expect(await runOfPerson({ flow, automation: guide, person: jordan })).toMatchObject({
        status: 'waiting',
        waiting_for: 'opening_message_button',
      });
      // Sent as if the team had never written: the private reply to that comment.
      expect(instagram.directMessages.at(-1)?.recipient).toEqual({ comment_id: commentId });
    });

    it('2 hours after our last DM: the echo moves nothing; the hello is still saved for the slow lane, which owns the 24-hour person rule (R43)', async () => {
      const contact = await ownDirectMessageSentHoursAgo(2);
      const guide = await flow.createAutomation({ name: 'Guide', keywords: ['guide'] });

      await receiveEcho(jordan);

      expect(await flow.contactOf(jordan)).toEqual(contact);
      const commentId = await flow.commentAndProcess({ person: jordan, postId, text: 'guide' });
      // Since R14 the engine never sends and never skips a hello itself: "one opening DM per person
      // per 24 hours" is the channel's slow lane (sub-domain 6, WC-5 — ROUTE row R43, AC-17.4), re-proved there.
      expect(instagram.waitingMessages.at(-1)).toMatchObject({
        step: 'hello',
        answersEventId: commentId,
      });
      expect(await runOfPerson({ flow, automation: guide, person: jordan })).toMatchObject({
        status: 'waiting',
        waiting_for: 'opening_message_button',
      });
    });

    it('to a person who never wrote: it makes no contact, and starts no run even with a keyword in it', async () => {
      await flow.createAutomation({ name: 'Any keyword', keywords: ['shop'] });

      await receiveEcho(casey);

      expect(
        await readAccountContactRows({
          organizationId: flow.team.organization.id,
          instagramAccountId: flow.account.id,
        }),
      ).toEqual([]);
      expect(await flow.runs()).toEqual([]);
    });
  });

  describe('no log line holds the token, the app secret or the code (AC-2.24, AC-1.18)', () => {
    /** Meta's error answer, quoting what it was sent — as an error text may. */
    function errorAnswerQuoting({ quoted, code }: { quoted: string; code: number }) {
      return {
        error: { message: `Cannot parse ${quoted}`, type: 'OAuthException', code },
        error_type: 'OAuthException',
        error_message: `Cannot use ${quoted}`,
      };
    }

    /** The code exchange answering the system-user token, as every callback starts. */
    function mockCodeExchange(): void {
      nock(META_GRAPH_BASE_URL)
        .get(`/${META_GRAPH_VERSION}/oauth/access_token`)
        .query(true)
        .reply(200, { access_token: TEST_INSTAGRAM_LONG_LIVED_TOKEN, token_type: 'bearer' });
    }

    /** The app secret the Meta calls and Meta's signatures use. */
    function appSecret(): string {
      const secret = getEnv().META_APP_SECRET;
      if (!secret) throw new Error('the test harness sets no Meta app secret');
      return secret;
    }

    /** Runs `act` with every log line captured, and expects none of them to hold a secret. */
    async function expectNoSecretLogged({
      code,
      act,
      expectedMessages,
    }: {
      code: string;
      act: () => Promise<void>;
      /** Log messages that must be among the lines — the capture saw the work. */
      expectedMessages: string[];
    }): Promise<void> {
      const captured = captureLogLines(app);
      try {
        await act();
      } finally {
        captured.restore();
      }
      const written = captured.lines.join('\n');
      for (const message of expectedMessages) expect(written).toContain(message);
      for (const secret of [TEST_INSTAGRAM_LONG_LIVED_TOKEN, appSecret(), code]) {
        expect(written).not.toContain(secret);
        expect(written).not.toContain(encodeURIComponent(secret));
        expect(written).not.toContain(Buffer.from(secret).toString('base64'));
      }
    }

    /** Finishes a channel connection (route 2) with `code`, after route 1 minted the state. */
    async function callback({
      code,
      token,
      payload,
    }: {
      code: string;
      token: string;
      payload?: (state: string) => unknown;
    }): Promise<InjectHttpResult> {
      const start = await injectAuthenticated(app, {
        method: 'POST',
        url: channelConnectStartPath(),
        token,
      });
      const state = readStateFromLoginUrl(
        (start.json() as { data: { login_url: string } }).data.login_url,
      );
      return injectAuthenticated(app, {
        method: 'POST',
        url: channelConnectCallbackPath(),
        token,
        payload: payload === undefined ? { code: `${code}#_`, state } : payload(state),
        headers: { 'x-idempotency-key': `channel-connect:${state}` },
      });
    }

    it.each<{
      outcome: string;
      mock: (input: { code: string }) => void;
      statusCode: number;
      payload?: (input: { code: string; state: string }) => unknown;
    }>([
      {
        outcome: 'a callback that works',
        mock: () =>
          mockMetaLogin({
            clientBusinessId: nextClientBusinessId(),
            assignedAccounts: [{ id: '17841400000000001', username: 'acme.shop' }],
          }),
        statusCode: 200,
      },
      {
        outcome: 'a code Meta refuses, quoting it and the secret',
        mock: ({ code }) =>
          nock(META_GRAPH_BASE_URL)
            .get(`/${META_GRAPH_VERSION}/oauth/access_token`)
            .query(true)
            .reply(400, errorAnswerQuoting({ quoted: `${code} ${appSecret()}`, code: 100 })),
        statusCode: 422,
      },
      {
        outcome: 'a code exchange that answers no JSON but the token',
        mock: () =>
          nock(META_GRAPH_BASE_URL)
            .get(`/${META_GRAPH_VERSION}/oauth/access_token`)
            .query(true)
            .reply(200, TEST_INSTAGRAM_LONG_LIVED_TOKEN),
        statusCode: 503,
      },
      {
        outcome: 'a code exchange that breaks off, naming its address',
        mock: ({ code }) =>
          nock(META_GRAPH_BASE_URL)
            .get(`/${META_GRAPH_VERSION}/oauth/access_token`)
            .query(true)
            .replyWithError(`socket hang up after client_secret=${appSecret()}&code=${code}`),
        statusCode: 503,
      },
      {
        outcome: 'a business read Meta refuses, quoting the token',
        mock: () => {
          mockCodeExchange();
          nock(META_GRAPH_BASE_URL)
            .get(`/${META_GRAPH_VERSION}/me`)
            .query(true)
            .reply(
              400,
              errorAnswerQuoting({
                quoted: `${TEST_INSTAGRAM_LONG_LIVED_TOKEN} ${appSecret()}`,
                code: 190,
              }),
            );
        },
        // The one-time code is spent: restart, never retry (D56).
        statusCode: 409,
      },
      {
        outcome: 'a business read that breaks off, naming its address',
        mock: () => {
          mockCodeExchange();
          nock(META_GRAPH_BASE_URL)
            .get(`/${META_GRAPH_VERSION}/me`)
            .query(true)
            .replyWithError(
              `getaddrinfo failed for ${META_GRAPH_BASE_URL}/me?appsecret_proof=x&access_token=${TEST_INSTAGRAM_LONG_LIVED_TOKEN}`,
            );
        },
        statusCode: 409,
      },
      {
        outcome: 'a callback body with an unknown field',
        mock: () => undefined,
        payload: ({ code, state }) => ({ code, state, extra: code }),
        statusCode: 400,
      },
    ])('$outcome ($statusCode)', async ({ mock, payload, statusCode }) => {
      const team = await createInstagramTeam();
      const code = `AQB-${randomUUID()}`;
      mock({ code });

      await expectNoSecretLogged({
        code,
        act: async () => {
          const response = await callback({
            code,
            token: team.ownerToken,
            ...(payload === undefined ? {} : { payload: (state) => payload({ code, state }) }),
          });
          expect(response.statusCode, response.body).toBe(statusCode);
        },
        expectedMessages: [
          'request.complete',
          '/api/v1/app/social/channel-connections/:provider/callback',
        ],
      });
      expect(nock.pendingMocks()).toEqual([]);
    });

    it('the daily check, refused and then done, and the disconnect whose unsubscribe fails', async () => {
      const team = await createInstagramTeam();
      const profile = buildInstagramProfile();
      await connectInstagramAccountsThroughRoutes({
        app,
        token: team.ownerToken,
        accounts: [{ id: profile.user_id, username: profile.username }],
      });
      // The set-up task (WC-30, R40) stamps the subscription in the worker; stamped here.
      await operatorQuery`
        UPDATE app.instagram_accounts SET webhook_subscribed_at = now()
        WHERE organization_id = ${team.organization.id}`;
      const accountPath = await organizationChannelAccountPath(team.organization.id);
      const [connection] = await operatorQuery<Array<{ public_id: string }>>`
        SELECT public_id FROM app.channel_connections WHERE organization_id = ${team.organization.id}`;
      /** The connection's daily token check (MC10, R51) — it refreshes the account's profile (P17). */
      const checkDaily = () =>
        processChannelConnectionTokenCheckJob({
          jobData: {
            organizationPublicId: team.organization.public_id,
            channelConnectionPublicId: connection?.public_id ?? '',
          },
          services: {
            connectionService: app.appDomain.channelConnectionService,
            accountPort: app.appDomain.channelAccountService,
          },
          requestId: 'acceptance-gaps-daily-check',
        });
      const mockAssignedAccounts = () =>
        nock(META_GRAPH_BASE_URL)
          .get(`/${META_GRAPH_VERSION}/me/assigned_instagram_accounts`)
          .query(true)
          .reply(200, { data: [{ id: profile.user_id, username: profile.username }] });

      await expectNoSecretLogged({
        code: 'no-code-in-this-test',
        act: async () => {
          mockAssignedAccounts();
          nock(META_GRAPH_BASE_URL)
            .get(`/${META_GRAPH_VERSION}/${profile.user_id}`)
            .query(true)
            .reply(400, errorAnswerQuoting({ quoted: TEST_INSTAGRAM_LONG_LIVED_TOKEN, code: 100 }));
          expect(await checkDaily()).toMatchObject({ outcome: 'checked', refreshedCount: 0 });

          mockAssignedAccounts();
          nock(META_GRAPH_BASE_URL)
            .get(`/${META_GRAPH_VERSION}/${profile.user_id}`)
            .query(true)
            .reply(200, profile);
          expect(await checkDaily()).toMatchObject({ outcome: 'checked', refreshedCount: 1 });

          // Route 8 removes the starter questions first (WC-31, R40), then unsubscribes.
          nock(META_GRAPH_BASE_URL)
            .delete(`/${META_GRAPH_VERSION}/${profile.id}/messenger_profile`)
            .query(true)
            .reply(200, { result: 'success' });
          nock(META_GRAPH_BASE_URL)
            .delete(`/${META_GRAPH_VERSION}/${profile.id}/subscribed_apps`)
            .query(true)
            .reply(500, errorAnswerQuoting({ quoted: TEST_INSTAGRAM_LONG_LIVED_TOKEN, code: 2 }));
          const disconnected = await injectAuthenticated(app, {
            method: 'DELETE',
            url: accountPath,
            token: team.ownerToken,
          });
          expect(disconnected.statusCode).toBe(204);
        },
        expectedMessages: [
          'outbound.call.failed',
          'app.channel_connection.token_check.completed',
          'request.complete',
          // The log names the route pattern, not the account's id.
          CHANNEL_ACCOUNTS_PATH,
        ],
      });
      expect(nock.pendingMocks()).toEqual([]);
      expect((await readInstagramAccountRows(team.organization.id))[0]?.connection_status).toBe(
        'revoked',
      );
    });
  });
});
