import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  META_GRAPH_BASE_URL,
  META_GRAPH_VERSION,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  type InstagramTeamFixture,
  TEST_INSTAGRAM_LONG_LIVED_TOKEN,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { connectInstagramAccountsThroughRoutes } from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import {
  CHANNEL_ACCOUNTS_PATH,
  channelAccountPath,
} from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { readLaneRows } from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';

/** Route 154's answer. */
interface MessageAccessCheck {
  channel_account_id: string;
  status: string;
  checked_at: string | null;
  is_from_meta: boolean;
}

/** Meta's error body. */
function graphError(code: number, errorSubcode?: number) {
  return {
    error: {
      message: 'Instagram error',
      type: 'OAuthException',
      code,
      ...(errorSubcode === undefined ? {} : { error_subcode: errorSubcode }),
      fbtrace_id: 'trace-integration',
    },
  };
}

let accountSequence = 0;

/**
 * Route 154 — `POST /social/instagram/accounts/{channel_account_id}/message-access-checks`
 * (feat-meta-connect-flow routes-final § 3, IG1–IG4, ROUTE R5) over HTTP: the probe's three
 * answers stored with the `access_off` stop ended, started or left; the 60-second rule; a refused
 * token breaks the connection; Meta down stores nothing; the gate and another organization; routes 6
 * and 7 show the stored answer. Meta is mocked with nock; the database and the lanes are real.
 */
