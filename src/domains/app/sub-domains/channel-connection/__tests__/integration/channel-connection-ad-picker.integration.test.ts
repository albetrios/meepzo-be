import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  META_GRAPH_BASE_URL,
  META_GRAPH_VERSION,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  META_ADS_PERMISSION,
  META_REQUIRED_PERMISSIONS,
} from '@/domains/app/sub-domains/channel-connection/channel-connection.constants.js';
import {
  type InstagramReconnectNoticeJobData,
  INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
  closeInstagramReconnectNoticeQueue,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.queue.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  readInstagramAccountRows,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  type TestAssignedAccount,
  channelAdAccountsPath,
  channelAdsPath,
  connectInstagramAccountsThroughRoutes,
  insertChannelConnection,
  readChannelConnectionRows,
} from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';

/** The Graph path prefix every mocked call takes. */
const GRAPH_PATH = `/${META_GRAPH_VERSION}`;
/** The ad account every granted test reads. */
const AD_ACCOUNT_ID = '1234567890123';

let accountSequence = 0;

/** A fresh assigned Instagram account (unique per call). */
function nextAccount(): TestAssignedAccount {
  accountSequence += 1;
  const suffix = `${Date.now()}${accountSequence}`.slice(-11).padStart(11, '0');
  return { id: `17841${suffix}`, username: `ads.${suffix}` };
}

/** The answer's `data`, `meta` and `error`. */
function bodyOf(response: InjectHttpResult) {
  return response.json() as {
    data: Array<Record<string, unknown>>;
    meta: {
      ad_access?: string;
      pagination?: { per_page: number; next: string | null; has_more: boolean };
    };
    error?: { reason?: string };
  };
}

/** Meta's `/me/adaccounts` answer. */
function mockAdAccounts(): nock.Scope {
  return nock(META_GRAPH_BASE_URL)
    .get(`${GRAPH_PATH}/me/adaccounts`)
    .query(true)
    .reply(200, {
      data: [
        {
          id: `act_${AD_ACCOUNT_ID}`,
          account_id: AD_ACCOUNT_ID,
          name: 'Handmade Shop ads',
          account_status: 1,
        },
      ],
    });
}

/**
 * The ad picker — routes 41 and 15 of the channel connection (feat-instagram-dm-sending
 * routes-final § 1 MC13, MCC8; ROUTE R4; AC-1.13, P57) — over HTTP: the connection's ad accounts,
 * then one ad account's ads at a time, read live from Meta (nock) and never stored; no `ads_read`
 * → empty lists with `meta.ad_access = 'missing'`; Meta's paging passed through; Meta's 190 breaks
 * the connection and every account of it (MC11); an `error` connection, another organization's
 * connection, a personal organization and the gates.
 */
