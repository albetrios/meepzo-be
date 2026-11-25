import { createHmac } from 'node:crypto';
import {
  INSTAGRAM_ACCESS_TOKEN_ERROR_CODE,
  MetaGraphApiError,
  buildMetaGraphMalformedAnswerError,
  readMetaGraphErrorResponse,
  toMetaGraphApiError,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import {
  parseMetaGraphUsage,
  type MetaGraphUsageReading,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-usage.util.js';
import {
  buildOutboundFetchOptions,
  outboundFetchJsonWithHeaders,
} from '@/infrastructure/outbound/index.js';
import { getEnv } from '@/shared/config/env.config.js';
import { ServiceUnavailableError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { decryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';

/**
 * The pinned Graph API version (routes-final § 1 MC2) — a code constant like Stripe's API version,
 * never an env var (it does not vary by environment, P4). Bump deliberately and verify against
 * Meta's changelog.
 */
export const META_GRAPH_VERSION = 'v27.0';
/** The host of every Graph call: Unified Login's code exchange and every call with a stored token. */
export const META_GRAPH_BASE_URL = 'https://graph.facebook.com';
/**
 * The six webhook fields every connected account is subscribed to (feat-instagram-dm-sending WC-30,
 * plan §25.7): Meta lets them differ per app, never per account.
 */
export const INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS = [
  'comments',
  'live_comments',
  'messages',
  'messaging_postbacks',
  'messaging_referral',
  'message_reactions',
] as const;

/** An Instagram professional account's profile fields (the pick's read, the profile refresh). */
const INSTAGRAM_ACCOUNT_PROFILE_FIELDS =
  'id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website';
/** Post and reel fields (schema-routes §6.2, IA16). */
const INSTAGRAM_MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count,children{id,media_type,media_url}';
/** Story fields (schema-routes §6.3, IA16). */
const INSTAGRAM_STORY_FIELDS = 'id,media_type,media_url,thumbnail_url,permalink,timestamp';
/** A person's profile and follow status in one read (contacts CQ3, the follow check). */
const INSTAGRAM_USER_PROFILE_FIELDS =
  'name,username,profile_pic,follower_count,is_user_follow_business';

/**
 * Receives Meta's usage read from one answer's headers (MC19, S13) — the channel connection's usage
 * service builds one per connection (`buildUsageRecorder`); the client calls it after the answer,
 * outside any transaction, and never fails a call on it.
 */
export type MetaGraphUsageRecorder = (reading: MetaGraphUsageReading) => Promise<void>;

/** Per-call options every Graph call takes: the request id and where Meta's usage goes. */
interface MetaGraphCallTracing {
  /** Sent as `X-Request-Id` for tracing. */
  requestId?: string | undefined;
  /** Where the usage headers of this call's answer go (MC19); omitted, they are not kept. */
  recordUsage?: MetaGraphUsageRecorder | undefined;
}

/** The four Meta app settings of MC3. */
export interface MetaAppSettings {
  appId: string;
  appSecret: string;
  configId: string;
  redirectUri: string;
}

/**
 * Whether the four Meta app settings are set (`META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID`,
 * `META_REDIRECT_URI`) — unset, the Instagram routes answer 503 `instagram_not_configured` (MC3),
 * and the Meta workers (the Instagram webhook's processing, the account check) stay off (WHC3).
 */
export function isMetaConfigured(): boolean {
  const environment = getEnv();
  return Boolean(
    environment.META_APP_ID &&
      environment.META_APP_SECRET &&
      environment.META_CONFIG_ID &&
      environment.META_REDIRECT_URI,
  );
}

/**
 * Throws 503 `instagram_not_configured` when any of the four Meta app settings is unset — for a
 * route that calls Meta with a stored token only (the post and story pickers, IA16), so it fails
 * closed as the exchanges do.
 */
export function assertInstagramConfigured(): void {
  readMetaAppSettings();
}

/**
 * The Meta app secret (`META_APP_SECRET`) alone, or 503 `instagram_not_configured` when it is unset
 * — for Meta's signed callbacks (deauthorize and data deletion), which check a signature and derive
 * a confirmation code, and for every call's `appsecret_proof`.
 */
export function readMetaAppSecret(): string {
  const appSecret = getEnv().META_APP_SECRET;
  if (!appSecret) throw instagramNotConfiguredError();
  return appSecret;
}

/** The 503 `instagram_not_configured` every unset Meta app setting answers. */
function instagramNotConfiguredError(): ServiceUnavailableError {
  return new ServiceUnavailableError('errors:instagramNotConfigured').withReason(
    'instagram_not_configured',
  );
}

/**
 * The four Meta app settings, or a 503 `instagram_not_configured` when any is unset (MC3) — read by
 * the login address and the code exchange (`meta-login.ts`).
 */
export function readMetaAppSettings(): MetaAppSettings {
  const environment = getEnv();
  const appId = environment.META_APP_ID;
  const appSecret = environment.META_APP_SECRET;
  const configId = environment.META_CONFIG_ID;
  const redirectUri = environment.META_REDIRECT_URI;
  if (!(appId && appSecret && configId && redirectUri)) throw instagramNotConfiguredError();
  return { appId, appSecret, configId, redirectUri };
}

/**
 * Hands the usage headers of one answer to the caller's recorder (MC19): parsed, and dropped when
 * the answer carries neither usage header. A failing recorder is logged and never fails the call —
 * the usage is a pace hint, the answer is what the caller needs.
 */
async function reportMetaGraphUsage({
  headers,
  recordUsage,
}: {
  headers: Headers | null;
  recordUsage: MetaGraphUsageRecorder | undefined;
}): Promise<void> {
  if (recordUsage === undefined || headers === null) return;
  const reading = parseMetaGraphUsage({ headers, readAt: new Date() });
  if (reading === null) return;
  try {
    await recordUsage(reading);
  } catch (error) {
    logger.warn(
      { event: 'meta_graph.usage.record_failed', error_name: (error as Error | null)?.name },
      'Meta usage could not be recorded',
    );
  }
}

/**
 * One Meta call through the outbound layer: the `meta-graph` timeout (10 s) and `metaGraphCircuit`,
 * the error answer read once ({@link readMetaGraphErrorResponse}), every failure a
 * `MetaGraphApiError`, and the usage headers of the answer — a success or an error — handed to
 * `recordUsage` (MC19).
 *
 * @remarks
 * - **Algorithm:** `outboundFetchJsonWithHeaders` expecting 200; an error answer is classified from
 *   its status, body and `Retry-After`; in either case the answer's headers go to
 *   {@link reportMetaGraphUsage} once the call is over.
 * - **Failure modes:** every failure is a `MetaGraphApiError` (`auth`, `throttled`, `refused`,
 *   `outage`).
 * - **Side effects:** one HTTP request; the recorder's write, outside any transaction.
 * - **Notes:** exported for `meta-login.ts` only — every other caller uses a named call below.
 */
export async function callMetaGraph<TAnswer>({
  url,
  init,
  requestId,
  recordUsage,
}: {
  url: string;
  init?: RequestInit;
} & MetaGraphCallTracing): Promise<TAnswer> {
  const answered: { headers: Headers | null } = { headers: null };
  try {
    const answer = await outboundFetchJsonWithHeaders<TAnswer>(
      buildOutboundFetchOptions({
        name: 'meta-graph',
        url,
        init,
        requestId,
        expectedStatus: 200,
        classifyResponseError: (response, body) => {
          answered.headers = response.headers;
          return readMetaGraphErrorResponse({
            httpStatus: response.status,
            body,
            retryAfterHeader: response.headers.get('retry-after'),
          });
        },
      }),
    );
    answered.headers = answer.headers;
    return answer.body;
  } catch (error) {
    throw toMetaGraphApiError(error);
  } finally {
    await reportMetaGraphUsage({ headers: answered.headers, recordUsage });
  }
}

/**
 * `<base>/<version>/<path>?<query>` — every path segment already encoded; `undefined` query values
 * are left out. Exported for `meta-login.ts`.
 */
export function buildMetaGraphUrl({
  path,
  query = {},
  baseUrl = META_GRAPH_BASE_URL,
  version = META_GRAPH_VERSION,
}: {
  path: string;
  query?: Record<string, string | undefined>;
  baseUrl?: string;
  version?: string;
}): string {
  const url = new URL(`/${version}/${path}`, baseUrl);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
}

/**
 * `appsecret_proof` (plan:L7183–L7194, SE.M.14): the HMAC-SHA256 of the access token keyed by the
 * app secret, hex — Meta refuses a stolen token used without the app's secret.
 */
export function buildMetaAppSecretProof({
  accessToken,
  appSecret,
}: {
  accessToken: string;
  appSecret: string;
}): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/**
 * The URL and request init of a Graph call with a customer's token (MC2): the token, decrypted only
 * here, travels only in `Authorization`; the URL carries `appsecret_proof` (redacted wherever a URL
 * is logged — its name holds `secret`).
 */
function buildMetaGraphTokenRequest({
  encryptedAccessToken,
  path,
  query = {},
  method = 'GET',
  jsonBody,
}: {
  encryptedAccessToken: string;
  path: string;
  query?: Record<string, string | undefined>;
  method?: 'GET' | 'POST' | 'DELETE';
  jsonBody?: unknown;
}): { url: string; init: RequestInit } {
  const appSecret = readMetaAppSecret();
  const accessToken = decryptFieldSecret(encryptedAccessToken);
  const url = buildMetaGraphUrl({
    path,
    query: { ...query, appsecret_proof: buildMetaAppSecretProof({ accessToken, appSecret }) },
  });
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (jsonBody === undefined) return { url, init: { method, headers } };
  headers['Content-Type'] = 'application/json';
  return { url, init: { method, headers, body: JSON.stringify(jsonBody) } };
}

/** One Graph call with a customer's token: {@link buildMetaGraphTokenRequest} + {@link callMetaGraph}. */
async function callMetaGraphWithToken<TAnswer>({
  encryptedAccessToken,
  path,
  query,
  method,
  jsonBody,
  requestId,
  recordUsage,
}: {
  encryptedAccessToken: string;
  path: string;
  query?: Record<string, string | undefined>;
  method?: 'GET' | 'POST' | 'DELETE';
  jsonBody?: unknown;
} & MetaGraphCallTracing): Promise<TAnswer> {
  const { url, init } = buildMetaGraphTokenRequest({
    encryptedAccessToken,
    path,
    ...(query !== undefined ? { query } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(jsonBody !== undefined ? { jsonBody } : {}),
  });
  return callMetaGraph<TAnswer>({ url, init, requestId, recordUsage });
}

/** A non-empty string field of an Instagram answer, else `null`. */
export function readAnswerText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A count field of an Instagram answer (a non-negative whole number), else `null`. */
export function readAnswerCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** An Instagram id: Graph sends a digit string; an exact JSON number is accepted too. */
export function readAnswerId(value: unknown): string | null {
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

/** A connected Instagram professional account as the Graph API describes it; an absent field is `null`. */
export interface InstagramAccountProfile {
  /** The Instagram user id (`instagram_user_id`, webhook `entry.id`, the Graph path id). */
  instagramUserId: string;
  username: string | null;
  name: string | null;
  profilePictureUrl: string | null;
  followersCount: number | null;
  followsCount: number | null;
  mediaCount: number | null;
  biography: string | null;
  website: string | null;
}

/**
 * Reads one Instagram professional account's profile with its connection's token
 * (`GET /{instagram_user_id}`, routes-final § 1 MC7 — the pick's profile read; MC10 — the profile
 * refresh, P17).
 *
 * @remarks
 * - **Algorithm:** one Graph read on `graph.facebook.com` with the token in `Authorization` and
 *   `appsecret_proof`, fields `id,username,name,profile_picture_url,followers_count,follows_count,
 *   media_count,biography,website`; the profile is read from the flat body or `data[0]` (D33).
 * - **Failure modes:** `MetaGraphApiError` (`auth` for a dead token); an answer without `id` →
 *   `outage`.
 * - **Side effects:** one Meta call; its usage goes to `recordUsage`.
 * - **Notes:** replaces the launch's Instagram Login `/me` read (RC-6, WC-35); the profile is the
 *   organization's business data, not a secret.
 */
export async function readInstagramAccountProfile({
  encryptedAccessToken,
  instagramUserId,
  requestId,
  recordUsage,
}: {
  encryptedAccessToken: string;
  instagramUserId: string;
} & MetaGraphCallTracing): Promise<InstagramAccountProfile> {
  const answer = readInstagramAnswerRecord(
    await callMetaGraphWithToken<unknown>({
      encryptedAccessToken,
      path: encodeURIComponent(instagramUserId),
      query: { fields: INSTAGRAM_ACCOUNT_PROFILE_FIELDS },
      requestId,
      recordUsage,
    }),
  );
  const answeredUserId = readAnswerId(answer.id);
  if (answeredUserId === null) {
    throw buildMetaGraphMalformedAnswerError({ operation: '/{instagram_user_id}', missing: 'id' });
  }
  return {
    instagramUserId: answeredUserId,
    username: readAnswerText(answer.username),
    name: readAnswerText(answer.name),
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
export interface ListInstagramItemsOptions extends MetaGraphCallTracing {
  encryptedAccessToken: string;
  /** The account's Instagram user id (the id the Graph paths take under Unified Login). */
  instagramUserId: string;
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
  edge: 'media' | 'stories' | 'live_media';
  fields: string;
}): Promise<InstagramGraphPage<TItem>> {
  const answer = await callMetaGraphWithToken<InstagramGraphListAnswer>({
    encryptedAccessToken: options.encryptedAccessToken,
    path: `${encodeURIComponent(options.instagramUserId)}/${edge}`,
    query: { fields, limit: String(options.limit), after: options.after },
    requestId: options.requestId,
    recordUsage: options.recordUsage,
  });
  if (!Array.isArray(answer.data)) {
    throw buildMetaGraphMalformedAnswerError({ operation: `/${edge}`, missing: 'data' });
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
 * Lists one page of the account's posts and reels, live (`/{instagram_user_id}/media`, IA16).
 *
 * @remarks
 * - **Algorithm:** `GET /v27.0/{id}/media?fields=…&limit=…&after=…` with the token in the
 *   `Authorization` header; items without an id are dropped.
 * - **Failure modes:** `MetaGraphApiError` — `auth` (the route's 404 `instagram_reconnect_required`),
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
 * Lists one page of the account's live stories (`/{instagram_user_id}/stories`, IA16).
 *
 * @remarks
 * - **Algorithm:** `GET /v27.0/{id}/stories?fields=id,media_type,media_url,thumbnail_url,permalink,
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
 * Lists the account's Lives on air now (`/{instagram_user_id}/live_media`, feat-instagram-dm-sending
 * WC-16 — ROUTE row R48's Live check).
 *
 * @remarks
 * - **Algorithm:** `GET /v27.0/{id}/live_media?fields=id&limit=…` with the token in the
 *   `Authorization` header; items without an id are dropped. A Live no longer listed has ended.
 * - **Failure modes:** as {@link listInstagramMedia}.
 * - **Side effects:** one Instagram call; nothing is stored.
 * - **Notes:** the Live comment way to start is go-live-gated until Meta's §43 test (P36).
 */
export async function listInstagramLiveMedia(
  options: ListInstagramItemsOptions,
): Promise<InstagramGraphPage<{ id: string }>> {
  return listInstagramEdge<{ id: string }>({ options, edge: 'live_media', fields: 'id' });
}

/**
 * Reads one post by its Instagram media id — the post a comment arrived on, stored the first time
 * (WH13, IA17).
 *
 * @remarks
 * - **Algorithm:** `GET /v27.0/{media_id}?fields=<the media fields>` with the token in the
 *   `Authorization` header.
 * - **Failure modes:** `MetaGraphApiError`; an answer without `id` → `outage`.
 * - **Side effects:** one Instagram call.
 * - **Notes:** the same fields as {@link listInstagramMedia}.
 */
export async function readInstagramMediaItem({
  encryptedAccessToken,
  instagramMediaId,
  requestId,
  recordUsage,
}: {
  encryptedAccessToken: string;
  instagramMediaId: string;
} & MetaGraphCallTracing): Promise<InstagramMediaGraphItem> {
  const answer = await callMetaGraphWithToken<InstagramMediaGraphItem>({
    encryptedAccessToken,
    path: encodeURIComponent(instagramMediaId),
    query: { fields: INSTAGRAM_MEDIA_FIELDS },
    requestId,
    recordUsage,
  });
  if (readAnswerId(answer.id) === null) {
    throw buildMetaGraphMalformedAnswerError({ operation: 'the media read', missing: 'id' });
  }
  return answer;
}

/** Options of the webhook subscription calls. */
export interface InstagramWebhookSubscriptionOptions extends MetaGraphCallTracing {
  encryptedAccessToken: string;
  /** The account's Instagram user id (the id the Graph paths take under Unified Login). */
  instagramUserId: string;
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
    throw buildMetaGraphMalformedAnswerError({ operation, missing: 'success: true' });
  }
}

/**
 * Subscribes the account to the six webhook fields of {@link INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS}
 * (`POST /{instagram_user_id}/subscribed_apps`, WC-30, IA8).
 *
 * @remarks
 * - **Algorithm:** `POST /v27.0/{id}/subscribed_apps?subscribed_fields=comments,live_comments,
 *   messages,messaging_postbacks,messaging_referral,message_reactions` with the token in the
 *   `Authorization` header; Instagram answers `{ success: true }`.
 * - **Failure modes:** `MetaGraphApiError`; any answer but `success: true` → `outage`.
 * - **Side effects:** one Instagram call — Meta starts sending this account's events.
 * - **Notes:** safe to repeat. The connect logs a failure and never fails on it.
 */
export async function subscribeInstagramWebhookFields({
  encryptedAccessToken,
  instagramUserId,
  requestId,
  recordUsage,
}: InstagramWebhookSubscriptionOptions): Promise<void> {
  const answer = await callMetaGraphWithToken<{ success?: unknown }>({
    encryptedAccessToken,
    path: `${encodeURIComponent(instagramUserId)}/subscribed_apps`,
    query: { subscribed_fields: INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS.join(',') },
    method: 'POST',
    requestId,
    recordUsage,
  });
  assertInstagramSuccessAnswer({ answer, operation: 'the webhook subscription' });
}

/**
 * Unsubscribes the account from every webhook field (`DELETE /{instagram_user_id}/subscribed_apps`)
 * — the disconnect (IA14).
 *
 * @remarks
 * - **Algorithm:** `DELETE /v27.0/{id}/subscribed_apps` with the token in the `Authorization`
 *   header; Instagram answers `{ success: true }`.
 * - **Failure modes:** `MetaGraphApiError`; any answer but `success: true` → `outage`.
 * - **Side effects:** one Instagram call — Meta stops sending this account's events.
 * - **Notes:** safe to repeat.
 */
export async function unsubscribeInstagramWebhookFields({
  encryptedAccessToken,
  instagramUserId,
  requestId,
  recordUsage,
}: InstagramWebhookSubscriptionOptions): Promise<void> {
  const answer = await callMetaGraphWithToken<{ success?: unknown }>({
    encryptedAccessToken,
    path: `${encodeURIComponent(instagramUserId)}/subscribed_apps`,
    method: 'DELETE',
    requestId,
    recordUsage,
  });
  assertInstagramSuccessAnswer({ answer, operation: 'the webhook unsubscription' });
}

/**
 * The webhook fields the account is subscribed to for our app (`GET /{instagram_user_id}/subscribed_apps`)
 * — the 10-minute subscription check (WC-25).
 *
 * @remarks
 * - **Algorithm:** `GET /v27.0/{id}/subscribed_apps` with the token in the `Authorization` header;
 *   Meta answers `{ data: [{ id, name, subscribed_fields: [...] }] }`, one entry per app. The entry
 *   whose `id` is `appId` gives the fields; no such entry → an empty list (nothing subscribed).
 * - **Failure modes:** `MetaGraphApiError`; no `data` list → `outage`.
 * - **Side effects:** one Instagram call; nothing is stored.
 */
export async function readInstagramWebhookSubscribedFields({
  encryptedAccessToken,
  instagramUserId,
  appId,
  requestId,
  recordUsage,
}: InstagramWebhookSubscriptionOptions & { appId: string }): Promise<string[]> {
  const answer = await callMetaGraphWithToken<{ data?: unknown }>({
    encryptedAccessToken,
    path: `${encodeURIComponent(instagramUserId)}/subscribed_apps`,
    requestId,
    recordUsage,
  });
  if (!Array.isArray(answer.data)) {
    throw buildMetaGraphMalformedAnswerError({
      operation: 'the webhook subscription read',
      missing: 'data',
    });
  }
  const ours = answer.data
    .map((entry) => readAnswerObject(entry))
    .find((entry) => readAnswerId(entry.id) === appId);
  if (ours === undefined || !Array.isArray(ours.subscribed_fields)) return [];
  return ours.subscribed_fields.filter((field): field is string => typeof field === 'string');
}

/** One starter question (an Instagram ice breaker): its text and the payload a tap sends back. */
export interface InstagramIceBreaker {
  question: string;
  payload: string;
}

/** Fails unless Meta answered `{ result: 'success' }` (the Messenger profile calls). */
function assertMessengerProfileSuccess({
  answer,
  operation,
}: {
  answer: { result?: unknown };
  operation: string;
}): void {
  if (answer.result !== 'success') {
    throw buildMetaGraphMalformedAnswerError({ operation, missing: "result: 'success'" });
  }
}

/**
 * Writes the account's whole starter-question list (Instagram's ice breakers,
 * `POST /{instagram_user_id}/messenger_profile`) — the starter-question sync (WC-31) and the set-up
 * (WC-30).
 *
 * @remarks
 * - **Algorithm:** `POST /v27.0/{id}/messenger_profile` with the JSON body `{ platform: 'instagram',
 *   ice_breakers: [{ locale: 'default', call_to_actions: [{ question, payload }] }] }`; Meta answers
 *   `{ result: 'success' }`. The list replaces the one Meta holds.
 * - **Failure modes:** `MetaGraphApiError`; any other answer → `outage`.
 * - **Side effects:** one Instagram call — the chat's starter questions change at once.
 * - **Notes:** safe to repeat; an empty list is {@link deleteInstagramIceBreakers}'s.
 */
export async function setInstagramIceBreakers({
  encryptedAccessToken,
  instagramUserId,
  iceBreakers,
  requestId,
  recordUsage,
}: InstagramWebhookSubscriptionOptions & {
  iceBreakers: readonly InstagramIceBreaker[];
}): Promise<void> {
  const answer = await callMetaGraphWithToken<{ result?: unknown }>({
    encryptedAccessToken,
    path: `${encodeURIComponent(instagramUserId)}/messenger_profile`,
    method: 'POST',
    jsonBody: {
      platform: 'instagram',
      ice_breakers: [
        {
          locale: 'default',
          call_to_actions: iceBreakers.map(({ question, payload }) => ({ question, payload })),
        },
      ],
    },
    requestId,
    recordUsage,
  });
  assertMessengerProfileSuccess({ answer, operation: 'the starter-question write' });
}

/**
 * Removes the account's starter questions (`DELETE /{instagram_user_id}/messenger_profile`,
 * `fields: ['ice_breakers']`) — the sync of an account with none live (WC-31) and route 8's
 * disconnect (CA8).
 *
 * @remarks
 * - **Algorithm:** `DELETE /v27.0/{id}/messenger_profile?platform=instagram` with the JSON body
 *   `{ fields: ['ice_breakers'] }`; Meta answers `{ result: 'success' }`.
 * - **Failure modes:** `MetaGraphApiError`; any other answer → `outage`.
 * - **Side effects:** one Instagram call.
 * - **Notes:** safe to repeat.
 */
export async function deleteInstagramIceBreakers({
  encryptedAccessToken,
  instagramUserId,
  requestId,
  recordUsage,
}: InstagramWebhookSubscriptionOptions): Promise<void> {
  const answer = await callMetaGraphWithToken<{ result?: unknown }>({
    encryptedAccessToken,
    path: `${encodeURIComponent(instagramUserId)}/messenger_profile`,
    query: { platform: 'instagram' },
    method: 'DELETE',
    jsonBody: { fields: ['ice_breakers'] },
    requestId,
    recordUsage,
  });
  assertMessengerProfileSuccess({ answer, operation: 'the starter-question removal' });
}

/** Graph's "(#200) … disabled access to Instagram Direct" — message access is off (plan §25.14). */
const INSTAGRAM_MESSAGE_ACCESS_OFF_ERROR_CODE = 200;
/** Graph's permission code whose subcode below means message access is off. */
const INSTAGRAM_MESSAGE_ACCESS_OFF_PERMISSION_CODE = 10;
/** Code 10's subcode for message access off (plan §25.14 `CODES_ACCESS_OFF`, test needed). */
const INSTAGRAM_MESSAGE_ACCESS_OFF_PERMISSION_SUBCODE = 2534077;

/** What the read-only message-access probe found (plan §25.14). */
export type InstagramMessageAccess = 'on' | 'off' | 'unknown';

/**
 * Probes once, read-only, whether "Allow access to messages" is on for the account
 * (`GET /{instagram_user_id}/conversations?platform=instagram&limit=1`) — the set-up's last step
 * (WC-30, plan §25.14).
 *
 * @remarks
 * - **Algorithm:** the read; an answer → `on`. Meta's code 200 (any subcode) or code 10 with subcode
 *   2534077 → `off`. Any other refusal or outage → `unknown` (the probe never fails the set-up).
 * - **Failure modes:** a refused token (code 190) is rethrown — the caller breaks the account.
 * - **Side effects:** one Instagram call; nothing is stored or sent.
 * - **Notes:** which call shows it under Unified Login is a Meta test still to run (plan §43); the
 *   codes live here, beside the client's other code tables.
 */
export async function probeInstagramMessageAccess({
  encryptedAccessToken,
  instagramUserId,
  requestId,
  recordUsage,
}: InstagramWebhookSubscriptionOptions): Promise<InstagramMessageAccess> {
  try {
    await callMetaGraphWithToken<unknown>({
      encryptedAccessToken,
      path: `${encodeURIComponent(instagramUserId)}/conversations`,
      query: { platform: 'instagram', limit: '1', fields: 'id' },
      requestId,
      recordUsage,
    });
    return 'on';
  } catch (error) {
    if (!(error instanceof MetaGraphApiError)) return 'unknown';
    const code = error.instagramErrorCode;
    if (code === INSTAGRAM_ACCESS_TOKEN_ERROR_CODE) throw error;
    if (
      code === INSTAGRAM_MESSAGE_ACCESS_OFF_ERROR_CODE ||
      (code === INSTAGRAM_MESSAGE_ACCESS_OFF_PERMISSION_CODE &&
        error.instagramErrorSubcode === INSTAGRAM_MESSAGE_ACCESS_OFF_PERMISSION_SUBCODE)
    ) {
      return 'off';
    }
    return 'unknown';
  }
}

/** Who a message goes to: a person (`id`, their Instagram-scoped id) or a comment (a private reply). */
export type InstagramMessageRecipient = { id: string } | { comment_id: string };

/** A quick reply under a message: a text choice, or Instagram's own email / phone button. */
export interface InstagramQuickReply {
  content_type: 'text' | 'user_email' | 'user_phone_number';
  title?: string;
  payload?: string;
}

/**
 * The `message` object of a send, in Instagram's wire shape: text, quick replies, a template, a file
 * by its uploaded `attachment_id` (`image`, `audio`, `file`) or one of the account's posts
 * (`MEDIA_SHARE`).
 */
export interface InstagramOutgoingMessage {
  text?: string;
  quick_replies?: readonly InstagramQuickReply[];
  attachment?: {
    type: 'template' | 'image' | 'audio' | 'file' | 'MEDIA_SHARE';
    payload: Readonly<Record<string, unknown>>;
  };
}

/** What Instagram answers for a sent message. */
export interface InstagramSentMessage {
  messageId: string | null;
  recipientId: string | null;
}

/**
 * Sends a direct message, or a private reply to a comment (`recipient.comment_id`), from the
 * account (`POST /{instagram_user_id}/messages`) — sub-domains 3–4.
 *
 * @remarks
 * - **Algorithm:** `POST /v27.0/{id}/messages` with JSON `{ recipient, message }` and the token in
 *   the `Authorization` header; returns Instagram's `message_id` and `recipient_id`.
 * - **Failure modes:** `MetaGraphApiError` — `auth` (a dead token: the guarded status change),
 *   `refused` (`isQuickReplyRefused` for code 100 / 2534015: send the question as plain text; code
 *   10 outside the 24-hour messaging window: only this send fails, D32), `throttled`, `outage`.
 * - **Side effects:** one Instagram call — the person receives the message.
 * - **Notes:** not idempotent — the run engine's claim keeps a message from going twice (D16); the
 *   200–1000 ms pause before a send (K10) is the caller's.
 */
export async function sendInstagramMessage({
  encryptedAccessToken,
  instagramUserId,
  recipient,
  message,
  requestId,
  recordUsage,
}: {
  encryptedAccessToken: string;
  instagramUserId: string;
  recipient: InstagramMessageRecipient;
  message: InstagramOutgoingMessage;
} & MetaGraphCallTracing): Promise<InstagramSentMessage> {
  const answer = await callMetaGraphWithToken<{ message_id?: unknown; recipient_id?: unknown }>({
    encryptedAccessToken,
    path: `${encodeURIComponent(instagramUserId)}/messages`,
    method: 'POST',
    jsonBody: { recipient, message },
    requestId,
    recordUsage,
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
 * - **Algorithm:** `POST /v27.0/{comment_id}/replies` with JSON `{ message: text }` and the token
 *   in the `Authorization` header; returns the reply's id.
 * - **Failure modes:** `MetaGraphApiError`, as {@link sendInstagramMessage}.
 * - **Side effects:** one Instagram call — a public comment appears.
 * - **Notes:** not idempotent; the caller's claim keeps it single.
 */
export async function replyToInstagramComment({
  encryptedAccessToken,
  instagramCommentId,
  text,
  requestId,
  recordUsage,
}: {
  encryptedAccessToken: string;
  instagramCommentId: string;
  text: string;
} & MetaGraphCallTracing): Promise<InstagramCommentReply> {
  const answer = await callMetaGraphWithToken<{ id?: unknown }>({
    encryptedAccessToken,
    path: `${encodeURIComponent(instagramCommentId)}/replies`,
    method: 'POST',
    jsonBody: { message: text },
    requestId,
    recordUsage,
  });
  return { instagramCommentReplyId: readAnswerId(answer.id) };
}

/**
 * Hides a comment under the account's post (`POST /{comment_id}?hide=true`) — sub-domain 6's hide
 * (plan §29.4 rule 5, `instagram_manage_comments`).
 *
 * @remarks
 * - **Algorithm:** `POST /v27.0/{comment_id}?hide=true` with the token in the `Authorization`
 *   header; Instagram answers `{ success: true }`.
 * - **Failure modes:** `MetaGraphApiError` as {@link sendInstagramMessage}; any answer but
 *   `success: true` → `outage` (malformed answer).
 * - **Side effects:** one Instagram call — the comment is hidden from everyone but its writer.
 * - **Notes:** safe to repeat; the reply lane's claim keeps it single.
 */
export async function hideInstagramComment({
  encryptedAccessToken,
  instagramCommentId,
  requestId,
  recordUsage,
}: {
  encryptedAccessToken: string;
  instagramCommentId: string;
} & MetaGraphCallTracing): Promise<void> {
  const answer = await callMetaGraphWithToken<{ success?: unknown }>({
    encryptedAccessToken,
    path: encodeURIComponent(instagramCommentId),
    query: { hide: 'true' },
    method: 'POST',
    requestId,
    recordUsage,
  });
  assertInstagramSuccessAnswer({ answer, operation: 'the comment hide' });
}

/** What a comment read answers: whether it is still there to answer, and whether it is hidden. */
export interface InstagramCommentState {
  isHidden: boolean;
}

/**
 * Reads one comment (`GET /{comment_id}?fields=id,hidden`) — the send's check before a
 * `deleted_comment` (plan §33.7 rule 1): a comment Meta no longer shows answers its error.
 *
 * @remarks
 * - **Algorithm:** `GET /v27.0/{comment_id}?fields=id,hidden` with the token in the
 *   `Authorization` header.
 * - **Failure modes:** `MetaGraphApiError` (code 100 when the comment is gone); an answer without
 *   `id` → `outage` (malformed answer).
 * - **Side effects:** one Instagram call, read only.
 * - **Notes:** the caller reads a gone comment as `comment_gone` and one still there as bad text.
 */
export async function readInstagramComment({
  encryptedAccessToken,
  instagramCommentId,
  requestId,
  recordUsage,
}: {
  encryptedAccessToken: string;
  instagramCommentId: string;
} & MetaGraphCallTracing): Promise<InstagramCommentState> {
  const answer = await callMetaGraphWithToken<{ id?: unknown; hidden?: unknown }>({
    encryptedAccessToken,
    path: encodeURIComponent(instagramCommentId),
    query: { fields: 'id,hidden' },
    requestId,
    recordUsage,
  });
  if (readAnswerId(answer.id) === null) {
    throw buildMetaGraphMalformedAnswerError({ operation: 'the comment read', missing: 'id' });
  }
  return { isHidden: answer.hidden === true };
}

/** The kinds of file Instagram takes as a message attachment (image, voice note, PDF). */
export type InstagramAttachmentType = 'image' | 'audio' | 'file';

/** What Instagram answers for an uploaded attachment: its reusable id for this account. */
export interface InstagramUploadedAttachment {
  attachmentId: string;
}

/**
 * Uploads a message file to Instagram once for the account and answers its reusable id
 * (`POST /{instagram_user_id}/message_attachments`) — sub-domain 6.C (SN20, SNC15).
 *
 * @remarks
 * - **Algorithm:** `POST /v27.0/{id}/message_attachments` with JSON `{ platform: 'instagram',
 *   message: { attachment: { type, payload: { url, is_reusable: true } } } }` — Meta fetches the file
 *   from the short-lived presigned `url` — and the token in the `Authorization` header with
 *   `appsecret_proof`; returns Meta's `attachment_id`.
 * - **Failure modes:** `MetaGraphApiError` as {@link sendInstagramMessage}; an answer without
 *   `attachment_id` → `outage` (malformed answer).
 * - **Side effects:** one Instagram call; its usage goes to `recordUsage`.
 * - **Notes:** a later send names the file by `attachment_id` instead of a URL; the id lives in
 *   `app.instagram_attachments` (one per account and upload).
 */
export async function uploadInstagramMessageAttachment({
  encryptedAccessToken,
  instagramUserId,
  type,
  url,
  requestId,
  recordUsage,
}: {
  encryptedAccessToken: string;
  instagramUserId: string;
  type: InstagramAttachmentType;
  /** Where Meta fetches the file (a short-lived presigned GET). */
  url: string;
} & MetaGraphCallTracing): Promise<InstagramUploadedAttachment> {
  const answer = await callMetaGraphWithToken<{ attachment_id?: unknown }>({
    encryptedAccessToken,
    path: `${encodeURIComponent(instagramUserId)}/message_attachments`,
    method: 'POST',
    jsonBody: {
      platform: 'instagram',
      message: { attachment: { type, payload: { url, is_reusable: true } } },
    },
    requestId,
    recordUsage,
  });
  const attachmentId = readAnswerId(answer.attachment_id);
  if (attachmentId === null) {
    throw buildMetaGraphMalformedAnswerError({
      operation: 'the attachment upload',
      missing: 'attachment_id',
    });
  }
  return { attachmentId };
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
 * - **Algorithm:** `GET /v27.0/{igsid}?fields=name,username,profile_pic,follower_count,
 *   is_user_follow_business` with the token in the `Authorization` header.
 * - **Failure modes:** `MetaGraphApiError` (`refused` when Instagram will not show this person).
 * - **Side effects:** one Instagram call.
 * - **Notes:** Instagram shows the profile only of someone who messaged or commented; callers fail
 *   open (a contact is saved without it).
 */
export async function readInstagramUserProfile({
  encryptedAccessToken,
  instagramScopedUserId,
  requestId,
  recordUsage,
}: {
  encryptedAccessToken: string;
  instagramScopedUserId: string;
} & MetaGraphCallTracing): Promise<InstagramUserProfile> {
  const answer = await callMetaGraphWithToken<Record<string, unknown>>({
    encryptedAccessToken,
    path: encodeURIComponent(instagramScopedUserId),
    query: { fields: INSTAGRAM_USER_PROFILE_FIELDS },
    requestId,
    recordUsage,
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

/** Options of every Unified Login read made with a connection's token (MC2). */
export interface MetaConnectionReadOptions extends MetaGraphCallTracing {
  /** The connection's system-user token, encrypted with `encryptFieldSecret`. */
  encryptedAccessToken: string;
}

/**
 * Reads the business portfolio a Unified Login token belongs to (`GET /me?fields=client_business_id`,
 * MC5 step 3).
 *
 * @remarks
 * - **Algorithm:** one Graph read with the token in `Authorization` and `appsecret_proof`; the id is
 *   read from the flat body or `data[0]` (D33).
 * - **Failure modes:** `MetaGraphApiError`; an answer without `client_business_id` → `outage`.
 * - **Side effects:** one Meta call; its usage goes to `recordUsage`.
 * - **Notes:** the business id is digits, kept as an exact string.
 */
export async function readMetaClientBusinessId({
  encryptedAccessToken,
  requestId,
  recordUsage,
}: MetaConnectionReadOptions): Promise<string> {
  const answer = readInstagramAnswerRecord(
    await callMetaGraphWithToken<unknown>({
      encryptedAccessToken,
      path: 'me',
      query: { fields: 'client_business_id' },
      requestId,
      recordUsage,
    }),
  );
  const clientBusinessId = readAnswerId(answer.client_business_id);
  if (clientBusinessId === null) {
    throw buildMetaGraphMalformedAnswerError({
      operation: '/me (client_business_id)',
      missing: 'client_business_id',
    });
  }
  return clientBusinessId;
}

/** An Instagram account a Unified Login token is assigned (MC5, MC7). */
export interface MetaAssignedInstagramAccount {
  /** The Instagram user id (`provider_account_id` of the channel account). */
  instagramUserId: string;
  /** `@username` without the `@`, or `null` when Meta did not say. */
  username: string | null;
}

/** The largest page Meta answers for a connection's lists (its first 100 — MC13). */
const META_CONNECTION_LIST_LIMIT = '100';

/** The `data` list of a Graph list answer as plain objects, or `outage` when it is not a list. */
function readGraphListData({
  answer,
  operation,
}: {
  answer: InstagramGraphListAnswer;
  operation: string;
}): Record<string, unknown>[] {
  if (!Array.isArray(answer.data)) {
    throw buildMetaGraphMalformedAnswerError({ operation, missing: 'data' });
  }
  return answer.data.map(readAnswerObject);
}

/**
 * Lists the Instagram accounts the token's business shares with the app
 * (`GET /me/assigned_instagram_accounts?fields=id,username`, MC5 step 3, MC7, MC10).
 *
 * @remarks
 * - **Algorithm:** one Graph read (Meta's first 100) with the token in `Authorization` and
 *   `appsecret_proof`; items without an id are dropped.
 * - **Failure modes:** `MetaGraphApiError` (`auth` for a dead token — MC11); no `data` list → `outage`.
 * - **Side effects:** one Meta call; its usage goes to `recordUsage`.
 * - **Notes:** re-read at every pick (P55); never cached.
 */
export async function listMetaAssignedInstagramAccounts({
  encryptedAccessToken,
  requestId,
  recordUsage,
}: MetaConnectionReadOptions): Promise<MetaAssignedInstagramAccount[]> {
  const answer = await callMetaGraphWithToken<InstagramGraphListAnswer>({
    encryptedAccessToken,
    path: 'me/assigned_instagram_accounts',
    query: { fields: 'id,username', limit: META_CONNECTION_LIST_LIMIT },
    requestId,
    recordUsage,
  });
  return readGraphListData({ answer, operation: '/me/assigned_instagram_accounts' }).flatMap(
    (item) => {
      const instagramUserId = readAnswerId(item.id);
      return instagramUserId === null
        ? []
        : [{ instagramUserId, username: readAnswerText(item.username) }];
    },
  );
}

/**
 * Reads the permissions the token holds (`GET /me/permissions` — only `status: granted` counts,
 * MC5 step 4, plan:L4577).
 *
 * @remarks
 * - **Algorithm:** one Graph read with the token in `Authorization` and `appsecret_proof`; returns
 *   the granted permission names, in Meta's order.
 * - **Failure modes:** `MetaGraphApiError`; no `data` list → `outage`.
 * - **Side effects:** one Meta call; its usage goes to `recordUsage`.
 * - **Notes:** which call shows a system-user token's permissions is a Meta test (§43); this is
 *   Meta's documented read for a user token.
 */
export async function readMetaGrantedPermissions({
  encryptedAccessToken,
  requestId,
  recordUsage,
}: MetaConnectionReadOptions): Promise<string[]> {
  const answer = await callMetaGraphWithToken<InstagramGraphListAnswer>({
    encryptedAccessToken,
    path: 'me/permissions',
    requestId,
    recordUsage,
  });
  return readGraphListData({ answer, operation: '/me/permissions' }).flatMap((item) => {
    const permission = readAnswerText(item.permission);
    return permission !== null && item.status === 'granted' ? [permission] : [];
  });
}

/** An ad account the connection's token can read (route 41, MC13). */
export interface MetaAdAccount {
  /** Meta's ad account id, without the `act_` prefix. */
  adAccountId: string;
  name: string | null;
  /** Meta's `account_status` number (1 active, 2 disabled, …), or `null`. */
  accountStatus: number | null;
}

/**
 * Lists the ad accounts of the connection (`GET /me/adaccounts?fields=account_id,name,account_status`,
 * MC13 — Meta's first 100, no paging).
 *
 * @remarks
 * - **Algorithm:** one Graph read with the token in `Authorization` and `appsecret_proof`; items
 *   without `account_id` are dropped.
 * - **Failure modes:** `MetaGraphApiError`; no `data` list → `outage`.
 * - **Side effects:** one Meta call; its usage goes to `recordUsage`.
 * - **Notes:** the caller checks `ads_read` on the connection first — without it the route answers
 *   an empty list and `meta.ad_access = 'missing'` and never calls this.
 */
export async function listMetaAdAccounts({
  encryptedAccessToken,
  requestId,
  recordUsage,
}: MetaConnectionReadOptions): Promise<MetaAdAccount[]> {
  const answer = await callMetaGraphWithToken<InstagramGraphListAnswer>({
    encryptedAccessToken,
    path: 'me/adaccounts',
    query: { fields: 'account_id,name,account_status', limit: META_CONNECTION_LIST_LIMIT },
    requestId,
    recordUsage,
  });
  return readGraphListData({ answer, operation: '/me/adaccounts' }).flatMap((item) => {
    const adAccountId = readAnswerId(item.account_id);
    return adAccountId === null
      ? []
      : [
          {
            adAccountId,
            name: readAnswerText(item.name),
            accountStatus: readAnswerCount(item.account_status),
          },
        ];
  });
}

/** An ad of one ad account with its Instagram post (route 15, MC13). */
export interface MetaAd {
  adId: string;
  name: string | null;
  /** Meta's `effective_status` (`ACTIVE`, `PAUSED`, …). */
  status: string | null;
  /** The Instagram post the ad runs (`creative.effective_instagram_media_id`), or `null`. */
  instagramMediaId: string | null;
  /**
   * The Instagram account the ad runs as (`creative.instagram_user_id`), or `null` — route 15
   * matches it to a channel account by its Instagram id.
   */
  instagramUserId: string | null;
  thumbnailUrl: string | null;
  /** Meta's `created_time`, as sent. */
  createdAt: string | null;
}

/** Ad fields of route 15 (MC13). */
const META_AD_FIELDS =
  'id,name,effective_status,created_time,creative{effective_instagram_media_id,instagram_user_id,thumbnail_url}';

/**
 * Lists one page of an ad account's ads with their Instagram post
 * (`GET /act_{ad_account_id}/ads`, route 15, MC13 — one ad account at a time, P57).
 *
 * @remarks
 * - **Algorithm:** one Graph read with the token in `Authorization` and `appsecret_proof`,
 *   `limit` (1–50) and Meta's `after` cursor passed through; items without an id are dropped.
 * - **Failure modes:** `MetaGraphApiError` (`refused` for an ad account the token cannot read);
 *   no `data` list → `outage`.
 * - **Side effects:** one Meta call; its usage goes to `recordUsage`.
 * - **Notes:** `nextCursor` is `paging.cursors.after`, only when Meta has `paging.next`.
 */
export async function listMetaAdAccountAds({
  encryptedAccessToken,
  adAccountId,
  limit,
  after,
  requestId,
  recordUsage,
}: MetaConnectionReadOptions & {
  adAccountId: string;
  limit: number;
  after?: string | undefined;
}): Promise<InstagramGraphPage<MetaAd>> {
  const answer = await callMetaGraphWithToken<InstagramGraphListAnswer>({
    encryptedAccessToken,
    path: `act_${encodeURIComponent(adAccountId)}/ads`,
    query: { fields: META_AD_FIELDS, limit: String(limit), after },
    requestId,
    recordUsage,
  });
  const items = readGraphListData({ answer, operation: '/act_{id}/ads' }).flatMap((item) => {
    const adId = readAnswerId(item.id);
    if (adId === null) return [];
    const creative = readAnswerObject(item.creative);
    return [
      {
        adId,
        name: readAnswerText(item.name),
        status: readAnswerText(item.effective_status),
        instagramMediaId: readAnswerId(creative.effective_instagram_media_id),
        instagramUserId: readAnswerId(creative.instagram_user_id),
        thumbnailUrl: readAnswerText(creative.thumbnail_url),
        createdAt: readAnswerText(item.created_time),
      },
    ];
  });
  const hasNextPage = readAnswerText(answer.paging?.next) !== null;
  return { items, nextCursor: hasNextPage ? readAnswerText(answer.paging?.cursors?.after) : null };
}
