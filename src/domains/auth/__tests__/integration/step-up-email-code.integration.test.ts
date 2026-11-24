import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { generate as generateTotpCode } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateTestTokenAndSession } from '@/tests/helpers/test-auth.js';
import { seedRecentStepUpForTestUser } from '@/tests/helpers/test-step-up.helper.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { auth_methods } from '@/domains/auth/sub-domains/auth-method/auth-method.schema.js';
import { webauthn_credentials } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.schema.js';
import { emailCodeSendCooldownKey } from '@/domains/auth/sub-domains/auth-method/email-login.service.js';

/** The error envelope's `reason` and extra fields. */
function errorOf(response: { json: () => unknown }) {
  return (response.json() as { error?: { reason?: string; tries_left?: number } }).error;
}

/**
 * The email-code step-up is strong for a person without settled 2FA (feat-instagram-dm-sending
 * R32, routes-final § 10.C AT15, ATC8; AC-13.11): route 127 and the strong gate of routes 125,
 * 144, 146 and 147.
 */
describe('POST /auth/step-up by email code (route 127)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  /** Sends a code to `email` (the TEST_MODE echo) and steps up with it on `token`'s session. */
  async function stepUpByEmailCode(options: { token: string; email: string; code?: string }) {
    await redisConnection.del(emailCodeSendCooldownKey(options.email));
    const sent = await injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/email/send-code'),
      payload: { email: options.email },
    });
    const echoed = (sent.json() as { data: { debug_verification_code: string } }).data
      .debug_verification_code;
    return injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/step-up'),
      token: options.token,
      payload: { code: options.code ?? echoed },
    });
  }

  /** A signed-in person without 2FA. */
  async function personWithoutTwoFactor() {
    const user = await createTestUser({ isEmailVerified: true });
    const signedIn = await generateTestTokenAndSession({ userId: user.public_id });
    return { user, ...signedIn };
  }

  /** Enrolls a TOTP factor on `token`'s session, under whatever step-up window it holds. */
  async function enrollTotp(token: string) {
    const enroll = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/me/mfa/enroll'),
      token,
      payload: { method_type: 'MFA_TOTP' },
    });
    expect(enroll.statusCode, enroll.body).toBe(200);
    const { secret } = (enroll.json() as { data: { secret: string } }).data;
    const confirm = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/me/mfa/enroll/confirm'),
      token,
      payload: { code: await generateTotpCode({ secret }) },
    });
    expect(confirm.statusCode, confirm.body).toBe(200);
  }

  it('AC-13.11: without 2FA, an email-code step-up answers its factor and removes a passkey', async () => {
    const { user, token } = await personWithoutTwoFactor();
    const passkeys = await getOperatorDatabase()
      .insert(webauthn_credentials)
      .values(
        ['key-a', 'key-b'].map((publicKey) => ({
          public_id: generatePublicId('webauthnCredential'),
          user_id: user.id,
          credential_id: generatePublicId('organization'),
          public_key: publicKey,
        })),
      )
      .returning();

    const steppedUp = await stepUpByEmailCode({ token, email: user.email });
    expect(steppedUp.statusCode, steppedUp.body).toBe(200);
    expect((steppedUp.json() as { data: unknown }).data).toEqual({
      stepped_up: true,
      factor: 'email_code',
    });

    const removed = await injectAuthenticated(app, {
      method: 'DELETE',
      url: testApiPath(`/auth/me/webauthn/credentials/${passkeys[0]!.public_id}`),
      token,
    });
    expect(removed.statusCode, removed.body).toBe(204);
  });

  it('AC-13.11: without 2FA, an email-code step-up removes Google and ends another session', async () => {
    const { user, token } = await personWithoutTwoFactor();
    const [google] = await getOperatorDatabase()
      .insert(auth_methods)
      .values({
        public_id: generatePublicId('authMethod'),
        user_id: user.id,
        method_type: 'OAUTH',
        provider: 'google',
        provider_user_id: 'google-user-1',
        verified_at: new Date(),
      })
      .returning();
    await getOperatorDatabase()
      .insert(auth_methods)
      .values({
        public_id: generatePublicId('authMethod'),
        user_id: user.id,
        method_type: 'EMAIL_CODE',
        verified_at: new Date(),
      });
    const other = await generateTestTokenAndSession({ userId: user.public_id });

    expect((await stepUpByEmailCode({ token, email: user.email })).statusCode).toBe(200);

    const removedGoogle = await injectAuthenticated(app, {
      method: 'DELETE',
      url: testApiPath(`/auth/me/auth-methods/${google!.public_id}`),
      token,
    });
    expect(removedGoogle.statusCode, removedGoogle.body).toBe(204);

    const endedSession = await injectAuthenticated(app, {
      method: 'DELETE',
      url: testApiPath(`/auth/me/sessions/${other.sessionPublicId}`),
      token,
    });
    expect(endedSession.statusCode, endedSession.body).toBe(204);
  });

  it('with settled 2FA the email code is refused: 403 mfa_step_up_required', async () => {
    const { user, token, sessionPublicId } = await personWithoutTwoFactor();
    await seedRecentStepUpForTestUser(user.public_id, sessionPublicId, 'mfa');
    await enrollTotp(token);
    await redisConnection.del(`step-up:${user.public_id}:${sessionPublicId}`);

    const refused = await stepUpByEmailCode({ token, email: user.email });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorOf(refused)?.reason).toBe('mfa_step_up_required');
  });

  it('with only a provisional factor the email code is still a strong step-up', async () => {
    const { user, token, sessionPublicId } = await personWithoutTwoFactor();
    await seedRecentStepUpForTestUser(user.public_id, sessionPublicId, 'email_code');
    await enrollTotp(token);

    const steppedUp = await stepUpByEmailCode({ token, email: user.email });
    expect(steppedUp.statusCode, steppedUp.body).toBe(200);

    const signedOutElsewhere = await injectAuthenticated(app, {
      method: 'DELETE',
      url: testApiPath('/auth/me/sessions'),
      token,
    });
    expect(signedOutElsewhere.statusCode, signedOutElsewhere.body).toBe(204);
  });

  it('a wrong code answers 401 code_wrong with the tries left; a password field is a 400', async () => {
    const { user, token } = await personWithoutTwoFactor();
    const wrong = await stepUpByEmailCode({ token, email: user.email, code: '000000' });
    expect(wrong.statusCode, wrong.body).toBe(401);
    expect(errorOf(wrong)).toMatchObject({ reason: 'code_wrong', tries_left: 4 });

    const password = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/step-up'),
      token,
      payload: { password: 'hunter2' },
    });
    expect(password.statusCode).toBe(400);
  });
});
