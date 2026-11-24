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
import type { InstagramAccountAccess } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import type { InstagramMediaRepository } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';

const ACCOUNT_TOKEN = 'IGAA-picker-plain-token';
const APP_USER_ID = '8724000000000001';
const MEDIA_PATH = `/${META_GRAPH_VERSION}/${APP_USER_ID}/media`;
const STORIES_PATH = `/${META_GRAPH_VERSION}/${APP_USER_ID}/stories`;
const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: 'org_aaaaaaaaaaaaaaaaaaaaa' });
const instagramAccount = { organizationId: 41, instagramAccountId: 7 };

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

/** The live account the mocked account service hands out. */
function accountAccess({
  connectionStatus = 'connected',
  encryptedAccessToken = encryptFieldSecret(ACCOUNT_TOKEN),
}: {
  connectionStatus?: InstagramAccountRow['connection_status'];
  encryptedAccessToken?: string | null;
} = {}): InstagramAccountAccess {
  return {
    account: {
      id: instagramAccount.instagramAccountId,
      organization_id: instagramAccount.organizationId,
      instagram_user_id: APP_USER_ID,
      connection_status: connectionStatus,
    } as InstagramAccountRow,
    instagramAccount,
    encryptedAccessToken,
  };
}

/**
 * The post and story pickers' service (routes-final § 1.C, IA16) without a database: the account
 * service is mocked, Instagram is nock. Pins the paging pass-through and every mapping of 1.C.9 —
 * and that a refused token marks the account broken while nothing else does.
 */
describe('InstagramMediaService pickers', () => {
  let findLiveAccountAccess: ReturnType<typeof vi.fn>;
  let markConnectionBroken: ReturnType<typeof vi.fn>;
  let mediaRepository: { upsertForAccount: ReturnType<typeof vi.fn> };
  let service: InstagramMediaService;

  beforeEach(async () => {
    await metaGraphCircuit.reset();
    findLiveAccountAccess = vi.fn().mockResolvedValue(accountAccess());
    markConnectionBroken = vi.fn().mockResolvedValue(null);
    mediaRepository = { upsertForAccount: vi.fn() };
    service = new InstagramMediaService(
      mediaRepository as unknown as InstagramMediaRepository,
      { findLiveAccountAccess, markConnectionBroken } as unknown as InstagramAccountService,
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

  const listInput = { scope, limit: 2, after: undefined, requestId: 'request-picker' };

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
          media_product_type: 'feed',
          published_at: '2026-11-20T10:00:00.000Z',
        }),
      ],
      limit: 2,
      nextCursor: 'QVFIUnext',
    });
    expect(findLiveAccountAccess).toHaveBeenCalledWith({ scope });
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

  it.each(['expired', 'error'] as const)(
    'answers 404 instagram_reconnect_required for an %s account without calling Instagram',
    async (connectionStatus) => {
      findLiveAccountAccess.mockResolvedValue(accountAccess({ connectionStatus }));

      const error = await captureError(() => service.listMedia(listInput));

      expect(error).toMatchObject({ statusCode: 404, reason: 'instagram_reconnect_required' });
      expect(markConnectionBroken).not.toHaveBeenCalled();
    },
  );

  it('answers 404 instagram_reconnect_required when the account holds no token', async () => {
    findLiveAccountAccess.mockResolvedValue(accountAccess({ encryptedAccessToken: null }));

    const error = await captureError(() => service.listStories(listInput));

    expect(error).toMatchObject({ statusCode: 404, reason: 'instagram_reconnect_required' });
  });

  it('passes the account service’s own errors (not connected, team only) through unchanged', async () => {
    const notConnected = Object.assign(new Error('not connected'), { statusCode: 404 });
    findLiveAccountAccess.mockRejectedValue(notConnected);

    await expect(service.listMedia(listInput)).rejects.toBe(notConnected);
  });

  it('marks an expired token expired, then answers 404 instagram_reconnect_required (IA9)', async () => {
    graph().get(MEDIA_PATH).query(true).reply(400, graphError(190, 463));

    const error = await captureError(() => service.listMedia(listInput));

    expect(error).toMatchObject({ statusCode: 404, reason: 'instagram_reconnect_required' });
    expect(markConnectionBroken).toHaveBeenCalledWith({
      scope,
      instagramAccount,
      connectionStatus: 'expired',
      requestId: 'request-picker',
    });
  });

  it('marks any other refused token error', async () => {
    graph().get(STORIES_PATH).query(true).reply(400, graphError(190));

    await captureError(() => service.listStories(listInput));

    expect(markConnectionBroken).toHaveBeenCalledWith({
      scope,
      instagramAccount,
      connectionStatus: 'error',
      requestId: 'request-picker',
    });
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
    );

    await expect(
      service.upsertFromInstagram({
        scope,
        instagramAccount,
        mediaItem: mediaItem as never,
      }),
    ).rejects.toMatchObject({ name: 'MetaGraphApiError', errorClass: 'outage' });
    expect(upsertForAccount).not.toHaveBeenCalled();
  });
});
