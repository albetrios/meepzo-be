import { instagramCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  exchangeInstagramAuthorizationCode,
  exchangeInstagramLongLivedAccessToken,
  INSTAGRAM_AUTHORIZATION_BASE_URL,
  INSTAGRAM_GRAPH_API_VERSION,
  INSTAGRAM_GRAPH_BASE_URL,
  INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS,
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
import {
  INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODE,
  INSTAGRAM_THROTTLE_DEFAULT_RETRY_AFTER_MS,
  InstagramApiError,
} from '@/infrastructure/social/instagram-error.util.js';
import { getEnv } from '@/shared/config/env.config.js';
import { MILLISECONDS_PER_SECOND } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  decryptFieldSecret,
  encryptFieldSecret,
} from '@/shared/utils/security/field-secret-encryption.util.js';
import {
  redactSensitiveUrl,
  SENSITIVE_REDACTION_PLACEHOLDER,
} from '@/shared/utils/security/sensitive-redaction.util.js';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import accessTokenSuccessFixture from './fixtures/instagram/access-token.success.response.json' with {
  type: 'json',
};
import commentRepliesSuccessFixture from './fixtures/instagram/comment-replies.success.response.json' with {
  type: 'json',
};
import graphErrorApplicationThrottledFixture from './fixtures/instagram/graph-error.application-throttled.response.json' with {
  type: 'json',
};
import graphErrorOutsideMessagingWindowFixture from './fixtures/instagram/graph-error.outside-messaging-window.response.json' with {
  type: 'json',
};
import graphErrorQuickReplyRefusedFixture from './fixtures/instagram/graph-error.quick-reply-refused.response.json' with {
  type: 'json',
};
import graphErrorRecipientNotFoundFixture from './fixtures/instagram/graph-error.recipient-not-found.response.json' with {
  type: 'json',
};
import graphErrorTokenExpiredFixture from './fixtures/instagram/graph-error.token-expired.response.json' with {
  type: 'json',
};
import graphErrorTokenInvalidatedFixture from './fixtures/instagram/graph-error.token-invalidated.response.json' with {
  type: 'json',
};
import graphErrorUnexpectedFixture from './fixtures/instagram/graph-error.unexpected.response.json' with {
  type: 'json',
};
import meSuccessFixture from './fixtures/instagram/me.success.response.json' with { type: 'json' };
import meWrappedSuccessFixture from './fixtures/instagram/me.wrapped.success.response.json' with {
  type: 'json',
};
import mediaFirstPageFixture from './fixtures/instagram/media.first-page.response.json' with {
  type: 'json',
};
import mediaLastPageFixture from './fixtures/instagram/media.last-page.response.json' with {
  type: 'json',
};
import mediaItemSuccessFixture from './fixtures/instagram/media-item.success.response.json' with {
  type: 'json',
};
import messagesSuccessFixture from './fixtures/instagram/messages.success.response.json' with {
  type: 'json',
};
import oauthAccessTokenErrorFixture from './fixtures/instagram/oauth-access-token.error.response.json' with {
  type: 'json',
};
import oauthAccessTokenFlatSuccessFixture from './fixtures/instagram/oauth-access-token.flat.success.response.json' with {
  type: 'json',
};
import oauthAccessTokenSuccessFixture from './fixtures/instagram/oauth-access-token.success.response.json' with {
  type: 'json',
};
import refreshAccessTokenSuccessFixture from './fixtures/instagram/refresh-access-token.success.response.json' with {
  type: 'json',
};
import storiesSuccessFixture from './fixtures/instagram/stories.success.response.json' with {
  type: 'json',
};
import subscribedAppsSuccessFixture from './fixtures/instagram/subscribed-apps.success.response.json' with {
  type: 'json',
};
import userProfileSuccessFixture from './fixtures/instagram/user-profile.success.response.json' with {
  type: 'json',
};
import { registerThirdPartyContractTestIsolationHooks } from './helpers/register-contract-test-hooks.js';

registerThirdPartyContractTestIsolationHooks();

