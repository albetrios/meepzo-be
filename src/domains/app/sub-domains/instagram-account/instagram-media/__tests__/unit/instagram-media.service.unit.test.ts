import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The `instagram` circuit in memory with a low threshold — no Redis, and quick to open.
vi.mock('@/infrastructure/resilience/circuit-breaker.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/infrastructure/resilience/circuit-breaker.js')>();
  return {
    ...actual,
    metaGraphCircuit: new actual.CircuitBreaker({
      name: 'meta',
      failureThreshold: 3,
      resetTimeoutMs: 60_000,
    }),
  };
});

import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  META_GRAPH_VERSION,
  META_GRAPH_BASE_URL,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import type { InstagramAccountRow } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramAccountReadAccess } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import type { InstagramMediaRepository } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import type { InstagramMediaConnectionBreakPort } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.types.js';

const ACCOUNT_TOKEN = 'IGAA-picker-plain-token';
const APP_USER_ID = '8724000000000001';
const MEDIA_PATH = `/${META_GRAPH_VERSION}/${APP_USER_ID}/media`;
const STORIES_PATH = `/${META_GRAPH_VERSION}/${APP_USER_ID}/stories`;
const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: 'org_aaaaaaaaaaaaaaaaaaaaa' });
const channelAccount = { organizationId: 41, channelAccountId: 7 };
const channelConnection = { organizationId: 41, channelConnectionId: 12 };
const CHANNEL_ACCOUNT_PUBLIC_ID = 'cha_aaaaaaaaaaaaaaaaaaaaa';

/** A Graph error body, as graph.instagram.com sends it. */
function graphError(code: number, errorSubcode?: number) {
  return {
    error: {
      message: 'Instagram error',
      type: 'OAuthException',
      code,
      ...(errorSubcode === undefined ? {} : { error_subcode: errorSubcode }),
    },
  };
}

/** The named account the mocked account service hands out. */
function accountAccess({
  accountStatus = 'connected',
  connectionStatus = 'connected',
  encryptedAccessToken = encryptFieldSecret(ACCOUNT_TOKEN),
}: {
  accountStatus?: InstagramAccountRow['connection_status'];
  connectionStatus?: string;
  encryptedAccessToken?: string | null;
} = {}): InstagramAccountReadAccess {
  return {
    account: {
      id: 3,
      organization_id: channelAccount.organizationId,
      channel_account_id: channelAccount.channelAccountId,
      instagram_user_id: APP_USER_ID,
      connection_status: accountStatus,
    } as InstagramAccountRow,
    channelAccount,
    channelConnection,
    connectionStatus,
    channelConnectionPublicId: 'chc_aaaaaaaaaaaaaaaaaaaaa',
    clientBusinessId: '1029384756',
    encryptedAccessToken,
  };
}

/**
 * The post and story pickers' service (routes-final § 2.C, IA15) without a database: the account
 * service and the connection's break are mocked, Meta is nock. Pins the paging pass-through, `kind`
 * and the picture fallback, every mapping of 2.C.9 — and that only Meta's 190 breaks the
 * connection (MC11).
 */
