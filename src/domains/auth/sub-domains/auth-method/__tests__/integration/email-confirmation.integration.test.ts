import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { captureNextEmailConfirmToken } from '@/tests/helpers/verification-code.helper.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { users } from '@/domains/user/user.schema.js';
import { verification_tokens } from '@/domains/auth/sub-domains/auth-method/verification-token/verification-token.schema.js';
import { mail_outbox } from '@/infrastructure/mail/mail-outbox.schema.js';

type ErrorBody = {
  error: { reason?: string; retry_after_seconds?: number; errors?: { field: string }[] };
};

/**
 * Confirm your email (feat-instagram-dm-sending § 11.B, routes 133–134, AC-14.4): asking for a link
 * emails one; asking again within 60 s is 429 with its wait; the link's token confirms the email
 * once; an unknown, spent or expired token is 400; a person a code sign-in already confirmed gets
 * the same success.
 */
describe('Confirm your email — POST /users/me/email-confirmation, POST /auth/email/confirm', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = (await createTestApp()).app;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function newUnconfirmedPerson() {
    const user = await createTestUser({ isEmailVerified: false });
    const token = await generateTestToken({ userId: user.public_id });
    return { user, token };
  }

  async function requestLink(token: string, payload?: unknown) {
    return injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/users/me/email-confirmation'),
      token,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function confirm(linkToken: unknown) {
    return injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/email/confirm'),
      payload: { token: linkToken },
    });
  }

  async function isEmailVerified(userId: number): Promise<boolean> {
    const [row] = await getOperatorDatabase()
      .select({ is_email_verified: users.is_email_verified })
      .from(users)
      .where(eq(users.id, userId));
    return row!.is_email_verified;
  }

  it('emails a link that confirms the email once; the spent link is then refused', async () => {
    const { user, token } = await newUnconfirmedPerson();
    const linkTokenPromise = captureNextEmailConfirmToken(user.email);

    const sent = await requestLink(token);
    expect(sent.statusCode, sent.body).toBe(200);
    const sentData = (sent.json() as { data: { resend_after_seconds: number; expires_at: string } })
      .data;
    expect(sentData.resend_after_seconds).toBe(60);
    const hoursLeft = (Date.parse(sentData.expires_at) - Date.now()) / 3_600_000;
    expect(hoursLeft).toBeGreaterThan(23.9);
    expect(hoursLeft).toBeLessThanOrEqual(24);

    const linkToken = await linkTokenPromise;
    // Only the hash is stored, never the token.
    const [stored] = await getOperatorDatabase()
      .select()
      .from(verification_tokens)
      .where(
        and(
          eq(verification_tokens.user_id, user.id),
          eq(verification_tokens.token_type, 'EMAIL_CONFIRM'),
        ),
      );
    expect(stored!.token_hash).not.toBe(linkToken);
    expect(stored!.token_hash).toHaveLength(64);
    // The email went to the mail outbox with the link.
    const [mail] = await getOperatorDatabase()
      .select({ html: mail_outbox.html, to_addresses: mail_outbox.to_addresses })
      .from(mail_outbox)
      .where(sql`${mail_outbox.to_addresses} @> ${JSON.stringify([user.email])}::jsonb`)
      .orderBy(desc(mail_outbox.created_at))
      .limit(1);
    expect(mail?.html).toContain(`/confirm-email?token=${linkToken}`);

    const confirmed = await confirm(linkToken);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect((confirmed.json() as { data: unknown }).data).toEqual({ is_email_verified: true });
    expect(await isEmailVerified(user.id)).toBe(true);

    const again = await confirm(linkToken);
    expect(again.statusCode).toBe(400);
    expect((again.json() as ErrorBody).error.reason).toBe('email_confirm_token_invalid');
  });

  it('refuses a new link within 60 seconds with its wait', async () => {
    const { user, token } = await newUnconfirmedPerson();
    const linkTokenPromise = captureNextEmailConfirmToken(user.email);
    expect((await requestLink(token)).statusCode).toBe(200);
    await linkTokenPromise;

    const tooSoon = await requestLink(token);
    expect(tooSoon.statusCode).toBe(429);
    const body = tooSoon.json() as ErrorBody;
    expect(body.error.reason).toBe('email_confirmation_resend_too_soon');
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
    expect(body.error.retry_after_seconds).toBeLessThanOrEqual(60);
    expect(Number(tooSoon.headers['retry-after'])).toBe(body.error.retry_after_seconds);
  });

  it('a new link after the wait ends the previous one', async () => {
    const { user, token } = await newUnconfirmedPerson();
    const firstPromise = captureNextEmailConfirmToken(user.email);
    expect((await requestLink(token, {})).statusCode).toBe(200);
    const firstLink = await firstPromise;
    // Age the first link past the 60 s wait.
    await getOperatorDatabase()
      .update(verification_tokens)
      .set({ created_at: new Date(Date.now() - 61_000) })
      .where(eq(verification_tokens.user_id, user.id));

    const secondPromise = captureNextEmailConfirmToken(user.email);
    expect((await requestLink(token)).statusCode).toBe(200);
    const secondLink = await secondPromise;

    expect((await confirm(firstLink)).statusCode).toBe(400);
    expect((await confirm(secondLink)).statusCode).toBe(200);
  });

  it('refuses an expired link (older than 24 hours)', async () => {
    const { user, token } = await newUnconfirmedPerson();
    const linkTokenPromise = captureNextEmailConfirmToken(user.email);
    expect((await requestLink(token)).statusCode).toBe(200);
    const linkToken = await linkTokenPromise;
    await getOperatorDatabase()
      .update(verification_tokens)
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where(eq(verification_tokens.user_id, user.id));

    const response = await confirm(linkToken);
    expect(response.statusCode).toBe(400);
    expect((response.json() as ErrorBody).error.reason).toBe('email_confirm_token_invalid');
    expect(await isEmailVerified(user.id)).toBe(false);
  });

  it('a click after a code sign-in confirmed the email succeeds with nothing to change', async () => {
    const { user, token } = await newUnconfirmedPerson();
    const linkTokenPromise = captureNextEmailConfirmToken(user.email);
    expect((await requestLink(token)).statusCode).toBe(200);
    const linkToken = await linkTokenPromise;
    await getOperatorDatabase()
      .update(users)
      .set({ is_email_verified: true })
      .where(eq(users.id, user.id));

    const response = await confirm(linkToken);
    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as { data: unknown }).data).toEqual({ is_email_verified: true });
  });

  it('refuses an unknown token with 400 email_confirm_token_invalid', async () => {
    const response = await confirm('not-a-real-confirm-token');
    expect(response.statusCode).toBe(400);
    const body = response.json() as ErrorBody;
    expect(body.error.reason).toBe('email_confirm_token_invalid');
    expect(body.error.errors?.[0]?.field).toBe('token');
  });

  it('validates the confirm body (400): token missing, empty, too long, extra field', async () => {
    for (const payload of [
      {},
      { token: '' },
      { token: 'x'.repeat(513) },
      { token: 'abc', extra: true },
    ]) {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/email/confirm'),
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('refuses a link request when the email is already confirmed (409)', async () => {
    const user = await createTestUser({ isEmailVerified: true });
    const token = await generateTestToken({ userId: user.public_id });
    const response = await requestLink(token);
    expect(response.statusCode).toBe(409);
    expect((response.json() as ErrorBody).error.reason).toBe('email_already_confirmed');
  });

  it('refuses a link request with a body field (400) and without a bearer (401)', async () => {
    const { token } = await newUnconfirmedPerson();
    expect((await requestLink(token, { email: 'someone@example.com' })).statusCode).toBe(400);

    const anonymous = await injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/users/me/email-confirmation'),
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
