import { buildOutboundFetchOptions, outboundFetchJson } from '@/infrastructure/outbound/index.js';
import {
  buildInstagramMalformedAnswerError,
  readInstagramErrorResponse,
  toInstagramApiError,
} from '@/infrastructure/social/instagram-error.util.js';
import { getEnv } from '@/shared/config/env.config.js';
import { MILLISECONDS_PER_SECOND } from '@/shared/constants/ttl.constants.js';
import { ServiceUnavailableError } from '@/shared/errors/index.js';
import {
  decryptFieldSecret,
  encryptFieldSecret,
} from '@/shared/utils/security/field-secret-encryption.util.js';

/** Pinned Instagram Graph API version (D20) — bump deliberately and verify against Meta's changelog. */
export const INSTAGRAM_GRAPH_API_VERSION = 'v24.0';
/** The host of Instagram's authorization-code exchange (`/oauth/access_token`). */
export const INSTAGRAM_AUTHORIZATION_BASE_URL = 'https://api.instagram.com';
/** The host of every other Instagram call: the token exchange and renewal, and the Graph API. */
export const INSTAGRAM_GRAPH_BASE_URL = 'https://graph.instagram.com';
/** The webhook fields every connected account is subscribed to (IA12). */
export const INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS = [
  'comments',
  'messages',
  'messaging_postbacks',
] as const;

/** `/me` fields the connect and the daily check read (IA12). */
const INSTAGRAM_ACCOUNT_PROFILE_FIELDS =
  'user_id,id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count,biography,website';
/** Post and reel fields (schema-routes §6.2, IA16). */
const INSTAGRAM_MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count,children{id,media_type,media_url}';
/** Story fields (schema-routes §6.3, IA16). */
const INSTAGRAM_STORY_FIELDS = 'id,media_type,media_url,thumbnail_url,permalink,timestamp';
/** A person's profile and follow status in one read (contacts CQ3, the follow check). */
const INSTAGRAM_USER_PROFILE_FIELDS =
  'name,username,profile_pic,follower_count,is_user_follow_business';
/** What Instagram appends to the code in the redirect, not part of it (IA12). */
const INSTAGRAM_CODE_REDIRECT_SUFFIX = '#_';

/** An Instagram call's request id, sent as `X-Request-Id` for tracing. */
interface InstagramRequestTracing {
  requestId?: string | undefined;
}

/**
 * Whether the three Instagram app settings are set (`INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`,
 * `INSTAGRAM_REDIRECT_URI`) — unset, the Instagram routes answer 503 `instagram_not_configured`.
 */
export function isInstagramConfigured(): boolean {
  const environment = getEnv();
  return Boolean(
    environment.INSTAGRAM_APP_ID &&
      environment.INSTAGRAM_APP_SECRET &&
      environment.INSTAGRAM_REDIRECT_URI,
  );
}

/** The three app settings, or a 503 `instagram_not_configured` when any is unset. */
function readInstagramAppSettings(): { appId: string; appSecret: string; redirectUri: string } {
  const environment = getEnv();
  const appId = environment.INSTAGRAM_APP_ID;
  const appSecret = environment.INSTAGRAM_APP_SECRET;
  const redirectUri = environment.INSTAGRAM_REDIRECT_URI;
  if (!(appId && appSecret && redirectUri)) {
    throw new ServiceUnavailableError('errors:instagramNotConfigured').withReason(
      'instagram_not_configured',
    );
  }
  return { appId, appSecret, redirectUri };
}

/**
 * One Instagram call through the outbound layer: the `instagram` timeout (10 s) and circuit, the
 * error answer read once ({@link readInstagramErrorResponse}), every failure an
 * `InstagramApiError`.
 */
