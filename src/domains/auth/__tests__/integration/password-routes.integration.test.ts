import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { hashPassword } from '@/shared/utils/security/password.util.js';
import { users } from '@/domains/user/user.schema.js';
import { verification_tokens } from '@/domains/auth/sub-domains/auth-method/verification-token/verification-token.schema.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { generateTestTokenAndSession } from '@/tests/helpers/test-auth.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { seedRecentStepUpForTestUser } from '@/tests/helpers/test-step-up.helper.js';

/**
 * PASSWORD-ROUTES-DISABLED — the four password routes (RC-98–RC-101) are kept disabled behind
 * `PASSWORD_ROUTES_ENABLED` instead of removed (owner instruction 2026-11-25, P251). Off → not
 * registered (404); on → the restored R30-era behaviour (the old `auth.test.ts` password cases,
 * adapted: a password is set through the operator connection, since no route creates one).
 */

const PASSWORD_ROUTES = [
  {
    method: 'POST' as const,
    path: '/auth/login',
    payload: { email: 'a@example.com', password: 'x' },
  },
  { method: 'POST' as const, path: '/auth/password/forgot', payload: { email: 'a@example.com' } },
  {
    method: 'POST' as const,
    path: '/auth/password/reset',
    payload: { token: 't', password: 'NewSecurePassword123!' },
  },
  {
    method: 'POST' as const,
    path: '/auth/password/change',
    payload: { current_password: 'a', new_password: 'NewSecurePassword123!' },
  },
];

const KNOWN_PASSWORD = 'TestPassword123!';

/** Creates an active user whose `password_hash` holds {@link KNOWN_PASSWORD}. */
async function createUserWithPassword(options: { isEmailVerified?: boolean } = {}) {
  const user = await createTestUser(options);
  await getOperatorDatabase()
    .update(users)
    .set({ password_hash: await hashPassword(KNOWN_PASSWORD) })
    .where(eq(users.id, user.id));
  return user;
}

async function withPasswordRoutesFlag<Result>(
  value: 'true' | 'false',
  callback: () => Promise<Result>,
): Promise<Result> {
  const previous = process.env.PASSWORD_ROUTES_ENABLED;
  process.env.PASSWORD_ROUTES_ENABLED = value;
  resetEnvCacheForTests();
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.PASSWORD_ROUTES_ENABLED;
    else process.env.PASSWORD_ROUTES_ENABLED = previous;
    resetEnvCacheForTests();
  }
}

