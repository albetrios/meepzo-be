import { createHmac } from 'node:crypto';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  META_GRAPH_VERSION,
  META_GRAPH_BASE_URL,
  INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS,
  listInstagramMedia,
  listInstagramStories,
  listMetaAdAccountAds,
  listMetaAdAccounts,
  listMetaAssignedInstagramAccounts,
  readInstagramAccountProfile,
  readInstagramMediaItem,
  readInstagramUserProfile,
  readMetaClientBusinessId,
  readMetaGrantedPermissions,
  replyToInstagramComment,
  sendInstagramMessage,
  subscribeInstagramWebhookFields,
  unsubscribeInstagramWebhookFields,
  uploadInstagramMessageAttachment,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { exchangeMetaLoginCode } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-login.js';
import {
  INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODE,
  INSTAGRAM_THROTTLE_DEFAULT_RETRY_AFTER_MS,
  INSTAGRAM_THROTTLE_MAX_RETRY_AFTER_MS,
  MetaGraphApiError,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { getEnv } from '@/shared/config/env.config.js';
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

import adAccountsSuccessFixture from './fixtures/meta-graph/ad-accounts.success.response.json' with {
  type: 'json',
};
import adsSuccessFixture from './fixtures/meta-graph/ads.success.response.json' with {
  type: 'json',
};
import assignedInstagramAccountsSuccessFixture from './fixtures/meta-graph/assigned-instagram-accounts.success.response.json' with {
  type: 'json',
};
import assignedInstagramAccountsFirstPageFixture from './fixtures/meta-graph/assigned-instagram-accounts.first-page.response.json' with {
  type: 'json',
};
import commentRepliesSuccessFixture from './fixtures/meta-graph/comment-replies.success.response.json' with {
  type: 'json',
};
import graphErrorApplicationThrottledFixture from './fixtures/meta-graph/graph-error.application-throttled.response.json' with {
  type: 'json',
};
import graphErrorBusinessThrottledFixture from './fixtures/meta-graph/graph-error.business-throttled.response.json' with {
  type: 'json',
};
import graphErrorOutsideMessagingWindowFixture from './fixtures/meta-graph/graph-error.outside-messaging-window.response.json' with {
  type: 'json',
};
import graphErrorQuickReplyRefusedFixture from './fixtures/meta-graph/graph-error.quick-reply-refused.response.json' with {
  type: 'json',
};
import graphErrorRecipientNotFoundFixture from './fixtures/meta-graph/graph-error.recipient-not-found.response.json' with {
  type: 'json',
};
import graphErrorTokenExpiredFixture from './fixtures/meta-graph/graph-error.token-expired.response.json' with {
  type: 'json',
};
import graphErrorTokenInvalidatedFixture from './fixtures/meta-graph/graph-error.token-invalidated.response.json' with {
  type: 'json',
};
import graphErrorUnexpectedFixture from './fixtures/meta-graph/graph-error.unexpected.response.json' with {
  type: 'json',
};
import meSuccessFixture from './fixtures/meta-graph/instagram-account.success.response.json' with {
  type: 'json',
};
import meWrappedSuccessFixture from './fixtures/meta-graph/instagram-account.wrapped.success.response.json' with {
  type: 'json',
};
import meClientBusinessSuccessFixture from './fixtures/meta-graph/me-client-business.success.response.json' with {
  type: 'json',
};
import mediaFirstPageFixture from './fixtures/meta-graph/media.first-page.response.json' with {
  type: 'json',
};
import mediaLastPageFixture from './fixtures/meta-graph/media.last-page.response.json' with {
  type: 'json',
};
import mediaItemSuccessFixture from './fixtures/meta-graph/media-item.success.response.json' with {
  type: 'json',
};
import messageAttachmentsSuccessFixture from './fixtures/meta-graph/message-attachments.success.response.json' with {
  type: 'json',
};
import messagesSuccessFixture from './fixtures/meta-graph/messages.success.response.json' with {
  type: 'json',
};
import oauthAccessTokenErrorFixture from './fixtures/meta-graph/oauth-access-token.error.response.json' with {
  type: 'json',
};
import permissionsSuccessFixture from './fixtures/meta-graph/permissions.success.response.json' with {
  type: 'json',
};
import storiesSuccessFixture from './fixtures/meta-graph/stories.success.response.json' with {
  type: 'json',
};
import subscribedAppsSuccessFixture from './fixtures/meta-graph/subscribed-apps.success.response.json' with {
  type: 'json',
};
import unifiedLoginAccessTokenSuccessFixture from './fixtures/meta-graph/unified-login-access-token.success.response.json' with {
  type: 'json',
};
import userProfileSuccessFixture from './fixtures/meta-graph/user-profile.success.response.json' with {
  type: 'json',
};
import { registerThirdPartyContractTestIsolationHooks } from './helpers/register-contract-test-hooks.js';

registerThirdPartyContractTestIsolationHooks();

/**
 * The wire contract of the one Meta client (routes-final § 1 MC2, re-recorded at
 * feat-instagram-dm-sending ROUTE R3 — the Instagram Login calls, hosts and fixtures are gone, RC-6,
 * WC-35) (`src/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.ts`
 * and `meta-login.ts`): what each call sends to `graph.facebook.com`, where the token travels (only
 * `Authorization`, with `appsecret_proof`), and how Meta's real answers — success and error — are read.
 *
 * Where each fixture's shape comes from (`fixtures/meta-graph/`):
 *
 * | Fixture | Source |
 * | --- | --- |
 * | `unified-login-access-token.success`, `oauth-access-token.error` | Facebook Login for Business — the code exchange `GET /oauth/access_token` (`access_token`, `token_type`; a used code is Graph's `OAuthException` code 100) — developers.facebook.com/docs/facebook-login/facebook-login-for-business, docs/facebook-login/guides/advanced/manual-flow |
 * | `me-client-business.success` | `GET /me?fields=client_business_id` of a business-integration system user token — docs/facebook-login/facebook-login-for-business (Business Integration System User access tokens) |
 * | `assigned-instagram-accounts.success` | the system user's `assigned_instagram_accounts` edge (`id`, `username`, cursor paging) — docs/marketing-api/reference/system-user |
 * | `permissions.success` | `GET /me/permissions` (`permission`, `status` granted / declined) — docs/graph-api/reference/user/permissions |
 * | `ad-accounts.success`, `ads.success` | `GET /me/adaccounts` and an ad account's `/ads` with `creative{effective_instagram_media_id,instagram_user_id,thumbnail_url}` — docs/marketing-api/reference/ad-account, …/ad-account/ads, …/ad-creative |
 * | `instagram-account.success` / `.wrapped.success` | the IG User node read by its id on `graph.facebook.com` (`id`, `username`, counts) — docs/instagram-platform/instagram-graph-api/reference/ig-user; flat, or inside `data` as Meta's guides print it (D33) |
 * | `media.first-page` / `.last-page`, `stories.success`, `media-item.success` | IG User `/media` and `/stories` edges and the IG Media node (ISO `+0000` timestamps, `children.data`) — docs/instagram-platform/instagram-graph-api/reference/ig-user/media, …/ig-user/stories; Graph's cursor paging (`paging.cursors`, `paging.next` carrying `access_token` as live answers do) — docs/graph-api/results |
 * | `subscribed-apps.success` | `POST` / `DELETE /{id}/subscribed_apps` → `{ success: true }` — docs/instagram-platform/webhooks |
 * | `messages.success` | Send Messages and Private Replies → `{ recipient_id, message_id }` — docs/messenger-platform/instagram (the Instagram Messaging API on Facebook Login), docs/instagram-platform/private-replies |
 * | `message-attachments.success` | the Attachment Upload API → `{ attachment_id }` for a reusable file (`platform: instagram`, `payload.url`, `is_reusable: true`) — docs/messenger-platform/reference/attachment-upload-api, docs/instagram-platform/instagram-api-with-facebook-login/messaging-api (send a media message by `attachment_id`) |
 * | `comment-replies.success` | IG Comment `/replies` → `{ id }` — docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies |
 * | `user-profile.success` | Instagram User Profile API (Meta's own sample person) — docs/messenger-platform/instagram/features/user-profile |
 * | `graph-error.*` | Graph's error envelope and codes (190 with subcode 460 / 463, 4, 2 with `is_transient`) — docs/graph-api/guides/error-handling; `80002` (the Instagram business-use-case rate limit, subcode 2446079) — docs/graph-api/overview/rate-limiting; `100` / `2534014` — docs/messenger-platform/error-codes; `10` / `2534022` (a message outside the 24-hour messaging window; Messenger's `2018278` means the same) — docs/messenger-platform/error-codes, D32; `100` / `2534015` (the quick reply refused) — the intake's schema-routes § 6.5, no Meta page names it |
 */
describe('Meta outbound contract (`meta-graph.client`)', () => {
  /** The connection's token in plain text — the value that must never reach a URL or a log. */
  const ACCOUNT_ACCESS_TOKEN = 'EAAG-contract-fixture-account-access-token';
  /** The account's Instagram user id — the id every Graph path takes under Unified Login. */
  const APP_USER_ID = meSuccessFixture.id;
  const GRAPH_VERSION_PATH = `/${META_GRAPH_VERSION}`;
  const MEDIA_FIELDS =
    'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count,children{id,media_type,media_url}';
  const STORY_FIELDS = 'id,media_type,media_url,thumbnail_url,permalink,timestamp';
  const ACCOUNT_PROFILE_FIELDS =
    'id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website';
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
  /** The Unified Login code exchange's answer: a token that never ends (no `expires_in`, D24). */
  const UnifiedLoginTokenContractSchema = z.object({
    access_token: z.string().min(1),
    token_type: z.literal('bearer'),
    /** Present only for a configuration whose token ends (P355). */
    expires_in: z.number().int().nonnegative().optional(),
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

  /**
   * The `appsecret_proof` every call with a customer's token carries (SE.M.14): the HMAC-SHA256 of
   * the token keyed by the app secret, hex — computed here, apart from the client, so the wire is pinned.
   */
  function appSecretProofQuery(): { appsecret_proof: string } {
    return {
      appsecret_proof: createHmac('sha256', String(getEnv().META_APP_SECRET))
        .update(ACCOUNT_ACCESS_TOKEN)
        .digest('hex'),
    };
  }

  let encryptedAccountAccessToken = '';
  let loggerSpies: ReturnType<typeof vi.spyOn>[] = [];

  /** The Graph host, expecting the account's token in the `Authorization` header (IA4). */
  function graphWithAccountToken(): nock.Scope {
    return nock(META_GRAPH_BASE_URL).matchHeader('authorization', `Bearer ${ACCOUNT_ACCESS_TOKEN}`);
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

  describe('the Unified Login calls (MC2, MC5, MC13)', () => {
    test('the code exchange sends the app id, secret, return page and code to graph.facebook.com and encrypts the answer', async () => {
      const environment = getEnv();
      UnifiedLoginTokenContractSchema.parse(unifiedLoginAccessTokenSuccessFixture);
      let interceptedUrl = '';
      nock(META_GRAPH_BASE_URL)
        .get(`${GRAPH_VERSION_PATH}/oauth/access_token`)
        .query({
          client_id: String(environment.META_APP_ID),
          client_secret: String(environment.META_APP_SECRET),
          redirect_uri: String(environment.META_REDIRECT_URI),
          code: 'AQB-contract-code',
        })
        .reply(200, (interceptedUri: string) => {
          interceptedUrl = readInterceptedUrl({ interceptedUri, baseUrl: META_GRAPH_BASE_URL });
          return unifiedLoginAccessTokenSuccessFixture;
        });
      const readLoggedText = recordLoggedText();

      const token = await exchangeMetaLoginCode({ code: 'AQB-contract-code' });

      expect(token.encryptedAccessToken).not.toContain(
        unifiedLoginAccessTokenSuccessFixture.access_token,
      );
      expect(decryptFieldSecret(token.encryptedAccessToken)).toBe(
        unifiedLoginAccessTokenSuccessFixture.access_token,
      );
      // No `expires_in`: the configuration's token never ends (P355).
      expect(token.expiresAt).toBeNull();
      // The secret rides the query, as Meta documents the exchange; every logged URL is redacted.
      expect(redactSensitiveUrl(interceptedUrl)).not.toContain(String(environment.META_APP_SECRET));
      expect(redactSensitiveUrl(interceptedUrl)).toContain(SENSITIVE_REDACTION_PLACEHOLDER);
      expect(readLoggedText()).not.toContain(String(environment.META_APP_SECRET));
    });

    test('a used code is refused — never an outage, never a circuit failure', async () => {
      GraphErrorEnvelopeContractSchema.parse(oauthAccessTokenErrorFixture);
      nock(META_GRAPH_BASE_URL)
        .get(`${GRAPH_VERSION_PATH}/oauth/access_token`)
        .query(true)
        .reply(400, oauthAccessTokenErrorFixture);
      recordLoggedText();

      await expect(exchangeMetaLoginCode({ code: 'AQB-used' })).rejects.toMatchObject({
        errorClass: 'refused',
        instagramErrorCode: 100,
        countsAsCircuitFailure: false,
      });
    });

    test('the business, the assigned accounts and the granted permissions are read with the token in Authorization only', async () => {
      const interceptedUrls: string[] = [];
      const record = (body: unknown) => (interceptedUri: string) => {
        interceptedUrls.push(readInterceptedUrl({ interceptedUri, baseUrl: META_GRAPH_BASE_URL }));
        return body;
      };
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/me`)
        .query((query) => query.fields === 'client_business_id' && Boolean(query.appsecret_proof))
        .reply(200, record(meClientBusinessSuccessFixture))
        .get(`${GRAPH_VERSION_PATH}/me/assigned_instagram_accounts`)
        .query((query) => query.fields === 'id,username' && query.limit === '100')
        .reply(200, record(assignedInstagramAccountsSuccessFixture))
        .get(`${GRAPH_VERSION_PATH}/me/permissions`)
        .query(true)
        .reply(200, record(permissionsSuccessFixture));

      await expect(
        readMetaClientBusinessId({ encryptedAccessToken: encryptedAccountAccessToken }),
      ).resolves.toBe(meClientBusinessSuccessFixture.client_business_id);
      await expect(
        listMetaAssignedInstagramAccounts({ encryptedAccessToken: encryptedAccountAccessToken }),
      ).resolves.toEqual({
        accounts: assignedInstagramAccountsSuccessFixture.data.map((account) => ({
          instagramUserId: account.id,
          username: account.username,
        })),
        isComplete: true,
      });
      // A declined permission is not granted.
      await expect(
        readMetaGrantedPermissions({ encryptedAccessToken: encryptedAccountAccessToken }),
      ).resolves.toEqual([
        'instagram_basic',
        'instagram_manage_messages',
        'instagram_manage_comments',
      ]);
      for (const url of interceptedUrls) expectUrlWithoutToken(url);
    });

    test("the assigned accounts follow Meta's paging.next with the after cursor until the last page (P353)", async () => {
      GraphListPageContractSchema.parse(assignedInstagramAccountsFirstPageFixture);
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/me/assigned_instagram_accounts`)
        .query(
          (query) =>
            query.fields === 'id,username' && query.limit === '100' && query.after === undefined,
        )
        .reply(200, assignedInstagramAccountsFirstPageFixture)
        .get(`${GRAPH_VERSION_PATH}/me/assigned_instagram_accounts`)
        .query(
          (query) =>
            query.after === assignedInstagramAccountsFirstPageFixture.paging.cursors.after &&
            Boolean(query.appsecret_proof),
        )
        .reply(200, assignedInstagramAccountsSuccessFixture);

      const list = await listMetaAssignedInstagramAccounts({
        encryptedAccessToken: encryptedAccountAccessToken,
      });

      expect(list.isComplete).toBe(true);
      expect(list.accounts.map((account) => account.instagramUserId)).toEqual([
        '17841400000000101',
        ...assignedInstagramAccountsSuccessFixture.data.map((account) => account.id),
      ]);
    });

    test("the ad accounts, then one ad account's ads with their Instagram post and Meta's cursor", async () => {
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/me/adaccounts`)
        .query(true)
        .reply(200, adAccountsSuccessFixture)
        .get(`${GRAPH_VERSION_PATH}/act_1234567890123/ads`)
        .query((query) => query.limit === '25' && query.after === 'cursor-one')
        .reply(200, adsSuccessFixture);

      await expect(
        listMetaAdAccounts({ encryptedAccessToken: encryptedAccountAccessToken }),
      ).resolves.toEqual([
        { adAccountId: '1234567890123', name: 'Contract Fixture Ads', accountStatus: 1 },
      ]);
      const page = await listMetaAdAccountAds({
        encryptedAccessToken: encryptedAccountAccessToken,
        adAccountId: '1234567890123',
        limit: 25,
        after: 'cursor-one',
      });
      expect(page.items).toEqual([
        {
          adId: '120200000000000001',
          name: 'Winter sale',
          status: 'ACTIVE',
          instagramMediaId: '18030000000000001',
          instagramUserId: '17841400000000001',
          thumbnailUrl: 'https://scontent.cdninstagram.com/v/contract-fixture-ad.jpg',
          createdAt: '2026-11-01T10:00:00+0000',
        },
      ]);
      // The cursor, never paging.next (it carries a token).
      expect(page.nextCursor).toBe(adsSuccessFixture.paging.cursors.after);
    });
  });

  describe('the Graph reads (the token in the Authorization header, never the URL)', () => {
    /** The IG User node read by its id: the id as a digit string, counts. */
    const AccountProfileContractSchema = z
      .object({
        id: z.string().regex(/^\d+$/),
        username: z.string().min(1),
        followers_count: z.number().int().nonnegative(),
        follows_count: z.number().int().nonnegative(),
        media_count: z.number().int().nonnegative(),
      })
      .loose();
    /** The account both `/me` fixtures describe, as the client maps it. */
    const expectedAccountProfile = {
      instagramUserId: meSuccessFixture.id,
      username: meSuccessFixture.username,
      name: meSuccessFixture.name,
      profilePictureUrl: meSuccessFixture.profile_picture_url,
      followersCount: meSuccessFixture.followers_count,
      followsCount: meSuccessFixture.follows_count,
      mediaCount: meSuccessFixture.media_count,
      biography: meSuccessFixture.biography,
      website: meSuccessFixture.website,
    };

    test('the account read asks for the profile fields by its id and maps the account', async () => {
      AccountProfileContractSchema.parse(meSuccessFixture);
      let interceptedUrl = '';
      graphWithAccountToken()
        .matchHeader('x-request-id', 'contract-instagram-request')
        .get(`${GRAPH_VERSION_PATH}/${APP_USER_ID}`)
        .query((query) => query.fields === ACCOUNT_PROFILE_FIELDS)
        .reply(200, (interceptedUri: string) => {
          interceptedUrl = readInterceptedUrl({
            interceptedUri,
            baseUrl: META_GRAPH_BASE_URL,
          });
          return meSuccessFixture;
        });

      const accountProfile = await readInstagramAccountProfile({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramUserId: APP_USER_ID,
        requestId: 'contract-instagram-request',
      });

      expectUrlWithoutToken(interceptedUrl);
      expect(accountProfile).toEqual(expectedAccountProfile);
    });

    test("the account wrapped in data, as Meta's guide prints it, is read from data[0] — the same account as the flat answer (D33)", async () => {
      z.object({ data: z.array(AccountProfileContractSchema).min(1) }).parse(
        meWrappedSuccessFixture,
      );
      expect(meWrappedSuccessFixture.data[0]).toEqual(meSuccessFixture);
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/${APP_USER_ID}`)
        .query((query) => query.fields === ACCOUNT_PROFILE_FIELDS)
        .reply(200, meWrappedSuccessFixture);

      await expect(
        readInstagramAccountProfile({
          encryptedAccessToken: encryptedAccountAccessToken,
          instagramUserId: APP_USER_ID,
        }),
      ).resolves.toEqual(expectedAccountProfile);
    });

    test("media pages follow Instagram's after cursor and never hand back paging.next, which carries a token", async () => {
      GraphListPageContractSchema.parse(mediaFirstPageFixture);
      GraphListPageContractSchema.parse(mediaLastPageFixture);
      // The recorded next page is on the Graph host and version the client calls (AC-1.17).
      const recordedNext = new URL(mediaFirstPageFixture.paging.next);
      expect(recordedNext.origin).toBe(META_GRAPH_BASE_URL);
      expect(recordedNext.pathname.startsWith(`${GRAPH_VERSION_PATH}/`)).toBe(true);
      for (const mediaNode of [...mediaFirstPageFixture.data, ...mediaLastPageFixture.data]) {
        MediaNodeContractSchema.parse(mediaNode);
      }
      const interceptedUrls: string[] = [];
      const nextCursor = mediaFirstPageFixture.paging.cursors.after;
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/media`)
        .query({ fields: MEDIA_FIELDS, limit: '2', ...appSecretProofQuery() })
        .reply(200, (interceptedUri: string) => {
          interceptedUrls.push(
            readInterceptedUrl({ interceptedUri, baseUrl: META_GRAPH_BASE_URL }),
          );
          return mediaFirstPageFixture;
        });
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/media`)
        .query({ fields: MEDIA_FIELDS, limit: '2', after: nextCursor, ...appSecretProofQuery() })
        .reply(200, (interceptedUri: string) => {
          interceptedUrls.push(
            readInterceptedUrl({ interceptedUri, baseUrl: META_GRAPH_BASE_URL }),
          );
          return mediaLastPageFixture;
        });
      const listOptions = {
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramUserId: APP_USER_ID,
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
        .query({ fields: STORY_FIELDS, limit: '25', ...appSecretProofQuery() })
        .reply(200, storiesSuccessFixture);

      const storiesPage = await listInstagramStories({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramUserId: APP_USER_ID,
        limit: 25,
      });

      expect(storiesPage).toEqual({ items: storiesSuccessFixture.data, nextCursor: null });
    });

    test('the single media read asks for the media fields and keeps the carousel children as sent', async () => {
      MediaNodeContractSchema.parse(mediaItemSuccessFixture);
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/${mediaItemSuccessFixture.id}`)
        .query({ fields: MEDIA_FIELDS, ...appSecretProofQuery() })
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
        .query({
          fields: 'name,username,profile_pic,follower_count,is_user_follow_business',
          ...appSecretProofQuery(),
        })
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
    test('subscribed_apps: subscribe posts the six webhook fields (WC-30), unsubscribe deletes, both read success: true', async () => {
      z.object({ success: z.literal(true) }).parse(subscribedAppsSuccessFixture);
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/subscribed_apps`)
        .query({
          subscribed_fields:
            'comments,live_comments,messages,messaging_postbacks,messaging_referral,message_reactions',
          ...appSecretProofQuery(),
        })
        .reply(200, subscribedAppsSuccessFixture);
      graphWithAccountToken()
        .delete(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/subscribed_apps`)
        .query(appSecretProofQuery())
        .reply(200, subscribedAppsSuccessFixture);
      const subscriptionOptions = {
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramUserId: APP_USER_ID,
      };

      expect(INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS).toEqual([
        'comments',
        'live_comments',
        'messages',
        'messaging_postbacks',
        'messaging_referral',
        'message_reactions',
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
        .query(appSecretProofQuery())
        .matchHeader('content-type', 'application/json')
        .reply(200, messagesSuccessFixture);
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/messages`, privateReply)
        .query(appSecretProofQuery())
        .matchHeader('content-type', 'application/json')
        .reply(200, messagesSuccessFixture);
      const sender = {
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramUserId: APP_USER_ID,
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

    test("a message file is uploaded once to /message_attachments as a reusable URL attachment and Meta's attachment_id is read (SN20)", async () => {
      z.object({ attachment_id: z.string().regex(/^\d+$/) }).parse(
        messageAttachmentsSuccessFixture,
      );
      const fileUrl =
        'https://files.example.test/message-media/org_x/voice.m4a?X-Amz-Signature=abc';
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/message_attachments`, {
          platform: 'instagram',
          message: { attachment: { type: 'audio', payload: { url: fileUrl, is_reusable: true } } },
        })
        .query(appSecretProofQuery())
        .matchHeader('content-type', 'application/json')
        .reply(200, messageAttachmentsSuccessFixture);

      await expect(
        uploadInstagramMessageAttachment({
          encryptedAccessToken: encryptedAccountAccessToken,
          instagramUserId: APP_USER_ID,
          type: 'audio',
          url: fileUrl,
        }),
      ).resolves.toEqual({ attachmentId: messageAttachmentsSuccessFixture.attachment_id });
    });

    test('an attachment upload answered without attachment_id is a malformed answer (outage), never a kept id', async () => {
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/message_attachments`)
        .query(appSecretProofQuery())
        .reply(200, {});

      const rejection = await uploadInstagramMessageAttachment({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramUserId: APP_USER_ID,
        type: 'image',
        url: 'https://files.example.test/message-media/org_x/photo.png',
      }).catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(MetaGraphApiError);
      expect((rejection as MetaGraphApiError).errorClass).toBe('outage');
    });

    test('a public comment reply posts the message to /{comment_id}/replies and returns the reply id', async () => {
      z.object({ id: z.string().regex(/^\d+$/) }).parse(commentRepliesSuccessFixture);
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/17865800000000001/replies`, { message: 'Sent you a message!' })
        .query(appSecretProofQuery())
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
    test('190 / 463 is auth → expired, and the token reaches neither a log line nor the error', async () => {
      GraphErrorEnvelopeContractSchema.parse(graphErrorTokenExpiredFixture);
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/${APP_USER_ID}`)
        .query(true)
        .reply(400, graphErrorTokenExpiredFixture);
      const readLoggedText = recordLoggedText();

      const rejection = await readInstagramAccountProfile({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramUserId: APP_USER_ID,
      }).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(MetaGraphApiError);
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
      const shortLivedAccessToken = ACCOUNT_ACCESS_TOKEN;
      GraphErrorEnvelopeContractSchema.parse(graphErrorTokenInvalidatedFixture);
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/me`)
        .query(true)
        .reply(400, graphErrorTokenInvalidatedFixture);
      const readLoggedText = recordLoggedText();

      const rejection = await readMetaClientBusinessId({
        encryptedAccessToken: encryptedAccountAccessToken,
      }).catch((error: unknown) => error);

      expect(rejection).toMatchObject({
        errorClass: 'auth',
        connectionStatus: 'error',
        instagramErrorCode: 190,
        instagramErrorSubcode: 460,
        countsAsCircuitFailure: false,
      });
      const appSecret = String(environment.META_APP_SECRET);
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
        instagramUserId: APP_USER_ID,
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

    test('the business messaging throttle (code 80002) is a throttle too (D53), and a long Retry-After is cut to 15 minutes (D56)', async () => {
      GraphErrorEnvelopeContractSchema.parse(graphErrorBusinessThrottledFixture);
      const send = () =>
        sendInstagramMessage({
          encryptedAccessToken: encryptedAccountAccessToken,
          instagramUserId: APP_USER_ID,
          recipient: { id: messagesSuccessFixture.recipient_id },
          message: { text: 'Hello!' },
        });
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/messages`)
        .query(appSecretProofQuery())
        .reply(400, graphErrorBusinessThrottledFixture);
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/messages`)
        .query(appSecretProofQuery())
        .reply(400, graphErrorBusinessThrottledFixture, { 'Retry-After': '86400' });

      await expect(send()).rejects.toMatchObject({
        errorClass: 'throttled',
        connectionStatus: null,
        status: 400,
        retryAfterMs: INSTAGRAM_THROTTLE_DEFAULT_RETRY_AFTER_MS,
        instagramErrorCode: 80002,
        instagramErrorSubcode: 2446079,
        countsAsCircuitFailure: false,
      });
      await expect(send()).rejects.toMatchObject({
        errorClass: 'throttled',
        retryAfterMs: INSTAGRAM_THROTTLE_MAX_RETRY_AFTER_MS,
      });
    });

    test('a plain refusal (code 100, no matching user) is refused — not a quick-reply refusal', async () => {
      GraphErrorEnvelopeContractSchema.parse(graphErrorRecipientNotFoundFixture);
      graphWithAccountToken()
        .post(`${GRAPH_VERSION_PATH}/${APP_USER_ID}/messages`)
        .query(appSecretProofQuery())
        .reply(400, graphErrorRecipientNotFoundFixture);

      const rejection = await sendInstagramMessage({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramUserId: APP_USER_ID,
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
        .query(appSecretProofQuery())
        .reply(400, graphErrorOutsideMessagingWindowFixture);

      const rejection = await sendInstagramMessage({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramUserId: APP_USER_ID,
        recipient: { id: messagesSuccessFixture.recipient_id },
        message: { text: 'Thanks for your message!' },
      }).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(MetaGraphApiError);
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
        .query(appSecretProofQuery())
        .reply(400, graphErrorQuickReplyRefusedFixture);

      const rejection = await sendInstagramMessage({
        encryptedAccessToken: encryptedAccountAccessToken,
        instagramUserId: APP_USER_ID,
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

    test('a 5xx is an outage; five of them open the meta circuit and the next call never leaves', async () => {
      GraphErrorEnvelopeContractSchema.parse(graphErrorUnexpectedFixture);
      const failureThreshold = 5;
      graphWithAccountToken()
        .get(`${GRAPH_VERSION_PATH}/${APP_USER_ID}`)
        .query(true)
        .times(failureThreshold)
        .reply(500, graphErrorUnexpectedFixture);
      recordLoggedText();
      const readProfile = () =>
        readInstagramAccountProfile({
          encryptedAccessToken: encryptedAccountAccessToken,
          instagramUserId: APP_USER_ID,
        });

      for (let attempt = 0; attempt < failureThreshold; attempt += 1) {
        await expect(readProfile()).rejects.toMatchObject({
          errorClass: 'outage',
          category: 'http_5xx',
          status: 500,
          instagramErrorCode: 2,
          countsAsCircuitFailure: true,
        });
      }
      expect(await metaGraphCircuit.getState()).toBe('OPEN');

      // No interceptor is left and the network is closed: only the open circuit can answer.
      const rejection = await readProfile().catch((error: unknown) => error);
      expect(rejection).toMatchObject({ errorClass: 'outage', category: 'circuit_open' });
      expect(rejection).toHaveProperty('retryAfterMs', expect.any(Number));
    });

    test('a burst of dead tokens, throttles and refusals never opens the meta circuit', async () => {
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
          .get(`${GRAPH_VERSION_PATH}/${APP_USER_ID}`)
          .query(true)
          .reply(400, refusalFixture);
      }
      recordLoggedText();

      for (let attempt = 0; attempt < refusalFixtures.length; attempt += 1) {
        const rejection = await readInstagramAccountProfile({
          encryptedAccessToken: encryptedAccountAccessToken,
          instagramUserId: APP_USER_ID,
        }).catch((error: unknown) => error);
        expect(rejection).toBeInstanceOf(MetaGraphApiError);
        expect(rejection).toHaveProperty('countsAsCircuitFailure', false);
      }

      expect(await metaGraphCircuit.getState()).toBe('CLOSED');
    });
  });
});
