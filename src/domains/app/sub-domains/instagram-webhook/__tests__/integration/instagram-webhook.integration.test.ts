import { createHmac } from 'node:crypto';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { INSTAGRAM_WEBHOOK_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnv, resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery, withOperatorTransaction } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { type InjectHttpResult, injectRoute } from '@/tests/helpers/test-http-inject.helper.js';
import { buildStripeWebhookTestSignatureHeader } from '@/tests/contract/helpers/stripe-signature.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  TEST_CONTACT_INSTAGRAM_USER_ID,
  type TestInstagramAccount,
  insertTestInstagramAccount,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';

/**
 * The delivery's Meta times: an hour ago, so the store function's 8-day replay guard (WH9 step 5,
 * feat-instagram-dm-sending R16) keeps them.
 */
const ENTRY_TIME_SECONDS = Math.floor(Date.now() / 1000) - 3600;
const ITEM_TIME_MILLISECONDS = ENTRY_TIME_SECONDS * 1000 + 1234;
/**
 * Routes 60–61, Meta's Instagram webhook (feat-instagram-dm-sending routes-final § 5.A, ROUTE R17;
 * launch ROUTE R13) over HTTP with the real database: the subscription check (WH7), the signature first (WH8), each event stored once before
 * `OK` (WH9, WH10), the account no team holds (WH4), the skip reasons, the body rules — and the
 * Stripe receiver still verifying through the shared raw-body registry (WH2).
 */

const WEBHOOK_PATH = testApiPath('/app/social/channel-connections/meta/webhooks/instagram');

interface StoredEvent {
  event_kind: string;
  event_key: string;
  status: string;
  skip_reason: string | null;
  instagram_user_id: string;
  contact_instagram_user_id: string | null;
  request_id: string | null;
  processed_at: Date | null;
  occurred_at: Date | null;
}

/** The organization's stored events, oldest first — read as the operator. */
async function storedEvents(organizationId: number): Promise<StoredEvent[]> {
  return operatorQuery<StoredEvent[]>`
    SELECT event_kind, event_key, status, skip_reason, instagram_user_id,
           contact_instagram_user_id, request_id, processed_at, occurred_at
    FROM app.instagram_webhook_events
    WHERE organization_id = ${organizationId}
    ORDER BY created_at, id`;
}

/** Every stored event, any organization — for "nothing stored". */
async function countAllEvents(): Promise<number> {
  const [row] = await operatorQuery<Array<{ count: string }>>`
    SELECT count(*)::text AS count FROM app.instagram_webhook_events`;
  return Number(row?.count ?? 0);
}

/** `sha256=` + the HMAC of the exact bytes with the harness's fake Instagram app secret. */
function signatureFor(rawBody: string, secret = getEnv().META_APP_SECRET ?? ''): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function errorOf(response: InjectHttpResult): { reason?: string; code?: string } {
  return (response.json() as { error: { reason?: string; code?: string } }).error;
}

