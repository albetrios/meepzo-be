import {
  channelAccountPath,
  insertChannelAccount,
} from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  META_GRAPH_VERSION,
  META_GRAPH_BASE_URL,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { provisionOrganizationWithOwner } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  TEST_INSTAGRAM_LONG_LIVED_TOKEN,
  buildInstagramProfile,
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  connectInstagramAccount,
  mockInstagramUnsubscribe,
  type InstagramTeamFixture,
  type TestInstagramProfile,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';

/** `GET /app/social/instagram/accounts/{channel_account_id}/media` (route 13). */
function mediaPath(channelAccountPublicId: string): string {
  return testApiPath(`/app/social/instagram/accounts/${channelAccountPublicId}/media`);
}
/** `GET /app/social/instagram/accounts/{channel_account_id}/stories` (route 14). */
function storiesPath(channelAccountPublicId: string): string {
  return testApiPath(`/app/social/instagram/accounts/${channelAccountPublicId}/stories`);
}
/** A well-formed `cha_` id no organization has. */
const UNKNOWN_ACCOUNT_ID = `cha_${'0'.repeat(21)}`;

/** A post page as Instagram sends it: one image post, and a next page. */
const MEDIA_FIRST_PAGE = {
  data: [
    {
      id: '18030000000000001',
      caption: 'New drop this Friday — comment SHOP for the link',
      media_type: 'IMAGE',
      media_product_type: 'FEED',
      media_url: 'https://scontent.cdninstagram.com/v/acme-post.jpg',
      permalink: 'https://www.instagram.com/p/AcmePost/',
      timestamp: '2026-11-20T10:00:00+0000',
      comments_count: 12,
      like_count: 340,
    },
    {
      id: '18030000000000002',
      media_type: 'VIDEO',
      media_product_type: 'REELS',
      thumbnail_url: 'https://scontent.cdninstagram.com/v/acme-reel.jpg',
      permalink: 'https://www.instagram.com/reel/AcmeReel/',
      timestamp: '2026-11-19T08:30:00+0000',
      comments_count: 4,
      like_count: 98,
    },
  ],
  paging: {
    cursors: { before: 'QVFIUbefore', after: 'QVFIUnextpage' },
    next: 'https://graph.facebook.com/v27.0/next-page',
  },
};

/** The last post page: Instagram names a cursor but no next page. */
const MEDIA_LAST_PAGE = {
  data: [
    {
      id: '18030000000000003',
      caption: 'Our first post',
      media_type: 'CAROUSEL_ALBUM',
      media_product_type: 'FEED',
      permalink: 'https://www.instagram.com/p/AcmeFirst/',
      timestamp: '2026-01-02T09:00:00+0000',
      comments_count: 0,
      like_count: 21,
      children: {
        data: [
          {
            id: '18030000000000004',
            media_type: 'IMAGE',
            media_url: 'https://cdn.example.com/a.jpg',
          },
        ],
      },
    },
  ],
  paging: { cursors: { before: 'QVFIUnextpage', after: 'QVFIUlast' } },
};

/** A story page as Instagram sends it. */
const STORIES_PAGE = {
  data: [
    {
      id: '17900000000000001',
      media_type: 'IMAGE',
      media_url: 'https://scontent.cdninstagram.com/v/acme-story.jpg',
      permalink: 'https://www.instagram.com/stories/acme.shop/17900000000000001/',
      timestamp: '2026-11-21T07:15:00+0000',
    },
  ],
  paging: { cursors: { before: 'QVFIUs1', after: 'QVFIUs2' } },
};

/** A Graph error body, as graph.facebook.com sends it. */
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

/**
 * Routes 13–14 — the post and story pickers of one named account (routes-final § 2.C, ROUTE R8)
 * over HTTP: every success and every error of 2.C.9 and 2.5, Meta's paging passed through, `kind`
 * and the picture fallback, team-only, the Editor and Viewer roles, another organization's or a
 * revoked account refused, the break on Meta's 190 (MC11), and that browsing stores nothing
 * (AC-4.3). Meta is mocked with nock; the database, auth and permissions are real.
 */