/**
 * The wire contract of the one Instagram client (`src/infrastructure/social/instagram.client.ts`,
 * IA4 / IAC4): what each call sends to `api.instagram.com` / `graph.instagram.com`, where the token
 * travels, and how Meta's real answers — success and error — are read.
 *
 * Where each fixture's shape comes from (`fixtures/instagram/`):
 *
 * | Fixture | Source |
 * | --- | --- |
 * | `oauth-access-token.success` / `.error` | Business Login for Instagram, step 2 (the documented `data[0]` wrap; the error's `error_type` / `code` / `error_message`) — developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login |
 * | `oauth-access-token.flat.success` | the flat answer `api.instagram.com` sends live (numeric `user_id`, `permissions` as a list) — the reason the client reads both and never `user_id` |
 * | `access-token.success`, `refresh-access-token.success` | the same Business Login page (long-lived token, refresh) and docs/instagram-platform/reference/refresh_access_token |
 * | `me.success` | the IG User node fields (`user_id`, `id`, `username`, `account_type`, counts) — docs/instagram-platform/instagram-api-with-instagram-login/get-started; a node read answers flat |
 * | `me.wrapped.success` | the same account inside `data`, as Meta's get-started guide prints the `/me` answer — the client reads both (D33) until a test account confirms the live shape |
 * | `media.first-page` / `.last-page`, `stories.success`, `media-item.success` | IG User `/media` and `/stories` edges and the IG Media node (ISO `+0000` timestamps, `children.data`) — docs/instagram-platform/instagram-graph-api/reference/ig-user/media, …/ig-user/stories; Graph's cursor paging (`paging.cursors`, `paging.next` carrying `access_token` as live answers do) — docs/graph-api/results |
 * | `subscribed-apps.success` | `POST` / `DELETE /{id}/subscribed_apps` → `{ success: true }` — docs/instagram-platform/webhooks |
 * | `messages.success` | Send Messages and Private Replies → `{ recipient_id, message_id }` — docs/instagram-platform/instagram-api-with-instagram-login/messaging-api, docs/instagram-platform/private-replies |
 * | `comment-replies.success` | IG Comment `/replies` → `{ id }` — docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies |
 * | `user-profile.success` | Instagram User Profile API (Meta's own sample person) — docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/user-profile |
 * | `graph-error.*` | Graph's error envelope and codes (190 with subcode 460 / 463, 4, 2 with `is_transient`) — docs/graph-api/guides/error-handling; `100` / `2534014` — docs/messenger-platform/error-codes; `10` / `2534022` (a message outside the 24-hour messaging window; Messenger's `2018278` means the same) — docs/messenger-platform/error-codes, D32; `100` / `2534015` (the quick reply refused) — the intake's schema-routes § 6.5, no Meta page names it |
 */