async function callInstagram<TAnswer>({
  url,
  init,
  requestId,
}: {
  url: string;
  init?: RequestInit;
  requestId?: string | undefined;
}): Promise<TAnswer> {
  try {
    return await outboundFetchJson<TAnswer>(
      buildOutboundFetchOptions({
        name: 'instagram',
        url,
        init,
        requestId,
        expectedStatus: 200,
        classifyResponseError: (response, body) =>
          readInstagramErrorResponse({
            httpStatus: response.status,
            body,
            retryAfterHeader: response.headers.get('retry-after'),
          }),
      }),
    );
  } catch (error) {
    throw toInstagramApiError(error);
  }
}

/** `https://graph.instagram.com/v24.0/<path>?<query>` — every path segment already encoded. */
function buildInstagramGraphUrl({
  path,
  query = {},
}: {
  path: string;
  query?: Record<string, string | undefined>;
}): string {
  const url = new URL(`/${INSTAGRAM_GRAPH_API_VERSION}/${path}`, INSTAGRAM_GRAPH_BASE_URL);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
}

/**
 * The request init for a Graph call: the token, decrypted only here, in the `Authorization`
 * header — never in the URL.
 */
function buildInstagramGraphInit({
  encryptedAccessToken,
  method = 'GET',
  jsonBody,
}: {
  encryptedAccessToken: string;
  method?: 'GET' | 'POST' | 'DELETE';
  jsonBody?: unknown;
}): RequestInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${decryptFieldSecret(encryptedAccessToken)}`,
  };
  if (jsonBody === undefined) return { method, headers };
  headers['Content-Type'] = 'application/json';
  return { method, headers, body: JSON.stringify(jsonBody) };
}

/** A non-empty string field of an Instagram answer, else `null`. */
function readAnswerText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A count field of an Instagram answer (a non-negative whole number), else `null`. */
function readAnswerCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** An Instagram id: Graph sends a digit string; an exact JSON number is accepted too. */
function readAnswerId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/**
 * The record an Instagram answer carries: `data[0]` when the body has `data` as a non-empty list
 * (the shape Meta's guides print), else the flat body (the shape a node read answers) — D33.
 * Anything not an object reads as empty, so the caller's check of what it needs fails it as malformed.
 */
function readInstagramAnswerRecord(answer: unknown): Record<string, unknown> {
  const body = readAnswerObject(answer);
  const record = Array.isArray(body.data) && body.data.length > 0 ? body.data[0] : body;
  return readAnswerObject(record);
}

/** `value` as a plain object, else an empty one. */
function readAnswerObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The granted permissions: a comma-separated string or a list (Instagram has sent both). */
function readGrantedPermissions(value: unknown): string[] {
  let permissions: string[] = [];
  if (Array.isArray(value)) {
    permissions = value.filter(
      (permission): permission is string => typeof permission === 'string',
    );
  } else if (typeof value === 'string') {
    permissions = value.split(',');
  }
  return permissions
    .map((permission) => permission.trim())
    .filter((permission) => permission.length > 0);
}

/** The short-lived token of {@link exchangeInstagramAuthorizationCode}, already encrypted (IA5). */
export interface InstagramShortLivedAccessToken {
  /** The short-lived token, encrypted with `encryptFieldSecret`. */
  encryptedAccessToken: string;
  /** The permissions the person granted on Instagram's consent screen. */
  grantedPermissions: string[];
}

/**
 * Exchanges the authorization code Instagram sent to `INSTAGRAM_REDIRECT_URI` for a short-lived
 * token and the permissions granted (IA12 step 1).
 *
 * @remarks
 * - **Algorithm:** strips a trailing `#_` from the code, then `POST
 *   https://api.instagram.com/oauth/access_token` (form: `client_id`, `client_secret`,
 *   `grant_type=authorization_code`, `redirect_uri`, `code`); the token comes back encrypted.
 * - **Failure modes:** a setting unset → 503 `instagram_not_configured`; a bad, used or expired
 *   code → `InstagramApiError` `refused`; an answer without a token → `outage`.
 * - **Side effects:** one Instagram call; the code and the secret travel in the body, not the URL.
 * - **Notes:** the answer's `user_id` is not read — `/me` gives the ids as exact strings.
 */
