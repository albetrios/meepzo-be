import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The `instagram` circuit in memory with a low threshold — no Redis, and quick to open.
vi.mock('@/infrastructure/resilience/circuit-breaker.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/infrastructure/resilience/circuit-breaker.js')>();
  return {
    ...actual,
    instagramCircuit: new actual.CircuitBreaker({
      name: 'instagram',
      failureThreshold: 3,
      resetTimeoutMs: 60_000,
    }),
  };
});

import { instagramCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  exchangeInstagramAuthorizationCode,
  exchangeInstagramLongLivedAccessToken,
  INSTAGRAM_AUTHORIZATION_BASE_URL,
  INSTAGRAM_GRAPH_API_VERSION,
  INSTAGRAM_GRAPH_BASE_URL,
  isInstagramConfigured,
  listInstagramMedia,
  listInstagramStories,
  readInstagramAccountProfile,
  readInstagramMediaItem,
  readInstagramUserProfile,
  refreshInstagramLongLivedAccessToken,
  replyToInstagramComment,
  sendInstagramMessage,
  subscribeInstagramWebhookFields,
  unsubscribeInstagramWebhookFields,
} from '@/infrastructure/social/instagram.client.js';
import { InstagramApiError } from '@/infrastructure/social/instagram-error.util.js';
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

const VERSION_PATH = `/${INSTAGRAM_GRAPH_API_VERSION}`;
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
  return nock(INSTAGRAM_GRAPH_BASE_URL).matchHeader('authorization', `Bearer ${ACCOUNT_TOKEN}`);
}

/** A form body as nock hands it to a matcher: already parsed, or the raw string. */
function readFormBody(body: unknown): Record<string, string> {
  return typeof body === 'string'
    ? Object.fromEntries(new URLSearchParams(body))
    : { ...(body as Record<string, string>) };
}

beforeEach(async () => {
  encryptedAccountToken = encryptFieldSecret(ACCOUNT_TOKEN);
  await instagramCircuit.reset();
});

afterEach(() => {
  expect(nock.pendingMocks()).toEqual([]);
  nock.cleanAll();
});

