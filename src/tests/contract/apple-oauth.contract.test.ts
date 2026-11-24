import {
  type CryptoKey,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from 'jose';
import nock from 'nock';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  APPLE_ISSUER,
  exchangeAppleOAuthCode,
  resetAppleKeysCache,
} from '@/domains/auth/sub-domains/auth-method/oauth/providers/apple-oauth.provider.js';
import { env } from '@/shared/config/env.config.js';
import { ServiceUnavailableError, UnauthorizedError } from '@/shared/errors/index.js';

import appleTokenSuccessFixture from './fixtures/oauth/apple.token.success.response.json' with {
  type: 'json',
};
import { registerThirdPartyContractTestIsolationHooks } from './helpers/register-contract-test-hooks.js';
import {
  AppleKeysResponseContractSchema,
  AppleTokenOutgoingFormContractSchema,
  AppleTokenSuccessResponseContractSchema,
} from './schemas/oauth.schemas.js';

registerThirdPartyContractTestIsolationHooks();

const EXPECTED_NONCE = 'contract-apple-nonce-hash';

let appleSigningKey: CryptoKey;
let applePublicJwk: JWK;

async function appleIdToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'contract-apple-key' })
    .setIssuer(APPLE_ISSUER)
    .setAudience(env.OAUTH_APPLE_CLIENT_ID as string)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(appleSigningKey);
}

/**
 * Sign in with Apple's wire contract (feat-instagram-dm-sending § 10.B ATC6): the form our token
 * swap sends (with the ES256 client secret signed per swap), the `id_token` check against Apple's
 * key set (issuer, audience, the flow's nonce), and how Apple's refusals and outages surface.
 */
describe('Apple OAuth outbound contract (`apple-oauth.provider`)', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    appleSigningKey = pair.privateKey;
    applePublicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: 'contract-apple-key',
      alg: 'RS256',
      use: 'sig',
    };
  });

  beforeEach(() => {
    resetAppleKeysCache();
  });

  test('the swap sends the documented form with an ES256 client secret, and the id_token yields the person', async () => {
    const idToken = await appleIdToken({
      sub: '001234.contract-apple-sub',
      email: 'contract@privaterelay.appleid.com',
      email_verified: 'true',
      is_private_email: 'true',
      nonce: EXPECTED_NONCE,
    });
    AppleTokenSuccessResponseContractSchema.parse({
      ...appleTokenSuccessFixture,
      id_token: idToken,
    });
    AppleKeysResponseContractSchema.parse({ keys: [applePublicJwk] });

    let clientSecret = '';
    nock(APPLE_ISSUER)
      .post('/auth/token', (body: Record<string, string>) => {
        const form = AppleTokenOutgoingFormContractSchema.parse({ ...body });
        expect(form.client_id).toBe(env.OAUTH_APPLE_CLIENT_ID);
        expect(form.code).toBe('contract-apple-code');
        expect(form.redirect_uri).toBe(env.OAUTH_APPLE_REDIRECT_URI);
        clientSecret = form.client_secret;
        return true;
      })
      .matchHeader('content-type', /application\/x-www-form-urlencoded/)
      .reply(200, { ...appleTokenSuccessFixture, id_token: idToken });
    nock(APPLE_ISSUER)
      .get('/auth/keys')
      .reply(200, { keys: [applePublicJwk] });

    const profile = await exchangeAppleOAuthCode({
      code: 'contract-apple-code',
      expectedNonce: EXPECTED_NONCE,
    });

    expect(profile).toEqual({
      email: 'contract@privaterelay.appleid.com',
      provider_user_id: '001234.contract-apple-sub',
    });
    expect(decodeProtectedHeader(clientSecret)).toEqual({
      alg: 'ES256',
      kid: env.OAUTH_APPLE_KEY_ID,
    });
    const secretClaims = decodeJwt(clientSecret);
    expect(secretClaims).toMatchObject({
      iss: env.OAUTH_APPLE_TEAM_ID,
      sub: env.OAUTH_APPLE_CLIENT_ID,
      aud: APPLE_ISSUER,
    });
    expect((secretClaims.exp ?? 0) - (secretClaims.iat ?? 0)).toBeLessThanOrEqual(300);
  });

  test('a later sign-in without an email still yields the person by sub', async () => {
    const idToken = await appleIdToken({ sub: 'contract-apple-sub-2', nonce: EXPECTED_NONCE });
    nock(APPLE_ISSUER)
      .post('/auth/token')
      .reply(200, { ...appleTokenSuccessFixture, id_token: idToken });
    nock(APPLE_ISSUER)
      .get('/auth/keys')
      .reply(200, { keys: [applePublicJwk] });

    await expect(
      exchangeAppleOAuthCode({ code: 'c', expectedNonce: EXPECTED_NONCE }),
    ).resolves.toEqual({ provider_user_id: 'contract-apple-sub-2' });
  });

  test('an id_token of another flow (nonce) is refused — 401 oauth_failed', async () => {
    const idToken = await appleIdToken({ sub: 's', nonce: 'another-flow' });
    nock(APPLE_ISSUER)
      .post('/auth/token')
      .reply(200, { ...appleTokenSuccessFixture, id_token: idToken });
    nock(APPLE_ISSUER)
      .get('/auth/keys')
      .reply(200, { keys: [applePublicJwk] });

    const error = await exchangeAppleOAuthCode({ code: 'c', expectedNonce: EXPECTED_NONCE }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).toMatchObject({ reason: 'oauth_failed' });
  });

  test('invalid_grant (HTTP 400) is a refused sign-in (401), a 5xx an outage (503)', async () => {
    nock(APPLE_ISSUER).post('/auth/token').reply(400, { error: 'invalid_grant' });
    await expect(
      exchangeAppleOAuthCode({ code: 'expired', expectedNonce: EXPECTED_NONCE }),
    ).rejects.toThrow(UnauthorizedError);

    nock(APPLE_ISSUER).post('/auth/token').reply(503, 'unavailable');
    await expect(
      exchangeAppleOAuthCode({ code: 'c', expectedNonce: EXPECTED_NONCE }),
    ).rejects.toThrow(ServiceUnavailableError);
  });
});