export async function exchangeInstagramAuthorizationCode({
  code,
  requestId,
}: { code: string } & InstagramRequestTracing): Promise<InstagramShortLivedAccessToken> {
  const { appId, appSecret, redirectUri } = readInstagramAppSettings();
  const authorizationCode = code.endsWith(INSTAGRAM_CODE_REDIRECT_SUFFIX)
    ? code.slice(0, -INSTAGRAM_CODE_REDIRECT_SUFFIX.length)
    : code;
  const answer = await callInstagram<unknown>({
    url: new URL('/oauth/access_token', INSTAGRAM_AUTHORIZATION_BASE_URL).toString(),
    requestId,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: authorizationCode,
      }),
    },
  });
  // Flat, or wrapped in `data[0]` as Meta documents it.
  const grant = readInstagramAnswerRecord(answer);
  const accessToken = readAnswerText(grant.access_token);
  if (accessToken === null) {
    throw buildInstagramMalformedAnswerError({
      operation: 'the code exchange',
      missing: 'access_token',
    });
  }
  return {
    encryptedAccessToken: encryptFieldSecret(accessToken),
    grantedPermissions: readGrantedPermissions(grant.permissions),
  };
}

/** A long-lived token (about 60 days), already encrypted, and when it ends (IA5, IA12). */
export interface InstagramLongLivedAccessToken {
  /** The long-lived token, encrypted with `encryptFieldSecret`. */
  encryptedAccessToken: string;
  /** When Instagram says the token ends (`expires_in` from now). */
  expiresAt: Date;
}

/** The answer of the long-lived exchange and of the renewal. */
type InstagramLongLivedTokenAnswer = { access_token?: unknown; expires_in?: unknown };

/** Reads a long-lived token answer: the token encrypted, `expires_in` seconds from now. */
function readLongLivedTokenAnswer({
  answer,
  operation,
}: {
  answer: InstagramLongLivedTokenAnswer;
  operation: string;
}): InstagramLongLivedAccessToken {
  const accessToken = readAnswerText(answer.access_token);
  if (accessToken === null) {
    throw buildInstagramMalformedAnswerError({ operation, missing: 'access_token' });
  }
  const expiresInSeconds = answer.expires_in;
  if (typeof expiresInSeconds !== 'number' || !(expiresInSeconds > 0)) {
    throw buildInstagramMalformedAnswerError({ operation, missing: 'expires_in' });
  }
  return {
    encryptedAccessToken: encryptFieldSecret(accessToken),
    expiresAt: new Date(Date.now() + expiresInSeconds * MILLISECONDS_PER_SECOND),
  };
}

/**
 * Exchanges a short-lived token for a long-lived one (`ig_exchange_token`, about 60 days) (IA12).
 *
 * @remarks
 * - **Algorithm:** decrypts the short-lived token right before `GET
 *   https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=…&access_token=…`
 *   (Instagram takes both only in the query); returns the new token encrypted and `expiresAt`.
 * - **Failure modes:** a setting unset → 503 `instagram_not_configured`; Instagram refusing the
 *   token → `InstagramApiError` `auth`; an answer without a token or `expires_in` → `outage`.
 * - **Side effects:** one Instagram call.
 * - **Notes:** the URL carries the secret and the token; any log or Sentry breadcrumb of it goes
 *   through `redactSensitiveUrl` (`access_token`, `client_secret` are redacted).
 */
export async function exchangeInstagramLongLivedAccessToken({
  encryptedShortLivedAccessToken,
  requestId,
}: {
  encryptedShortLivedAccessToken: string;
} & InstagramRequestTracing): Promise<InstagramLongLivedAccessToken> {
  const { appSecret } = readInstagramAppSettings();
  const url = new URL('/access_token', INSTAGRAM_GRAPH_BASE_URL);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('access_token', decryptFieldSecret(encryptedShortLivedAccessToken));
  const answer = await callInstagram<InstagramLongLivedTokenAnswer>({
    url: url.toString(),
    requestId,
  });
  return readLongLivedTokenAnswer({ answer, operation: 'the long-lived token exchange' });
}

