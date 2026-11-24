import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { type CryptoKey, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { auth_methods } from '@/domains/auth/sub-domains/auth-method/auth-method.schema.js';
import { users } from '@/domains/user/user.schema.js';
import { env } from '@/shared/config/env.config.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { OAUTH_FORM_CALLBACK_BODY_LIMIT_BYTES } from '@/shared/constants/limits.constants.js';
import { resetAppleKeysCache } from '@/domains/auth/sub-domains/auth-method/oauth/providers/apple-oauth.provider.js';

/**
 * Sign in with Apple (routes 122–124, 143 — feat-instagram-dm-sending § 10.B AT10–AT14) and the
 * link mode of the OAuth start. Only Apple's two endpoints are faked (nock): the token swap and its
 * public keys. The state, the nonce cookie, the form post, the 303, the find-or-create and the link
 * all run for real.
 */

const OAUTH_NONCE_COOKIE = 'oauth_nonce';
const APPLE = 'https://appleid.apple.com';
const APPLE_CALLBACK_PATH = '/auth/oauth/apple/callback';

let appleSigningKey: CryptoKey;
let applePublicJwk: JWK;

/** An `id_token` Apple would mint: RS256 over our client id, with the given claims. */
async function appleIdToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'apple-test-key' })
    .setIssuer(APPLE)
    .setAudience(env.OAUTH_APPLE_CLIENT_ID as string)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(appleSigningKey);
}

