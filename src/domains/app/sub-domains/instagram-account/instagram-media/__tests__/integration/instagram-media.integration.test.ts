import { organizationChannelAccountPath } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
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
  readInstagramAccountRows,
  type InstagramTeamFixture,
  type TestInstagramProfile,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';

/** `GET /app/social/instagram/media` (route 5). */
const INSTAGRAM_MEDIA_PATH = testApiPath('/app/social/instagram/media');
/** `GET /app/social/instagram/stories` (route 6). */
const INSTAGRAM_STORIES_PATH = testApiPath('/app/social/instagram/stories');

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
      media_url: 'https://scontent.cdninstagram.com/o1/v/acme-reel.mp4',
      thumbnail_url: 'https://scontent.cdninstagram.com/v/acme-reel.jpg',
      permalink: 'https://www.instagram.com/reel/AcmeReel/',
      timestamp: '2026-11-19T08:30:00+0000',
      comments_count: 4,
      like_count: 98,
    },
  ],
  paging: {
    cursors: { before: 'QVFIUbefore', after: 'QVFIUnextpage' },
    next: 'https://graph.instagram.com/v24.0/next-page',
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

/** A Graph error body, as graph.instagram.com sends it. */
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
 * Routes 5–6 — the post and story pickers (routes-final § 1.C, ROUTE R5) over HTTP: every success
 * and every error of 1.C.9 and 1.5, Instagram's paging passed through, team-only (K1), the Editor
 * role, another organization's account never used, the guarded status change on a refused token
 * (IA9), and that browsing stores nothing (AC-3.7). Instagram is mocked with nock; the database,
 * auth and permissions are real.
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

  /** Connects a fresh Instagram account for `fixture` (start, callback, pick) and returns its profile. */
  async function connectAccount(
    fixture: InstagramTeamFixture = team,
  ): Promise<TestInstagramProfile> {
    const profile = buildInstagramProfile();
    await connectInstagramAccount({ app, token: fixture.ownerToken, profile });
    return profile;
  }

  /** The Graph host, expecting the stored token (decrypted by the client) in the header only. */
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

  describe('GET /app/social/instagram/media (route 5)', () => {
    it('lists the posts live from Instagram, mapped, with Instagram’s cursor and no total — storing nothing', async () => {
      const profile = await connectAccount();
      const instagram = graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query((query) => query.limit === '25' && query.after === undefined)
        .reply(200, MEDIA_FIRST_PAGE);

      const response = await get({ url: INSTAGRAM_MEDIA_PATH });

      expect(response.statusCode).toBe(200);
      expect(instagram.isDone()).toBe(true);
      expect(response.body).not.toContain(TEST_INSTAGRAM_LONG_LIVED_TOKEN);
      const body = response.json() as {
        data: Array<Record<string, unknown>>;
        meta: { pagination: Record<string, unknown> };
      };
      expect(body.data).toEqual([
        {
          instagram_media_id: '18030000000000001',
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
          media_type: 'video',
          media_product_type: 'reels',
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

    it('passes limit and after to Instagram, and ends on the page with no next page', async () => {
      const profile = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query((query) => query.limit === '2' && query.after === 'QVFIUnextpage')
        .reply(200, MEDIA_LAST_PAGE);

      const response = await get({ url: `${INSTAGRAM_MEDIA_PATH}?limit=2&after=QVFIUnextpage` });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<Record<string, unknown>>;
        meta: { pagination: Record<string, unknown> };
      };
      expect(body.meta.pagination).toEqual({ per_page: 2, next: null, has_more: false });
      expect(body.data[0]).toMatchObject({
        media_type: 'carousel_album',
        children: [
          {
            instagram_media_id: '18030000000000004',
            media_type: 'image',
            media_url: 'https://cdn.example.com/a.jpg',
          },
        ],
      });
    });

    it('lets an Editor browse (instagram-account:read)', async () => {
      const profile = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query(true)
        .reply(200, MEDIA_LAST_PAGE);

      const response = await get({ url: INSTAGRAM_MEDIA_PATH, token: team.editorToken });

      expect(response.statusCode).toBe(200);
    });

    it.each([
      ['limit 0', '?limit=0', 'querystring.limit'],
      ['limit 51', '?limit=51', 'querystring.limit'],
      ['an empty after', '?after=', 'querystring.after'],
      ['an after over 1000 characters', `?after=${'a'.repeat(1001)}`, 'querystring.after'],
    ])(
      'answers 400 on %s (the field named as the query validation names it)',
      async (_case, query, field) => {
        await connectAccount();

        const response = await get({ url: `${INSTAGRAM_MEDIA_PATH}${query}` });

        expect(response.statusCode).toBe(400);
        const error = (response.json() as { error: { errors?: Array<{ field: string }> } }).error;
        expect(error.errors?.map((item) => item.field)).toContain(field);
      },
    );

    it('answers 400 on an unknown query field', async () => {
      const response = await get({ url: `${INSTAGRAM_MEDIA_PATH}?offset=10` });

      expect(response.statusCode).toBe(400);
      const error = (response.json() as { error: { errors?: Array<{ field: string }> } }).error;
      expect(error.errors?.map((item) => item.field)).toContain('querystring.offset');
    });

    it('answers 404 instagram_not_connected when no account was ever connected', async () => {
      const response = await get({ url: INSTAGRAM_MEDIA_PATH });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_not_connected');
    });

    it('answers 404 instagram_not_connected once the only account is disconnected', async () => {
      const profile = await connectAccount();
      mockInstagramUnsubscribe({ instagramAppUserId: profile.id });
      const disconnected = await injectAuthenticated(app, {
        method: 'DELETE',
        url: await organizationChannelAccountPath(team.organization.id),
        token: team.ownerToken,
      });
      expect(disconnected.statusCode).toBe(204);

      const response = await get({ url: INSTAGRAM_MEDIA_PATH });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_not_connected');
    });

    it('answers 404 instagram_reconnect_required for an expired account, without calling Instagram', async () => {
      await connectAccount();
      const [row] = await readInstagramAccountRows(team.organization.id);
      await app.appDomain.instagramAccountService.markConnectionBroken({
        scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: team.organization.public_id }),
        instagramAccount: {
          organizationId: team.organization.id,
          instagramAccountId: Number(row?.id),
        },
        connectionStatus: 'expired',
      });

      const response = await get({ url: INSTAGRAM_MEDIA_PATH });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_reconnect_required');
      expect(nock.pendingMocks()).toEqual([]);
    });

    it('marks the account expired when Instagram refuses its token (190/463), then answers 404 instagram_reconnect_required', async () => {
      const profile = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query(true)
        .reply(400, graphError(190, 463));

      const response = await get({ url: INSTAGRAM_MEDIA_PATH });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_reconnect_required');
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('expired');

      // The account page now shows the reconnect card (IA13).
      const account = await injectAuthenticated(app, {
        url: await organizationChannelAccountPath(team.organization.id),
        token: team.ownerToken,
      });
      // The channel account has no `expired`: the connection's token never ends (CA4).
      expect(
        (account.json() as { data: { connection_status: string } }).data.connection_status,
      ).toBe('error');
    });

    it('marks the account error on any other refused token', async () => {
      const profile = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query(true)
        .reply(400, graphError(190));

      const response = await get({ url: INSTAGRAM_MEDIA_PATH });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_reconnect_required');
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('error');
    });

    it('answers 503 instagram_unavailable with Instagram’s Retry-After when it throttles, the account still connected', async () => {
      const profile = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query(true)
        .reply(429, graphError(4), { 'Retry-After': '120' });

      const response = await get({ url: INSTAGRAM_MEDIA_PATH });

      expect(response.statusCode).toBe(503);
      expect(errorOf(response).reason).toBe('instagram_unavailable');
      expect(response.headers['retry-after']).toBe('120');
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('connected');
    });

    it('answers 503 instagram_unavailable with a Retry-After when Instagram fails', async () => {
      const profile = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query(true)
        .reply(500, graphError(2));

      const response = await get({ url: INSTAGRAM_MEDIA_PATH });

      expect(response.statusCode).toBe(503);
      expect(errorOf(response).reason).toBe('instagram_unavailable');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('answers 503 instagram_not_configured, with its reason, when the Instagram app is not set', async () => {
      await connectAccount();
      const savedAppId = process.env.META_APP_ID;
      delete process.env.META_APP_ID;
      resetEnvCacheForTests();
      try {
        const response = await get({ url: INSTAGRAM_MEDIA_PATH });

        expect(response.statusCode).toBe(503);
        expect(errorOf(response).code).toBe('service_unavailable');
        expect(errorOf(response).reason).toBe('instagram_not_configured');
      } finally {
        process.env.META_APP_ID = savedAppId;
        resetEnvCacheForTests();
      }
    });

    it('answers 404 team_organization_required on a personal organization, even with the code (IA3)', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes();

      const response = await get({ url: INSTAGRAM_MEDIA_PATH, token: personal.token });

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

      const response = await get({ url: INSTAGRAM_MEDIA_PATH, token });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).reason).toBe('missing_permission');
    });

    it("never uses another organization's account: no account here is 404, and each team reads its own", async () => {
      const profile = await connectAccount();
      const otherTeam = await createInstagramTeam();

      const withoutAccount = await get({ url: INSTAGRAM_MEDIA_PATH, token: otherTeam.ownerToken });
      expect(withoutAccount.statusCode).toBe(404);
      expect(errorOf(withoutAccount).reason).toBe('instagram_not_connected');

      const otherProfile = await connectAccount(otherTeam);
      const ownCall = graph()
        .get(edgePath({ profile: otherProfile, edge: 'media' }))
        .query(true)
        .reply(200, MEDIA_LAST_PAGE);
      const foreignCall = graph()
        .get(edgePath({ profile, edge: 'media' }))
        .query(true)
        .reply(200, MEDIA_FIRST_PAGE);

      const response = await get({ url: INSTAGRAM_MEDIA_PATH, token: otherTeam.ownerToken });

      expect(response.statusCode).toBe(200);
      expect(ownCall.isDone()).toBe(true);
      expect(foreignCall.isDone()).toBe(false);
    });
  });

  describe('GET /app/social/instagram/stories (route 6)', () => {
    it('lists the live stories, each ending 24 hours after it was published — storing nothing', async () => {
      const profile = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'stories' }))
        .query((query) => query.limit === '10')
        .reply(200, STORIES_PAGE);

      const response = await get({ url: `${INSTAGRAM_STORIES_PATH}?limit=10` });

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

    it('lets an Editor browse stories', async () => {
      const profile = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'stories' }))
        .query(true)
        .reply(200, STORIES_PAGE);

      const response = await get({ url: INSTAGRAM_STORIES_PATH, token: team.editorToken });

      expect(response.statusCode).toBe(200);
    });

    it('answers 400 on limit 51', async () => {
      const response = await get({ url: `${INSTAGRAM_STORIES_PATH}?limit=51` });

      expect(response.statusCode).toBe(400);
    });

    it('answers 404 instagram_not_connected with no account', async () => {
      const response = await get({ url: INSTAGRAM_STORIES_PATH });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_not_connected');
    });

    it('marks the account broken on a refused token and answers 404 instagram_reconnect_required', async () => {
      const profile = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'stories' }))
        .query(true)
        .reply(400, graphError(190, 463));

      const response = await get({ url: INSTAGRAM_STORIES_PATH });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_reconnect_required');
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('expired');
    });

    it('answers 503 instagram_unavailable with Retry-After when Instagram throttles', async () => {
      const profile = await connectAccount();
      graph()
        .get(edgePath({ profile, edge: 'stories' }))
        .query(true)
        .reply(429, graphError(613), { 'Retry-After': '30' });

      const response = await get({ url: INSTAGRAM_STORIES_PATH });

      expect(response.statusCode).toBe(503);
      expect(errorOf(response).reason).toBe('instagram_unavailable');
      expect(response.headers['retry-after']).toBe('30');
    });

    it('answers 404 team_organization_required on a personal organization (IA3)', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes();

      const response = await get({ url: INSTAGRAM_STORIES_PATH, token: personal.token });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('team_organization_required');
    });
  });
});