describe('password routes — PASSWORD_ROUTES_ENABLED=false (the default)', () => {
  let application: FastifyInstance;

  beforeAll(async () => {
    application = await withPasswordRoutesFlag('false', async () => (await createTestApp()).app);
  });

  afterAll(async () => {
    await application.close();
  });

  for (const route of PASSWORD_ROUTES) {
    it(`${route.method} ${route.path} is not registered (404)`, async () => {
      const user = await createTestUser();
      const { token } = await generateTestTokenAndSession({ userId: user.public_id });
      const unauthenticated = await injectUnauthenticated(application, {
        method: route.method,
        url: testApiPath(route.path),
        payload: route.payload,
      });
      expect(unauthenticated.statusCode).toBe(404);
      const authenticated = await injectAuthenticated(application, {
        method: route.method,
        url: testApiPath(route.path),
        token,
        payload: route.payload,
      });
      expect(authenticated.statusCode).toBe(404);
    });
  }

  it('the email-code sign-in stays registered', async () => {
    const response = await injectUnauthenticated(application, {
      method: 'POST',
      url: testApiPath('/auth/email/login'),
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('password routes — PASSWORD_ROUTES_ENABLED=true', () => {
  let application: FastifyInstance;

  beforeAll(async () => {
    application = await withPasswordRoutesFlag('true', async () => (await createTestApp()).app);
  });

  afterAll(async () => {
    await application.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  describe('POST /api/v1/auth/login', () => {
    it('returns 400 for missing credentials', async () => {
      const response = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 401 for an unknown email', async () => {
      const response = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: { email: 'nonexistent@example.com', password: 'wrong-password' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 401 for an account with no password (every hash was emptied by auth_passwords_off)', async () => {
      const user = await createTestUser();
      const response = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: { email: user.email, password: KNOWN_PASSWORD },
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 401 for a wrong password and counts the failure', async () => {
      const user = await createUserWithPassword();
      const response = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: { email: user.email, password: 'WrongPassword999!' },
      });
      expect(response.statusCode).toBe(401);
      const [row] = await getOperatorDatabase()
        .select({ failed_login_count: users.failed_login_count })
        .from(users)
        .where(eq(users.id, user.id));
      expect(row?.failed_login_count).toBe(1);
    });

    it('signs in with the right password: access token + session cookie', async () => {
      const user = await createUserWithPassword();
      const response = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: { email: user.email, password: KNOWN_PASSWORD },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect((response.json() as { data: Record<string, unknown> }).data).toHaveProperty(
        'access_token',
      );
      expect(String(response.headers['set-cookie'])).toContain('session_id=');
    });

    it('refuses a suspended account a session', async () => {
      const user = await createUserWithPassword();
      await getOperatorDatabase()
        .update(users)
        .set({ status: 'SUSPENDED' })
        .where(eq(users.id, user.id));
      const response = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: { email: user.email, password: KNOWN_PASSWORD },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/auth/password/forgot', () => {
    it('returns 400 for a missing email', async () => {
      const response = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/password/forgot'),
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('answers the same for a known and an unknown email, and issues a reset token for the known one', async () => {
      const user = await createUserWithPassword();
      const existing = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/password/forgot'),
        payload: { email: user.email },
      });
      const missing = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/password/forgot'),
        payload: { email: 'nobody@nonexistent.example.com' },
      });
      expect(existing.statusCode, existing.body).toBe(200);
      expect(missing.statusCode, missing.body).toBe(200);
      const existingData = (existing.json() as { data: Record<string, unknown> }).data;
      expect(existingData.message).toBeTypeOf('string');
      expect((missing.json() as { data: Record<string, unknown> }).data).toEqual(existingData);
      const tokens = await getOperatorDatabase()
        .select({ id: verification_tokens.id })
        .from(verification_tokens)
        .where(
          and(
            eq(verification_tokens.user_id, user.id),
            eq(verification_tokens.token_type, 'PASSWORD_RESET'),
          ),
        );
      expect(tokens).toHaveLength(1);
    });
  });

  describe('POST /api/v1/auth/password/reset', () => {
    it('returns 400 for a missing token/password', async () => {
      const response = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/password/reset'),
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 401 for an invalid reset token', async () => {
      const response = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/password/reset'),
        payload: { token: 'invalid-token-value', password: 'NewSecurePassword123!' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('resets with a valid token, signs in, and the new password logs in', async () => {
      // A user with no password at all (the state auth_passwords_off left) can set one by reset.
      const user = await createTestUser();
      const rawToken = randomBytes(32).toString('hex');
      await getOperatorDatabase()
        .insert(verification_tokens)
        .values({
          token_type: 'PASSWORD_RESET',
          token_hash: createHash('sha256').update(rawToken).digest('hex'),
          user_id: user.id,
          email: user.email,
          expires_at: new Date(Date.now() + 3_600_000),
        });

      const newPassword = 'BrandNewPassword456!';
      const resetResponse = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/password/reset'),
        payload: { token: rawToken, password: newPassword },
      });
      expect(resetResponse.statusCode, resetResponse.body).toBe(200);
      expect((resetResponse.json() as { data: Record<string, unknown> }).data).toHaveProperty(
        'access_token',
      );

      const replay = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/password/reset'),
        payload: { token: rawToken, password: newPassword },
      });
      expect(replay.statusCode).toBe(401);

      const loginResponse = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: { email: user.email, password: newPassword },
      });
      expect(loginResponse.statusCode, loginResponse.body).toBe(200);
    });
  });

  describe('POST /api/v1/auth/password/change', () => {
    it('returns 401 without authentication', async () => {
      const response = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/password/change'),
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 without a recent step-up', async () => {
      const user = await createUserWithPassword();
      const { token } = await generateTestTokenAndSession({ userId: user.public_id });
      const response = await injectAuthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/password/change'),
        token,
        payload: { current_password: KNOWN_PASSWORD, new_password: 'ChangedPassword789!' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 401 for a wrong current password', async () => {
      const user = await createUserWithPassword();
      const { token, sessionPublicId } = await generateTestTokenAndSession({
        userId: user.public_id,
      });
      await seedRecentStepUpForTestUser(user.public_id, sessionPublicId);
      const response = await injectAuthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/password/change'),
        token,
        payload: { current_password: 'WrongPassword999!', new_password: 'ChangedPassword789!' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('changes the password after a step-up; the new one logs in and the old one no longer does', async () => {
      const user = await createUserWithPassword();
      const { token, sessionPublicId } = await generateTestTokenAndSession({
        userId: user.public_id,
      });
      await seedRecentStepUpForTestUser(user.public_id, sessionPublicId);
      const newPassword = 'ChangedPassword789!';
      const response = await injectAuthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/password/change'),
        token,
        payload: { current_password: KNOWN_PASSWORD, new_password: newPassword },
      });
      expect(response.statusCode, response.body).toBe(200);

      const loginResponse = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: { email: user.email, password: newPassword },
      });
      expect(loginResponse.statusCode).toBe(200);
      const oldPasswordLogin = await injectUnauthenticated(application, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: { email: user.email, password: KNOWN_PASSWORD },
      });
      expect(oldPasswordLogin.statusCode).toBe(401);
    });
  });
});
