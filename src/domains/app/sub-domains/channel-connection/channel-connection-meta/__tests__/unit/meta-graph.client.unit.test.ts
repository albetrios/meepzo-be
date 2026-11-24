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
  exchangeInstagramAuthorizationCode,
  exchangeInstagramLongLivedAccessToken,
  INSTAGRAM_AUTHORIZATION_BASE_URL,
  INSTAGRAM_LOGIN_GRAPH_BASE_URL,
  INSTAGRAM_LOGIN_GRAPH_VERSION,
  META_GRAPH_VERSION,
  META_GRAPH_BASE_URL,
  isInstagramConfigured,
  listMetaAdAccountAds,
  listMetaAdAccounts,
  listMetaAssignedInstagramAccounts,
  readMetaClientBusinessId,
  readMetaGrantedPermissions,
  listInstagramMedia,
  listInstagramStories,
  readInstagramAccountProfile,
  readMetaAppSecret,
  readInstagramMediaItem,
  readInstagramUserProfile,
  refreshInstagramLongLivedAccessToken,
  replyToInstagramComment,
  sendInstagramMessage,
  subscribeInstagramWebhookFields,
  unsubscribeInstagramWebhookFields,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { getEnv, resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { ServiceUnavailableError } from '@/shared/errors/index.js';
import {
  decryptFieldSecret,
  encryptFieldSecret,
} from '@/shared/utils/security/field-secret-encryption.util.js';
import {
  SENSITIVE_REDACTION_PLACEHOLDER,
  redactSensitiveUrl,
} from '@/shared/utils/security/sensitive-redaction.util.js';

const VERSION_PATH = `/${META_GRAPH_VERSION}`;
const LOGIN_VERSION_PATH = `/${INSTAGRAM_LOGIN_GRAPH_VERSION}`;
const ACCOUNT_TOKEN = 'IGAA-long-lived-plain-token';
const APP_USER_ID = '9876543210';
const MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count,children{id,media_type,media_url}';

let encryptedAccountToken: string;

/** A Graph error body, as graph.instagram.com sends it. */
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

/** The launch's Instagram Login host (`/me`, until ROUTE row R3 retires it). */
function instagramLoginWithAccountToken(): nock.Scope {
  return nock(INSTAGRAM_LOGIN_GRAPH_BASE_URL).matchHeader(
    'authorization',
    `Bearer ${ACCOUNT_TOKEN}`,
  );
}

/** A Graph query plus the `appsecret_proof` of the account token (MC2). */
function withProof(query: Record<string, string> = {}): Record<string, string> {
  const appSecret = getEnv().META_APP_SECRET ?? '';
  return {
    ...query,
    appsecret_proof: createHmac('sha256', appSecret).update(ACCOUNT_TOKEN).digest('hex'),
  };
}

/** A form body as nock hands it to a matcher: already parsed, or the raw string. */
function readFormBody(body: unknown): Record<string, string> {
  return typeof body === 'string'
    ? Object.fromEntries(new URLSearchParams(body))
    : { ...(body as Record<string, string>) };
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
  it('pins Graph API v27.0 on graph.facebook.com, and keeps the Instagram Login hosts until R3', () => {
    expect(META_GRAPH_VERSION).toBe('v27.0');
    expect(META_GRAPH_BASE_URL).toBe('https://graph.facebook.com');
    expect(INSTAGRAM_AUTHORIZATION_BASE_URL).toBe('https://api.instagram.com');
    expect(INSTAGRAM_LOGIN_GRAPH_BASE_URL).toBe('https://graph.instagram.com');
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

    it('is not configured, and both exchanges answer 503 without calling Instagram', async () => {
      expect(isInstagramConfigured()).toBe(false);

      const exchange = exchangeInstagramAuthorizationCode({ code: 'any-code' });
      await expect(exchange).rejects.toBeInstanceOf(ServiceUnavailableError);
      await expect(exchange).rejects.toMatchObject({
        statusCode: 503,
        messageKey: 'errors:instagramNotConfigured',
        reason: 'instagram_not_configured',
      });
      await expect(
        exchangeInstagramLongLivedAccessToken({
          encryptedShortLivedAccessToken: encryptedAccountToken,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableError);
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
    expect(isInstagramConfigured()).toBe(true);
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

describe('exchangeInstagramAuthorizationCode', () => {
  it('posts the documented form, strips the trailing #_, and returns the token encrypted', async () => {
    const environment = getEnv();
    nock(INSTAGRAM_AUTHORIZATION_BASE_URL)
      .post('/oauth/access_token', (body) => {
        expect(readFormBody(body)).toEqual({
          client_id: environment.META_APP_ID,
          client_secret: environment.META_APP_SECRET,
          grant_type: 'authorization_code',
          redirect_uri: environment.META_REDIRECT_URI,
          code: 'AQB-authorization-code',
        });
        return true;
      })
      .matchHeader('content-type', /application\/x-www-form-urlencoded/)
      .reply(200, {
        data: [
          {
            access_token: 'IGAA-short-lived-plain-token',
            user_id: '17841400000000000',
            permissions:
              'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments',
          },
        ],
      });

    const token = await exchangeInstagramAuthorizationCode({ code: 'AQB-authorization-code#_' });

    expect(token.encryptedAccessToken).not.toContain('IGAA-short-lived-plain-token');
    expect(decryptFieldSecret(token.encryptedAccessToken)).toBe('IGAA-short-lived-plain-token');
    expect(token.grantedPermissions).toEqual([
      'instagram_business_basic',
      'instagram_business_manage_messages',
      'instagram_business_manage_comments',
    ]);
  });

  it('reads the flat answer with a permission list too', async () => {
    nock(INSTAGRAM_AUTHORIZATION_BASE_URL)
      .post('/oauth/access_token')
      .reply(200, {
        access_token: 'IGAA-short',
        user_id: 17841400000000000,
        permissions: ['instagram_business_basic', ' instagram_business_manage_comments '],
      });

    const token = await exchangeInstagramAuthorizationCode({ code: 'code' });

    expect(decryptFieldSecret(token.encryptedAccessToken)).toBe('IGAA-short');
    expect(token.grantedPermissions).toEqual([
      'instagram_business_basic',
      'instagram_business_manage_comments',
    ]);
  });

  it('a used or expired code is refused — not an outage', async () => {
    nock(INSTAGRAM_AUTHORIZATION_BASE_URL).post('/oauth/access_token').reply(400, {
      error_type: 'OAuthException',
      code: 400,
      error_message: 'This authorization code has been used',
    });

    await expect(exchangeInstagramAuthorizationCode({ code: 'used' })).rejects.toMatchObject({
      errorClass: 'refused',
      status: 400,
      countsAsCircuitFailure: false,
    });
  });

  it('an answer without a token is an outage', async () => {
    nock(INSTAGRAM_AUTHORIZATION_BASE_URL).post('/oauth/access_token').reply(200, { data: [] });

    await expect(exchangeInstagramAuthorizationCode({ code: 'code' })).rejects.toMatchObject({
      errorClass: 'outage',
    });
  });
});

describe('the token exchange and renewal (token in the query, URL redacted)', () => {
  it('exchanges the short-lived token for a long-lived one, encrypted, with expiresAt', async () => {
    const environment = getEnv();
    const encryptedShortLivedAccessToken = encryptFieldSecret('IGAA-short-lived-plain-token');
    let requestedUrl = '';
    nock(INSTAGRAM_LOGIN_GRAPH_BASE_URL)
      .get('/access_token')
      .query({
        grant_type: 'ig_exchange_token',
        client_secret: String(environment.META_APP_SECRET),
        access_token: 'IGAA-short-lived-plain-token',
      })
      .reply(200, (uri: string) => {
        // nock hands `fetch` requests over as a Request; a path string otherwise.
        const request = uri as unknown as string | { url: string };
        requestedUrl =
          typeof request === 'string' ? `${META_GRAPH_BASE_URL}${request}` : request.url;
        return { access_token: 'IGAA-long-lived', token_type: 'bearer', expires_in: 5_183_944 };
      });
    const before = Date.now();

    const token = await exchangeInstagramLongLivedAccessToken({ encryptedShortLivedAccessToken });

    expect(decryptFieldSecret(token.encryptedAccessToken)).toBe('IGAA-long-lived');
    expect(token.encryptedAccessToken).not.toContain('IGAA-long-lived');
    expect(token.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 5_183_944_000);
    expect(token.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_183_944_000);

    // Whatever logs this URL (a Sentry breadcrumb, an error) sees neither the secret nor the token.
    const loggedUrl = redactSensitiveUrl(requestedUrl);
    expect(loggedUrl).not.toContain('IGAA-short-lived-plain-token');
    expect(loggedUrl).not.toContain(String(environment.META_APP_SECRET));
    expect(loggedUrl).toContain(`access_token=${SENSITIVE_REDACTION_PLACEHOLDER}`);
    expect(loggedUrl).toContain(`client_secret=${SENSITIVE_REDACTION_PLACEHOLDER}`);
  });

  it('renews a long-lived token', async () => {
    nock(INSTAGRAM_LOGIN_GRAPH_BASE_URL)
      .get('/refresh_access_token')
      .query({ grant_type: 'ig_refresh_token', access_token: ACCOUNT_TOKEN })
      .reply(200, { access_token: 'IGAA-renewed', token_type: 'bearer', expires_in: 5_184_000 });

    const token = await refreshInstagramLongLivedAccessToken({
      encryptedAccessToken: encryptedAccountToken,
    });

    expect(decryptFieldSecret(token.encryptedAccessToken)).toBe('IGAA-renewed');
  });

  it('a dead token on renewal is auth — expired for 190 / 463', async () => {
    nock(INSTAGRAM_LOGIN_GRAPH_BASE_URL)
      .get('/refresh_access_token')
      .query(true)
      .reply(400, graphError(190, 463));

    await expect(
      refreshInstagramLongLivedAccessToken({ encryptedAccessToken: encryptedAccountToken }),
    ).rejects.toMatchObject({ errorClass: 'auth', connectionStatus: 'expired' });
  });

  it('an answer without expires_in is an outage', async () => {
    nock(INSTAGRAM_LOGIN_GRAPH_BASE_URL)
      .get('/refresh_access_token')
      .query(true)
      .reply(200, { access_token: 'IGAA-renewed' });

    await expect(
      refreshInstagramLongLivedAccessToken({ encryptedAccessToken: encryptedAccountToken }),
    ).rejects.toMatchObject({ errorClass: 'outage', category: 'unknown' });
  });

  it('a token that does not decrypt is our failure: it stays a plain error and nothing is sent', async () => {
    const rejection = refreshInstagramLongLivedAccessToken({ encryptedAccessToken: 'plain-token' });

    await expect(rejection).rejects.not.toBeInstanceOf(MetaGraphApiError);
    await expect(rejection).rejects.toThrow(/not encrypted/);
  });
});

describe('Graph reads (token in the Authorization header, never the URL)', () => {
  it('reads /me with the IA12 fields', async () => {
    instagramLoginWithAccountToken()
      .get(`${LOGIN_VERSION_PATH}/me`)
      .query({
        fields:
          'user_id,id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count,biography,website',
      })
      .reply(200, {
        user_id: '17841400000000000',
        id: APP_USER_ID,
        username: 'meepzo.shop',
        name: 'Acme Shop',
        account_type: 'BUSINESS',
        profile_picture_url: 'https://scontent.cdninstagram.com/picture.jpg',
        followers_count: 1200,
        follows_count: 80,
        media_count: 54,
        biography: 'We sell things',
      });

    await expect(
      readInstagramAccountProfile({ encryptedAccessToken: encryptedAccountToken }),
    ).resolves.toEqual({
      instagramUserId: '17841400000000000',
      instagramAppUserId: APP_USER_ID,
      username: 'meepzo.shop',
      name: 'Acme Shop',
      accountType: 'BUSINESS',
      profilePictureUrl: 'https://scontent.cdninstagram.com/picture.jpg',
      followersCount: 1200,
      followsCount: 80,
      mediaCount: 54,
      biography: 'We sell things',
      website: null,
    });
  });

  it('reads a /me answer wrapped in data from data[0] (D33)', async () => {
    instagramLoginWithAccountToken()
      .get(`${LOGIN_VERSION_PATH}/me`)
      .query(true)
      .reply(200, {
        data: [
          {
            user_id: '17841400000000000',
            id: APP_USER_ID,
            username: 'meepzo.shop',
            account_type: 'MEDIA_CREATOR',
            followers_count: 12,
          },
        ],
      });

    await expect(
      readInstagramAccountProfile({ encryptedAccessToken: encryptedAccountToken }),
    ).resolves.toEqual({
      instagramUserId: '17841400000000000',
      instagramAppUserId: APP_USER_ID,
      username: 'meepzo.shop',
      name: null,
      accountType: 'MEDIA_CREATOR',
      profilePictureUrl: null,
      followersCount: 12,
      followsCount: null,
      mediaCount: null,
      biography: null,
      website: null,
    });
  });

  it.each([
    ['without the ids', { username: 'x' }],
    ['with an empty data list and no flat ids', { data: [] }],
    ['with data[0] that is not an object', { data: ['17841400000000000'] }],
    ['with data[0] lacking the ids', { data: [{ username: 'x' }] }],
    ['that is not an object', [{ user_id: '1', id: '2' }]],
  ])('a /me answer %s is an outage', async (_shape, body) => {
    instagramLoginWithAccountToken().get(`${LOGIN_VERSION_PATH}/me`).query(true).reply(200, body);

    await expect(
      readInstagramAccountProfile({ encryptedAccessToken: encryptedAccountToken }),
    ).rejects.toMatchObject({ errorClass: 'outage' });
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
          next: 'https://graph.instagram.com/next',
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
      instagramAppUserId: APP_USER_ID,
      limit: 25,
      after: 'cursor-one',
    });
    const lastPage = await listInstagramMedia({
      encryptedAccessToken: encryptedAccountToken,
      instagramAppUserId: APP_USER_ID,
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
        instagramAppUserId: APP_USER_ID,
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
        instagramAppUserId: APP_USER_ID,
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
  it('subscribes the three fields and unsubscribes', async () => {
    graphWithAccountToken()
      .post(`${VERSION_PATH}/${APP_USER_ID}/subscribed_apps`)
      .query(withProof({ subscribed_fields: 'comments,messages,messaging_postbacks' }))
      .reply(200, { success: true });
    graphWithAccountToken()
      .delete(`${VERSION_PATH}/${APP_USER_ID}/subscribed_apps`)
      .query(withProof())
      .reply(200, { success: true });
    const options = {
      encryptedAccessToken: encryptedAccountToken,
      instagramAppUserId: APP_USER_ID,
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
        instagramAppUserId: APP_USER_ID,
      }),
    ).rejects.toMatchObject({ errorClass: 'outage' });
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
        instagramAppUserId: APP_USER_ID,
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
        instagramAppUserId: APP_USER_ID,
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
    instagramLoginWithAccountToken()
      .get(`${LOGIN_VERSION_PATH}/me`)
      .query(true)
      .reply(429, graphError(4), { 'Retry-After': '90' });

    await expect(
      readInstagramAccountProfile({ encryptedAccessToken: encryptedAccountToken }),
    ).rejects.toMatchObject({ errorClass: 'throttled', retryAfterMs: 90_000 });
  });

  it('a network failure is an outage', async () => {
    instagramLoginWithAccountToken()
      .get(`${LOGIN_VERSION_PATH}/me`)
      .query(true)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    await expect(
      readInstagramAccountProfile({ encryptedAccessToken: encryptedAccountToken }),
    ).rejects.toMatchObject({
      errorClass: 'outage',
      category: 'network',
      integration: 'meta-graph',
    });
  });

  it('refusals never open the circuit; outages do, and then nothing is sent', async () => {
    const readProfile = () =>
      readInstagramAccountProfile({ encryptedAccessToken: encryptedAccountToken });
    instagramLoginWithAccountToken()
      .get(`${LOGIN_VERSION_PATH}/me`)
      .query(true)
      .times(2)
      .reply(400, graphError(190));
    instagramLoginWithAccountToken()
      .get(`${LOGIN_VERSION_PATH}/me`)
      .query(true)
      .times(2)
      .reply(400, graphError(100));
    instagramLoginWithAccountToken()
      .get(`${LOGIN_VERSION_PATH}/me`)
      .query(true)
      .times(2)
      .reply(400, graphError(17));

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(readProfile()).rejects.toBeInstanceOf(MetaGraphApiError);
    }
    expect(await metaGraphCircuit.getState()).toBe('CLOSED');

    instagramLoginWithAccountToken()
      .get(`${LOGIN_VERSION_PATH}/me`)
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
    ).resolves.toEqual([
      { instagramUserId: '17841400000000001', username: 'shop.one' },
      { instagramUserId: '17841400000000002', username: null },
    ]);
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
            'id,name,effective_status,created_time,creative{effective_instagram_media_id,thumbnail_url}',
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
        instagramAppUserId: APP_USER_ID,
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
