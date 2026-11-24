import {
  createLocalJWKSet,
  importPKCS8,
  type JSONWebKeySet,
  jwtVerify,
  SignJWT,
  errors as joseErrors,
} from 'jose';
import { NotImplementedError, UnauthorizedError } from '@/shared/errors/index.js';
import { env } from '@/shared/config/env.config.js';
import { DEFAULT_FRONTEND_URL } from '@/shared/constants/index.js';
import { normalizePem } from '@/shared/utils/security/jwt.util.js';
import { buildOutboundFetchOptions, outboundFetchJson } from '@/infrastructure/outbound/index.js';
import { toOAuthProviderFailure } from '@/domains/auth/sub-domains/auth-method/oauth/providers/oauth-provider-failure.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { OAuthProfile } from '@/domains/auth/sub-domains/auth-method/oauth/oauth.types.js';

/** Apple's issuer — the `iss` of every `id_token` and the `aud` of our client secret. */
export const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_AUTHORIZE_URL = `${APPLE_ISSUER}/auth/authorize`;
const APPLE_TOKEN_URL = `${APPLE_ISSUER}/auth/token`;
const APPLE_KEYS_URL = `${APPLE_ISSUER}/auth/keys`;

/** Life of the ES256 client secret signed for one code swap (Apple allows up to six months). */
const APPLE_CLIENT_SECRET_TTL_SECONDS = 300;

/** How long Apple's public keys are reused before they are read again (≤ 60 s, be-read-cache-guard). */
export const APPLE_KEYS_CACHE_TTL_MS = 60_000;

/** The Apple configuration a swap needs; all five env vars are set together (env-schema refine). */
interface AppleOAuthConfiguration {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  redirectUri: string;
}

function readAppleConfiguration(): AppleOAuthConfiguration | null {
  const clientId = env.OAUTH_APPLE_CLIENT_ID;
  const teamId = env.OAUTH_APPLE_TEAM_ID;
  const keyId = env.OAUTH_APPLE_KEY_ID;
  const privateKey = env.OAUTH_APPLE_PRIVATE_KEY;
  const redirectUri = env.OAUTH_APPLE_REDIRECT_URI;
  if (!(clientId && teamId && keyId && privateKey && redirectUri)) return null;
  return { clientId, teamId, keyId, privateKey, redirectUri };
}

function requireAppleConfiguration(): AppleOAuthConfiguration {
  const configuration = readAppleConfiguration();
  if (!configuration) {
    throw new NotImplementedError('errors:oauthProviderNotConfigured', { provider: 'apple' });
  }
  return configuration;
}

/** True when all five `OAUTH_APPLE_*` env vars are set — Apple is then offered (AT11). */
export function isAppleOAuthConfigured(): boolean {
  return readAppleConfiguration() !== null;
}

/**
 * The app page Apple's form callback sends the browser on to: `<FRONTEND_URL>/callback/apple`
 * with `code` and `state` (a good post), or with `reason` (a failed one) — AT10.
 */