/**
 * Renews a long-lived token for another ~60 days (`ig_refresh_token`) — the daily check (IA8).
 *
 * @remarks
 * - **Algorithm:** decrypts the token right before `GET
 *   https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=…`
 *   (Instagram takes it only in the query); returns the new token encrypted and `expiresAt`.
 * - **Failure modes:** a dead token → `InstagramApiError` `auth` (`expired` for 190 / 463);
 *   Instagram down → `outage`; an answer without a token or `expires_in` → `outage`.
 * - **Side effects:** one Instagram call.
 * - **Notes:** needs no app setting. The URL carries the token; logs redact it.
 */
export async function refreshInstagramLongLivedAccessToken({
  encryptedAccessToken,
  requestId,
}: {
  encryptedAccessToken: string;
} & InstagramRequestTracing): Promise<InstagramLongLivedAccessToken> {
  const url = new URL('/refresh_access_token', INSTAGRAM_GRAPH_BASE_URL);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', decryptFieldSecret(encryptedAccessToken));
  const answer = await callInstagram<InstagramLongLivedTokenAnswer>({
    url: url.toString(),
    requestId,
  });
  return readLongLivedTokenAnswer({ answer, operation: 'the token renewal' });
}

/** The connected account as `/me` describes it (IA12); an absent field is `null`. */
export interface InstagramAccountProfile {
  /** `user_id` — the professional account's Instagram id (`instagram_user_id`, webhook `entry.id`). */
  instagramUserId: string;
  /** `id` — the app-scoped id the Graph calls take (`instagram_app_user_id`). */
  instagramAppUserId: string;
  username: string | null;
  name: string | null;
  /** `BUSINESS`, `MEDIA_CREATOR` or `PERSONAL`, as Instagram sends it. */
  accountType: string | null;
  profilePictureUrl: string | null;
  followersCount: number | null;
  followsCount: number | null;
  mediaCount: number | null;
  biography: string | null;
  website: string | null;
}

/**
 * Reads the connected account's `/me` profile (IA12 — the connect and the daily refresh).
 *
 * @remarks
 * - **Algorithm:** `GET /v24.0/me?fields=user_id,id,username,name,account_type,profile_picture_url,
 *   followers_count,follows_count,media_count,biography,website` with the token in the
 *   `Authorization` header. The profile is read from `data[0]` when the answer wraps it in a
 *   non-empty `data` list, else from the flat body (D33 — Meta documents both).
 * - **Failure modes:** `InstagramApiError` (`auth` for a dead token); an answer without `user_id`
 *   or `id` → `outage`.
 * - **Side effects:** one Instagram call.
 * - **Notes:** the profile is the organization's business data, not a secret.
 */
export async function readInstagramAccountProfile({
  encryptedAccessToken,
  requestId,
}: { encryptedAccessToken: string } & InstagramRequestTracing): Promise<InstagramAccountProfile> {
  const answer = readInstagramAnswerRecord(
    await callInstagram<unknown>({
      url: buildInstagramGraphUrl({
        path: 'me',
        query: { fields: INSTAGRAM_ACCOUNT_PROFILE_FIELDS },
      }),
      init: buildInstagramGraphInit({ encryptedAccessToken }),
      requestId,
    }),
  );
  const instagramUserId = readAnswerId(answer.user_id);
  const instagramAppUserId = readAnswerId(answer.id);
  if (instagramUserId === null || instagramAppUserId === null) {
    throw buildInstagramMalformedAnswerError({ operation: '/me', missing: 'user_id or id' });
  }
  return {
    instagramUserId,
    instagramAppUserId,
    username: readAnswerText(answer.username),
    name: readAnswerText(answer.name),
    accountType: readAnswerText(answer.account_type),
    profilePictureUrl: readAnswerText(answer.profile_picture_url),
    followersCount: readAnswerCount(answer.followers_count),
    followsCount: readAnswerCount(answer.follows_count),
    mediaCount: readAnswerCount(answer.media_count),
    biography: readAnswerText(answer.biography),
    website: readAnswerText(answer.website),
  };
}