/** Fakes Apple's token swap (answering `id_token`) and its key set. */
function fakeAppleSwap(idToken: string): void {
  nock(APPLE)
    .post('/auth/token', (body: Record<string, string>) => {
      return (
        body.grant_type === 'authorization_code' &&
        body.client_id === env.OAUTH_APPLE_CLIENT_ID &&
        typeof body.client_secret === 'string' &&
        body.client_secret.split('.').length === 3
      );
    })
    .reply(200, { access_token: 'a', token_type: 'Bearer', expires_in: 3600, id_token: idToken });
  nock(APPLE)
    .get('/auth/keys')
    .optionally()
    .reply(200, { keys: [applePublicJwk] });
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

describe('Sign in with Apple and OAuth link mode — Integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
    const pair = await generateKeyPair('RS256');
    appleSigningKey = pair.privateKey;
    applePublicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: 'apple-test-key',
      alg: 'RS256',
      use: 'sig',
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    resetAppleKeysCache();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  /** Starts the Apple flow (route 123) and returns the state, the nonce cookie and Apple's nonce. */
  async function startApple(options?: { token?: string; intent?: string }) {
    const url = testApiPath(
      `/auth/oauth/apple${options?.intent ? `?intent=${options.intent}` : ''}`,
    );
    const response = options?.token
      ? await injectAuthenticated(app, { method: 'GET', url, token: options.token })
      : await injectUnauthenticated(app, { method: 'GET', url });
    expect(response.statusCode, response.body).toBe(200);
    const redirect = new URL(
      (response.json() as { data: { redirect_url: string } }).data.redirect_url,
    );
    const nonce = response.cookies[OAUTH_NONCE_COOKIE] as string;
    return { redirect, state: redirect.searchParams.get('state') as string, nonce };
  }

  function postAppleForm(payload: string, contentType = 'application/x-www-form-urlencoded') {
    // A cross-site POST from Apple: no cookie of ours, no bearer.
    return injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath(APPLE_CALLBACK_PATH),
      headers: { 'content-type': contentType },
      payload,
    });
  }

  it('route 122 answers Google and Apple only (AC-13.6)', async () => {
    const response = await injectUnauthenticated(app, {
      url: testApiPath('/auth/oauth/providers'),
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: { providers: string[] } }).data.providers).toEqual([
      'google',
      'apple',
    ]);
  });

  it("route 123 asks Apple for form_post with the name and email scopes and the nonce's hash", async () => {
    const { redirect, nonce } = await startApple();
    expect(redirect.origin).toBe(APPLE);
    expect(redirect.pathname).toBe('/auth/authorize');
    expect(redirect.searchParams.get('response_mode')).toBe('form_post');
    expect(redirect.searchParams.get('scope')).toBe('name email');
    expect(redirect.searchParams.get('nonce')).toBe(sha256Hex(nonce));
  });

  it('route 123 refuses another provider name — 400 on provider', async () => {
    const response = await injectUnauthenticated(app, {
      url: testApiPath('/auth/oauth/github'),
    });
    expect(response.statusCode).toBe(400);
  });

  it('route 124 keeps the name with the state, answers 303 to the app page, and signs nobody in (AC-13.5)', async () => {
    const { state, nonce } = await startApple();
    const user = JSON.stringify({
      name: { firstName: 'Ada', lastName: 'Lovelace' },
      email: 'ada@example.com',
    });

    const first = await postAppleForm(formBody({ state, code: 'apple-code', user, id_token: 'x' }));
    expect(first.statusCode, first.body).toBe(303);
    const location = new URL(first.headers.location as string);
    expect(location.pathname).toBe('/callback/apple');
    expect(location.searchParams.get('code')).toBe('apple-code');
    expect(location.searchParams.get('state')).toBe(state);
    expect(first.cookies.session_id).toBeUndefined();
    expect(first.body).toBe('');

    // A second post without `user` still lands, and does not lose the kept name.
    const second = await postAppleForm(formBody({ state, code: 'apple-code' }));
    expect(second.statusCode).toBe(303);

    fakeAppleSwap(
      await appleIdToken({
        sub: 'apple-sub-ada',
        email: 'ada@example.com',
        email_verified: 'true',
        nonce: sha256Hex(nonce),
      }),
    );
    const callback = await injectUnauthenticated(app, {
      method: 'GET',
      url: testApiPath(`${APPLE_CALLBACK_PATH}?code=apple-code&state=${state}`),
      cookies: { [OAUTH_NONCE_COOKIE]: nonce },
    });
    expect(callback.statusCode, callback.body).toBe(200);
    expect(callback.cookies.session_id).toBeTruthy();

    const [person] = await getOperatorDatabase()
      .select({ first_name: users.first_name, last_name: users.last_name })
      .from(users)
      .where(eq(users.email, 'ada@example.com'));
    expect(person).toEqual({ first_name: 'Ada', last_name: 'Lovelace' });

    // The state is spent: Apple's form now lands on the failed page, the callback is a 401.
    const spent = await postAppleForm(formBody({ state, code: 'apple-code' }));
    expect(spent.statusCode).toBe(303);
    expect(new URL(spent.headers.location as string).searchParams.get('reason')).toBe(
      'oauth_expired',
    );
    const replay = await injectUnauthenticated(app, {
      method: 'GET',
      url: testApiPath(`${APPLE_CALLBACK_PATH}?code=apple-code&state=${state}`),
      cookies: { [OAUTH_NONCE_COOKIE]: nonce },
    });
    expect(replay.statusCode).toBe(401);
    expect((replay.json() as { error: { reason?: string } }).error.reason).toBe('oauth_expired');
  });

  it("route 124 sends Apple's cancel to the failed page with oauth_cancelled", async () => {
    const { state } = await startApple();
    const response = await postAppleForm(formBody({ state, error: 'user_cancelled_authorize' }));
    expect(response.statusCode).toBe(303);
    expect(new URL(response.headers.location as string).searchParams.get('reason')).toBe(
      'oauth_cancelled',
    );
  });

  it('route 124 refuses a body over 16 KiB (413), a body that is not a form (415) and a missing state (400)', async () => {
    const { state } = await startApple();
    const tooLarge = await postAppleForm(
      formBody({ state, code: 'c', filler: 'x'.repeat(OAUTH_FORM_CALLBACK_BODY_LIMIT_BYTES) }),
    );
    expect(tooLarge.statusCode).toBe(413);

    const json = await postAppleForm(JSON.stringify({ state, code: 'c' }), 'application/json');
    expect(json.statusCode).toBe(415);

    const noState = await postAppleForm(formBody({ code: 'c' }));
    expect(noState.statusCode).toBe(400);
  });

  it('a callback whose id_token nonce is not this flow is refused — 401 oauth_failed', async () => {
    const { state, nonce } = await startApple();
    fakeAppleSwap(
      await appleIdToken({ sub: 'apple-sub-x', email: 'x@example.com', nonce: 'another-flow' }),
    );
    const response = await injectUnauthenticated(app, {
      method: 'GET',
      url: testApiPath(`${APPLE_CALLBACK_PATH}?code=apple-code&state=${state}`),
      cookies: { [OAUTH_NONCE_COOKIE]: nonce },
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { reason?: string } }).error.reason).toBe('oauth_failed');
  });

  describe('link mode (route 123 intent=link, route 143) — AC-13.7', () => {
    it('needs a bearer (401) and a recent step-up (403 recent_step_up_required)', async () => {
      const signedOut = await injectUnauthenticated(app, {
        url: testApiPath('/auth/oauth/apple?intent=link'),
      });
      expect(signedOut.statusCode).toBe(401);

      const person = await createTestUser();
      const token = await generateTestToken({ userId: person.public_id });
      const noStepUp = await injectAuthenticated(app, {
        url: testApiPath('/auth/oauth/apple?intent=link'),
        token,
      });
      expect(noStepUp.statusCode).toBe(403);
      expect((noStepUp.json() as { error: { reason?: string } }).error.reason).toBe(
        'recent_step_up_required',
      );

      const badIntent = await injectAuthenticated(app, {
        url: testApiPath('/auth/oauth/apple?intent=merge'),
        token,
      });
      expect(badIntent.statusCode).toBe(400);
    });

    it('links an Apple account of another email to the signed-in person and answers the linked way', async () => {
      const person = await createTestUser({ email: 'owner@example.com' });
      const token = await generateTestToken({ userId: person.public_id, stepUp: true });
      const { state, nonce } = await startApple({ token, intent: 'link' });
      fakeAppleSwap(
        await appleIdToken({
          sub: 'apple-sub-link',
          email: 'someone-else@privaterelay.appleid.com',
          email_verified: true,
          nonce: sha256Hex(nonce),
        }),
      );

      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath(`${APPLE_CALLBACK_PATH}?code=apple-code&state=${state}`),
        cookies: { [OAUTH_NONCE_COOKIE]: nonce },
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as {
        data: { id: string; provider: string; method_type: string };
      };
      expect(body.data).toMatchObject({ provider: 'apple', method_type: 'OAUTH' });
      expect(body.data.id).toBeTypeOf('string');
      expect(response.cookies.session_id).toBeUndefined();

      const rows = await getOperatorDatabase()
        .select({ user_id: auth_methods.user_id })
        .from(auth_methods)
        .where(
          and(
            eq(auth_methods.provider, 'apple'),
            eq(auth_methods.provider_user_id, 'apple-sub-link'),
            isNull(auth_methods.revoked_at),
          ),
        );
      expect(rows).toEqual([{ user_id: person.id }]);
      const created = await getOperatorDatabase()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, 'someone-else@privaterelay.appleid.com'));
      expect(created).toHaveLength(0);
    });

    it('refuses an Apple account already linked to someone else — 409 provider_account_in_use', async () => {
      const holder = await createTestUser();
      await getOperatorDatabase()
        .insert(auth_methods)
        .values({
          public_id: generatePublicId('authMethod'),
          user_id: holder.id,
          method_type: 'OAUTH',
          provider: 'apple',
          provider_user_id: 'apple-sub-taken',
          is_primary: false,
        });
      const person = await createTestUser();
      const token = await generateTestToken({ userId: person.public_id, stepUp: true });
      const { state, nonce } = await startApple({ token, intent: 'link' });
      fakeAppleSwap(
        await appleIdToken({
          sub: 'apple-sub-taken',
          email: 'h@example.com',
          nonce: sha256Hex(nonce),
          email_verified: true,
        }),
      );

      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath(`${APPLE_CALLBACK_PATH}?code=apple-code&state=${state}`),
        cookies: { [OAUTH_NONCE_COOKIE]: nonce },
      });
      expect(response.statusCode).toBe(409);
      expect((response.json() as { error: { reason?: string } }).error.reason).toBe(
        'provider_account_in_use',
      );
    });
  });
});
