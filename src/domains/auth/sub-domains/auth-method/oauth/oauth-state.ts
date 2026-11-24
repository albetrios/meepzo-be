import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  consumeOneUseValue,
  generateOneUseToken,
  storeOneUseValue,
} from '@/infrastructure/cache/redis-one-use-value.util.js';
import { NotFoundError, UnauthorizedError } from '@/shared/errors/index.js';
import { OAUTH_STATE_TTL_SECONDS } from '@/shared/constants/ttl.constants.js';
import {
  SUPPORTED_OAUTH_PROVIDERS,
  type OAuthLinkTarget,
  type OAuthProvider,
} from './oauth.types.js';
import { generatePkceCodeVerifier } from './oauth-pkce.js';

export { OAUTH_STATE_TTL_SECONDS };
/** Redis key prefix for stored OAuth `state` tokens (CSRF defence on the authorize round-trip). */
export const OAUTH_STATE_KEY_PREFIX = 'oauth:state:';
/**
 * Redis key prefix of the provider's `user` JSON kept next to a state (Apple's name, sent on the
 * first sign-in only, AT10) — same life as the state, read once by the callback.
 */
export const OAUTH_PROVIDER_USER_KEY_PREFIX = 'oauth:provider-user:';

/** The `oauth_expired` refusal: a state that is missing, spent, expired, forged or not this browser's. */
function oauthStateExpiredError(): UnauthorizedError {
  return new UnauthorizedError('errors:oauthInvalidState').withReason('oauth_expired');
}

/** Lower-cases the provider slug (`Google` → `google`) so storage/comparison is case-insensitive. */
export function normalizeOAuthProvider(provider: string): string {
  return provider.toLowerCase();
}

/**
 * Normalises the provider slug and ensures it belongs to
 * {@link SUPPORTED_OAUTH_PROVIDERS}; otherwise throws `NotFoundError` (404) —
 * an unknown provider name is a missing resource, not an unimplemented
 * feature. The 501 `NotImplementedError` is reserved for providers that are
 * in the supported list but lack a configured implementation.
 */
export function assertOAuthProviderSupported(provider: string): OAuthProvider {
  const normalizedProvider = normalizeOAuthProvider(provider);
  if (!SUPPORTED_OAUTH_PROVIDERS.includes(normalizedProvider as OAuthProvider)) {
    throw new NotFoundError('OAuth provider');
  }
  return normalizedProvider as OAuthProvider;
}

/**
 * Payload persisted under `oauth:state:<state>` for the authorize round-trip.
 *
 * @remarks
 * - **Algorithm:** binds the issued `state` to the provider, the PKCE `code_verifier`
 *   (RFC 7636) the token exchange must echo, and the SHA-256 hash of the browser nonce
 *   so the callback can only be completed by the same browser that began the flow.
 * - **Side effects:** none (shape only).
 * - **Notes:** the raw nonce is never stored — only its hash rests in Redis.
 */
interface OAuthStatePayload {
  provider: OAuthProvider;
  code_verifier: string;
  nonce_hash: string;
  /** Link mode (AT12): the signed-in person and session the callback links the account to. */
  link?: OAuthLinkTarget;
}

/** SHA-256 hex digest of a browser nonce, so the raw nonce never rests in Redis. */
export function hashOAuthNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

/**
 * Result of {@link createOAuthState}: the opaque `state`, the PKCE `codeVerifier` the
 * service derives a challenge from, and the `nonce` the handler must set as a browser cookie.
 */
export interface CreateOAuthStateResult {
  state: string;
  codeVerifier: string;
  nonce: string;
}

/**
 * Mints a single-use OAuth `state` plus the PKCE verifier and browser nonce that harden the
 * authorize round-trip, persisting `{provider, code_verifier, nonce_hash}` in Redis with
 * {@link OAUTH_STATE_TTL_SECONDS} TTL.
 *
 * @remarks
 * - **Algorithm:** generates a 32-byte `state`, an RFC 7636 PKCE `code_verifier`, and a 32-byte
 *   browser `nonce`; stores the provider, the verifier (needed at token exchange), and the nonce
 *   HASH so the callback can require the originating browser's cookie.
 * - **Side effects:** writes one `oauth:state:*` entry to Redis.
 * - **Notes:** the verifier and nonce are returned to the caller and must NOT be persisted
 *   anywhere except (verifier) Redis and (nonce) a short-lived httpOnly cookie.
 */
export async function createOAuthState({
  redis,
  provider,
  link,
}: {
  redis: Redis;
  provider: OAuthProvider;
  link?: OAuthLinkTarget | undefined;
}): Promise<CreateOAuthStateResult> {
  const state = generateOneUseToken('hex');
  const codeVerifier = generatePkceCodeVerifier();
  const nonce = generateOneUseToken('hex');
  const payload: OAuthStatePayload = {
    provider,
    code_verifier: codeVerifier,
    nonce_hash: hashOAuthNonce(nonce),
    ...(link ? { link } : {}),
  };
  await storeOneUseValue({
    redis,
    key: `${OAUTH_STATE_KEY_PREFIX}${state}`,
    value: JSON.stringify(payload),
    ttlSeconds: OAUTH_STATE_TTL_SECONDS,
  });
  return { state, codeVerifier, nonce };
}