/** One child of a carousel, as Instagram sends it. */
export interface InstagramMediaChildGraphItem {
  id: string;
  media_type?: string;
  media_url?: string;
}

/**
 * A post or reel as Instagram sends it (schema-routes §6.2) — the wire shape, kept as read so the
 * media service can map it (IA16) and store it as `graph_data` (IA17).
 */
export interface InstagramMediaGraphItem {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
  comments_count?: number;
  like_count?: number;
  children?: { data?: InstagramMediaChildGraphItem[] };
}

/** A live story as Instagram sends it (schema-routes §6.3). */
export interface InstagramStoryGraphItem {
  id: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
}

/**
 * One page of an Instagram list: the items, and Instagram's `after` cursor only when Instagram has
 * a next page (IA16: `next` / `has_more` follow it).
 */
export interface InstagramGraphPage<TItem> {
  items: TItem[];
  nextCursor: string | null;
}

/** A Graph list answer: `data` and Instagram's own paging. */
type InstagramGraphListAnswer = {
  data?: unknown;
  paging?: { cursors?: { after?: unknown }; next?: unknown };
};

/** Options of {@link listInstagramMedia} and {@link listInstagramStories}. */
export interface ListInstagramItemsOptions extends InstagramRequestTracing {
  encryptedAccessToken: string;
  /** The account's app-scoped id (`/me` `id`). */
  instagramAppUserId: string;
  /** Page size, passed on as Instagram's `limit` (the route allows 1–50). */
  limit: number;
  /** Instagram's `after` cursor from the previous page. */
  after?: string | undefined;
}

/** Reads one page of an account's edge (`media`, `stories`) with Instagram's cursor. */
async function listInstagramEdge<TItem extends { id: string }>({
  options,
  edge,
  fields,
}: {
  options: ListInstagramItemsOptions;
  edge: 'media' | 'stories';
  fields: string;
}): Promise<InstagramGraphPage<TItem>> {
  const answer = await callInstagram<InstagramGraphListAnswer>({
    url: buildInstagramGraphUrl({
      path: `${encodeURIComponent(options.instagramAppUserId)}/${edge}`,
      query: { fields, limit: String(options.limit), after: options.after },
    }),
    init: buildInstagramGraphInit({ encryptedAccessToken: options.encryptedAccessToken }),
    requestId: options.requestId,
  });
  if (!Array.isArray(answer.data)) {
    throw buildInstagramMalformedAnswerError({ operation: `/${edge}`, missing: 'data' });
  }
  const items = answer.data.filter(
    (item): item is TItem =>
      typeof item === 'object' && item !== null && readAnswerId((item as TItem).id) !== null,
  );
  const hasNextPage = readAnswerText(answer.paging?.next) !== null;
  const afterCursor = readAnswerText(answer.paging?.cursors?.after);
  return { items, nextCursor: hasNextPage ? afterCursor : null };
}

/**
 * Lists one page of the account's posts and reels, live (`/{instagram_app_user_id}/media`, IA16).
 *
 * @remarks
 * - **Algorithm:** `GET /v24.0/{id}/media?fields=…&limit=…&after=…` with the token in the
 *   `Authorization` header; items without an id are dropped.
 * - **Failure modes:** `InstagramApiError` — `auth` (the route's 404 `instagram_reconnect_required`),
 *   `throttled` / `outage` (503 with `Retry-After`); no `data` list → `outage`.
 * - **Side effects:** one Instagram call; nothing is stored.
 * - **Notes:** `nextCursor` is `paging.cursors.after`, only when Instagram has `paging.next`.
 */
