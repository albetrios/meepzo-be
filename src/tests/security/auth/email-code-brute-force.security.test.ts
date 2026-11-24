import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectUnauthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS } from '@/domains/auth/sub-domains/auth-method/verification-code.js';

/**
 * Online brute-force resistance for the passwordless email-code login.
 *
 * The verification code is a short, bounded string, so its ONLY defence against
 * an attacker who knows a victim's email is the per-user online attempt cap
 * (`VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS`) plus the short TTL and single-use
 * consume. The cap lives in the service on a Redis counter keyed by user id and
 * is security-critical, yet no HTTP-level test proved it engages — a refactor
 * that dropped the counter would keep every functional login test green while
 * reopening unlimited guessing. This locks it: the (N+1)th wrong code for one
 * email is rejected, and the rejection is the SAME generic 401 as a plain wrong
 * code (no "too many attempts" oracle that would confirm the account exists).
 */
describe('Security: email-code login online brute-force cap', () => {
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

  function attemptLogin(email: string, code: string) {
    return injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/email/login'),
      payload: { email, code },
    });
  }

  async function sendCode(email: string) {
    return injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/email/send-code'),
      payload: { email },
    });
  }

  it('rejects wrong codes past the per-code cap with the same answers for a known and an unknown email', async () => {
    const victim = await createTestUser({ email: 'brute-victim@example.com' });
    // Issue a real live code so the account is in the exact state a legitimate
    // login would face — the attacker just does not know the value.
    const sent = await sendCode(victim.email);
    const liveCode = (sent.json() as { data?: { debug_verification_code?: string } }).data
      ?.debug_verification_code;
    const wrongCode = liveCode === '000000' ? '111111' : '000000';

    /** The answer sequence of `cap + 1` wrong tries: status, reason and tries left. */
    async function burn(email: string) {
      const answers: Array<{ status: number; reason: unknown; tries_left: unknown }> = [];
      for (let attempt = 0; attempt < VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS + 1; attempt += 1) {
        const response = await attemptLogin(email, wrongCode);
        const error = (response.json() as { error?: Record<string, unknown> }).error ?? {};
        answers.push({
          status: response.statusCode,
          reason: error.reason,
          tries_left: error.tries_left,
        });
      }
      return answers;
    }

    const known = await burn(victim.email);
    // AT8: tries 1–4 are code_wrong with the tries left, the 5th and later code_used_up — all 401.
    expect(known.every((answer) => answer.status === 401)).toBe(true);
    expect(
      known.slice(0, VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS - 1).map((a) => a.tries_left),
    ).toEqual([4, 3, 2, 1]);
    expect(known.slice(VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS - 1).map((a) => a.reason)).toEqual([
      'code_used_up',
      'code_used_up',
    ]);
    // The counter is keyed by the email, so a stranger's email walks the identical sequence —
    // the used-up answer confirms nothing about whether the account exists.
    expect(await burn('brute-nobody@example.com')).toEqual(known);
  });

  it('applies the cap per-email — hammering one account does not lock out another', async () => {
    const victim = await createTestUser({ email: 'victim-a@example.com' });
    const bystander = await createTestUser({ email: 'victim-b@example.com' });
    await sendCode(victim.email);
    await sendCode(bystander.email);

    // Exhaust victim A's attempt budget entirely.
    for (let attempt = 0; attempt < VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS + 2; attempt += 1) {
      await attemptLogin(victim.email, '000000');
    }

    // Bystander B, untouched, still gets the normal generic 401 for a wrong code —
    // A's counter did not bleed onto B (the counter is keyed by the email, so a
    // shared/global counter regression would surface here as a premature reject).
    const bystanderResponse = await attemptLogin(bystander.email, '000000');
    expect(bystanderResponse.statusCode).toBe(401);
    expect((bystanderResponse.json() as { error?: { reason?: string } }).error?.reason).toBe(
      'code_wrong',
    );
  });
});