/**
 * Result of a successful {@link consumeOAuthState}: the resolved provider, the PKCE verifier to
 * send at token exchange, the nonce hash (Apple carries it inside its `id_token`, AT10) and the
 * link target when the flow began in link mode (AT12).
 */
export interface ConsumeOAuthStateResult {
  provider: OAuthProvider;
  codeVerifier: string;
  nonceHash: string;
  link?: OAuthLinkTarget;
}

/**
 * Single-use, browser-bound lookup of an OAuth `state` token.
 *
 * @remarks
 * - **Algorithm:** atomically reads-and-deletes the Redis entry (`GETDEL`), parses the JSON
 *   payload, then enforces three checks before returning: the `state` was issued for the same
 *   provider, and the supplied browser `nonce` hashes to the stored `nonce_hash`. Returns the
 *   PKCE `code_verifier` so the caller can complete the RFC 7636 exchange.
 * - **Failure modes:** missing/empty/expired state, malformed payload, provider mismatch, or a
 *   missing/mismatched nonce all throw `UnauthorizedError` (`errors:oauthInvalidState`, reason
 *   `oauth_expired`). The
 *   atomic consume guarantees only one of two concurrent callbacks can read a non-null value,
 *   preventing state replay in a GET-then-DEL race.
 * - **Side effects:** deletes the `oauth:state:*` entry.
 * - **Notes:** the nonce check binds the callback to the browser that initiated authorize,
 *   defeating login-CSRF where an attacker injects their own `state`+`code` pair.
 */
export async function consumeOAuthState({
  redis,
  provider,
  state,
  nonce,
}: {
  redis: Redis;
  provider: string;
  state: string | undefined;
  nonce: string | undefined;
}): Promise<ConsumeOAuthStateResult> {
  if (!state || state.length === 0) {
    throw oauthStateExpiredError();
  }

  const storedPayloadRaw = await consumeOneUseValue({
    redis,
    key: `${OAUTH_STATE_KEY_PREFIX}${state}`,
  });
  if (!storedPayloadRaw) {
    throw oauthStateExpiredError();
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(storedPayloadRaw) as OAuthStatePayload;
  } catch {
    throw oauthStateExpiredError();
  }

  const normalizedProvider = normalizeOAuthProvider(provider);
  if (payload.provider !== normalizedProvider) {
    throw oauthStateExpiredError();
  }

  if (!nonce || nonce.length === 0 || hashOAuthNonce(nonce) !== payload.nonce_hash) {
    throw oauthStateExpiredError();
  }

  return {
    provider: assertOAuthProviderSupported(normalizedProvider),
    codeVerifier: payload.code_verifier,
    nonceHash: payload.nonce_hash,
    ...(payload.link ? { link: payload.link } : {}),
  };
}

/**
 * Seconds left on a live, unspent `state` issued for `provider`, or `null` when there is none —
 * read WITHOUT using the state up: Apple's form post (route 124) checks the state, and the app's
 * callback call (route 143) uses it once.
 *
 * @remarks
 * - **Algorithm:** reads the `oauth:state:*` entry and its TTL; a missing, unreadable or other
 *   provider's entry, or one without a TTL, is `null`.
 * - **Failure modes:** none — a Redis error propagates.
 * - **Side effects:** none.
 */
export async function readLiveOAuthStateSeconds({
  redis,
  provider,
  state,
}: {
  redis: Redis;
  provider: OAuthProvider;
  state: string;
}): Promise<number | null> {
  const key = `${OAUTH_STATE_KEY_PREFIX}${state}`;
  const [storedPayloadRaw, secondsLeft] = await Promise.all([redis.get(key), redis.ttl(key)]);
  if (!storedPayloadRaw || secondsLeft <= 0) return null;
  try {
    const payload = JSON.parse(storedPayloadRaw) as OAuthStatePayload;
    return payload.provider === provider ? secondsLeft : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the provider's `user` JSON text next to a live state for the state's remaining life
 * (Apple's name, sent on the first sign-in only — AT10).
 *
 * @remarks
 * Short-lived login state like the state itself: nothing is lost if it goes (the person is
 * created without a name). Never logged.
 */
export async function rememberOAuthProviderUser({
  redis,
  state,
  userJson,
  ttlSeconds,
}: {
  redis: Redis;
  state: string;
  userJson: string;
  ttlSeconds: number;
}): Promise<void> {
  await redis.set(`${OAUTH_PROVIDER_USER_KEY_PREFIX}${state}`, userJson, 'EX', ttlSeconds);
}

/** Takes (reads and deletes) the provider `user` JSON kept next to `state`, or `null` when none was kept. */
export async function takeOAuthProviderUser({
  redis,
  state,
}: {
  redis: Redis;
  state: string;
}): Promise<string | null> {
  return redis.getdel(`${OAUTH_PROVIDER_USER_KEY_PREFIX}${state}`);
}