export function buildAppleAppCallbackUrl(query: Record<string, string>): string {
  const url = new URL(`${env.FRONTEND_URL ?? DEFAULT_FRONTEND_URL}/callback/apple`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url.toString();
}

/**
 * Builds Apple's authorize URL: `response_type=code`, `response_mode=form_post` with the
 * `name email` scopes (Apple then posts its answer to route 124), the CSRF `state`, and the
 * `nonce` Apple copies into its `id_token`.
 *
 * @remarks
 * - **Algorithm:** the `nonce` is the SHA-256 of the browser nonce kept with the state, so the
 *   `id_token` proves it was minted for this browser's flow (AT10). No PKCE: Apple's token
 *   endpoint does not document `code_verifier`, so the state and the `id_token` nonce carry the
 *   binding instead (routes-final § 10.B AT10's stated fallback).
 * - **Failure modes:** `NotImplementedError` when Apple is not configured (the service checks
 *   {@link isAppleOAuthConfigured} first and answers 404).
 * - **Side effects:** none.
 */
export function buildAppleOAuthRedirectUrl({
  state,
  nonce,
}: {
  state: string;
  nonce: string;
}): string {
  const configuration = requireAppleConfiguration();
  const params = new URLSearchParams({
    client_id: configuration.clientId,
    redirect_uri: configuration.redirectUri,
    response_type: 'code',
    response_mode: 'form_post',
    scope: 'name email',
    state,
    nonce,
  });
  return `${APPLE_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Signs the short ES256 client secret Apple's token endpoint takes in place of a static secret:
 * `iss` the team id, `sub` the client id, `aud` Apple, `kid` our key id, five minutes of life.
 *
 * @remarks
 * - **Algorithm:** a fresh JWT per swap with `jose` (`SignJWT`, the key imported from
 *   `OAUTH_APPLE_PRIVATE_KEY` as PKCS#8 PEM).
 * - **Failure modes:** a malformed key throws (a 500 — an operator error).
 * - **Side effects:** none.
 */
export async function createAppleClientSecret(): Promise<string> {
  const configuration = requireAppleConfiguration();
  const key = await importPKCS8(normalizePem(configuration.privateKey), 'ES256');
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: configuration.keyId })
    .setIssuer(configuration.teamId)
    .setSubject(configuration.clientId)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + APPLE_CLIENT_SECRET_TTL_SECONDS)
    .sign(key);
}

let cachedAppleKeys: { keys: JSONWebKeySet; readAt: number } | null = null;

/** Forgets Apple's cached public keys — for the tests, which swap Apple's answers through nock. */
export function resetAppleKeysCache(): void {
  cachedAppleKeys = null;
}

async function readAppleKeys({
  requestId,
  fresh,
}: {
  requestId?: string | undefined;
  fresh: boolean;
}): Promise<JSONWebKeySet> {
  if (!fresh && cachedAppleKeys && Date.now() - cachedAppleKeys.readAt < APPLE_KEYS_CACHE_TTL_MS) {
    return cachedAppleKeys.keys;
  }
  let keys: JSONWebKeySet;
  try {
    keys = await outboundFetchJson<JSONWebKeySet>(
      buildOutboundFetchOptions({
        name: 'oauth-apple',
        url: APPLE_KEYS_URL,
        requestId,
        expectedStatus: 200,
      }),
    );
  } catch (error) {
    throw toOAuthProviderFailure({ error, rejectedMessageKey: 'errors:appleIdTokenInvalid' });
  }
  cachedAppleKeys = { keys, readAt: Date.now() };
  return keys;
}

/** The `id_token` claims the sign-in reads. */
interface AppleIdTokenClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  nonce?: string;
}

async function verifyAppleIdToken({
  idToken,
  clientId,
  requestId,
}: {
  idToken: string;
  clientId: string;
  requestId?: string | undefined;
}): Promise<AppleIdTokenClaims> {
  const verify = async (fresh: boolean) =>
    jwtVerify<AppleIdTokenClaims>(
      idToken,
      createLocalJWKSet(await readAppleKeys({ requestId, fresh })),
      { issuer: APPLE_ISSUER, audience: clientId, algorithms: ['RS256'] },
    );
  try {
    return (await verify(false)).payload;
  } catch (error) {
    // Apple rotated its keys since the cached read: read them once more, then give up.
    if (error instanceof joseErrors.JWKSNoMatchingKey) {
      try {
        return (await verify(true)).payload;
      } catch (retryError) {
        if (retryError instanceof joseErrors.JOSEError) {
          throw new UnauthorizedError('errors:appleIdTokenInvalid').withReason('oauth_failed');
        }
        throw retryError;
      }
    }
    if (error instanceof joseErrors.JOSEError) {
      throw new UnauthorizedError('errors:appleIdTokenInvalid').withReason('oauth_failed');
    }
    throw error;
  }
}

/** Input for {@link exchangeAppleOAuthCode}. */
export interface ExchangeAppleOAuthCodeOptions {
  /** The authorization code Apple posted to route 124 and the app passed to route 143. */
  code: string;
  /** The nonce hash kept with the state; the `id_token`'s `nonce` must equal it. */
  expectedNonce: string;
  requestId?: string;
}

/**
 * Swaps Apple's code for tokens with a fresh ES256 client secret, checks the `id_token` against
 * Apple's public keys and returns the person: `sub`, and `email` when Apple sent one (AT10).
 *
 * @remarks
 * - **Algorithm:** `POST /auth/token` (form: `client_id`, the client secret, `code`,
 *   `grant_type=authorization_code`, `redirect_uri`); the `id_token` is verified (RS256, Apple's
 *   issuer, our client id as audience, not expired) against Apple's keys — cached
 *   {@link APPLE_KEYS_CACHE_TTL_MS}, read again once when the token names an unknown key — and
 *   its `nonce` must equal `expectedNonce`. An email Apple marks unverified is refused (the
 *   find-or-link takeover guard, as Google's); a private relay address is an ordinary email.
 * - **Failure modes:** Apple refusing the code → 401 `errors:appleExchangeFailed` (reason
 *   `oauth_failed`); an `id_token` that does not verify, a wrong nonce, no `sub` or an
 *   unverified email → 401 (reason `oauth_failed`); Apple failing (network, timeout, 5xx) → 503
 *   (`toOAuthProviderFailure`).
 * - **Side effects:** two outbound calls at most (the swap, Apple's keys when not cached).
 * - **Notes:** Apple's name is not in the `id_token`; the service adds it from the `user` JSON
 *   kept by route 124.
 */
export async function exchangeAppleOAuthCode(
  options: ExchangeAppleOAuthCodeOptions,
): Promise<OAuthProfile> {
  const configuration = requireAppleConfiguration();
  const clientSecret = await createAppleClientSecret();

  let tokenData: { id_token?: string };
  try {
    tokenData = await outboundFetchJson<{ id_token?: string }>(
      buildOutboundFetchOptions({
        name: 'oauth-apple',
        url: APPLE_TOKEN_URL,
        requestId: options.requestId,
        expectedStatus: 200,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: configuration.clientId,
            client_secret: clientSecret,
            code: options.code,
            grant_type: 'authorization_code',
            redirect_uri: configuration.redirectUri,
          }),
        },
      }),
    );
  } catch (error) {
    throw toOAuthProviderFailure({ error, rejectedMessageKey: 'errors:appleExchangeFailed' });
  }

  if (!tokenData.id_token) {
    throw new UnauthorizedError('errors:appleExchangeFailed').withReason('oauth_failed');
  }

  const claims = await verifyAppleIdToken({
    idToken: tokenData.id_token,
    clientId: configuration.clientId,
    requestId: options.requestId,
  });

  if (!claims.sub || claims.nonce !== options.expectedNonce) {
    throw new UnauthorizedError('errors:appleIdTokenInvalid').withReason('oauth_failed');
  }
  if (claims.email && !(claims.email_verified === true || claims.email_verified === 'true')) {
    throw new UnauthorizedError('errors:appleIdTokenInvalid').withReason('oauth_failed');
  }

  return omitUndefined({ email: claims.email, provider_user_id: claims.sub });
}