describe('Instagram media routes (post and story pickers)', () => {
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

  /** Connects a fresh Instagram account for `fixture` (start, callback, pick): its profile and `cha_` id. */
  async function connectAccount(
    fixture: InstagramTeamFixture = team,
  ): Promise<{ profile: TestInstagramProfile; accountId: string; connectionId: string }> {
    const profile = buildInstagramProfile();
    const connected = await connectInstagramAccount({ app, token: fixture.ownerToken, profile });
    return {
      profile,
      accountId: connected.instagramAccountPublicId,
      connectionId: connected.channelConnectionPublicId,
    };
  }

  /** The Graph host, expecting the connection's token (decrypted by the client) in the header only. */
  function graph(): nock.Scope {
    return nock(META_GRAPH_BASE_URL).matchHeader(
      'authorization',
      `Bearer ${TEST_INSTAGRAM_LONG_LIVED_TOKEN}`,
    );
  }

  function edgePath({
    profile,
    edge,
  }: {
    profile: TestInstagramProfile;
    edge: 'media' | 'stories';
  }) {
    return `/${META_GRAPH_VERSION}/${profile.id}/${edge}`;
  }

  function get({
    url,
    token = team.ownerToken,
  }: {
    url: string;
    token?: string;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, { url, token });
  }

  function errorOf(response: InjectHttpResult): { code?: string; reason?: string } {
    return (response.json() as { error: Record<string, never> }).error;
  }

  async function storedMediaCount(): Promise<number> {
    const rows = await operatorQuery<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM app.instagram_media`;
    return Number(rows[0]?.count);
  }

  async function accountStatus(channelAccountPublicId: string): Promise<string | undefined> {
    const rows = await operatorQuery<Array<{ connection_status: string }>>`
      SELECT connection_status FROM app.channel_accounts WHERE public_id = ${channelAccountPublicId}`;
    return rows[0]?.connection_status;
  }

  describe('GET /app/social/instagram/accounts/{channel_account_id}/media (route 13)', () => {
    it('lists the posts live from Meta, with kind and the picture fallback, Meta’s cursor and no total — storing nothing', async () => {
      const { profile, accountId } = await connectAccount();
      const meta = graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query((query) => query.limit === '25' && query.after === undefined)
        .reply(200, MEDIA_FIRST_PAGE);

      const response = await get({ url: mediaPath(accountId) });

      expect(response.statusCode).toBe(200);
      expect(meta.isDone()).toBe(true);
      expect(response.body).not.toContain(TEST_INSTAGRAM_LONG_LIVED_TOKEN);
      const body = response.json() as {
        data: Array<Record<string, unknown>>;
        meta: { pagination: Record<string, unknown> };
      };
      expect(body.data).toEqual([
        {
          instagram_media_id: '18030000000000001',
          kind: 'post',
          caption: 'New drop this Friday — comment SHOP for the link',
          media_type: 'image',
          media_product_type: 'feed',
          media_url: 'https://scontent.cdninstagram.com/v/acme-post.jpg',
          thumbnail_url: null,
          permalink: 'https://www.instagram.com/p/AcmePost/',
          published_at: '2026-11-20T10:00:00.000Z',
          comments_count: 12,
          like_count: 340,
          children: null,
        },
        expect.objectContaining({
          instagram_media_id: '18030000000000002',
          kind: 'reel',
          media_type: 'video',
          media_product_type: 'reels',
          // No media_url from Meta: the thumbnail stands in (plan:L811).
          media_url: 'https://scontent.cdninstagram.com/v/acme-reel.jpg',
          thumbnail_url: 'https://scontent.cdninstagram.com/v/acme-reel.jpg',
        }),
      ]);
      expect(body.meta.pagination).toEqual({
        per_page: 25,
        next: 'QVFIUnextpage',
        has_more: true,
      });
      expect(body.meta.pagination).not.toHaveProperty('estimated_total');
      expect(await storedMediaCount()).toBe(0);
    });

    it('passes limit and after to Meta, ends on the page with no next page, and falls back to the permalink', async () => {
      const { profile, accountId } = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query((query) => query.limit === '2' && query.after === 'QVFIUnextpage')
        .reply(200, MEDIA_LAST_PAGE);

      const response = await get({ url: `${mediaPath(accountId)}?limit=2&after=QVFIUnextpage` });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<Record<string, unknown>>;
        meta: { pagination: Record<string, unknown> };
      };
      expect(body.meta.pagination).toEqual({ per_page: 2, next: null, has_more: false });
      expect(body.data[0]).toMatchObject({
        kind: 'post',
        media_type: 'carousel_album',
        media_url: 'https://www.instagram.com/p/AcmeFirst/',
        children: [
          {
            instagram_media_id: '18030000000000004',
            media_type: 'image',
            media_url: 'https://cdn.example.com/a.jpg',
          },
        ],
      });
    });

    it.each(['editorToken', 'viewerToken'] as const)(
      'lets the %s holder browse (instagram-account:read, AC-4.6)',
      async (tokenName) => {
        const { profile, accountId } = await connectAccount();
        graph()
          .get(edgePath({ profile, edge: 'media' }))
          .query(true)
          .reply(200, MEDIA_LAST_PAGE);

        const response = await get({ url: mediaPath(accountId), token: team[tokenName] });

        expect(response.statusCode).toBe(200);
      },
    );

    it.each([
      ['limit 0', '?limit=0', 'querystring.limit'],
      ['limit 51', '?limit=51', 'querystring.limit'],
      ['an empty after', '?after=', 'querystring.after'],
      ['an after over 1000 characters', `?after=${'a'.repeat(1001)}`, 'querystring.after'],
    ])(
      'answers 400 on %s (the field named as the query validation names it)',
      async (_case, query, field) => {
        const { accountId } = await connectAccount();

        const response = await get({ url: `${mediaPath(accountId)}${query}` });

        expect(response.statusCode).toBe(400);
        const error = (response.json() as { error: { errors?: Array<{ field: string }> } }).error;
        expect(error.errors?.map((item) => item.field)).toContain(field);
      },
    );

    it('answers 400 on an unknown query field', async () => {
      const response = await get({ url: `${mediaPath(UNKNOWN_ACCOUNT_ID)}?offset=10` });

      expect(response.statusCode).toBe(400);
      const error = (response.json() as { error: { errors?: Array<{ field: string }> } }).error;
      expect(error.errors?.map((item) => item.field)).toContain('querystring.offset');
    });

    it('answers 404 channel_account_not_found for an id no organization has', async () => {
      const response = await get({ url: mediaPath(UNKNOWN_ACCOUNT_ID) });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('channel_account_not_found');
    });

    it('answers 404 channel_account_not_found once the account is disconnected (AC-4.4)', async () => {
      const { profile, accountId } = await connectAccount();
      mockInstagramUnsubscribe({ instagramUserId: profile.id });
      const disconnected = await injectAuthenticated(app, {
        method: 'DELETE',
        url: channelAccountPath(accountId),
        token: team.ownerToken,
      });
      expect(disconnected.statusCode).toBe(204);

      const response = await get({ url: mediaPath(accountId) });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('channel_account_not_found');
    });

    it("answers 404 channel_account_not_found for another organization's account, never calling Meta (AC-4.4)", async () => {
      const { profile, accountId } = await connectAccount();
      const otherTeam = await createInstagramTeam();
      const foreignCall = graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query(true)
        .reply(200, MEDIA_FIRST_PAGE);

      const response = await get({ url: mediaPath(accountId), token: otherTeam.ownerToken });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('channel_account_not_found');
      expect(foreignCall.isDone()).toBe(false);
    });

    it.each([
      ['the account', 'channel_accounts'],
      ['its connection', 'channel_connections'],
    ] as const)(
      'answers 404 instagram_reconnect_required when %s is error, without calling Meta',
      async (_case, table) => {
        const { accountId, connectionId } = await connectAccount();
        if (table === 'channel_accounts') {
          await operatorQuery`
            UPDATE app.channel_accounts SET connection_status = 'error' WHERE public_id = ${accountId}`;
        } else {
          await operatorQuery`
            UPDATE app.channel_connections SET status = 'error', status_changed_at = now()
            WHERE public_id = ${connectionId}`;
        }

        const response = await get({ url: mediaPath(accountId) });

        expect(response.statusCode).toBe(404);
        expect(errorOf(response).reason).toBe('instagram_reconnect_required');
        expect(nock.pendingMocks()).toEqual([]);
      },
    );

    it('breaks the connection’s accounts when Meta refuses the token (190), then answers 404 instagram_reconnect_required', async () => {
      const { profile, accountId } = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query(true)
        .reply(400, graphError(190, 463));

      const response = await get({ url: mediaPath(accountId) });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_reconnect_required');
      // Subcode 463 lands as `error`: the channel account has no `expired` (CA4).
      expect(await accountStatus(accountId)).toBe('error');

      // The account page now shows the reconnect card.
      const account = await injectAuthenticated(app, {
        url: channelAccountPath(accountId),
        token: team.ownerToken,
      });
      expect(
        (account.json() as { data: { connection_status: string } }).data.connection_status,
      ).toBe('error');
    });

    it('answers 404 instagram_reconnect_required on a refused permission, the account still connected', async () => {
      const { profile, accountId } = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query(true)
        .reply(403, graphError(10));

      const response = await get({ url: mediaPath(accountId) });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_reconnect_required');
      expect(await accountStatus(accountId)).toBe('connected');
    });

    it('answers 503 instagram_unavailable with Meta’s Retry-After when it throttles, the account still connected (AC-4.5)', async () => {
      const { profile, accountId } = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query(true)
        .reply(429, graphError(4), { 'Retry-After': '120' });

      const response = await get({ url: mediaPath(accountId) });

      expect(response.statusCode).toBe(503);
      expect(errorOf(response).reason).toBe('instagram_unavailable');
      expect(response.headers['retry-after']).toBe('120');
      expect(await accountStatus(accountId)).toBe('connected');
      expect(await storedMediaCount()).toBe(0);
    });

    it('answers 503 instagram_unavailable with a Retry-After when Meta fails', async () => {
      const { profile, accountId } = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query(true)
        .reply(500, graphError(2));

      const response = await get({ url: mediaPath(accountId) });

      expect(response.statusCode).toBe(503);
      expect(errorOf(response).reason).toBe('instagram_unavailable');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('answers 503 instagram_not_configured, with its reason, when the Meta app is not set', async () => {
      const { accountId } = await connectAccount();
      const savedAppId = process.env.META_APP_ID;
      delete process.env.META_APP_ID;
      resetEnvCacheForTests();
      try {
        const response = await get({ url: mediaPath(accountId) });

        expect(response.statusCode).toBe(503);
        expect(errorOf(response).code).toBe('service_unavailable');
        expect(errorOf(response).reason).toBe('instagram_not_configured');
      } finally {
        process.env.META_APP_ID = savedAppId;
        resetEnvCacheForTests();
      }
    });

    it('answers 404 team_organization_required on a personal organization, even with the code', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes();

      const response = await get({ url: mediaPath(UNKNOWN_ACCOUNT_ID), token: personal.token });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('team_organization_required');
    });

    it('answers 403 missing_permission to a caller without instagram-account:read', async () => {
      const owner = await createTestUser();
      const { organization } = await provisionOrganizationWithOwner({
        name: 'Personal',
        slug: null,
        type: 'PERSONAL',
        ownerUserId: owner.id,
      });
      const token = await generateTestToken({
        userId: owner.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await get({ url: mediaPath(UNKNOWN_ACCOUNT_ID), token });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).reason).toBe('missing_permission');
    });
  });

  describe('GET /app/social/instagram/accounts/{channel_account_id}/stories (route 14)', () => {
    it('lists the live stories, each ending 24 hours after it was published — storing nothing', async () => {
      const { profile, accountId } = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'stories' }))
        .query((query) => query.limit === '10')
        .reply(200, STORIES_PAGE);

      const response = await get({ url: `${storiesPath(accountId)}?limit=10` });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<Record<string, unknown>>;
        meta: { pagination: Record<string, unknown> };
      };
      expect(body.data).toEqual([
        {
          instagram_story_id: '17900000000000001',
          media_type: 'image',
          media_url: 'https://scontent.cdninstagram.com/v/acme-story.jpg',
          thumbnail_url: null,
          permalink: 'https://www.instagram.com/stories/acme.shop/17900000000000001/',
          published_at: '2026-11-21T07:15:00.000Z',
          expires_at: '2026-11-22T07:15:00.000Z',
        },
      ]);
      expect(body.meta.pagination).toEqual({ per_page: 10, next: null, has_more: false });
      expect(await storedMediaCount()).toBe(0);
    });

    it('lets a Viewer browse stories (AC-4.6)', async () => {
      const { profile, accountId } = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'stories' }))
        .query(true)
        .reply(200, STORIES_PAGE);

      const response = await get({ url: storiesPath(accountId), token: team.viewerToken });

      expect(response.statusCode).toBe(200);
    });

    it('answers 400 on limit 51', async () => {
      const response = await get({ url: `${storiesPath(UNKNOWN_ACCOUNT_ID)}?limit=51` });

      expect(response.statusCode).toBe(400);
    });

    it('answers 404 channel_account_not_found for a revoked account (AC-4.4)', async () => {
      const revoked = await insertChannelAccount({
        organizationId: team.organization.id,
        providerAccountId: '17841499999999999',
        connectionStatus: 'revoked',
      });

      const response = await get({ url: storiesPath(revoked.public_id) });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('channel_account_not_found');
    });

    it('breaks the account on a refused token and answers 404 instagram_reconnect_required', async () => {
      const { profile, accountId } = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'stories' }))
        .query(true)
        .reply(400, graphError(190));

      const response = await get({ url: storiesPath(accountId) });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_reconnect_required');
      expect(await accountStatus(accountId)).toBe('error');
    });

    it('answers 503 instagram_unavailable with Retry-After when Meta throttles', async () => {
      const { profile, accountId } = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'stories' }))
        .query(true)
        .reply(429, graphError(613), { 'Retry-After': '30' });

      const response = await get({ url: storiesPath(accountId) });

      expect(response.statusCode).toBe(503);
      expect(errorOf(response).reason).toBe('instagram_unavailable');
      expect(response.headers['retry-after']).toBe('30');
    });

    it('answers 404 team_organization_required on a personal organization', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes();

      const response = await get({ url: storiesPath(UNKNOWN_ACCOUNT_ID), token: personal.token });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('team_organization_required');
    });
  });
});