export async function listInstagramMedia(
  options: ListInstagramItemsOptions,
): Promise<InstagramGraphPage<InstagramMediaGraphItem>> {
  return listInstagramEdge<InstagramMediaGraphItem>({
    options,
    edge: 'media',
    fields: INSTAGRAM_MEDIA_FIELDS,
  });
}

/**
 * Lists one page of the account's live stories (`/{instagram_app_user_id}/stories`, IA16).
 *
 * @remarks
 * - **Algorithm:** `GET /v24.0/{id}/stories?fields=id,media_type,media_url,thumbnail_url,permalink,
 *   timestamp&limit=…&after=…` with the token in the `Authorization` header.
 * - **Failure modes:** as {@link listInstagramMedia}.
 * - **Side effects:** one Instagram call; nothing is stored.
 * - **Notes:** a story's `expires_at` is the service's (`timestamp` + 24 h); Instagram sends none.
 */
export async function listInstagramStories(
  options: ListInstagramItemsOptions,
): Promise<InstagramGraphPage<InstagramStoryGraphItem>> {
  return listInstagramEdge<InstagramStoryGraphItem>({
    options,
    edge: 'stories',
    fields: INSTAGRAM_STORY_FIELDS,
  });
}

/**
 * Reads one post by its Instagram media id — the post a comment arrived on, stored the first time
 * (WH13, IA17).
 *
 * @remarks
 * - **Algorithm:** `GET /v24.0/{media_id}?fields=<the media fields>` with the token in the
 *   `Authorization` header.
 * - **Failure modes:** `InstagramApiError`; an answer without `id` → `outage`.
 * - **Side effects:** one Instagram call.
 * - **Notes:** the same fields as {@link listInstagramMedia}.
 */
export async function readInstagramMediaItem({
  encryptedAccessToken,
  instagramMediaId,
  requestId,
}: {
  encryptedAccessToken: string;
  instagramMediaId: string;
} & InstagramRequestTracing): Promise<InstagramMediaGraphItem> {
  const answer = await callInstagram<InstagramMediaGraphItem>({
    url: buildInstagramGraphUrl({
      path: encodeURIComponent(instagramMediaId),
      query: { fields: INSTAGRAM_MEDIA_FIELDS },
    }),
    init: buildInstagramGraphInit({ encryptedAccessToken }),
    requestId,
  });
  if (readAnswerId(answer.id) === null) {
    throw buildInstagramMalformedAnswerError({ operation: 'the media read', missing: 'id' });
  }
  return answer;
}

/** Options of the webhook subscription calls. */
export interface InstagramWebhookSubscriptionOptions extends InstagramRequestTracing {
  encryptedAccessToken: string;
  /** The account's app-scoped id (`/me` `id`). */
  instagramAppUserId: string;
}

/** Fails unless Instagram answered `{ success: true }`. */
function assertInstagramSuccessAnswer({
  answer,
  operation,
}: {
  answer: { success?: unknown };
  operation: string;
}): void {
  if (answer.success !== true) {
    throw buildInstagramMalformedAnswerError({ operation, missing: 'success: true' });
  }
}

/**
 * Subscribes the account to the webhook fields `comments`, `messages`, `messaging_postbacks`
 * (`POST /{instagram_app_user_id}/subscribed_apps`, IA12 step 5, IA8).
 *
 * @remarks
 * - **Algorithm:** `POST /v24.0/{id}/subscribed_apps?subscribed_fields=comments,messages,
 *   messaging_postbacks` with the token in the `Authorization` header; Instagram answers
 *   `{ success: true }`.
 * - **Failure modes:** `InstagramApiError`; any answer but `success: true` → `outage`.
 * - **Side effects:** one Instagram call — Meta starts sending this account's events.
 * - **Notes:** safe to repeat. The connect logs a failure and never fails on it.
 */