describe('Instagram client settings', () => {
  it('pins Graph API v24.0 and one base URL per host', () => {
    expect(INSTAGRAM_GRAPH_API_VERSION).toBe('v24.0');
    expect(INSTAGRAM_AUTHORIZATION_BASE_URL).toBe('https://api.instagram.com');
    expect(INSTAGRAM_GRAPH_BASE_URL).toBe('https://graph.instagram.com');
  });

  describe('with an app setting unset', () => {
    const savedAppId = process.env.INSTAGRAM_APP_ID;

    beforeEach(() => {
      delete process.env.INSTAGRAM_APP_ID;
      resetEnvCacheForTests();
    });

    afterEach(() => {
      process.env.INSTAGRAM_APP_ID = savedAppId;
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
  });

  it('is configured with all three settings', () => {
    expect(isInstagramConfigured()).toBe(true);
  });
});

describe('exchangeInstagramAuthorizationCode', () => {
  it('posts the documented form, strips the trailing #_, and returns the token encrypted', async () => {
    const environment = getEnv();
    nock(INSTAGRAM_AUTHORIZATION_BASE_URL)
      .post('/oauth/access_token', (body) => {
        expect(readFormBody(body)).toEqual({
          client_id: environment.INSTAGRAM_APP_ID,
          client_secret: environment.INSTAGRAM_APP_SECRET,
          grant_type: 'authorization_code',
          redirect_uri: environment.INSTAGRAM_REDIRECT_URI,
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
    nock(INSTAGRAM_GRAPH_BASE_URL)
      .get('/access_token')
      .query({
        grant_type: 'ig_exchange_token',
        client_secret: String(environment.INSTAGRAM_APP_SECRET),
        access_token: 'IGAA-short-lived-plain-token',
      })
      .reply(200, (uri: string) => {
        // nock hands `fetch` requests over as a Request; a path string otherwise.
        const request = uri as unknown as string | { url: string };
        requestedUrl =
          typeof request === 'string' ? `${INSTAGRAM_GRAPH_BASE_URL}${request}` : request.url;
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
    expect(loggedUrl).not.toContain(String(environment.INSTAGRAM_APP_SECRET));
    expect(loggedUrl).toContain(`access_token=${SENSITIVE_REDACTION_PLACEHOLDER}`);
    expect(loggedUrl).toContain(`client_secret=${SENSITIVE_REDACTION_PLACEHOLDER}`);
  });

  it('renews a long-lived token', async () => {
    nock(INSTAGRAM_GRAPH_BASE_URL)
      .get('/refresh_access_token')
      .query({ grant_type: 'ig_refresh_token', access_token: ACCOUNT_TOKEN })
      .reply(200, { access_token: 'IGAA-renewed', token_type: 'bearer', expires_in: 5_184_000 });

    const token = await refreshInstagramLongLivedAccessToken({
      encryptedAccessToken: encryptedAccountToken,
    });

    expect(decryptFieldSecret(token.encryptedAccessToken)).toBe('IGAA-renewed');
  });

  it('a dead token on renewal is auth — expired for 190 / 463', async () => {
    nock(INSTAGRAM_GRAPH_BASE_URL)
      .get('/refresh_access_token')
      .query(true)
      .reply(400, graphError(190, 463));

    await expect(
      refreshInstagramLongLivedAccessToken({ encryptedAccessToken: encryptedAccountToken }),
    ).rejects.toMatchObject({ errorClass: 'auth', connectionStatus: 'expired' });
  });

  it('an answer without expires_in is an outage', async () => {
    nock(INSTAGRAM_GRAPH_BASE_URL)
      .get('/refresh_access_token')
      .query(true)
      .reply(200, { access_token: 'IGAA-renewed' });

    await expect(
      refreshInstagramLongLivedAccessToken({ encryptedAccessToken: encryptedAccountToken }),
    ).rejects.toMatchObject({ errorClass: 'outage', category: 'unknown' });
  });

  it('a token that does not decrypt is our failure: it stays a plain error and nothing is sent', async () => {
    const rejection = refreshInstagramLongLivedAccessToken({ encryptedAccessToken: 'plain-token' });

    await expect(rejection).rejects.not.toBeInstanceOf(InstagramApiError);
    await expect(rejection).rejects.toThrow(/not encrypted/);
  });
});

describe('Graph reads (token in the Authorization header, never the URL)', () => {
  it('reads /me with the IA12 fields', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me`)
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
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me`)
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
    graphWithAccountToken().get(`${VERSION_PATH}/me`).query(true).reply(200, body);

    await expect(
      readInstagramAccountProfile({ encryptedAccessToken: encryptedAccountToken }),
    ).rejects.toMatchObject({ errorClass: 'outage' });
  });

  it("lists media with Instagram's cursor and returns the next cursor only when there is a next page", async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/${APP_USER_ID}/media`)
      .query({ fields: MEDIA_FIELDS, limit: '25', after: 'cursor-one' })
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
      .query({ fields: MEDIA_FIELDS, limit: '25', after: 'cursor-two' })
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
      .query({ fields: 'id,media_type,media_url,thumbnail_url,permalink,timestamp', limit: '10' })
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
      .query({ fields: MEDIA_FIELDS })
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
      .query({ fields: 'name,username,profile_pic,follower_count,is_user_follow_business' })
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
      .query({ subscribed_fields: 'comments,messages,messaging_postbacks' })
      .reply(200, { success: true });
    graphWithAccountToken()
      .delete(`${VERSION_PATH}/${APP_USER_ID}/subscribed_apps`)
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
      .get(`${VERSION_PATH}/me`)
      .query(true)
      .reply(429, graphError(4), { 'Retry-After': '90' });

    await expect(
      readInstagramAccountProfile({ encryptedAccessToken: encryptedAccountToken }),
    ).rejects.toMatchObject({ errorClass: 'throttled', retryAfterMs: 90_000 });
  });

  it('a network failure is an outage', async () => {
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me`)
      .query(true)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    await expect(
      readInstagramAccountProfile({ encryptedAccessToken: encryptedAccountToken }),
    ).rejects.toMatchObject({
      errorClass: 'outage',
      category: 'network',
      integration: 'instagram',
    });
  });

  it('refusals never open the circuit; outages do, and then nothing is sent', async () => {
    const readProfile = () =>
      readInstagramAccountProfile({ encryptedAccessToken: encryptedAccountToken });
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me`)
      .query(true)
      .times(2)
      .reply(400, graphError(190));
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me`)
      .query(true)
      .times(2)
      .reply(400, graphError(100));
    graphWithAccountToken()
      .get(`${VERSION_PATH}/me`)
      .query(true)
      .times(2)
      .reply(400, graphError(17));

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(readProfile()).rejects.toBeInstanceOf(InstagramApiError);
    }
    expect(await instagramCircuit.getState()).toBe('CLOSED');

    graphWithAccountToken().get(`${VERSION_PATH}/me`).query(true).times(3).reply(503, 'down');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(readProfile()).rejects.toMatchObject({ errorClass: 'outage' });
    }
    expect(await instagramCircuit.getState()).toBe('OPEN');

    // No interceptor is left: the open circuit answers before any request leaves.
    const rejection = readProfile();
    await expect(rejection).rejects.toMatchObject({
      errorClass: 'outage',
      category: 'circuit_open',
    });
    await expect(rejection).rejects.toHaveProperty('retryAfterMs', expect.any(Number));
  });
});
