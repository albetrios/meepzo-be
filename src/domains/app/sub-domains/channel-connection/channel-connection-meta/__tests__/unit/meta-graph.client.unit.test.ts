import { createHmac } from 'node:crypto';
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

import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  assertInstagramConfigured,
  META_GRAPH_VERSION,
  META_GRAPH_BASE_URL,
  isMetaConfigured,
  listMetaAdAccountAds,
  listMetaAdAccounts,
  META_ASSIGNED_ACCOUNTS_MAX_PAGES,
  listMetaAssignedInstagramAccounts,
  readMetaClientBusinessId,
  readMetaGrantedPermissions,
  listInstagramMedia,
  listInstagramStories,
  readInstagramAccountProfile,
  readMetaAppSecret,
  readInstagramMediaItem,
  listInstagramMediaComments,
  readInstagramCommentTime,
  readInstagramUserProfile,
  replyToInstagramComment,
  sendInstagramMessage,
  deleteInstagramIceBreakers,
  probeInstagramMessageAccess,
  readInstagramWebhookSubscribedFields,
  setInstagramIceBreakers,
  subscribeInstagramWebhookFields,
  unsubscribeInstagramWebhookFields,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { getEnv, resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { ServiceUnavailableError } from '@/shared/errors/index.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';

const VERSION_PATH = `/${META_GRAPH_VERSION}`;
const ACCOUNT_TOKEN = 'EAAG-long-lived-plain-token';
const APP_USER_ID = '9876543210';
const MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count,children{id,media_type,media_url}';

let encryptedAccountToken: string;

/** A Graph error body, as graph.facebook.com sends it. */
function graphError(code: number, errorSubcode?: number) {
  return {
    error: {
      message: 'Instagram error',
      type: 'OAuthException',
      code,
      ...(errorSubcode === undefined ? {} : { error_subcode: errorSubcode }),
      fbtrace_id: 'trace-unit',
    },
  };
}

/** The Graph host, expecting the account's token in the `Authorization` header only. */
function graphWithAccountToken(): nock.Scope {
  return nock(META_GRAPH_BASE_URL).matchHeader('authorization', `Bearer ${ACCOUNT_TOKEN}`);
}

/** A Graph query plus the `appsecret_proof` of the account token (MC2). */
function withProof(query: Record<string, string> = {}): Record<string, string> {
  const appSecret = getEnv().META_APP_SECRET ?? '';
  return {
    ...query,
    appsecret_proof: createHmac('sha256', appSecret).update(ACCOUNT_TOKEN).digest('hex'),
  };
}

beforeEach(async () => {
  encryptedAccountToken = encryptFieldSecret(ACCOUNT_TOKEN);
  await metaGraphCircuit.reset();
});

afterEach(() => {
  expect(nock.pendingMocks()).toEqual([]);
  nock.cleanAll();
});

describe('Instagram client settings', () => {
  it('pins Graph API v27.0 on graph.facebook.com — no Instagram Login host is left (AC-1.17)', async () => {
    expect(META_GRAPH_VERSION).toBe('v27.0');
    expect(META_GRAPH_BASE_URL).toBe('https://graph.facebook.com');
    const client = await import(
      '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js'
    );
    expect(Object.keys(client)).not.toContain('INSTAGRAM_LOGIN_GRAPH_BASE_URL');
    expect(Object.keys(client)).not.toContain('refreshInstagramLongLivedAccessToken');
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

    it('is not configured', () => {
      expect(isMetaConfigured()).toBe(false);
    });

    it('fails the configured check with 503 instagram_not_configured (the pickers, IA16)', () => {
      expect(() => assertInstagramConfigured()).toThrow(ServiceUnavailableError);
      try {
        assertInstagramConfigured();
      } catch (error) {
        expect(error).toMatchObject({
          statusCode: 503,
          messageKey: 'errors:instagramNotConfigured',
          reason: 'instagram_not_configured',
        });
      }
    });
  });

  it('is configured with all four settings', () => {
    expect(isMetaConfigured()).toBe(true);
    expect(() => assertInstagramConfigured()).not.toThrow();
  });

  describe('the app secret alone (Meta callbacks, IA18)', () => {
    it('reads the app secret, whatever the other settings', () => {
      const savedAppId = process.env.META_APP_ID;
      delete process.env.META_APP_ID;
      resetEnvCacheForTests();
      try {
        expect(readMetaAppSecret()).toBe(getEnv().META_APP_SECRET);
        expect(readMetaAppSecret().length).toBeGreaterThan(0);
      } finally {
        process.env.META_APP_ID = savedAppId;
        resetEnvCacheForTests();
      }
    });

    it('answers 503 instagram_not_configured without it', () => {
      const savedAppSecret = process.env.META_APP_SECRET;
      delete process.env.META_APP_SECRET;
      resetEnvCacheForTests();
      try {
        expect(() => readMetaAppSecret()).toThrow(
          expect.objectContaining({
            statusCode: 503,
            messageKey: 'errors:instagramNotConfigured',
            reason: 'instagram_not_configured',
          }),
        );
      } finally {
        process.env.META_APP_SECRET = savedAppSecret;
        resetEnvCacheForTests();
      }
    });
  });
});

describe('Graph reads (token in the Authorization header, never the URL)', () => {
  it('reads an account profile on graph.facebook.com by its Instagram user id (MC7, P17)', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}`)
      .query(
        withProof({
          fields:
            'id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website',
        }),
      )
      .reply(200, {
        id: APP_USER_ID,
        username: 'meepzo.shop',
        name: 'Acme Shop',
        profile_picture_url: 'https://scontent.cdninstagram.com/picture.jpg',
        followers_count: 1200,
        follows_count: 80,
        media_count: 54,
        biography: 'We sell things',
      });

    await expect(
      readInstagramAccountProfile({
        encryptedAccessToken: encryptedAccountToken,
        instagramUserId: APP_USER_ID,
      }),
    ).resolves.toEqual({
      instagramUserId: APP_USER_ID,
      username: 'meepzo.shop',
      name: 'Acme Shop',
      profilePictureUrl: 'https://scontent.cdninstagram.com/picture.jpg',
      followersCount: 1200,
      followsCount: 80,
      mediaCount: 54,
      biography: 'We sell things',
      website: null,
    });
  });

  it('reads a profile answer wrapped in data from data[0] (D33)', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}`)
      .query(true)
      .reply(200, { data: [{ id: APP_USER_ID, username: 'meepzo.shop', followers_count: 12 }] });

    await expect(
      readInstagramAccountProfile({
        encryptedAccessToken: encryptedAccountToken,
        instagramUserId: APP_USER_ID,
      }),
    ).resolves.toMatchObject({ instagramUserId: APP_USER_ID, followersCount: 12, name: null });
  });

  it.each([
    ['without the id', { username: 'x' }],
    ['with an empty data list and no flat id', { data: [] }],
    ['that is not an object', [{ id: '1' }]],
  ])('a profile answer %s is an outage', async (_shape, body) => {
    graphWithAccountToken().get(`${VERSION_PATH}/${APP_USER_ID}`).query(true).reply(200, body);

    await expect(
      readInstagramAccountProfile({
        encryptedAccessToken: encryptedAccountToken,
        instagramUserId: APP_USER_ID,
      }),
    ).rejects.toMatchObject({ errorClass: 'outage' });
  });

  it('a token that does not decrypt is our failure: it stays a plain error and nothing is sent', async () => {
    const rejection = readInstagramAccountProfile({
      encryptedAccessToken: 'plain-token',
      instagramUserId: APP_USER_ID,
    });

    await expect(rejection).rejects.not.toBeInstanceOf(MetaGraphApiError);
    await expect(rejection).rejects.toThrow(/not encrypted/);
  });

  it("lists media with Instagram's cursor and returns the next cursor only when there is a next page", async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}/media`)
      .query(withProof({ fields: MEDIA_FIELDS, limit: '25', after: 'cursor-one' }))
      .reply(200, {
        data: [
          { id: '18000000000000001', media_type: 'IMAGE', timestamp: '2026-11-20T10:00:00+0000' },
        ],
        paging: {
          cursors: { before: 'b', after: 'cursor-two' },
          next: 'https://graph.facebook.com/v27.0/next',
        },
      });
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}/media`)
      .query(withProof({ fields: MEDIA_FIELDS, limit: '25', after: 'cursor-two' }))
      .reply(200, {
        data: [{ id: '18000000000000002' }, { caption: 'an item without an id is dropped' }],
        paging: { cursors: { before: 'c', after: 'cursor-three' } },
      });

    const firstPage = await listInstagramMedia({
      encryptedAccessToken: encryptedAccountToken,
      instagramUserId: APP_USER_ID,
      limit: 25,
      after: 'cursor-one',
    });
    const lastPage = await listInstagramMedia({
      encryptedAccessToken: encryptedAccountToken,
      instagramUserId: APP_USER_ID,
      limit: 25,
      after: 'cursor-two',
    });

    expect(firstPage).toEqual({
      items: [
        { id: '18000000000000001', media_type: 'IMAGE', timestamp: '2026-11-20T10:00:00+0000' },
      ],
      nextCursor: 'cursor-two',
    });
    expect(lastPage).toEqual({ items: [{ id: '18000000000000002' }], nextCursor: null });
  });

  it('lists live stories with the story fields and no cursor on the first page', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}/stories`)
      .query(
        withProof({
          fields: 'id,media_type,media_url,thumbnail_url,permalink,timestamp',
          limit: '10',
        }),
      )
      .reply(200, { data: [{ id: '17900000000000001', media_type: 'VIDEO' }] });

    await expect(
      listInstagramStories({
        encryptedAccessToken: encryptedAccountToken,
        instagramUserId: APP_USER_ID,
        limit: 10,
      }),
    ).resolves.toEqual({
      items: [{ id: '17900000000000001', media_type: 'VIDEO' }],
      nextCursor: null,
    });
  });

  it('a list answer without data is an outage', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}/stories`)
      .query(true)
      .reply(200, {});

    await expect(
      listInstagramStories({
        encryptedAccessToken: encryptedAccountToken,
        instagramUserId: APP_USER_ID,
        limit: 10,
      }),
    ).rejects.toMatchObject({ errorClass: 'outage' });
  });

  it('reads one post by its media id', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/18000000000000001`)
      .query(withProof({ fields: MEDIA_FIELDS }))
      .reply(200, { id: '18000000000000001', caption: 'hello' });

    await expect(
      readInstagramMediaItem({
        encryptedAccessToken: encryptedAccountToken,
        instagramMediaId: '18000000000000001',
      }),
    ).resolves.toEqual({ id: '18000000000000001', caption: 'hello' });
  });

  it("lists a post's comments newest first, 50 a page, with Meta's cursor (WC-26)", async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/18000000000000001/comments`)
      .query(
        withProof({
          fields: 'id,text,timestamp,username,from,parent_id',
          limit: '50',
          after: 'c1',
        }),
      )
      .reply(200, {
        data: [{ id: '17900000000000001', text: 'price?' }, { text: 'no id' }],
        paging: { cursors: { after: 'c2' }, next: 'https://graph.facebook.com/next' },
      });

    await expect(
      listInstagramMediaComments({
        encryptedAccessToken: encryptedAccountToken,
        instagramMediaId: '18000000000000001',
        isRepliesIncluded: false,
        after: 'c1',
      }),
    ).resolves.toEqual({
      items: [{ id: '17900000000000001', text: 'price?' }],
      nextCursor: 'c2',
    });
  });

  it('asks for the replies only when comment replies are on (D64), and a list without data is an outage', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/18000000000000001/comments`)
      .query(
        withProof({
          fields:
            'id,text,timestamp,username,from,parent_id,replies{id,text,timestamp,username,from,parent_id}',
          limit: '50',
        }),
      )
      .reply(200, { error_free: true });

    await expect(
      listInstagramMediaComments({
        encryptedAccessToken: encryptedAccountToken,
        instagramMediaId: '18000000000000001',
        isRepliesIncluded: true,
      }),
    ).rejects.toMatchObject({ errorClass: 'outage' });
  });

  it("reads a comment's own time; an answer without a readable time is null", async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/17900000000000001`)
      .query(withProof({ fields: 'timestamp' }))
      .reply(200, { timestamp: '2026-11-20T10:00:00+0000', id: '17900000000000001' });
    graphWithAccountToken()
      .get(`${VERSION_PATH}/17900000000000002`)
      .query(withProof({ fields: 'timestamp' }))
      .reply(200, { id: '17900000000000002' });

    await expect(
      readInstagramCommentTime({
        encryptedAccessToken: encryptedAccountToken,
        instagramCommentId: '17900000000000001',
      }),
    ).resolves.toEqual(new Date('2026-11-20T10:00:00Z'));
    await expect(
      readInstagramCommentTime({
        encryptedAccessToken: encryptedAccountToken,
        instagramCommentId: '17900000000000002',
      }),
    ).resolves.toBeNull();
  });

  it("reads a person's profile and follow status in one call", async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/5550001`)
      .query(
        withProof({ fields: 'name,username,profile_pic,follower_count,is_user_follow_business' }),
      )
      .reply(200, {
        name: 'Asha',
        username: 'asha.k',
        profile_pic: 'https://scontent.cdninstagram.com/asha.jpg',
        follower_count: 310,
        is_user_follow_business: true,
        id: '5550001',
      });

    await expect(
      readInstagramUserProfile({
        encryptedAccessToken: encryptedAccountToken,
        instagramScopedUserId: '5550001',
      }),
    ).resolves.toEqual({
      name: 'Asha',
      username: 'asha.k',
      profilePictureUrl: 'https://scontent.cdninstagram.com/asha.jpg',
      followerCount: 310,
      isUserFollowingBusiness: true,
    });
  });
});

describe('webhook subscription', () => {
  it('subscribes the six fields (WC-30) and unsubscribes', async () => {
    graphWithAccountToken()
      .post(`${VERSION_PATH}/${APP_USER_ID}/subscribed_apps`)
      .query(
        withProof({
          subscribed_fields:
            'comments,live_comments,messages,messaging_postbacks,messaging_referral,message_reactions',
        }),
      )
      .reply(200, { success: true });
    graphWithAccountToken()
      .delete(`${VERSION_PATH}/${APP_USER_ID}/subscribed_apps`)
      .query(withProof())
      .reply(200, { success: true });
    const options = {
      encryptedAccessToken: encryptedAccountToken,
      instagramUserId: APP_USER_ID,
    };

    await expect(subscribeInstagramWebhookFields(options)).resolves.toBeUndefined();
    await expect(unsubscribeInstagramWebhookFields(options)).resolves.toBeUndefined();
  });

  it('an answer other than success: true is an outage', async () => {
    graphWithAccountToken()
      .post(`${VERSION_PATH}/${APP_USER_ID}/subscribed_apps`)
      .query(true)
      .reply(200, { success: false });

    await expect(
      subscribeInstagramWebhookFields({
        encryptedAccessToken: encryptedAccountToken,
        instagramUserId: APP_USER_ID,
      }),
    ).rejects.toMatchObject({ errorClass: 'outage' });
  });
});

describe('the account set-up calls (WC-25, WC-30, WC-31)', () => {
  const options = () => ({
    encryptedAccessToken: encryptedAccountToken,
    instagramUserId: APP_USER_ID,
  });

  it("reads our app's subscribed fields and ignores another app's", async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}/subscribed_apps`)
      .query(withProof())
      .reply(200, {
        data: [
          { id: '111', name: 'Other', subscribed_fields: ['feed'] },
          { id: '222', name: 'Ours', subscribed_fields: ['comments', 'messages', 7] },
        ],
      });
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}/subscribed_apps`)
      .query(withProof())
      .reply(200, { data: [{ id: '111', subscribed_fields: ['comments'] }] });

    await expect(
      readInstagramWebhookSubscribedFields({ ...options(), appId: '222' }),
    ).resolves.toEqual(['comments', 'messages']);
    await expect(
      readInstagramWebhookSubscribedFields({ ...options(), appId: '222' }),
    ).resolves.toEqual([]);
  });

  it('writes the whole ice-breaker list and removes it', async () => {
    graphWithAccountToken()
      .post(`${VERSION_PATH}/${APP_USER_ID}/messenger_profile`, {
        platform: 'instagram',
        ice_breakers: [
          {
            locale: 'default',
            call_to_actions: [{ question: 'Price?', payload: 'starter:aut_1' }],
          },
        ],
      })
      .query(withProof())
      .reply(200, { result: 'success' });
    graphWithAccountToken()
      .delete(`${VERSION_PATH}/${APP_USER_ID}/messenger_profile`, { fields: ['ice_breakers'] })
      .query(withProof({ platform: 'instagram' }))
      .reply(200, { result: 'success' });

    await expect(
      setInstagramIceBreakers({
        ...options(),
        iceBreakers: [{ question: 'Price?', payload: 'starter:aut_1' }],
      }),
    ).resolves.toBeUndefined();
    await expect(deleteInstagramIceBreakers(options())).resolves.toBeUndefined();
  });

  it('a Messenger profile answer other than success is an outage', async () => {
    graphWithAccountToken()
      .post(`${VERSION_PATH}/${APP_USER_ID}/messenger_profile`)
      .query(true)
      .reply(200, { result: 'nope' });

    await expect(setInstagramIceBreakers({ ...options(), iceBreakers: [] })).rejects.toMatchObject({
      errorClass: 'outage',
    });
  });

  it('probes message access: on, off (200 / 10·2534077), unknown, and a refused token thrown', async () => {
    const probe = async (status: number, body: unknown) => {
      await metaGraphCircuit.reset();
      graphWithAccountToken()
        .get(`${VERSION_PATH}/${APP_USER_ID}/conversations`)
        .query(withProof({ platform: 'instagram', limit: '1', fields: 'id' }))
        .reply(status, body as nock.Body);
      return probeInstagramMessageAccess(options());
    };

    await expect(probe(200, { data: [] })).resolves.toBe('on');
    await expect(probe(403, graphError(200, 2534041))).resolves.toBe('off');
    await expect(probe(400, graphError(10, 2534077))).resolves.toBe('off');
    await expect(probe(400, graphError(100))).resolves.toBe('unknown');
    await expect(probe(401, graphError(190))).rejects.toBeInstanceOf(MetaGraphApiError);
  });
});

describe('sends', () => {
  it('sends a private reply to a comment through /messages', async () => {
    graphWithAccountToken()
      .post(`${VERSION_PATH}/${APP_USER_ID}/messages`, {
        recipient: { comment_id: '17850000000000001' },
        message: { text: 'Check your DMs!' },
      })
      .query(withProof())
      .matchHeader('content-type', 'application/json')
      .reply(200, { recipient_id: '5550001', message_id: 'aWdfZAG1-message' });

    await expect(
      sendInstagramMessage({
        encryptedAccessToken: encryptedAccountToken,
        instagramUserId: APP_USER_ID,
        recipient: { comment_id: '17850000000000001' },
        message: { text: 'Check your DMs!' },
      }),
    ).resolves.toEqual({ messageId: 'aWdfZAG1-message', recipientId: '5550001' });
  });

  it('flags a refused email quick reply so the question can go again as plain text', async () => {
    graphWithAccountToken()
      .post(`${VERSION_PATH}/${APP_USER_ID}/messages`)
      .query(true)
      .reply(400, graphError(100, 2534015));

    await expect(
      sendInstagramMessage({
        encryptedAccessToken: encryptedAccountToken,
        instagramUserId: APP_USER_ID,
        recipient: { id: '5550001' },
        message: {
          text: 'Please share your email to continue!',
          quick_replies: [{ content_type: 'user_email' }],
        },
      }),
    ).rejects.toMatchObject({ errorClass: 'refused', isQuickReplyRefused: true });
  });

  it('replies publicly under a comment', async () => {
    graphWithAccountToken()
      .post(`${VERSION_PATH}/17850000000000001/replies`, { message: 'Sent you a DM' })
      .query(withProof())
      .reply(200, { id: '17850000000000002' });

    await expect(
      replyToInstagramComment({
        encryptedAccessToken: encryptedAccountToken,
        instagramCommentId: '17850000000000001',
        text: 'Sent you a DM',
      }),
    ).resolves.toEqual({ instagramCommentReplyId: '17850000000000002' });
  });
});

describe('failures and the instagram circuit', () => {
  it('a throttle carries the wait Instagram named', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}`)
      .query(true)
      .reply(429, graphError(4), { 'Retry-After': '90' });

    await expect(
      readInstagramAccountProfile({
        encryptedAccessToken: encryptedAccountToken,
        instagramUserId: APP_USER_ID,
      }),
    ).rejects.toMatchObject({ errorClass: 'throttled', retryAfterMs: 90_000 });
  });

  it('a network failure is an outage', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}`)
      .query(true)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    await expect(
      readInstagramAccountProfile({
        encryptedAccessToken: encryptedAccountToken,
        instagramUserId: APP_USER_ID,
      }),
    ).rejects.toMatchObject({
      errorClass: 'outage',
      category: 'network',
      integration: 'meta-graph',
    });
  });

  it('refusals never open the circuit; outages do, and then nothing is sent', async () => {
    const readProfile = () =>
      readInstagramAccountProfile({
        encryptedAccessToken: encryptedAccountToken,
        instagramUserId: APP_USER_ID,
      });
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}`)
      .query(true)
      .times(2)
      .reply(400, graphError(190));
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}`)
      .query(true)
      .times(2)
      .reply(400, graphError(100));
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}`)
      .query(true)
      .times(2)
      .reply(400, graphError(17));

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(readProfile()).rejects.toBeInstanceOf(MetaGraphApiError);
    }
    expect(await metaGraphCircuit.getState()).toBe('CLOSED');

    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}`)
      .query(true)
      .times(3)
      .reply(503, 'down');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(readProfile()).rejects.toMatchObject({ errorClass: 'outage' });
    }
    expect(await metaGraphCircuit.getState()).toBe('OPEN');

    // No interceptor is left: the open circuit answers before any request leaves.
    const rejection = readProfile();
    await expect(rejection).rejects.toMatchObject({
      errorClass: 'outage',
      category: 'circuit_open',
    });
    await expect(rejection).rejects.toHaveProperty('retryAfterMs', expect.any(Number));
  });
});

describe('Unified Login reads with a connection token (MC2)', () => {
  it('reads the business id', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me`)
      .query(withProof({ fields: 'client_business_id' }))
      .reply(200, { client_business_id: '5550001234', id: '1' });
    await expect(
      readMetaClientBusinessId({ encryptedAccessToken: encryptedAccountToken }),
    ).resolves.toBe('5550001234');
  });

  it('an answer without the business id is an outage', async () => {
    graphWithAccountToken().get(`${VERSION_PATH}/me`).query(true).reply(200, { id: '1' });
    await expect(
      readMetaClientBusinessId({ encryptedAccessToken: encryptedAccountToken }),
    ).rejects.toMatchObject({ errorClass: 'outage' });
  });

  it('lists the assigned Instagram accounts, dropping items without an id', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me/assigned_instagram_accounts`)
      .query(withProof({ fields: 'id,username', limit: '100' }))
      .reply(200, {
        data: [{ id: '17841400000000001', username: 'shop.one' }, { id: '17841400000000002' }, {}],
      });
    await expect(
      listMetaAssignedInstagramAccounts({ encryptedAccessToken: encryptedAccountToken }),
    ).resolves.toEqual({
      accounts: [
        { instagramUserId: '17841400000000001', username: 'shop.one' },
        { instagramUserId: '17841400000000002', username: null },
      ],
      isComplete: true,
    });
  });

  it('follows paging.next to the last page and answers the whole list (P353)', async () => {
    const firstPage = Array.from({ length: 100 }, (_unused, index) => ({
      id: `178414000000${String(index).padStart(5, '0')}`,
    }));
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me/assigned_instagram_accounts`)
      .query(withProof({ fields: 'id,username', limit: '100' }))
      .reply(200, {
        data: firstPage,
        paging: { cursors: { after: 'cursor-two' }, next: 'https://graph.facebook.com/next' },
      })
      .get(`${VERSION_PATH}/me/assigned_instagram_accounts`)
      .query(withProof({ fields: 'id,username', limit: '100', after: 'cursor-two' }))
      .reply(200, {
        data: [{ id: '17841400000000101', username: 'account.one.hundred.one' }],
        paging: { cursors: { after: 'cursor-end' } },
      });

    const list = await listMetaAssignedInstagramAccounts({
      encryptedAccessToken: encryptedAccountToken,
    });
    expect(list.isComplete).toBe(true);
    expect(list.accounts).toHaveLength(101);
    expect(list.accounts.at(-1)).toEqual({
      instagramUserId: '17841400000000101',
      username: 'account.one.hundred.one',
    });
  });

  it('stops at the page cap and says the list is not complete', async () => {
    const scope = graphWithAccountToken();
    for (let page = 0; page < META_ASSIGNED_ACCOUNTS_MAX_PAGES; page += 1) {
      scope
        .get(`${VERSION_PATH}/me/assigned_instagram_accounts`)
        .query(true)
        .reply(200, {
          data: [{ id: `178414000000${String(page).padStart(5, '0')}` }],
          paging: {
            cursors: { after: `cursor-${page + 1}` },
            next: 'https://graph.facebook.com/next',
          },
        });
    }
    const list = await listMetaAssignedInstagramAccounts({
      encryptedAccessToken: encryptedAccountToken,
    });
    expect(list.isComplete).toBe(false);
    expect(list.accounts).toHaveLength(META_ASSIGNED_ACCOUNTS_MAX_PAGES);
  });

  it('fails the whole list when a later page fails — never answers part of it', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me/assigned_instagram_accounts`)
      .query(true)
      .reply(200, {
        data: [{ id: '17841400000000001' }],
        paging: { cursors: { after: 'cursor-two' }, next: 'https://graph.facebook.com/next' },
      })
      .get(`${VERSION_PATH}/me/assigned_instagram_accounts`)
      .query(true)
      .reply(500, { error: { message: 'An unexpected error has occurred.', code: 2 } });
    await expect(
      listMetaAssignedInstagramAccounts({ encryptedAccessToken: encryptedAccountToken }),
    ).rejects.toMatchObject({ errorClass: 'outage' });
  });

  it('reads only the granted permissions', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me/permissions`)
      .query(withProof())
      .reply(200, {
        data: [
          { permission: 'instagram_basic', status: 'granted' },
          { permission: 'ads_read', status: 'declined' },
          { permission: 'instagram_manage_messages', status: 'granted' },
        ],
      });
    await expect(
      readMetaGrantedPermissions({ encryptedAccessToken: encryptedAccountToken }),
    ).resolves.toEqual(['instagram_basic', 'instagram_manage_messages']);
  });

  describe('the /debug_token fallback (fix-meta-unified-login F1)', () => {
    /** The Graph host answering `/debug_token` for the account token with the app token. */
    function debugToken(): nock.Interceptor {
      const environment = getEnv();
      return nock(META_GRAPH_BASE_URL)
        .get(`${VERSION_PATH}/debug_token`)
        .query({
          input_token: ACCOUNT_TOKEN,
          access_token: `${environment.META_APP_ID}|${environment.META_APP_SECRET}`,
        });
    }

    it('reads the scopes from /debug_token when /me/permissions answers no granted permission (AF-1)', async () => {
      graphWithAccountToken()
        .get(`${VERSION_PATH}/me/permissions`)
        .query(withProof())
        .reply(200, { data: [] });
      debugToken().reply(200, {
        data: {
          type: 'SYSTEM_USER',
          is_valid: true,
          scopes: ['instagram_basic', 'instagram_manage_messages', 'instagram_basic'],
        },
      });
      await expect(
        readMetaGrantedPermissions({ encryptedAccessToken: encryptedAccountToken }),
      ).resolves.toEqual(['instagram_basic', 'instagram_manage_messages']);
    });

    it('reads /debug_token when Meta refuses /me/permissions with code 100 or a permission code (AF-2)', async () => {
      for (const code of [100, 200]) {
        graphWithAccountToken()
          .get(`${VERSION_PATH}/me/permissions`)
          .query(withProof())
          .reply(400, graphError(code));
        debugToken().reply(200, { data: { scopes: ['instagram_manage_comments'] } });
        await expect(
          readMetaGrantedPermissions({ encryptedAccessToken: encryptedAccountToken }),
        ).resolves.toEqual(['instagram_manage_comments']);
      }
    });

    it('rethrows a dead token (190) and never asks /debug_token (AF-2)', async () => {
      graphWithAccountToken()
        .get(`${VERSION_PATH}/me/permissions`)
        .query(withProof())
        .reply(400, graphError(190));
      await expect(
        readMetaGrantedPermissions({ encryptedAccessToken: encryptedAccountToken }),
      ).rejects.toMatchObject({ errorClass: 'auth', instagramErrorCode: 190 });
    });

    it('answers an outage, never an empty list, when neither read names a permission (AF-3)', async () => {
      graphWithAccountToken()
        .get(`${VERSION_PATH}/me/permissions`)
        .query(withProof())
        .reply(400, graphError(100));
      debugToken().reply(200, { data: { is_valid: true } });
      await expect(
        readMetaGrantedPermissions({ encryptedAccessToken: encryptedAccountToken }),
      ).rejects.toMatchObject({ errorClass: 'outage' });
    });
  });

  it('lists the ad accounts (first 100)', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me/adaccounts`)
      .query(withProof({ fields: 'account_id,name,account_status', limit: '100' }))
      .reply(200, {
        data: [{ id: 'act_42', account_id: '42', name: 'Shop ads', account_status: 1 }],
      });
    await expect(
      listMetaAdAccounts({ encryptedAccessToken: encryptedAccountToken }),
    ).resolves.toEqual([{ adAccountId: '42', name: 'Shop ads', accountStatus: 1 }]);
  });

  it("lists one ad account's ads with their Instagram post and Meta's cursor", async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/act_42/ads`)
      .query(
        withProof({
          fields:
            'id,name,effective_status,created_time,creative{effective_instagram_media_id,instagram_user_id,thumbnail_url}',
          limit: '25',
          after: 'cursor-one',
        }),
      )
      .reply(200, {
        data: [
          {
            id: '2384',
            name: 'Winter sale',
            effective_status: 'ACTIVE',
            created_time: '2026-11-01T10:00:00+0000',
            creative: {
              effective_instagram_media_id: '18000000000000009',
              instagram_user_id: '17841400000000001',
              thumbnail_url: 'https://x/t.jpg',
            },
          },
          { name: 'no id' },
        ],
        paging: { cursors: { after: 'cursor-two' }, next: 'https://graph.facebook.com/next' },
      });
    await expect(
      listMetaAdAccountAds({
        encryptedAccessToken: encryptedAccountToken,
        adAccountId: '42',
        limit: 25,
        after: 'cursor-one',
      }),
    ).resolves.toEqual({
      items: [
        {
          adId: '2384',
          name: 'Winter sale',
          status: 'ACTIVE',
          instagramMediaId: '18000000000000009',
          instagramUserId: '17841400000000001',
          thumbnailUrl: 'https://x/t.jpg',
          createdAt: '2026-11-01T10:00:00+0000',
        },
      ],
      nextCursor: 'cursor-two',
    });
  });

  it('a Graph call needs the app secret for appsecret_proof — unset, 503 before any request', async () => {
    const savedAppSecret = process.env.META_APP_SECRET;
    delete process.env.META_APP_SECRET;
    resetEnvCacheForTests();
    try {
      await expect(
        readMetaClientBusinessId({ encryptedAccessToken: encryptedAccountToken }),
      ).rejects.toMatchObject({ statusCode: 503, reason: 'instagram_not_configured' });
    } finally {
      process.env.META_APP_SECRET = savedAppSecret;
      resetEnvCacheForTests();
    }
  });
});

