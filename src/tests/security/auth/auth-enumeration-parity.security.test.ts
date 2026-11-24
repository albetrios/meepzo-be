import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectUnauthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { webauthn_credentials } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { InjectHttpResult } from '@/tests/helpers/test-http-inject.helper.js';

/**
 * Account-enumeration resistance for the public auth surface.
 *
 * The service layer is already built to not leak account existence — the email-code sign-in
 * answers an unknown email exactly like a wrong code (`401 code_wrong` with the same `tries_left`,
 * the per-code try counter is keyed by the email, AT8), and send-code returns one generic response
 * for both. Passwords are off (P84), so there is no password login or forgot-password to compare.
 * Those are security-critical invariants with no HTTP-level regression guard:
 * the legacy login test even permitted a 404 for an unknown email. This suite
 * locks the parity so a future refactor cannot reintroduce an oracle.
 */
function responseData(response: InjectHttpResult): unknown {
  // Success envelope is `{ data, meta: { request_id } }`; meta carries per-request-volatile fields,
  // so the enumeration-relevant content is `data`. Under TEST_MODE the send-code `data` also carries
  // `debug_verification_code` — a fresh random code echoed for BOTH known and unknown emails
  // (auto-signup issues a code either way), so its PRESENCE is not an existence oracle; only its VALUE
  // churns. Normalise the value (but KEEP the key) so this equality check still catches a
  // presence-mismatch oracle while ignoring the expected value churn. The field never appears outside
  // TEST_MODE (a `.refine()` forbids `TEST_MODE=true` in production), so real responses are identical.
  const body = response.json() as { data?: Record<string, unknown> } | undefined;
  const data = body?.data;
  if (data && typeof data === 'object' && 'debug_verification_code' in data) {
    return { ...data, debug_verification_code: '<test-mode-code>' };
  }
  return data;
}

describe('Security: auth account-enumeration resistance', () => {
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

  function emailLogin(email: string, code: string) {
    return injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/email/login'),
      payload: { email, code },
    });
  }

  /** The enumeration-relevant part of an error answer: status, reason, tries left, detail. */
  function refusal(response: InjectHttpResult) {
    const error = (response.json() as { error?: Record<string, unknown> }).error ?? {};
    return {
      status: response.statusCode,
      reason: error.reason,
      tries_left: error.tries_left,
      detail: error.detail,
    };
  }

  function sendEmailCode(email: string) {
    return injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/email/send-code'),
      payload: { email },
    });
  }

  it('AC-13.3: an unknown email answers code_wrong exactly like a wrong code for a known one', async () => {
    await createTestUser({ email: 'enumeration-known@example.com', isEmailVerified: true });
    // The known account has a live code; the stranger's email never had one.
    const sent = await sendEmailCode('enumeration-known@example.com');
    const liveCode = (responseData(sent) as { debug_verification_code?: string })
      .debug_verification_code;
    const wrongCode = liveCode === '000000' ? '111111' : '000000';

    const wrongForKnown = await emailLogin('enumeration-known@example.com', wrongCode);
    const unknownEmail = await emailLogin('enumeration-absent@example.com', wrongCode);

    expect(refusal(wrongForKnown)).toMatchObject({
      status: 401,
      reason: 'code_wrong',
      tries_left: 4,
    });
    expect(refusal(unknownEmail)).toEqual(refusal(wrongForKnown));
  });

  it('email/send-code: known and unknown emails return an identical generic response (AC-13.2)', async () => {
    await createTestUser({
      email: 'enumeration-magic@example.com',
      isEmailVerified: true,
    });

    const known = await sendEmailCode('enumeration-magic@example.com');
    const unknown = await sendEmailCode('enumeration-magic-absent@example.com');

    expect(known.statusCode).toBe(unknown.statusCode);
    expect(responseData(unknown)).toEqual(responseData(known));
  });
  it('webauthn/authenticate/options: a multi-passkey account and an unknown email get the same options shape', async () => {
    // Real accounts used to list every stored credential with its transports while decoys listed
    // exactly one `internal` descriptor — count and transports told enrolled accounts apart.
    const user = await createTestUser({
      email: 'enumeration-passkeys@example.com',
      isEmailVerified: true,
    });
    await getOperatorDatabase()
      .insert(webauthn_credentials)
      .values([
        {
          public_id: generatePublicId('authMethod'),
          user_id: user.id,
          credential_id: 'enumeration-credential-usb',
          public_key: 'cHVibGljLWtleS1h',
          transports: ['usb', 'nfc'],
        },
        {
          public_id: generatePublicId('authMethod'),
          user_id: user.id,
          credential_id: 'enumeration-credential-hybrid',
          public_key: 'cHVibGljLWtleS1i',
          transports: ['hybrid'],
        },
      ]);

    const passkeyOptions = (email: string) =>
      injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/webauthn/authenticate/options'),
        payload: { email },
      });
    const enrolled = await passkeyOptions('enumeration-passkeys@example.com');
    const unknown = await passkeyOptions('enumeration-passkeys-absent@example.com');

    expect(enrolled.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(enrolled.statusCode);
    type OptionsData = { options: Record<string, unknown>; challenge_token: string };
    const enrolledData = (enrolled.json() as { data: OptionsData }).data;
    const unknownData = (unknown.json() as { data: OptionsData }).data;
    // No per-account descriptors at all, and every field but the random challenge is equal.
    expect(enrolledData.options).not.toHaveProperty('allowCredentials');
    expect(unknownData.options).not.toHaveProperty('allowCredentials');
    const { challenge: _enrolledChallenge, ...enrolledRest } = enrolledData.options;
    const { challenge: _unknownChallenge, ...unknownRest } = unknownData.options;
    expect(enrolledRest).toEqual(unknownRest);
    expect(Object.keys(enrolledData).sort()).toEqual(Object.keys(unknownData).sort());
  });
});