describe('Instagram message-access check (route 154)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    team = await createInstagramTeam();
  });

  afterEach(async () => {
    nock.cleanAll();
    await metaGraphCircuit.reset();
  });

  /** Connects one account: its `cha_` id, internal id and Instagram user id. */
  async function connectOne(): Promise<{
    id: string;
    internalId: number;
    instagramUserId: string;
  }> {
    accountSequence += 1;
    const instagramUserId = `17844${`${Date.now()}${accountSequence}`.slice(-11).padStart(11, '0')}`;
    const { pick } = await connectInstagramAccountsThroughRoutes({
      app,
      token: team.ownerToken,
      accounts: [{ id: instagramUserId, username: `shop.${instagramUserId.slice(-6)}` }],
    });
    const [result] = pick.results as Array<{ channel_account: { id: string } | null }>;
    const id = result?.channel_account?.id ?? '';
    const [row] = await operatorQuery<Array<{ id: string }>>`
      SELECT id::text FROM app.channel_accounts WHERE public_id = ${id}`;
    return { id, internalId: Number(row?.id), instagramUserId };
  }

  /** Meta's conversations read for this account, answered once. */
  function probe(instagramUserId: string): nock.Interceptor {
    return nock(META_GRAPH_BASE_URL)
      .matchHeader('authorization', `Bearer ${TEST_INSTAGRAM_LONG_LIVED_TOKEN}`)
      .get(`/${META_GRAPH_VERSION}/${instagramUserId}/conversations`)
      .query(true);
  }

  function check(channelAccountPublicId: string, token = team.ownerToken) {
    return injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath(
        `/app/social/instagram/accounts/${channelAccountPublicId}/message-access-checks`,
      ),
      token,
    });
  }

  function dataOf(response: InjectHttpResult): MessageAccessCheck {
    return (response.json() as { data: MessageAccessCheck }).data;
  }

  function reasonOf(response: InjectHttpResult): string | undefined {
    return (response.json() as { error: { reason?: string } }).error.reason;
  }

  async function storedAccess(internalId: number) {
    const [row] = await operatorQuery<
      Array<{ message_access: string; message_access_checked_at: Date | null }>
    >`SELECT message_access, message_access_checked_at FROM app.instagram_accounts
      WHERE channel_account_id = ${internalId}`;
    return row;
  }

  /** Moves the last check past the 60-second rule. */
  async function ageLastCheck(internalId: number): Promise<void> {
    await operatorQuery`
      UPDATE app.instagram_accounts
      SET message_access_checked_at = now() - interval '2 minutes'
      WHERE channel_account_id = ${internalId}`;
  }

  it('stores off and stops every lane, then on ends the stop (IG2)', async () => {
    const account = await connectOne();
    probe(account.instagramUserId).reply(403, graphError(200));

    const off = await check(account.id);

    expect(off.statusCode, off.body).toBe(200);
    expect(dataOf(off)).toMatchObject({
      channel_account_id: account.id,
      status: 'off',
      is_from_meta: true,
    });
    expect((await storedAccess(account.internalId))?.message_access).toBe('off');
    const stopped = await readLaneRows(account.internalId);
    expect(stopped.length).toBeGreaterThan(0);
    expect(stopped.every((lane) => lane.stop_reason === 'access_off')).toBe(true);

    await ageLastCheck(account.internalId);
    probe(account.instagramUserId).reply(200, { data: [] });
    const on = await check(account.id);

    expect(dataOf(on)).toMatchObject({ status: 'on', is_from_meta: true });
    expect((await storedAccess(account.internalId))?.message_access).toBe('on');
    expect(
      (await readLaneRows(account.internalId)).every((lane) => lane.stop_reason === null),
    ).toBe(true);
  });

  it('answers the stored result within 60 seconds without calling Meta', async () => {
    const account = await connectOne();
    probe(account.instagramUserId).reply(200, { data: [] });

    const first = await check(account.id);
    const second = await check(account.id);

    expect(dataOf(first)).toMatchObject({ status: 'on', is_from_meta: true });
    expect(dataOf(second)).toMatchObject({
      status: 'on',
      is_from_meta: false,
      checked_at: dataOf(first).checked_at,
    });
    expect(nock.isDone()).toBe(true);
  });

  it('serves a burst of checks with one Meta call and one stop (one check per account at a time)', async () => {
    const account = await connectOne();
    probe(account.instagramUserId).delay(200).reply(403, graphError(200));

    const answers = await Promise.all([check(account.id), check(account.id), check(account.id)]);

    for (const answer of answers) {
      expect(answer.statusCode, answer.body).toBe(200);
      expect(dataOf(answer).status).toBe('off');
    }
    expect(answers.filter((answer) => dataOf(answer).is_from_meta)).toHaveLength(1);
    expect(nock.isDone()).toBe(true);
    const stops = await operatorQuery<Array<{ id: string }>>`
      SELECT id::text FROM app.instagram_send_stops
      WHERE channel_account_id = ${account.internalId} AND reason = 'access_off'`;
    expect(stops).toHaveLength(1);
  });

  it('puts the stop right from the stored answer when a stop start failed after the write', async () => {
    const account = await connectOne();
    // `off` stored a moment ago, but the stop never started (the write committed, the stop failed).
    await operatorQuery`
      UPDATE app.instagram_accounts
      SET message_access = 'off', message_access_checked_at = now()
      WHERE channel_account_id = ${account.internalId}`;

    const response = await check(account.id);

    expect(dataOf(response)).toMatchObject({ status: 'off', is_from_meta: false });
    expect(
      (await readLaneRows(account.internalId)).every((lane) => lane.stop_reason === 'access_off'),
    ).toBe(true);
  });

  it('stores unknown and leaves the lanes as they are', async () => {
    const account = await connectOne();
    probe(account.instagramUserId).reply(400, graphError(100));

    const response = await check(account.id);

    expect(dataOf(response)).toMatchObject({ status: 'unknown', is_from_meta: true });
    expect((await storedAccess(account.internalId))?.message_access_checked_at).not.toBeNull();
    expect(
      (await readLaneRows(account.internalId)).every((lane) => lane.stop_reason === null),
    ).toBe(true);
  });

  it('breaks the connection when Meta refuses the token, then answers 409 instagram_not_connected', async () => {
    const account = await connectOne();
    probe(account.instagramUserId).reply(400, graphError(190));

    const response = await check(account.id);

    expect(response.statusCode).toBe(409);
    expect(reasonOf(response)).toBe('instagram_not_connected');
    const [row] = await operatorQuery<Array<{ connection_status: string }>>`
      SELECT connection_status FROM app.channel_accounts WHERE id = ${account.internalId}`;
    expect(row?.connection_status).toBe('error');
    const again = await check(account.id);
    expect(again.statusCode).toBe(409);
  });

  it('answers 503 instagram_unavailable when Meta is down, storing nothing', async () => {
    const account = await connectOne();
    probe(account.instagramUserId).reply(500, graphError(2));

    const response = await check(account.id);

    expect(response.statusCode).toBe(503);
    expect(reasonOf(response)).toBe('instagram_unavailable');
    expect(await storedAccess(account.internalId)).toMatchObject({
      message_access: 'unknown',
      message_access_checked_at: null,
    });
  });

  it('refuses a viewer (403) and answers 404 for another organization, calling no Meta', async () => {
    const account = await connectOne();
    expect((await check(account.id, team.viewerToken)).statusCode).toBe(403);
    const otherTeam = await createInstagramTeam();
    const foreign = await check(account.id, otherTeam.ownerToken);
    expect(foreign.statusCode).toBe(404);
    expect(reasonOf(foreign)).toBe('channel_account_not_found');
    expect((await storedAccess(account.internalId))?.message_access_checked_at).toBeNull();
  });

  it('shows the stored answer on routes 6 and 7 (IG4)', async () => {
    const account = await connectOne();
    const before = await injectAuthenticated(app, {
      url: channelAccountPath(account.id),
      token: team.ownerToken,
    });
    expect(
      (before.json() as { data: { instagram: { message_access: unknown } } }).data.instagram
        .message_access,
    ).toEqual({ status: 'unknown', checked_at: null });

    probe(account.instagramUserId).reply(403, graphError(200));
    await check(account.id);

    const one = await injectAuthenticated(app, {
      url: channelAccountPath(account.id),
      token: team.ownerToken,
    });
    const list = await injectAuthenticated(app, {
      url: CHANNEL_ACCOUNTS_PATH,
      token: team.ownerToken,
    });
    const fromOne = (one.json() as { data: { instagram: { message_access: { status: string } } } })
      .data.instagram.message_access;
    const [fromList] = (
      list.json() as { data: Array<{ instagram: { message_access: { status: string } } | null }> }
    ).data;
    expect(fromOne.status).toBe('off');
    expect(fromList?.instagram?.message_access.status).toBe('off');
  });
});