export async function subscribeInstagramWebhookFields({
  encryptedAccessToken,
  instagramAppUserId,
  requestId,
}: InstagramWebhookSubscriptionOptions): Promise<void> {
  const answer = await callInstagram<{ success?: unknown }>({
    url: buildInstagramGraphUrl({
      path: `${encodeURIComponent(instagramAppUserId)}/subscribed_apps`,
      query: { subscribed_fields: INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS.join(',') },
    }),
    init: buildInstagramGraphInit({ encryptedAccessToken, method: 'POST' }),
    requestId,
  });
  assertInstagramSuccessAnswer({ answer, operation: 'the webhook subscription' });
}

/**
 * Unsubscribes the account from every webhook field (`DELETE /{instagram_app_user_id}/subscribed_apps`)
 * — the disconnect (IA14).
 *
 * @remarks
 * - **Algorithm:** `DELETE /v24.0/{id}/subscribed_apps` with the token in the `Authorization`
 *   header; Instagram answers `{ success: true }`.
 * - **Failure modes:** `InstagramApiError`; any answer but `success: true` → `outage`.
 * - **Side effects:** one Instagram call — Meta stops sending this account's events.
 * - **Notes:** safe to repeat.
 */
export async function unsubscribeInstagramWebhookFields({
  encryptedAccessToken,
  instagramAppUserId,
  requestId,
}: InstagramWebhookSubscriptionOptions): Promise<void> {
  const answer = await callInstagram<{ success?: unknown }>({
    url: buildInstagramGraphUrl({
      path: `${encodeURIComponent(instagramAppUserId)}/subscribed_apps`,
    }),
    init: buildInstagramGraphInit({ encryptedAccessToken, method: 'DELETE' }),
    requestId,
  });
  assertInstagramSuccessAnswer({ answer, operation: 'the webhook unsubscription' });
}

/** Who a message goes to: a person (`id`, their Instagram-scoped id) or a comment (a private reply). */
export type InstagramMessageRecipient = { id: string } | { comment_id: string };

/** A quick reply under a message: a text choice, or Instagram's own email / phone button. */
export interface InstagramQuickReply {
  content_type: 'text' | 'user_email' | 'user_phone_number';
  title?: string;
  payload?: string;
}

/** The `message` object of a send, in Instagram's wire shape (text, quick replies, a template). */
export interface InstagramOutgoingMessage {
  text?: string;
  quick_replies?: readonly InstagramQuickReply[];
  attachment?: { type: 'template'; payload: Readonly<Record<string, unknown>> };
}

/** What Instagram answers for a sent message. */
export interface InstagramSentMessage {
  messageId: string | null;
  recipientId: string | null;
}

/**
 * Sends a direct message, or a private reply to a comment (`recipient.comment_id`), from the
 * account (`POST /{instagram_app_user_id}/messages`) — sub-domains 3–4.
 *
 * @remarks
 * - **Algorithm:** `POST /v24.0/{id}/messages` with JSON `{ recipient, message }` and the token in
 *   the `Authorization` header; returns Instagram's `message_id` and `recipient_id`.
 * - **Failure modes:** `InstagramApiError` — `auth` (a dead token: the guarded status change),
 *   `refused` (`isQuickReplyRefused` for code 100 / 2534015: send the question as plain text; code
 *   10 outside the 24-hour messaging window: only this send fails, D32), `throttled`, `outage`.
 * - **Side effects:** one Instagram call — the person receives the message.
 * - **Notes:** not idempotent — the run engine's claim keeps a message from going twice (D16); the
 *   200–1000 ms pause before a send (K10) is the caller's.
 */