describe("Meta's usage on every answer (MC19)", () => {
  const usageHeader = JSON.stringify({
    '5550001234': [{ type: 'instagram', call_count: 81, total_cputime: 2, total_time: 3 }],
  });

  it('hands the usage of a successful answer to the recorder', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me`)
      .query(true)
      .reply(
        200,
        { client_business_id: '5550001234' },
        {
          'X-Business-Use-Case-Usage': usageHeader,
          'X-App-Usage': JSON.stringify({ call_count: 4, total_cputime: 1, total_time: 1 }),
        },
      );
    const recordUsage = vi.fn(async () => undefined);
    await readMetaClientBusinessId({ encryptedAccessToken: encryptedAccountToken, recordUsage });
    expect(recordUsage).toHaveBeenCalledWith({
      readAt: expect.any(Date),
      appUsagePercent: 4,
      businessUseCases: [
        { assetId: '5550001234', type: 'instagram', usagePercent: 81, waitUntil: null },
      ],
    });
  });

  it('hands the usage of a throttled answer to the recorder too — 95 % waits 15 minutes', async () => {
    graphWithAccountToken()
      .post(`${VERSION_PATH}/${APP_USER_ID}/messages`)
      .query(true)
      .reply(400, graphError(80002), {
        'X-Business-Use-Case-Usage': JSON.stringify({
          '5550001234': [
            { type: 'instagram', call_count: 100, estimated_time_to_regain_access: 0 },
          ],
        }),
      });
    const recordUsage = vi.fn(async (_reading: unknown) => undefined);
    const before = Date.now();
    await expect(
      sendInstagramMessage({
        encryptedAccessToken: encryptedAccountToken,
        instagramUserId: APP_USER_ID,
        recipient: { id: '5550001' },
        message: { text: 'hi' },
        recordUsage,
      }),
    ).rejects.toMatchObject({ errorClass: 'throttled' });
    const reading = recordUsage.mock.calls[0]?.[0] as {
      businessUseCases: { usagePercent: number; waitUntil: Date }[];
    };
    expect(reading.businessUseCases[0]?.usagePercent).toBe(100);
    expect(reading.businessUseCases[0]?.waitUntil.getTime()).toBeGreaterThanOrEqual(
      before + 15 * 60_000,
    );
  });

  it('a missing header changes nothing — the recorder is not called', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me`)
      .query(true)
      .reply(200, { client_business_id: '5550001234' });
    const recordUsage = vi.fn(async () => undefined);
    await readMetaClientBusinessId({ encryptedAccessToken: encryptedAccountToken, recordUsage });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('a failing recorder never fails the call', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me`)
      .query(true)
      .reply(
        200,
        { client_business_id: '5550001234' },
        { 'X-Business-Use-Case-Usage': usageHeader },
      );
    await expect(
      readMetaClientBusinessId({
        encryptedAccessToken: encryptedAccountToken,
        recordUsage: async () => {
          throw new Error('database down');
        },
      }),
    ).resolves.toBe('5550001234');
  });
});