describe('Instagram webhook — routes 16–17', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let account: TestInstagramAccount;

  /** A reader of the event-processing queue the receiver adds to (WH5) — never a worker. */
  let processingQueue: Queue<{
    organizationPublicId: string;
    channelAccountPublicId: string;
    requestId?: string;
  }>;

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
    team = await createInstagramTeam();
    account = await insertTestInstagramAccount(team.organization.id);
  });

  /** Posts `rawBody` exactly as given, signed (or with the given header) as Meta would. */
  function deliver({
    rawBody,
    signature = signatureFor(rawBody),
    contentType = 'application/json',
  }: {
    rawBody: string;
    signature?: string | null;
    contentType?: string;
  }): Promise<InjectHttpResult> {
    return injectRoute(app, {
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: {
        'content-type': contentType,
        ...(signature === null ? {} : { 'x-hub-signature-256': signature }),
      },
      payload: Buffer.from(rawBody),
    });
  }

  /** A delivery for the test account: one comment by the contact and the given extra items. */
  function deliveryBody({
    instagramUserId = account.instagramUserId,
    changes = [
      {
        field: 'comments',
        value: {
          id: '18000000000000001',
          from: { id: TEST_CONTACT_INSTAGRAM_USER_ID, username: 'acme_customer' },
          text: 'Price please?',
        },
      },
    ],
    messaging = [],
  }: {
    instagramUserId?: string;
    changes?: unknown[];
    messaging?: unknown[];
  } = {}): string {
    return JSON.stringify({
      object: 'instagram',
      entry: [{ id: instagramUserId, time: ENTRY_TIME_SECONDS, changes, messaging }],
    });
  }

  async function setAutomationEnabled(isAutomationEnabled: boolean): Promise<void> {
    // The switch is the channel account's since ROUTE row R7 (P42).
    await operatorQuery`
      UPDATE app.channel_accounts SET is_automation_enabled = ${isAutomationEnabled}
      WHERE id = (SELECT channel_account_id FROM app.instagram_accounts WHERE id = ${account.id})`;
  }

  async function setConnectionStatus(status: 'expired' | 'error' | 'revoked'): Promise<void> {
    await operatorQuery`
      UPDATE app.channel_accounts
      SET connection_status = ${status === 'expired' ? 'error' : status},
          disconnected_at = ${status === 'revoked' ? new Date() : null}
      WHERE id = (SELECT channel_account_id FROM app.instagram_accounts WHERE id = ${account.id})`;
  }

  describe('GET /app/social/channel-connections/meta/webhooks/instagram — the subscription check (route 16, WH7)', () => {
    function check(query: Record<string, string>): Promise<InjectHttpResult> {
      return injectRoute(app, { method: 'GET', url: WEBHOOK_PATH, query });
    }
    const validQuery = () => ({
      'hub.mode': 'subscribe',
      'hub.verify_token': getEnv().META_WEBHOOK_VERIFY_TOKEN ?? '',
      'hub.challenge': '1158201444',
    });

    it('echoes the challenge as text/plain when the mode is subscribe and the token matches', async () => {
      const response = await check(validQuery());

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/plain/);
      expect(response.body).toBe('1158201444');
    });

    it('ignores other parameters Meta adds', async () => {
      const response = await check({ ...validQuery(), 'hub.topic': 'instagram' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('1158201444');
    });

    it('answers 400 invalid_webhook_verify_token for a wrong token', async () => {
      const response = await check({ ...validQuery(), 'hub.verify_token': 'not-the-token' });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).reason).toBe('invalid_webhook_verify_token');
    });

    it('answers 400 invalid_webhook_verify_token for a mode other than subscribe', async () => {
      const response = await check({ ...validQuery(), 'hub.mode': 'unsubscribe' });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).reason).toBe('invalid_webhook_verify_token');
    });

    it.each(['hub.mode', 'hub.verify_token', 'hub.challenge'])(
      'answers 400 invalid_field when %s is missing',
      async (missing) => {
        const query: Record<string, string> = validQuery();
        delete query[missing];

        const response = await check(query);

        expect(response.statusCode).toBe(400);
        expect(errorOf(response).code).toBe('invalid_field');
      },
    );

    it('answers 400 invalid_field for a challenge over 256 characters', async () => {
      const response = await check({ ...validQuery(), 'hub.challenge': 'c'.repeat(257) });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('invalid_field');
    });

    it('answers 503 instagram_webhook_not_configured without the verify token setting', async () => {
      const savedVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
      delete process.env.META_WEBHOOK_VERIFY_TOKEN;
      resetEnvCacheForTests();
      try {
        const response = await check({ ...validQuery(), 'hub.verify_token': 'anything' });

        expect(response.statusCode).toBe(503);
        expect(errorOf(response).reason).toBe('instagram_webhook_not_configured');
      } finally {
        process.env.META_WEBHOOK_VERIFY_TOKEN = savedVerifyToken;
        resetEnvCacheForTests();
      }
    });

    it('takes no Authorization header — Meta calls it unauthenticated', async () => {
      const response = await check(validQuery());
      expect(response.statusCode).not.toBe(401);
    });
  });

  describe('POST /app/social/channel-connections/meta/webhooks/instagram — the signature first (route 17, WH8)', () => {
    it('answers 400 invalid_webhook_signature and stores nothing for a wrong signature', async () => {
      const rawBody = deliveryBody();
      const response = await deliver({
        rawBody,
        signature: signatureFor(rawBody, 'another-secret'),
      });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).reason).toBe('invalid_webhook_signature');
      expect(await countAllEvents()).toBe(0);
    });

    it('answers 400 invalid_webhook_signature for a missing or malformed header', async () => {
      const rawBody = deliveryBody();
      for (const signature of [null, 'sha256=abc', signatureFor(rawBody).replace('sha256=', '')]) {
        const response = await deliver({ rawBody, signature });
        expect(response.statusCode).toBe(400);
        expect(errorOf(response).reason).toBe('invalid_webhook_signature');
      }
      expect(await countAllEvents()).toBe(0);
    });

    it('checks the raw bytes — the same JSON re-serialized does not verify', async () => {
      const rawBody = deliveryBody();
      const reformatted = JSON.stringify(JSON.parse(rawBody), null, 2);
      const response = await deliver({ rawBody: reformatted, signature: signatureFor(rawBody) });

      expect(response.statusCode).toBe(400);
      expect(await countAllEvents()).toBe(0);
    });

    it('answers 503 instagram_webhook_not_configured without the app secret, storing nothing', async () => {
      const rawBody = deliveryBody();
      const signature = signatureFor(rawBody);
      const savedAppSecret = process.env.META_APP_SECRET;
      delete process.env.META_APP_SECRET;
      resetEnvCacheForTests();
      try {
        const response = await deliver({ rawBody, signature });

        expect(response.statusCode).toBe(503);
        expect(errorOf(response).reason).toBe('instagram_webhook_not_configured');
        expect(await countAllEvents()).toBe(0);
      } finally {
        process.env.META_APP_SECRET = savedAppSecret;
        resetEnvCacheForTests();
      }
    });

    it('answers 415 for a body that is not application/json', async () => {
      const rawBody = deliveryBody();
      const response = await deliver({ rawBody, contentType: 'text/plain' });

      expect(response.statusCode).toBe(415);
      expect(await countAllEvents()).toBe(0);
    });
  });

  describe('nothing is parsed before the signature passed (D53)', () => {
    const STRIPE_WEBHOOK_PATH = testApiPath('/billing/webhook');
    const MARKER = 'never-parsed-before-the-signature';

    /** How often `JSON.parse` was given the delivered text while `act` ran. */
    async function countParsesOfTheBody(act: () => Promise<InjectHttpResult>) {
      const parse = vi.spyOn(JSON, 'parse');
      try {
        const response = await act();
        const parsedTimes = parse.mock.calls.filter(([text]) =>
          String(text).includes(MARKER),
        ).length;
        return { response, parsedTimes };
      } finally {
        parse.mockRestore();
      }
    }

    it.each([
      ['a wrong signature', 'application/json', `{"object":"instagram","marker":"${MARKER}"}`],
      ['a wrong signature over malformed JSON', 'application/json', `{"marker":"${MARKER}`],
      ['a charset on the content type', 'application/json; charset=utf-8', `{"m":"${MARKER}"}`],
    ])('%s: the signature answer, the body never parsed', async (_label, contentType, rawBody) => {
      const { response, parsedTimes } = await countParsesOfTheBody(() =>
        deliver({ rawBody, contentType, signature: signatureFor(rawBody, 'another-secret') }),
      );

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).reason).toBe('invalid_webhook_signature');
      expect(parsedTimes).toBe(0);
    });

    it('a percent-encoded path reaches the same route and parses nothing either', async () => {
      const rawBody = `{"object":"instagram","marker":"${MARKER}"}`;
      const { response, parsedTimes } = await countParsesOfTheBody(() =>
        injectRoute(app, {
          method: 'POST',
          url: WEBHOOK_PATH.replace('/webhook', '/web%68ook'),
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': signatureFor(rawBody, 'another-secret'),
          },
          payload: Buffer.from(rawBody),
        }),
      );

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).reason).toBe('invalid_webhook_signature');
      expect(parsedTimes).toBe(0);
    });

    it('no signature header: refused before the body is read — a content type it never looked at', async () => {
      const { response, parsedTimes } = await countParsesOfTheBody(() =>
        deliver({ rawBody: `<xml>${MARKER}</xml>`, signature: null, contentType: 'text/xml' }),
      );

      // Were the body looked at first, this would be the content type's 415.
      expect(response.statusCode).toBe(400);
      expect(errorOf(response).reason).toBe('invalid_webhook_signature');
      expect(parsedTimes).toBe(0);
    });

    it('a signed delivery is parsed once, after its signature', async () => {
      const rawBody = `{"object":"page","entry":[],"marker":"${MARKER}"}`;
      const { response, parsedTimes } = await countParsesOfTheBody(() => deliver({ rawBody }));

      expect(response.statusCode).toBe(200);
      expect(parsedTimes).toBe(1);
    });

    it('the Stripe receiver: a wrong signature is never parsed', async () => {
      const rawPayload = `{"id":"evt_${MARKER}","object":"event"}`;
      const { response, parsedTimes } = await countParsesOfTheBody(() =>
        injectRoute(app, {
          method: 'POST',
          url: STRIPE_WEBHOOK_PATH,
          headers: {
            'content-type': 'application/json',
            'stripe-signature': buildStripeWebhookTestSignatureHeader({
              rawPayload,
              webhookSigningSecret: 'another-signing-secret',
            }),
          },
          payload: Buffer.from(rawPayload),
        }),
      );

      expect(response.statusCode).toBe(400);
      expect(parsedTimes).toBe(0);
    });

    it('the Stripe receiver: no signature header keeps its answer, before the body is read', async () => {
      const missing = (contentType: string) =>
        injectRoute(app, {
          method: 'POST',
          url: STRIPE_WEBHOOK_PATH,
          headers: { 'content-type': contentType },
          payload: Buffer.from(`{"marker":"${MARKER}"}`),
        });

      for (const contentType of ['application/json', 'text/xml']) {
        const { response, parsedTimes } = await countParsesOfTheBody(() => missing(contentType));
        expect(response.statusCode).toBe(400);
        expect(errorOf(response).code).toBe('invalid_field');
        expect((response.json() as { error: { detail: string } }).error.detail).toBe(
          'Missing stripe-signature header',
        );
        expect(parsedTimes).toBe(0);
      }
    });
  });

  describe('POST /app/social/channel-connections/meta/webhooks/instagram — stored once, then OK (WH9, WH10)', () => {
    it("stores one row per event, adds the account's processing job, turns the rows queued and answers OK", async () => {
      const rawBody = deliveryBody({
        messaging: [
          {
            sender: { id: TEST_CONTACT_INSTAGRAM_USER_ID },
            recipient: { id: account.instagramUserId },
            timestamp: ITEM_TIME_MILLISECONDS,
            message: { mid: 'm_dm_1', text: 'hello' },
          },
        ],
      });

      const response = await deliver({ rawBody });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/plain/);
      expect(response.body).toBe('OK');
      const events = await storedEvents(team.organization.id);
      expect(
        events.map(({ event_kind, event_key, status, skip_reason }) => ({
          event_kind,
          event_key,
          status,
          skip_reason,
        })),
      ).toEqual([
        {
          event_kind: 'comment',
          event_key: 'comment:18000000000000001',
          status: 'queued',
          skip_reason: null,
        },
        {
          event_kind: 'message',
          event_key: 'message:m_dm_1',
          status: 'queued',
          skip_reason: null,
        },
      ]);
      // WH5, WH10: after the commit, one processing job for the account, with its organization.
      const processingJobs = await processingQueue.getJobs(['waiting', 'delayed', 'prioritized']);
      expect(
        processingJobs
          .map((job) => job.data)
          .filter((data) => data.organizationPublicId === team.organization.public_id),
      ).toEqual([
        expect.objectContaining({
          organizationPublicId: team.organization.public_id,
          channelAccountPublicId: account.channelAccountPublicId,
          requestId: expect.any(String),
        }),
      ]);
      for (const event of events) {
        expect(event.instagram_user_id).toBe(account.instagramUserId);
        expect(event.contact_instagram_user_id).toBe(TEST_CONTACT_INSTAGRAM_USER_ID);
        expect(event.request_id).toEqual(expect.any(String));
        expect(event.processed_at).toBeNull();
      }
      expect(events[1]?.occurred_at?.toISOString()).toBe(
        new Date(ITEM_TIME_MILLISECONDS).toISOString(),
      );
    });

    it('a repeat delivery stores nothing new and still answers OK', async () => {
      const rawBody = deliveryBody();

      const first = await deliver({ rawBody });
      const repeat = await deliver({ rawBody });

      expect(first.statusCode).toBe(200);
      expect(repeat.statusCode).toBe(200);
      expect(repeat.body).toBe('OK');
      expect(await storedEvents(team.organization.id)).toHaveLength(1);
    });

    it('a later delivery adds only its new events', async () => {
      await deliver({ rawBody: deliveryBody() });
      const later = deliveryBody({
        changes: [
          {
            field: 'comments',
            value: { id: '18000000000000001', from: { id: TEST_CONTACT_INSTAGRAM_USER_ID } },
          },
          {
            field: 'comments',
            value: { id: '18000000000000002', from: { id: TEST_CONTACT_INSTAGRAM_USER_ID } },
          },
        ],
      });

      await deliver({ rawBody: later });

      expect((await storedEvents(team.organization.id)).map((event) => event.event_key)).toEqual([
        'comment:18000000000000001',
        'comment:18000000000000002',
      ]);
    });

    it('saves each kind as 5.A.10 says: own comment and edit skipped, a hand-typed echo and a reaction received, a read receipt never (WH8, WHC5)', async () => {
      const rawBody = deliveryBody({
        changes: [
          {
            field: 'comments',
            value: { id: '18000000000000003', from: { id: account.instagramUserId } },
          },
          { field: 'mentions', value: { media_id: '1' } },
        ],
        messaging: [
          {
            sender: { id: account.instagramUserId },
            recipient: { id: TEST_CONTACT_INSTAGRAM_USER_ID },
            message: { mid: 'm_echo', is_echo: true },
          },
          { sender: { id: TEST_CONTACT_INSTAGRAM_USER_ID }, read: { mid: 'm_echo' } },
          {
            sender: { id: TEST_CONTACT_INSTAGRAM_USER_ID },
            timestamp: ITEM_TIME_MILLISECONDS,
            reaction: { mid: 'm_echo', action: 'react' },
          },
          {
            sender: { id: TEST_CONTACT_INSTAGRAM_USER_ID },
            message_edit: { mid: 'm_echo', num_edit: 1 },
          },
        ],
      });

      await deliver({ rawBody });

      const events = await storedEvents(team.organization.id);
      expect(
        events.map(({ event_kind, skip_reason, status }) => ({ event_kind, skip_reason, status })),
      ).toEqual([
        { event_kind: 'comment', skip_reason: 'own_comment', status: 'skipped' },
        { event_kind: 'unknown', skip_reason: 'unsupported', status: 'skipped' },
        // Not one of our sent messages (the own-message lookup, R19) — the owner's quiet time.
        { event_kind: 'echo', skip_reason: null, status: 'queued' },
        { event_kind: 'reaction', skip_reason: null, status: 'queued' },
        { event_kind: 'edit', skip_reason: 'edit', status: 'skipped' },
      ]);
      expect(events.some((event) => event.event_key.startsWith('read:'))).toBe(false);
    });

    it('saves the new kinds received: a Live comment, a story mention, a shared post, a starter tap, a referral (WH8)', async () => {
      const contact = { id: TEST_CONTACT_INSTAGRAM_USER_ID };
      const rawBody = deliveryBody({
        changes: [
          {
            field: 'live_comments',
            value: { id: '18000000000000077', from: contact, media: { id: '1790000000001' } },
          },
        ],
        messaging: [
          {
            sender: contact,
            timestamp: ITEM_TIME_MILLISECONDS,
            message: { mid: 'm_mention', attachments: [{ type: 'story_mention', payload: {} }] },
          },
          {
            sender: contact,
            timestamp: ITEM_TIME_MILLISECONDS,
            message: { mid: 'm_share', attachments: [{ type: 'share', payload: {} }] },
          },
          {
            sender: contact,
            timestamp: ITEM_TIME_MILLISECONDS,
            postback: { mid: 'm_starter', payload: 'starter:prices' },
          },
          {
            sender: contact,
            timestamp: ITEM_TIME_MILLISECONDS,
            referral: { ref: 'summer', source: 'SHORTLINK' },
          },
        ],
      });

      await deliver({ rawBody });

      expect(
        (await storedEvents(team.organization.id)).map(({ event_kind, status }) => [
          event_kind,
          status,
        ]),
      ).toEqual([
        ['live_comment', 'queued'],
        ['story_mention', 'queued'],
        ['shared_post', 'queued'],
        ['ice_breaker', 'queued'],
        ['referral', 'queued'],
      ]);
    });

    it('an event whose Meta time is over 8 days old saves nothing — the replay guard (WH9 step 5)', async () => {
      const nineDaysAgoSeconds = Math.floor(Date.now() / 1000) - 9 * 24 * 3600;
      const rawBody = JSON.stringify({
        object: 'instagram',
        entry: [
          {
            id: account.instagramUserId,
            time: nineDaysAgoSeconds,
            changes: [
              {
                field: 'comments',
                value: { id: '18000000000000099', from: { id: TEST_CONTACT_INSTAGRAM_USER_ID } },
              },
            ],
          },
        ],
      });

      const response = await deliver({ rawBody });

      expect(response.statusCode).toBe(200);
      expect(await countAllEvents()).toBe(0);
    });

    it('a save over its 3 s answers 503, keeps nothing, and Meta’s next delivery saves once (WH2, AC-16.5)', async () => {
      const rawBody = deliveryBody();

      const slow = await withOperatorTransaction(async (transaction) => {
        // Every insert into the key table waits behind this lock until the unit's time runs out.
        await transaction`LOCK TABLE app.instagram_webhook_event_keys IN SHARE MODE`;
        return deliver({ rawBody });
      });

      expect(slow.statusCode).toBe(503);
      expect(await countAllEvents()).toBe(0);
      const repeat = await deliver({ rawBody });
      expect(repeat.statusCode).toBe(200);
      expect(await storedEvents(team.organization.id)).toHaveLength(1);
    }, 20_000);

    it('with the automation switch off, events to handle are born skipped automation_disabled', async () => {
      await setAutomationEnabled(false);

      await deliver({ rawBody: deliveryBody() });

      expect(await storedEvents(team.organization.id)).toMatchObject([
        { status: 'skipped', skip_reason: 'automation_disabled' },
      ]);
    });

    it('an error account’s comment is saved received — it waits in its stopped lanes (WH3)', async () => {
      await setConnectionStatus('error');

      await deliver({ rawBody: deliveryBody() });

      expect(await storedEvents(team.organization.id)).toMatchObject([
        { event_kind: 'comment', status: 'queued', skip_reason: null },
      ]);
    });

    it('an account no team holds: OK, nothing stored (WH4)', async () => {
      const response = await deliver({
        rawBody: deliveryBody({ instagramUserId: '17841499999999999' }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('OK');
      expect(await countAllEvents()).toBe(0);
    });

    it('a revoked account: OK, nothing stored (WH4)', async () => {
      await setConnectionStatus('revoked');

      const response = await deliver({ rawBody: deliveryBody() });

      expect(response.statusCode).toBe(200);
      expect(await countAllEvents()).toBe(0);
    });

    it('an entry without an Instagram user id is dropped; the others are stored', async () => {
      const rawBody = JSON.stringify({
        object: 'instagram',
        entry: [
          {
            changes: [
              {
                field: 'comments',
                value: { id: '1', from: { id: TEST_CONTACT_INSTAGRAM_USER_ID } },
              },
            ],
          },
          JSON.parse(deliveryBody()).entry[0],
        ],
      });

      const response = await deliver({ rawBody });

      expect(response.statusCode).toBe(200);
      expect(await storedEvents(team.organization.id)).toHaveLength(1);
    });

    describe('text Postgres refuses, and an entry that cannot be stored (D53)', () => {
      const POISONED_TEXT = 'Price\u0000 please? \udead';

      /** One entry: a comment whose id and text are given, on the account `instagramUserId`. */
      function commentEntry({
        instagramUserId,
        commentId,
        text = 'Price please?',
      }: {
        instagramUserId: string;
        commentId: string;
        text?: string;
      }) {
        return {
          id: instagramUserId,
          time: ENTRY_TIME_SECONDS,
          changes: [
            {
              field: 'comments',
              value: {
                id: commentId,
                from: { id: TEST_CONTACT_INSTAGRAM_USER_ID, username: 'acme_customer' },
                text,
              },
            },
          ],
        };
      }

      it('stores a poisoned entry cleaned, and the next organization’s beside it', async () => {
        const otherTeam = await createInstagramTeam();
        const otherAccount = await insertTestInstagramAccount(otherTeam.organization.id);
        // JSON.stringify writes both characters as escapes — the bytes Meta would sign and send.
        const rawBody = JSON.stringify({
          object: 'instagram',
          entry: [
            commentEntry({
              instagramUserId: account.instagramUserId,
              commentId: '1800\u0000001',
              text: POISONED_TEXT,
            }),
            commentEntry({ instagramUserId: otherAccount.instagramUserId, commentId: '1800002' }),
          ],
        });
        expect(rawBody).toContain('\\u0000');

        const response = await deliver({ rawBody });

        expect(response.statusCode).toBe(200);
        expect(
          (await storedEvents(team.organization.id)).map(({ event_key }) => event_key),
        ).toEqual(['comment:1800001']);
        const [stored] = await operatorQuery<Array<{ text: string }>>`
          SELECT payload #>> '{value,text}' AS text FROM app.instagram_webhook_events
          WHERE organization_id = ${team.organization.id}`;
        expect(stored?.text).toBe('Price please? \ufffd');
        expect(
          (await storedEvents(otherTeam.organization.id)).map(({ event_key }) => event_key),
        ).toEqual(['comment:1800002']);

        // Cleaned the same way again, so a repeat dedupes on the cleaned key.
        expect((await deliver({ rawBody })).statusCode).toBe(200);
        expect(await countAllEvents()).toBe(2);
      });

      it('an entry the database refuses: the others stored, 500 — and Meta’s retry stores it', async () => {
        const otherTeam = await createInstagramTeam();
        const otherAccount = await insertTestInstagramAccount(otherTeam.organization.id);
        const rawBody = JSON.stringify({
          object: 'instagram',
          entry: [
            commentEntry({ instagramUserId: account.instagramUserId, commentId: '1800003' }),
            commentEntry({ instagramUserId: otherAccount.instagramUserId, commentId: '1800004' }),
          ],
        });
        const eventService = app.appDomain.instagramWebhookEventService;
        const store = vi
          .spyOn(eventService, 'recordReceivedEvents')
          .mockRejectedValueOnce(new Error('the database refused this insert'));
        try {
          const response = await deliver({ rawBody });

          expect(response.statusCode).toBe(500);
          expect(await storedEvents(team.organization.id)).toEqual([]);
          expect(
            (await storedEvents(otherTeam.organization.id)).map(({ event_key }) => event_key),
          ).toEqual(['comment:1800004']);
        } finally {
          store.mockRestore();
        }

        const retry = await deliver({ rawBody });

        expect(retry.statusCode).toBe(200);
        expect(
          (await storedEvents(team.organization.id)).map(({ event_key }) => event_key),
        ).toEqual(['comment:1800003']);
        expect(await storedEvents(otherTeam.organization.id)).toHaveLength(1);
      });
    });

    it.each([
      ['not JSON', 'this is not json'],
      ['about another object', JSON.stringify({ object: 'page', entry: [] })],
      ['without entries', JSON.stringify({ object: 'instagram' })],
    ])('a signed body %s: OK, nothing stored (WH10)', async (_label, rawBody) => {
      const response = await deliver({ rawBody });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('OK');
      expect(await countAllEvents()).toBe(0);
    });

    it("stores one organization's events only under that organization", async () => {
      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertTestInstagramAccount(otherTeam.organization.id);

      await deliver({ rawBody: deliveryBody({ instagramUserId: otherAccount.instagramUserId }) });

      expect(await storedEvents(team.organization.id)).toHaveLength(0);
      expect(await storedEvents(otherTeam.organization.id)).toHaveLength(1);
    });
  });

  describe('the Stripe receiver still verifies through the shared raw-body registry (WH2)', () => {
    const STRIPE_WEBHOOK_PATH = testApiPath('/billing/webhook');

    it('accepts a correctly signed Stripe event (200)', async () => {
      const webhookSigningSecret = getEnv().STRIPE_WEBHOOK_SECRET ?? '';
      const rawPayload = JSON.stringify({
        id: `evt_shared_registry_${Date.now()}`,
        object: 'event',
        type: 'customer.created',
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'cus_shared_registry', object: 'customer' } },
      });

      const response = await injectRoute(app, {
        method: 'POST',
        url: STRIPE_WEBHOOK_PATH,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': buildStripeWebhookTestSignatureHeader({
            rawPayload,
            webhookSigningSecret,
          }),
        },
        payload: Buffer.from(rawPayload),
      });

      expect(response.statusCode, response.body).toBe(200);
    });

    it('still answers 400 for a signed body that is not JSON', async () => {
      const webhookSigningSecret = getEnv().STRIPE_WEBHOOK_SECRET ?? '';
      const rawPayload = 'not json at all';

      const response = await injectRoute(app, {
        method: 'POST',
        url: STRIPE_WEBHOOK_PATH,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': buildStripeWebhookTestSignatureHeader({
            rawPayload,
            webhookSigningSecret,
          }),
        },
        payload: Buffer.from(rawPayload),
      });

      expect(response.statusCode).toBe(400);
    });

    it('does not keep the raw body for the Instagram header on the Stripe route', async () => {
      const rawPayload = JSON.stringify({ id: 'evt_wrong_header', object: 'event' });

      const response = await injectRoute(app, {
        method: 'POST',
        url: STRIPE_WEBHOOK_PATH,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signatureFor(rawPayload),
        },
        payload: Buffer.from(rawPayload),
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