describe('InstagramMediaService pickers', () => {
  let findAccountReadAccess: ReturnType<typeof vi.fn>;
  let markConnectionBroken: InstagramMediaConnectionBreakPort['markConnectionBroken'] &
    ReturnType<typeof vi.fn>;
  let mediaRepository: { upsertForAccount: ReturnType<typeof vi.fn> };
  let service: InstagramMediaService;

  beforeEach(async () => {
    await metaGraphCircuit.reset();
    findAccountReadAccess = vi.fn().mockResolvedValue(accountAccess());
    markConnectionBroken = vi.fn(async () => true);
    mediaRepository = { upsertForAccount: vi.fn() };
    service = new InstagramMediaService(
      mediaRepository as unknown as InstagramMediaRepository,
      { findAccountReadAccess } as unknown as InstagramAccountService,
      { markConnectionBroken },
    );
  });

  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });

  function graph(): nock.Scope {
    return nock(META_GRAPH_BASE_URL).matchHeader('authorization', `Bearer ${ACCOUNT_TOKEN}`);
  }

  async function captureError(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      await run();
    } catch (error) {
      return error as Record<string, unknown>;
    }
    throw new Error('expected the call to fail');
  }

  const listInput = {
    scope,
    channelAccountPublicId: CHANNEL_ACCOUNT_PUBLIC_ID,
    limit: 2,
    after: undefined,
    requestId: 'request-picker',
  };

  it('passes limit and the cursor on, maps the posts, and gives Instagram’s next cursor', async () => {
    graph()
      .get(MEDIA_PATH)
      .query((query) => query.limit === '2' && query.after === 'QVFIUcursor')
      .reply(200, {
        data: [
          {
            id: '18030000000000001',
            caption: 'New drop',
            media_type: 'IMAGE',
            media_product_type: 'FEED',
            timestamp: '2026-11-20T10:00:00+0000',
            comments_count: 12,
            like_count: 340,
          },
        ],
        paging: {
          cursors: { after: 'QVFIUnext' },
          next: 'https://graph.instagram.com/next-page',
        },
      });

    const page = await service.listMedia({ ...listInput, after: 'QVFIUcursor' });

    expect(page).toEqual({
      items: [
        expect.objectContaining({
          instagram_media_id: '18030000000000001',
          media_type: 'image',
          kind: 'post',
          media_product_type: 'feed',
          published_at: '2026-11-20T10:00:00.000Z',
        }),
      ],
      limit: 2,
      nextCursor: 'QVFIUnext',
    });
    expect(findAccountReadAccess).toHaveBeenCalledWith({
      scope,
      channelAccountPublicId: CHANNEL_ACCOUNT_PUBLIC_ID,
    });
    expect(markConnectionBroken).not.toHaveBeenCalled();
    expect(mediaRepository.upsertForAccount).not.toHaveBeenCalled();
  });

  it('gives no next cursor on the last page, even when Instagram names one', async () => {
    graph()
      .get(STORIES_PATH)
      .query(true)
      .reply(200, {
        data: [
          { id: '17900000000000001', media_type: 'IMAGE', timestamp: '2026-11-21T07:15:00+0000' },
        ],
        paging: { cursors: { after: 'QVFIUlast' } },
      });

    const page = await service.listStories(listInput);

    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      expect.objectContaining({
        instagram_story_id: '17900000000000001',
        expires_at: '2026-11-22T07:15:00.000Z',
      }),
    ]);
  });

  it('maps kind from the product type, and falls back to the thumbnail, then the permalink, for the picture', async () => {
    graph()
      .get(MEDIA_PATH)
      .query(true)
      .reply(200, {
        data: [
          {
            id: '18030000000000002',
            media_type: 'VIDEO',
            media_product_type: 'REELS',
            thumbnail_url: 'https://cdn.example.com/reel.jpg',
            permalink: 'https://www.instagram.com/reel/A/',
            timestamp: '2026-11-19T08:30:00+0000',
          },
          {
            id: '18030000000000003',
            media_type: 'IMAGE',
            media_product_type: 'AD',
            permalink: 'https://www.instagram.com/p/Ad/',
            timestamp: '2026-11-18T08:30:00+0000',
          },
          { id: '18030000000000004', timestamp: '2026-11-17T08:30:00+0000' },
        ],
      });

    const page = await service.listMedia(listInput);

    expect(page.items.map((item) => [item.kind, item.media_url])).toEqual([
      ['reel', 'https://cdn.example.com/reel.jpg'],
      ['ad_post', 'https://www.instagram.com/p/Ad/'],
      ['post', null],
    ]);
  });

  it.each([
    ['the account is error', { accountStatus: 'error' as const }],
    ['the connection is error', { connectionStatus: 'error' }],
    ['the connection holds no token', { encryptedAccessToken: null }],
  ])(
    'answers 404 instagram_reconnect_required when %s, without calling Meta',
    async (_case, overrides) => {
      findAccountReadAccess.mockResolvedValue(accountAccess(overrides));

      const error = await captureError(() => service.listMedia(listInput));

      expect(error).toMatchObject({ statusCode: 404, reason: 'instagram_reconnect_required' });
      expect(markConnectionBroken).not.toHaveBeenCalled();
    },
  );

  it('passes the account service’s own errors (not found, team only) through unchanged', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    findAccountReadAccess.mockRejectedValue(notFound);

    await expect(service.listMedia(listInput)).rejects.toBe(notFound);
  });

  it.each([
    ['media', MEDIA_PATH, graphError(190, 463)],
    ['stories', STORIES_PATH, graphError(190)],
  ])(
    'breaks the connection on Meta’s 190 (%s), then answers 404 instagram_reconnect_required (MC11)',
    async (edge, path, body) => {
      graph().get(path).query(true).reply(400, body);

      const error = await captureError(() =>
        edge === 'media' ? service.listMedia(listInput) : service.listStories(listInput),
      );

      expect(error).toMatchObject({ statusCode: 404, reason: 'instagram_reconnect_required' });
      expect(markConnectionBroken).toHaveBeenCalledWith({
        scope,
        channelConnection,
        lastCheckError: expect.stringMatching(/^auth \(code 190/),
        requestId: 'request-picker',
      });
    },
  );

  it('answers 404 instagram_reconnect_required on a refused permission without breaking the connection', async () => {
    graph().get(MEDIA_PATH).query(true).reply(400, graphError(10));

    const error = await captureError(() => service.listMedia(listInput));

    expect(error).toMatchObject({ statusCode: 404, reason: 'instagram_reconnect_required' });
    expect(markConnectionBroken).not.toHaveBeenCalled();
  });

  it('answers 503 instagram_unavailable with Instagram’s Retry-After when it throttles', async () => {
    graph().get(MEDIA_PATH).query(true).reply(429, graphError(4), { 'Retry-After': '120' });

    const error = await captureError(() => service.listMedia(listInput));

    expect(error).toMatchObject({
      statusCode: 503,
      reason: 'instagram_unavailable',
      retryAfterSeconds: 120,
    });
    expect(markConnectionBroken).not.toHaveBeenCalled();
  });

  it('answers 503 instagram_unavailable with a Retry-After when Instagram fails', async () => {
    graph().get(MEDIA_PATH).query(true).reply(500, graphError(2));

    const error = await captureError(() => service.listMedia(listInput));

    expect(error).toMatchObject({ statusCode: 503, reason: 'instagram_unavailable' });
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(error).not.toBeInstanceOf(MetaGraphApiError);
  });

  it('answers 503 instagram_unavailable when Instagram refuses the request itself', async () => {
    graph().get(MEDIA_PATH).query(true).reply(400, graphError(100));

    const error = await captureError(() => service.listMedia(listInput));

    expect(error).toMatchObject({ statusCode: 503, reason: 'instagram_unavailable' });
    expect(markConnectionBroken).not.toHaveBeenCalled();
  });

  it('answers 503 instagram_unavailable with the circuit’s wait once the circuit is open', async () => {
    graph().get(MEDIA_PATH).query(true).times(3).reply(500, graphError(2));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await captureError(() => service.listMedia(listInput));
    }

    const error = await captureError(() => service.listMedia(listInput));

    expect(error).toMatchObject({ statusCode: 503, reason: 'instagram_unavailable' });
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
  });

  describe('with an app setting unset', () => {
    const savedAppId = process.env.META_APP_ID;

    beforeEach(() => {
      delete process.env.META_APP_ID;
      resetEnvCacheForTests();
    });

    afterEach(() => {
      process.env.META_APP_ID = savedAppId;
      resetEnvCacheForTests();
    });

    it('answers 503 instagram_not_configured without calling Instagram', async () => {
      const error = await captureError(() => service.listMedia(listInput));

      expect(error).toMatchObject({ statusCode: 503, reason: 'instagram_not_configured' });
    });
  });
});

describe('InstagramMediaService.upsertFromInstagram (mapping)', () => {
  it.each([
    ['an id', { media_type: 'IMAGE', timestamp: '2026-11-20T10:00:00+0000' }],
    ['a readable timestamp', { id: '18030000000000001', timestamp: 'yesterday' }],
  ])('refuses an Instagram object without %s before any write', async (_case, mediaItem) => {
    const upsertForAccount = vi.fn();
    const service = new InstagramMediaService(
      { upsertForAccount } as unknown as InstagramMediaRepository,
      {} as InstagramAccountService,
      { markConnectionBroken: vi.fn() },
    );

    await expect(
      service.upsertFromInstagram({
        scope,
        channelAccount,
        mediaItem: mediaItem as never,
      }),
    ).rejects.toMatchObject({ name: 'MetaGraphApiError', errorClass: 'outage' });
    expect(upsertForAccount).not.toHaveBeenCalled();
  });
});