export async function sendInstagramMessage({
  encryptedAccessToken,
  instagramAppUserId,
  recipient,
  message,
  requestId,
}: {
  encryptedAccessToken: string;
  instagramAppUserId: string;
  recipient: InstagramMessageRecipient;
  message: InstagramOutgoingMessage;
} & InstagramRequestTracing): Promise<InstagramSentMessage> {
  const answer = await callInstagram<{ message_id?: unknown; recipient_id?: unknown }>({
    url: buildInstagramGraphUrl({ path: `${encodeURIComponent(instagramAppUserId)}/messages` }),
    init: buildInstagramGraphInit({
      encryptedAccessToken,
      method: 'POST',
      jsonBody: { recipient, message },
    }),
    requestId,
  });
  return {
    messageId: readAnswerText(answer.message_id),
    recipientId: readAnswerId(answer.recipient_id),
  };
}

/** What Instagram answers for a public comment reply. */
export interface InstagramCommentReply {
  /** The reply's own comment id. */
  instagramCommentReplyId: string | null;
}

/**
 * Replies publicly under a comment (`POST /{comment_id}/replies`) — sub-domain 3's public reply.
 *
 * @remarks
 * - **Algorithm:** `POST /v24.0/{comment_id}/replies` with JSON `{ message: text }` and the token
 *   in the `Authorization` header; returns the reply's id.
 * - **Failure modes:** `InstagramApiError`, as {@link sendInstagramMessage}.
 * - **Side effects:** one Instagram call — a public comment appears.
 * - **Notes:** not idempotent; the caller's claim keeps it single.
 */
export async function replyToInstagramComment({
  encryptedAccessToken,
  instagramCommentId,
  text,
  requestId,
}: {
  encryptedAccessToken: string;
  instagramCommentId: string;
  text: string;
} & InstagramRequestTracing): Promise<InstagramCommentReply> {
  const answer = await callInstagram<{ id?: unknown }>({
    url: buildInstagramGraphUrl({ path: `${encodeURIComponent(instagramCommentId)}/replies` }),
    init: buildInstagramGraphInit({
      encryptedAccessToken,
      method: 'POST',
      jsonBody: { message: text },
    }),
    requestId,
  });
  return { instagramCommentReplyId: readAnswerId(answer.id) };
}

/** A person's profile and whether they follow the account (contacts CQ3); absent fields are `null`. */
export interface InstagramUserProfile {
  name: string | null;
  username: string | null;
  profilePictureUrl: string | null;
  followerCount: number | null;
  /** `is_user_follow_business` — the follow check; `null` when Instagram did not say. */
  isUserFollowingBusiness: boolean | null;
}

/**
 * Reads a person's profile and follow status in one call (`GET /{instagram_scoped_user_id}`) — the
 * contact profile read (CQ3) and the follow check (`is_user_follow_business`).
 *
 * @remarks
 * - **Algorithm:** `GET /v24.0/{igsid}?fields=name,username,profile_pic,follower_count,
 *   is_user_follow_business` with the token in the `Authorization` header.
 * - **Failure modes:** `InstagramApiError` (`refused` when Instagram will not show this person).
 * - **Side effects:** one Instagram call.
 * - **Notes:** Instagram shows the profile only of someone who messaged or commented; callers fail
 *   open (a contact is saved without it).
 */
export async function readInstagramUserProfile({
  encryptedAccessToken,
  instagramScopedUserId,
  requestId,
}: {
  encryptedAccessToken: string;
  instagramScopedUserId: string;
} & InstagramRequestTracing): Promise<InstagramUserProfile> {
  const answer = await callInstagram<Record<string, unknown>>({
    url: buildInstagramGraphUrl({
      path: encodeURIComponent(instagramScopedUserId),
      query: { fields: INSTAGRAM_USER_PROFILE_FIELDS },
    }),
    init: buildInstagramGraphInit({ encryptedAccessToken }),
    requestId,
  });
  return {
    name: readAnswerText(answer.name),
    username: readAnswerText(answer.username),
    profilePictureUrl: readAnswerText(answer.profile_pic),
    followerCount: readAnswerCount(answer.follower_count),
    isUserFollowingBusiness:
      typeof answer.is_user_follow_business === 'boolean' ? answer.is_user_follow_business : null,
  };
}
