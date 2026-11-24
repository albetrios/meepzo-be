import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateTestTokenAndSession, signInWithEmailCode } from '@/tests/helpers/test-auth.js';
import { seedRecentStepUpForTestUser } from '@/tests/helpers/test-step-up.helper.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { auth_methods } from '@/domains/auth/sub-domains/auth-method/auth-method.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { FastifyInstance } from 'fastify';

describe('Auth Method Sub-Domain — Integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  describe('POST /api/v1/auth/email/login', () => {
    it('should return 400 for missing credentials', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/email/login'),
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('should return 200 for the right code', async () => {
      const user = await createTestUser();
      const response = await signInWithEmailCode(app, { email: user.email });
      expect(response.statusCode).toBe(200);
      expect(
        (response.json() as { data?: { access_token?: string } }).data?.access_token,
      ).toBeDefined();
    });
  });

  describe('POST /api/v1/auth/email/send-code', () => {
    it('should accept an email code send request', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/email/send-code'),
        payload: { email: 'email-code-integration@test.com' },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/auth/oauth/:provider', () => {
    it('returns the provider authorize redirect URL (200)', async () => {
      // setup.ts pins fake OAuth client credentials, so the authorize URL is
      // built deterministically (pure string work, no outbound call).
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath('/auth/oauth/google'),
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = (response.json() as { data: { redirect_url?: string } }).data;
      expect(body.redirect_url).toContain('accounts.google.com');
    });
  });

  describe('self-service auth-method management', () => {
    it('AC-13.4: the email-code way can never be removed — 409 email_code_always_on; another way can', async () => {
      const user = await createTestUser();
      const { token, sessionPublicId } = await generateTestTokenAndSession({
        userId: user.public_id,
      });
      // Removing a way in is destructive: it needs a strong step-up (MFA until R32 makes the email
      // code strong for a person without 2FA).
      await seedRecentStepUpForTestUser(user.public_id, sessionPublicId, 'mfa');

      // EMAIL_CODE is the only type this endpoint may create (route-#3).
      const create = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/me/auth-methods'),
        token,
        payload: { method_type: 'EMAIL_CODE' },
      });
      expect(create.statusCode, create.body).toBe(200);
      const created = (create.json() as { data: { id?: string; public_id?: string } }).data;
      const emailCodePublicId = created.id ?? created.public_id;
      expect(emailCodePublicId).toBeTypeOf('string');

      const refused = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/auth/me/auth-methods/${emailCodePublicId}`),
        token,
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ error: { reason: 'email_code_always_on' } });

      // Another way in (here a linked OAuth account) is removed while the email code stays.
      const oauthPublicId = generatePublicId('authMethod');
      await getOperatorDatabase()
        .insert(auth_methods)
        .values({
          public_id: oauthPublicId,
          user_id: user.id,
          method_type: 'OAUTH',
          provider: 'google',
          provider_user_id: `google-${user.public_id}`,
          verified_at: new Date(),
        });
      const remove = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/auth/me/auth-methods/${oauthPublicId}`),
        token,
      });
      expect(remove.statusCode, remove.body).toBe(204);
    });
  });
});