describe('Channel connection ad picker (routes 41, 15)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  const noticeQueue = new Queue<InstagramReconnectNoticeJobData>(
    INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
    { connection: getBullMQConnectionOptions(), prefix: getBullMQKeyPrefix() },
  );

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await closeInstagramReconnectNoticeQueue();
    await noticeQueue.close();
  });

  beforeEach(async () => {
    await noticeQueue.obliterate({ force: true });
    await cleanupDatabase();
    await seedAllPermissions();
    team = await createInstagramTeam();
    const plan = await createTestPlan({
      features: CREATOR_PLAN_FEATURES,
      priceMonthly: '29.00',
      priceYearly: '276.00',
    });
    await createTestSubscription({
      organizationId: team.organization.id,
      planId: plan.id,
      status: 'ACTIVE',
    });
  });

  afterEach(async () => {
    nock.cleanAll();
    await metaGraphCircuit.reset();
    await noticeQueue.obliterate({ force: true });
  });

  /** Connects two accounts through routes 1–3; `ads_read` granted unless `withAds` is false. */
  async function connectTwoAccounts({ withAds = true }: { withAds?: boolean } = {}) {
    const accounts = [nextAccount(), nextAccount()];
    const { channelConnectionPublicId } = await connectInstagramAccountsThroughRoutes({
      app,
      token: team.ownerToken,
      accounts,
      grantedPermissions: withAds
        ? [...META_REQUIRED_PERMISSIONS, META_ADS_PERMISSION]
        : [...META_REQUIRED_PERMISSIONS],
    });
    const rows = await readInstagramAccountRows(team.organization.id);
    return { channelConnectionPublicId, accounts, rows };
  }

  function get(url: string, token = team.ownerToken): Promise<InjectHttpResult> {
    return injectAuthenticated(app, { method: 'GET', url, token });
  }

  it("lists the connection's ad accounts live, never stored (AC-1.13)", async () => {
    const { channelConnectionPublicId } = await connectTwoAccounts();
    for (const attempt of [1, 2]) {
      const scope = mockAdAccounts();
      const response = await get(channelAdAccountsPath(channelConnectionPublicId));
      expect(response.statusCode, `${attempt}: ${response.body}`).toBe(200);
      expect(bodyOf(response).data).toEqual([
        { ad_account_id: AD_ACCOUNT_ID, name: 'Handmade Shop ads', account_status: 1 },
      ]);
      expect(bodyOf(response).meta.ad_access).toBe('granted');
      // Read live each time: Meta answered both reads.
      expect(scope.isDone()).toBe(true);
    }
  });

  it("lists one ad account's ads with Meta's paging and the account each runs as (AC-1.13, P57)", async () => {
    const { channelConnectionPublicId, accounts, rows } = await connectTwoAccounts();
    const runningAs = rows.find((row) => row.instagram_user_id === accounts[0]?.id);
    mockAdAccounts();
    const adsCall = nock(META_GRAPH_BASE_URL)
      .get(`${GRAPH_PATH}/act_${AD_ACCOUNT_ID}/ads`)
      .query((query) => query.limit === '2' && query.after === 'cursor-one')
      .reply(200, {
        data: [
          {
            id: '120200000000000001',
            name: 'Winter sale',
            effective_status: 'ACTIVE',
            created_time: '2026-11-01T10:00:00+0000',
            creative: {
              effective_instagram_media_id: '18030000000000001',
              instagram_user_id: accounts[0]?.id,
              thumbnail_url: 'https://scontent.cdninstagram.com/v/ad.jpg',
            },
          },
          {
            id: '120200000000000002',
            name: 'Facebook only',
            effective_status: 'PAUSED',
            created_time: '2026-11-02T10:00:00+0000',
            creative: { instagram_user_id: '17841499999999999' },
          },
        ],
        paging: {
          cursors: { after: 'cursor-two' },
          next: 'https://graph.facebook.com/v27.0/act_1/ads?after=cursor-two',
        },
      });

    const response = await get(
      channelAdsPath({
        channelConnectionPublicId,
        query: { ad_account_id: AD_ACCOUNT_ID, limit: '2', after: 'cursor-one' },
      }),
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(adsCall.isDone()).toBe(true);
    const body = bodyOf(response);
    expect(body.data).toEqual([
      {
        ad_id: '120200000000000001',
        name: 'Winter sale',
        status: 'ACTIVE',
        ad_account_id: AD_ACCOUNT_ID,
        instagram_media_id: '18030000000000001',
        channel_account_id: runningAs?.public_id,
        thumbnail_url: 'https://scontent.cdninstagram.com/v/ad.jpg',
        created_at: '2026-11-01T10:00:00+0000',
      },
      {
        ad_id: '120200000000000002',
        name: 'Facebook only',
        status: 'PAUSED',
        ad_account_id: AD_ACCOUNT_ID,
        instagram_media_id: null,
        channel_account_id: null,
        thumbnail_url: null,
        created_at: '2026-11-02T10:00:00+0000',
      },
    ]);
    expect(body.meta.ad_access).toBe('granted');
    expect(body.meta.pagination).toEqual({ per_page: 2, next: 'cursor-two', has_more: true });
  });

  it('refuses a list without an ad account, and an ad account not of the connection (AC-1.13)', async () => {
    const { channelConnectionPublicId } = await connectTwoAccounts();
    const missing = await get(channelAdsPath({ channelConnectionPublicId }));
    expect(missing.statusCode).toBe(400);
    const notDigits = await get(
      channelAdsPath({ channelConnectionPublicId, query: { ad_account_id: 'act_1' } }),
    );
    expect(notDigits.statusCode).toBe(400);
    const tooMany = await get(
      channelAdsPath({ channelConnectionPublicId, query: { ad_account_id: '1', limit: '51' } }),
    );
    expect(tooMany.statusCode).toBe(400);

    mockAdAccounts();
    const foreign = await get(
      channelAdsPath({ channelConnectionPublicId, query: { ad_account_id: '999' } }),
    );
    expect(foreign.statusCode).toBe(404);
    expect(bodyOf(foreign).error?.reason).toBe('ad_account_not_found');
  });

  it('answers empty lists with ad_access missing without ads_read, and calls Meta not at all', async () => {
    const { channelConnectionPublicId } = await connectTwoAccounts({ withAds: false });
    const adAccounts = await get(channelAdAccountsPath(channelConnectionPublicId));
    expect(adAccounts.statusCode).toBe(200);
    expect(bodyOf(adAccounts).data).toEqual([]);
    expect(bodyOf(adAccounts).meta.ad_access).toBe('missing');
    const ads = await get(
      channelAdsPath({ channelConnectionPublicId, query: { ad_account_id: AD_ACCOUNT_ID } }),
    );
    expect(ads.statusCode).toBe(200);
    expect(bodyOf(ads).data).toEqual([]);
    expect(bodyOf(ads).meta).toMatchObject({
      ad_access: 'missing',
      pagination: { per_page: 25, next: null, has_more: false },
    });
    // nock refuses any unmocked host: no Meta call was made.
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('answers ad_access missing when Meta says the ad permission was taken back (not a break)', async () => {
    const { channelConnectionPublicId } = await connectTwoAccounts();
    nock(META_GRAPH_BASE_URL)
      .get(`${GRAPH_PATH}/me/adaccounts`)
      .query(true)
      .reply(403, {
        error: { message: 'Requires ads_read', type: 'OAuthException', code: 200 },
      });
    const response = await get(channelAdAccountsPath(channelConnectionPublicId));
    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf(response)).toMatchObject({ data: [], meta: { ad_access: 'missing' } });
    const [connection] = await readChannelConnectionRows(team.organization.id);
    expect(connection?.status).toBe('connected');
  });

  it("breaks the connection and every account of it on Meta's 190, one notice each (MC11)", async () => {
    const { channelConnectionPublicId } = await connectTwoAccounts();
    nock(META_GRAPH_BASE_URL)
      .get(`${GRAPH_PATH}/me/adaccounts`)
      .query(true)
      .reply(400, {
        error: {
          message: 'Error validating access token',
          type: 'OAuthException',
          code: 190,
          error_subcode: 460,
        },
      });

    const response = await get(channelAdAccountsPath(channelConnectionPublicId));

    expect(response.statusCode).toBe(404);
    expect(bodyOf(response).error?.reason).toBe('instagram_reconnect_required');
    const [connection] = await readChannelConnectionRows(team.organization.id);
    expect(connection?.status).toBe('error');
    expect(connection?.last_check_error).toBe('auth (code 190, subcode 460, HTTP 400)');
    const rows = await readInstagramAccountRows(team.organization.id);
    expect(rows.map((row) => row.connection_status)).toEqual(['error', 'error']);
    const jobs = await noticeQueue.getJobs(['waiting', 'delayed', 'prioritized', 'active']);
    expect(jobs.map((job) => job.data.instagramAccountPublicId).sort()).toEqual(
      rows.map((row) => row.public_id).sort(),
    );

    // An `error` connection answers 404 instagram_reconnect_required without calling Meta.
    const again = await get(
      channelAdsPath({ channelConnectionPublicId, query: { ad_account_id: AD_ACCOUNT_ID } }),
    );
    expect(again.statusCode).toBe(404);
    expect(bodyOf(again).error?.reason).toBe('instagram_reconnect_required');
  });

  it('answers 503 instagram_unavailable with Retry-After when Meta is down, and changes nothing', async () => {
    const { channelConnectionPublicId } = await connectTwoAccounts();
    mockAdAccounts();
    nock(META_GRAPH_BASE_URL)
      .get(`${GRAPH_PATH}/act_${AD_ACCOUNT_ID}/ads`)
      .query(true)
      .reply(500, { error: { message: 'An unexpected error has occurred.', code: 2 } });
    const response = await get(
      channelAdsPath({ channelConnectionPublicId, query: { ad_account_id: AD_ACCOUNT_ID } }),
    );
    expect(response.statusCode).toBe(503);
    expect(bodyOf(response).error?.reason).toBe('instagram_unavailable');
    expect(response.headers['retry-after']).toBeDefined();
    const [connection] = await readChannelConnectionRows(team.organization.id);
    expect(connection?.status).toBe('connected');
  });

  it("answers 404 for an error connection, an unknown one and another organization's — no Meta call", async () => {
    const broken = await insertChannelConnection({
      organizationId: team.organization.id,
      status: 'error',
      scopes: [...META_REQUIRED_PERMISSIONS, META_ADS_PERMISSION],
    });
    const errorAnswer = await get(channelAdAccountsPath(broken.public_id));
    expect(errorAnswer.statusCode).toBe(404);
    expect(bodyOf(errorAnswer).error?.reason).toBe('instagram_reconnect_required');

    const unknown = await get(channelAdAccountsPath('chc_000000000000000000000'));
    expect(unknown.statusCode).toBe(404);
    expect(bodyOf(unknown).error?.reason).toBe('channel_connection_not_found');

    const otherTeam = await createInstagramTeam();
    const foreign = await insertChannelConnection({
      organizationId: otherTeam.organization.id,
      scopes: [...META_REQUIRED_PERMISSIONS, META_ADS_PERMISSION],
    });
    for (const url of [
      channelAdAccountsPath(foreign.public_id),
      channelAdsPath({
        channelConnectionPublicId: foreign.public_id,
        query: { ad_account_id: AD_ACCOUNT_ID },
      }),
    ]) {
      const response = await get(url);
      expect(response.statusCode).toBe(404);
      expect(bodyOf(response).error?.reason).toBe('channel_connection_not_found');
    }
    const [foreignRow] = await readChannelConnectionRows(otherTeam.organization.id);
    expect(foreignRow?.status).toBe('connected');
  });

  it('lets an Editor and a Viewer read the picker, and refuses a personal organization (AC-1.15)', async () => {
    const { channelConnectionPublicId } = await connectTwoAccounts({ withAds: false });
    for (const token of [team.editorToken, team.viewerToken]) {
      const response = await get(channelAdAccountsPath(channelConnectionPublicId), token);
      expect(response.statusCode, response.body).toBe(200);
    }
    const personal = await createPersonalOrganizationWithInstagramCodes({
      permissionCodes: [APP_PERMISSIONS.CHANNEL_ACCOUNT_READ],
    });
    const read = await get(channelAdAccountsPath(channelConnectionPublicId), personal.token);
    expect(read.statusCode).toBe(404);
    expect(bodyOf(read).error?.reason).toBe('team_organization_required');
  });
});