describe('Instagram outbound contract (`instagram.client`)', () => {
  /** The account's long-lived token in plain text — the value that must never reach a URL or a log. */
  const ACCOUNT_ACCESS_TOKEN = 'IGAA-contract-fixture-account-access-token';
  /** The account's app-scoped id, as `/me` `id` gives it. */
  const APP_USER_ID = meSuccessFixture.id;
  const GRAPH_VERSION_PATH = `/${INSTAGRAM_GRAPH_API_VERSION}`;
  const MEDIA_FIELDS =
    'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count,children{id,media_type,media_url}';
  const STORY_FIELDS = 'id,media_type,media_url,thumbnail_url,permalink,timestamp';
  const ACCOUNT_PROFILE_FIELDS =
    'user_id,id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count,biography,website';
  const LOGGER_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

  /** Meta's Graph error envelope (`docs/graph-api/guides/error-handling`). */
  const GraphErrorEnvelopeContractSchema = z.object({
    error: z
      .object({
        message: z.string().min(1),
        type: z.string().min(1),
        code: z.number().int(),
        error_subcode: z.number().int().optional(),
        is_transient: z.boolean().optional(),
        fbtrace_id: z.string().min(1),
      })
      .loose(),
  });
  /** Graph's long-lived token answer — the exchange and the renewal share it. */
  const LongLivedTokenContractSchema = z.object({
    access_token: z.string().min(1),
    token_type: z.literal('bearer'),
    expires_in: z.number().int().positive(),
  });
  /** One page of an edge with Graph's cursor paging. */
  const GraphListPageContractSchema = z.object({
    data: z.array(z.object({ id: z.string().regex(/^\d+$/) }).loose()),
    paging: z
      .object({
        cursors: z.object({ before: z.string().min(1), after: z.string().min(1) }),
        next: z.url().optional(),
      })
      .optional(),
  });
  /** An IG Media node: ids are digit strings, timestamps ISO 8601 with `+0000`. */
  const MediaNodeContractSchema = z
    .object({
      id: z.string().regex(/^\d+$/),
      media_type: z.enum(['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM']),
      permalink: z.url(),
      timestamp: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0000$/),
    })
    .loose();

  let encryptedAccountAccessToken = '';
  let loggerSpies: ReturnType<typeof vi.spyOn>[] = [];

  /** The Graph host, expecting the account's token in the `Authorization` header (IA4). */
  function graphWithAccountToken(): nock.Scope {
    return nock(INSTAGRAM_GRAPH_BASE_URL).matchHeader(
      'authorization',
      `Bearer ${ACCOUNT_ACCESS_TOKEN}`,
    );
  }

  /** A form body as nock hands it to a matcher: already parsed, or the raw string. */
  function readFormBody(body: unknown): Record<string, string> {
    return typeof body === 'string'
      ? Object.fromEntries(new URLSearchParams(body))
      : { ...(body as Record<string, string>) };
  }

  /** The full URL that reached nock: a `Request` when the call used `fetch`, else a path string. */
  function readInterceptedUrl({
    interceptedUri,
    baseUrl,
  }: {
    interceptedUri: unknown;
    baseUrl: string;
  }): string {
    return typeof interceptedUri === 'string'
      ? new URL(interceptedUri, baseUrl).toString()
      : (interceptedUri as { url: string }).url;
  }

  /** A Graph URL carries no token: no `access_token` parameter and no plain token anywhere. */
  function expectUrlWithoutToken(url: string): void {
    expect(new URL(url).searchParams.has('access_token')).toBe(false);
    expect(url).not.toContain(ACCOUNT_ACCESS_TOKEN);
  }

  /** Silences the logger and returns a reader of everything logged since, errors expanded. */
  function recordLoggedText(): () => string {
    loggerSpies = LOGGER_LEVELS.map((level) =>
      vi.spyOn(logger, level).mockImplementation(() => undefined),
    );
    return () =>
      JSON.stringify(
        loggerSpies.flatMap((spy) => spy.mock.calls),
        (_key, value: unknown) =>
          value instanceof Error ? { ...value, name: value.name, message: value.message } : value,
      );
  }

  /** An error as text — its message and every own field — to prove what it never carries. */
  function describeRejection(rejection: unknown): string {
    return rejection instanceof Error
      ? `${rejection.message} ${JSON.stringify({ ...rejection })}`
      : String(rejection);
  }

  beforeEach(() => {
    encryptedAccountAccessToken = encryptFieldSecret(ACCOUNT_ACCESS_TOKEN);
  });

  afterEach(() => {
    for (const spy of loggerSpies) spy.mockRestore();
    loggerSpies = [];
    // Every interceptor was used: each call went exactly where the contract says.
    expect(nock.pendingMocks()).toEqual([]);
  });

  describe('the connect exchanges (IA12)', () => {
    test('the code exchange posts the documented form to api.instagram.com — no token, no query, the answer encrypted', async () => {
      const environment = getEnv();
      const shortLivedAccessToken = oauthAccessTokenSuccessFixture.data[0]?.access_token ?? '';
      z.object({
        data: z
          .array(
            z.object({
              access_token: z.string().min(1),
              user_id: z.string().regex(/^\d+$/),
              permissions: z.string().min(1),
            }),
          )
          .length(1),
      }).parse(oauthAccessTokenSuccessFixture);
      let interceptedUrl = '';
      nock(INSTAGRAM_AUTHORIZATION_BASE_URL, { badheaders: ['authorization'] })
        .post('/oauth/access_token', (body) => {
          expect(readFormBody(body)).toEqual({
            client_id: environment.INSTAGRAM_APP_ID,
            client_secret: environment.INSTAGRAM_APP_SECRET,
            grant_type: 'authorization_code',
            redirect_uri: environment.INSTAGRAM_REDIRECT_URI,
            code: 'AQBcontract-fixture-authorization-code',
          });
          return true;
        })
        .matchHeader('content-type', /application\/x-www-form-urlencoded/)
        .reply(200, (interceptedUri: string) => {
          interceptedUrl = readInterceptedUrl({
            interceptedUri,
            baseUrl: INSTAGRAM_AUTHORIZATION_BASE_URL,
          });
          return oauthAccessTokenSuccessFixture;
        });

      // Instagram appends `#_` to the code in the redirect; it is not part of the code.
      const grant = await exchangeInstagramAuthorizationCode({
        code: 'AQBcontract-fixture-authorization-code#_',
      });

      // The code and the secret travel in the body only.
      expect(new URL(interceptedUrl).search).toBe('');
      expect(grant.encryptedAccessToken).not.toContain(shortLivedAccessToken);
      expect(decryptFieldSecret(grant.encryptedAccessToken)).toBe(shortLivedAccessToken);
      expect(grant.grantedPermissions).toEqual([
        'instagram_business_basic',
        'instagram_business_manage_messages',
        'instagram_business_manage_comments',
      ]);
    });

    test('the code exchange reads the flat answer Instagram sends live (numeric user_id, permission list)', async () => {
      z.object({
        access_token: z.string().min(1),
        user_id: z.number().int(),
        permissions: z.array(z.string().min(1)),
      }).parse(oauthAccessTokenFlatSuccessFixture);
      nock(INSTAGRAM_AUTHORIZATION_BASE_URL)
        .post('/oauth/access_token')
        .reply(200, oauthAccessTokenFlatSuccessFixture);

      const grant = await exchangeInstagramAuthorizationCode({
        code: 'AQBcontract-fixture-authorization-code',
      });

      expect(decryptFieldSecret(grant.encryptedAccessToken)).toBe(
        oauthAccessTokenFlatSuccessFixture.access_token,
      );
      expect(grant.grantedPermissions).toEqual(oauthAccessTokenFlatSuccessFixture.permissions);
    });

    test("a used code is refused, read from the code exchange's own error shape", async () => {
      z.object({
        error_type: z.string().min(1),
        code: z.number().int(),
        error_message: z.string().min(1),
      }).parse(oauthAccessTokenErrorFixture);
      nock(INSTAGRAM_AUTHORIZATION_BASE_URL)
        .post('/oauth/access_token')
        .reply(400, oauthAccessTokenErrorFixture);

      const rejection = await exchangeInstagramAuthorizationCode({
        code: 'AQBcontract-fixture-used-code',
      }).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(InstagramApiError);
      expect(rejection).toMatchObject({
        integration: 'instagram',
        errorClass: 'refused',
        connectionStatus: null,
        status: 400,
        instagramErrorType: 'OAuthException',
        instagramErrorCode: 400,
        instagramErrorMessage: oauthAccessTokenErrorFixture.error_message,
        countsAsCircuitFailure: false,
      });
    });

    test('the long-lived exchange carries the secret and the short-lived token in the query only — never a header', async () => {
      const environment = getEnv();
      const shortLivedAccessToken = 'IGAA-contract-fixture-short-lived-access-token';
      LongLivedTokenContractSchema.parse(accessTokenSuccessFixture);
      let interceptedUrl = '';
      nock(INSTAGRAM_GRAPH_BASE_URL, { badheaders: ['authorization'] })
        .get('/access_token')
        .query({
          grant_type: 'ig_exchange_token',
          client_secret: String(environment.INSTAGRAM_APP_SECRET),
          access_token: shortLivedAccessToken,
        })
        .reply(200, (interceptedUri: string) => {
          interceptedUrl = readInterceptedUrl({
            interceptedUri,
            baseUrl: INSTAGRAM_GRAPH_BASE_URL,
          });
          return accessTokenSuccessFixture;
        });
      const startedAt = Date.now();

      const longLivedToken = await exchangeInstagramLongLivedAccessToken({
        encryptedShortLivedAccessToken: encryptFieldSecret(shortLivedAccessToken),
      });

      expect(decryptFieldSecret(longLivedToken.encryptedAccessToken)).toBe(
        accessTokenSuccessFixture.access_token,
      );
      expect(longLivedToken.encryptedAccessToken).not.toContain(
        accessTokenSuccessFixture.access_token,
      );
      const expiresInMilliseconds = accessTokenSuccessFixture.expires_in * MILLISECONDS_PER_SECOND;
      expect(longLivedToken.expiresAt.getTime()).toBeGreaterThanOrEqual(
        startedAt + expiresInMilliseconds,
      );
      expect(longLivedToken.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + expiresInMilliseconds,
      );
      // The one URL that carries the token and the secret is redacted wherever it is logged.
      const loggedUrl = redactSensitiveUrl(interceptedUrl);
      expect(loggedUrl).not.toContain(shortLivedAccessToken);
      expect(loggedUrl).not.toContain(String(environment.INSTAGRAM_APP_SECRET));
      expect(loggedUrl).toContain(`access_token=${SENSITIVE_REDACTION_PLACEHOLDER}`);
      expect(loggedUrl).toContain(`client_secret=${SENSITIVE_REDACTION_PLACEHOLDER}`);
    });

    test('the renewal carries the token in the query only and returns the renewed token encrypted', async () => {
      LongLivedTokenContractSchema.parse(refreshAccessTokenSuccessFixture);
      let interceptedUrl = '';
      nock(INSTAGRAM_GRAPH_BASE_URL, { badheaders: ['authorization'] })
        .get('/refresh_access_token')
        .query({ grant_type: 'ig_refresh_token', access_token: ACCOUNT_ACCESS_TOKEN })
        .reply(200, (interceptedUri: string) => {
          interceptedUrl = readInterceptedUrl({
            interceptedUri,
            baseUrl: INSTAGRAM_GRAPH_BASE_URL,
          });
          return refreshAccessTokenSuccessFixture;
        });

      const renewedToken = await refreshInstagramLongLivedAccessToken({
        encryptedAccessToken: encryptedAccountAccessToken,
      });

      expect(decryptFieldSecret(renewedToken.encryptedAccessToken)).toBe(
        refreshAccessTokenSuccessFixture.access_token,
      );
      expect(redactSensitiveUrl(interceptedUrl)).not.toContain(ACCOUNT_ACCESS_TOKEN);
    });
  });

  describe('the Graph reads (the token in the Authorization header, never the URL)', () => {
    /** The IG User node `/me` answers with: ids as digit strings, a professional account type, counts. */
    const AccountProfileContractSchema = z
      .object({
        user_id: z.string().regex(/^\d+$/),
        id: z.string().regex(/^\d+$/),
        username: z.string().min(1),
        account_type: z.enum(['BUSINESS', 'MEDIA_CREATOR']),
        followers_count: z.number().int().nonnegative(),
        follows_count: z.number().int().nonnegative(),
        media_count: z.number().int().nonnegative(),
      })
      .loose();
    /** The account both `/me` fixtures describe, as the client maps it. */
    const expectedAccountProfile = {
      instagramUserId: meSuccessFixture.user_id,
      instagramAppUserId: meSuccessFixture.id,
      username: meSuccessFixture.username,
      name: meSuccessFixture.name,
      accountType: meSuccessFixture.account_type,
      profilePictureUrl: meSuccessFixture.profile_picture_url,
      followersCount: meSuccessFixture.followers_count,
      followsCount: meSuccessFixture.follows_count,
      mediaCount: meSuccessFixture.media_count,
      biography: meSuccessFixture.biography,
      website: meSuccessFixture.website,
    };

    test('/me asks for the connect fields and maps the account', async () => {
      AccountProfileContractSchema.parse(meSuccessFixture);
      let interceptedUrl = '';
      graphWithAccountToken()
        .matchHeader('x-request-id', 'contract-instagram-request')
        .get(`${GRAPH_VERSION_PATH}/me`)
        .query({ fields: ACCOUNT_PROFILE_FIELDS })
        .reply(200, (interceptedUri: string) => {
          interceptedUrl = readInterceptedUrl({
            interceptedUri,
            baseUrl: INSTAGRAM_GRAPH_BASE_URL,
          });
          return meSuccessFixture;
        });

      const accountProfile = await readInstagramAccountProfile({
        encryptedAccessToken: encryptedAccountAccessToken,
        requestId: 'contract-instagram-request',
      });

      expectUrlWithoutToken(interceptedUrl);
      expect(accountProfile).toEqual(expectedAccountProfile);
    });

    test("/me wrapped in data, as Meta's guide prints it, is read from data[0] — the same account as the flat answer (D33)", async () => {
      z.object({ data: z.array(AccountProfileContractSchema).min(1) }).parse(
        meWrappedSuccessFixture,
      );
      expect(meWrappedSuccessFixture.data[0]).toEqual(meSuccessFixture);
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/me`)
        .query({ fields: ACCOUNT_PROFILE_FIELDS })
        .reply(200, meWrappedSuccessFixture);

      await expect(
        readInstagramAccountProfile({ encryptedAccessToken: encryptedAccountAccessToken }),
      ).resolves.toEqual(expectedAccountProfile);
    });

    test("media pages follow Instagram's after cursor and never hand back paging.next, which carries a token", async () => {
      GraphListPageContractSchema.parse(mediaFirstPageFixture);
      GraphListPageContractSchema.parse(mediaLastPageFixture);
      for (const mediaNode of [...mediaFirstPageFixture.data, ...mediaLastPageFixture.data]) {
        MediaNodeContractSchema.parse(mediaNode);
      }
      const interceptedUrls: string[] = [];
      const nextCursor = mediaFirstPageFixture.paging.cursors.after;
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/media`)
        .query({ fields: MEDIA_FIELDS, limit: '2' })
        .reply(200, (interceptedUri: string) => {
          interceptedUrls.push(
            readInterceptedUrl({ interceptedUri, baseUrl: INSTAGRAM_GRAPH_BASE_URL }),
          );
          return mediaFirstPageFixture;
        });
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/media`)
        .query({ fields: MEDIA_FIELDS, limit: '2', after: nextCursor })
        .reply(200, (interceptedUri: string) => {
          interceptedUrls.push(
            readInterceptedUrl({ interceptedUri, baseUrl: INSTAGRAM_GRAPH_BASE_URL }),
          );
          return mediaLastPageFixture;
        });
      const listOptions = {
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramAppUserId: APP_USER_ID,
        limit: 2,
      };

      const firstPage = await listInstagramMedia(listOptions);
      const lastPage = await listInstagramMedia({ ...listOptions, after: nextCursor });

      expect(firstPage).toEqual({ items: mediaFirstPageFixture.data, nextCursor });
      expect(lastPage).toEqual({ items: mediaLastPageFixture.data, nextCursor: null });
      // Meta's `paging.next` URL repeats the account's token; only the bare cursor leaves the client.
      expect(JSON.stringify([firstPage, lastPage])).not.toContain(ACCOUNT_ACCESS_TOKEN);
      for (const interceptedUrl of interceptedUrls) expectUrlWithoutToken(interceptedUrl);
    });

    test('stories list with the story fields; a page without paging.next has no next cursor', async () => {
      GraphListPageContractSchema.parse(storiesSuccessFixture);
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/stories`)
        .query({ fields: STORY_FIELDS, limit: '25' })
        .reply(200, storiesSuccessFixture);

      const storiesPage = await listInstagramStories({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramAppUserId: APP_USER_ID,
        limit: 25,
      });

      expect(storiesPage).toEqual({ items: storiesSuccessFixture.data, nextCursor: null });
    });

    test('the single media read asks for the media fields and keeps the carousel children as sent', async () => {
      MediaNodeContractSchema.parse(mediaItemSuccessFixture);
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/${mediaItemSuccessFixture.id}`)
        .query({ fields: MEDIA_FIELDS })
        .reply(200, mediaItemSuccessFixture);

      const mediaItem = await readInstagramMediaItem({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramMediaId: mediaItemSuccessFixture.id,
      });

      expect(mediaItem).toEqual(mediaItemSuccessFixture);
    });

    test("the profile read and the follow check come from one read of the person's Instagram-scoped id", async () => {
      z.object({
        name: z.string().min(1),
        username: z.string().min(1),
        profile_pic: z.url(),
        follower_count: z.number().int().nonnegative(),
        is_user_follow_business: z.boolean(),
        is_business_follow_user: z.boolean(),
      })
        .loose()
        .parse(userProfileSuccessFixture);
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/${userProfileSuccessFixture.id}`)
        .query({ fields: 'name,username,profile_pic,follower_count,is_user_follow_business' })
        .reply(200, userProfileSuccessFixture);

      const userProfile = await readInstagramUserProfile({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramScopedUserId: userProfileSuccessFixture.id,
      });

      // `false` stays `false` — a person who does not follow is not "unknown".
      expect(userProfile).toEqual({
        name: userProfileSuccessFixture.name,
        username: userProfileSuccessFixture.username,
        profilePictureUrl: userProfileSuccessFixture.profile_pic,
        followerCount: userProfileSuccessFixture.follower_count,
        isUserFollowingBusiness: false,
      });
    });
  });

  describe('the writes', () => {
    test('subscribed_apps: subscribe posts the three webhook fields, unsubscribe deletes, both read success: true', async () => {
      z.object({ success: z.literal(true) }).parse(subscribedAppsSuccessFixture);
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/subscribed_apps`)
        .query({ subscribed_fields: 'comments,messages,messaging_postbacks' })
        .reply(200, subscribedAppsSuccessFixture);
      graphWithAccountToken()
        .delete(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/subscribed_apps`)
        .reply(200, subscribedAppsSuccessFixture);
      const subscriptionOptions = {
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramAppUserId: APP_USER_ID,
      };

      expect(INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS).toEqual([
        'comments',
        'messages',
        'messaging_postbacks',
      ]);
      await expect(subscribeInstagramWebhookFields(subscriptionOptions)).resolves.toBeUndefined();
      await expect(unsubscribeInstagramWebhookFields(subscriptionOptions)).resolves.toBeUndefined();
    });

    test("a direct message and a private reply post Meta's recipient and message shapes to /messages as JSON", async () => {
      const sentMessageContractSchema = z.object({
        recipient_id: z.string().regex(/^\d+$/),
        message_id: z.string().min(1),
      });
      sentMessageContractSchema.parse(messagesSuccessFixture);
      const directMessage = {
        recipient: { id: messagesSuccessFixture.recipient_id },
        message: {
          text: 'Please share your email to continue!',
          quick_replies: [{ content_type: 'user_email' as const }],
        },
      };
      const privateReply = {
        recipient: { comment_id: '17865800000000001' },
        message: { text: 'Check your messages!' },
      };
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/messages`, directMessage)
        .matchHeader('content-type', 'application/json')
        .reply(200, messagesSuccessFixture);
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/messages`, privateReply)
        .matchHeader('content-type', 'application/json')
        .reply(200, messagesSuccessFixture);
      const sender = {
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramAppUserId: APP_USER_ID,
      };

      const expectedSentMessage = {
        messageId: messagesSuccessFixture.message_id,
        recipientId: messagesSuccessFixture.recipient_id,
      };
      await expect(sendInstagramMessage({ ...sender, ...directMessage })).resolves.toEqual(
        expectedSentMessage,
      );
      await expect(sendInstagramMessage({ ...sender, ...privateReply })).resolves.toEqual(
        expectedSentMessage,
      );
    });

    test('a public comment reply posts the message to /{comment_id}/replies and returns the reply id', async () => {
      z.object({ id: z.string().regex(/^\d+$/) }).parse(commentRepliesSuccessFixture);
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/17865800000000001/replies`, { message: 'Sent you a message!' })
        .matchHeader('content-type', 'application/json')
        .reply(200, commentRepliesSuccessFixture);

      const commentReply = await replyToInstagramComment({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramCommentId: '17865800000000001',
        text: 'Sent you a message!',
      });

      expect(commentReply).toEqual({ instagramCommentReplyId: commentRepliesSuccessFixture.id });
    });
  });

  describe("Instagram's error answers (IA4 classes)", () => {
    test('190 / 463 on the renewal is auth → expired, and the token reaches neither a log line nor the error', async () => {
      GraphErrorEnvelopeContractSchema.parse(graphErrorTokenExpiredFixture);
      nock(INSTAGRAM_GRAPH_BASE_URL)
        .get('/refresh_access_token')
        .query(true)
        .reply(400, graphErrorTokenExpiredFixture);
      const readLoggedText = recordLoggedText();

      const rejection = await refreshInstagramLongLivedAccessToken({
        encryptedAccessToken: encryptedAccountAccessToken,
      }).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(InstagramApiError);
      expect(rejection).toMatchObject({
        errorClass: 'auth',
        connectionStatus: 'expired',
        status: 400,
        instagramErrorCode: 190,
        instagramErrorSubcode: 463,
        instagramErrorType: 'OAuthException',
        fbtraceId: graphErrorTokenExpiredFixture.error.fbtrace_id,
        countsAsCircuitFailure: false,
      });
      expect(readLoggedText()).toContain('outbound.call.failed');
      expect(readLoggedText()).not.toContain(ACCOUNT_ACCESS_TOKEN);
      expect(describeRejection(rejection)).not.toContain(ACCOUNT_ACCESS_TOKEN);
    });

    test('190 with another subcode (460) is auth → error, and neither the token nor the secret is logged', async () => {
      const environment = getEnv();
      const shortLivedAccessToken = 'IGAA-contract-fixture-short-lived-access-token';
      GraphErrorEnvelopeContractSchema.parse(graphErrorTokenInvalidatedFixture);
      nock(INSTAGRAM_GRAPH_BASE_URL)
        .get('/access_token')
        .query(true)
        .reply(400, graphErrorTokenInvalidatedFixture);
      const readLoggedText = recordLoggedText();

      const rejection = await exchangeInstagramLongLivedAccessToken({
        encryptedShortLivedAccessToken: encryptFieldSecret(shortLivedAccessToken),
      }).catch((error: unknown) => error);

      expect(rejection).toMatchObject({
        errorClass: 'auth',
        connectionStatus: 'error',
        instagramErrorCode: 190,
        instagramErrorSubcode: 460,
        countsAsCircuitFailure: false,
      });
      const appSecret = String(environment.INSTAGRAM_APP_SECRET);
      for (const text of [readLoggedText(), describeRejection(rejection)]) {
        expect(text).not.toContain(shortLivedAccessToken);
        expect(text).not.toContain(appSecret);
      }
    });

    test('a throttle (code 4) waits the Retry-After Instagram named, or one minute when it names none', async () => {
      GraphErrorEnvelopeContractSchema.parse(graphErrorApplicationThrottledFixture);
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/media`)
        .query(true)
        .reply(429, graphErrorApplicationThrottledFixture, { 'Retry-After': '120' });
      // Graph usually answers code 4 with HTTP 400 and no Retry-After: the code alone decides.
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/media`)
        .query(true)
        .reply(400, graphErrorApplicationThrottledFixture);
      const listOptions = {
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramAppUserId: APP_USER_ID,
        limit: 25,
      };

      await expect(listInstagramMedia(listOptions)).rejects.toMatchObject({
        errorClass: 'throttled',
        status: 429,
        retryAfterMs: 120_000,
        instagramErrorCode: 4,
        countsAsCircuitFailure: false,
      });
      await expect(listInstagramMedia(listOptions)).rejects.toMatchObject({
        errorClass: 'throttled',
        status: 400,
        retryAfterMs: INSTAGRAM_THROTTLE_DEFAULT_RETRY_AFTER_MS,
      });
    });

    test('a plain refusal (code 100, no matching user) is refused — not a quick-reply refusal', async () => {
      GraphErrorEnvelopeContractSchema.parse(graphErrorRecipientNotFoundFixture);
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/messages`)
        .reply(400, graphErrorRecipientNotFoundFixture);

      const rejection = await sendInstagramMessage({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramAppUserId: APP_USER_ID,
        recipient: { id: '7311000000000099' },
        message: { text: 'Hello!' },
      }).catch((error: unknown) => error);

      expect(rejection).toMatchObject({
        errorClass: 'refused',
        connectionStatus: null,
        status: 400,
        instagramErrorCode: 100,
        instagramErrorSubcode: 2534014,
        isQuickReplyRefused: false,
        countsAsCircuitFailure: false,
      });
    });

    test('a direct message outside the 24-hour messaging window (10 / 2534022) is refused — only that send fails, the account is not marked broken (D32)', async () => {
      GraphErrorEnvelopeContractSchema.parse(graphErrorOutsideMessagingWindowFixture);
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/messages`)
        .reply(400, graphErrorOutsideMessagingWindowFixture);

      const rejection = await sendInstagramMessage({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramAppUserId: APP_USER_ID,
        recipient: { id: messagesSuccessFixture.recipient_id },
        message: { text: 'Thanks for your message!' },
      }).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(InstagramApiError);
      expect(rejection).toMatchObject({
        errorClass: 'refused',
        connectionStatus: null,
        status: 400,
        instagramErrorCode: 10,
        instagramErrorSubcode: INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODE,
        isQuickReplyRefused: false,
        countsAsCircuitFailure: false,
      });
    });

    test('the quick-reply refusal (100 / 2534015) is flagged so the question can go again as plain text', async () => {
      GraphErrorEnvelopeContractSchema.parse(graphErrorQuickReplyRefusedFixture);
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/messages`)
        .reply(400, graphErrorQuickReplyRefusedFixture);

      const rejection = await sendInstagramMessage({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramAppUserId: APP_USER_ID,
        recipient: { id: messagesSuccessFixture.recipient_id },
        message: {
          text: 'Please share your phone number to continue!',
          quick_replies: [{ content_type: 'user_phone_number' }],
        },
      }).catch((error: unknown) => error);

      expect(rejection).toMatchObject({
        errorClass: 'refused',
        instagramErrorCode: 100,
        instagramErrorSubcode: 2534015,
        isQuickReplyRefused: true,
      });
    });

    test('a 5xx is an outage; five of them open the instagram circuit and the next call never leaves', async () => {
      GraphErrorEnvelopeContractSchema.parse(graphErrorUnexpectedFixture);
      const failureThreshold = 5;
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/me`)
        .query(true)
        .times(failureThreshold)
        .reply(500, graphErrorUnexpectedFixture);
      recordLoggedText();
      const readProfile = () =>
        readInstagramAccountProfile({ encryptedAccessToken: encryptedAccountAccessToken });

      for (let attempt = 0; attempt < failureThreshold; attempt += 1) {
        await expect(readProfile()).rejects.toMatchObject({
          errorClass: 'outage',
          category: 'http_5xx',
          status: 500,
          instagramErrorCode: 2,
          countsAsCircuitFailure: true,
        });
      }
      expect(await instagramCircuit.getState()).toBe('OPEN');

      // No interceptor is left and the network is closed: only the open circuit can answer.
      const rejection = await readProfile().catch((error: unknown) => error);
      expect(rejection).toMatchObject({ errorClass: 'outage', category: 'circuit_open' });
      expect(rejection).toHaveProperty('retryAfterMs', expect.any(Number));
    });

    test('a burst of dead tokens, throttles and refusals never opens the instagram circuit', async () => {
      const refusalFixtures = [
        graphErrorTokenExpiredFixture,
        graphErrorTokenInvalidatedFixture,
        graphErrorApplicationThrottledFixture,
        graphErrorRecipientNotFoundFixture,
        graphErrorQuickReplyRefusedFixture,
        graphErrorOutsideMessagingWindowFixture,
        graphErrorTokenExpiredFixture,
      ];
      for (const refusalFixture of refusalFixtures) {
        graphWithAccountToken()
          .get(`${GRAPH_VERSION_PATH}/me`)
          .query(true)
          .reply(400, refusalFixture);
      }
      recordLoggedText();

      for (let attempt = 0; attempt < refusalFixtures.length; attempt += 1) {
        const rejection = await readInstagramAccountProfile({
          encryptedAccessToken: encryptedAccountAccessToken,
        }).catch((error: unknown) => error);
        expect(rejection).toBeInstanceOf(InstagramApiError);
        expect(rejection).toHaveProperty('countsAsCircuitFailure', false);
      }

      expect(await instagramCircuit.getState()).toBe('CLOSED');
    });
  });
});
