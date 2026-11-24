import { describe, expect, it } from 'vitest';
import {
  buildIdempotencyRequestFingerprint,
  isIdempotencyRouteExcluded,
  responseBodyContainsSecretFields,
} from '@/shared/utils/idempotency/idempotency-fingerprint.util.js';

describe('buildIdempotencyRequestFingerprint', () => {
  it('differs when method, route, or body change', () => {
    const base = buildIdempotencyRequestFingerprint({
      method: 'POST',
      routePath: '/organizations',
      body: { name: 'A' },
    });
    const differentMethod = buildIdempotencyRequestFingerprint({
      method: 'PUT',
      routePath: '/organizations',
      body: { name: 'A' },
    });
    const differentRoute = buildIdempotencyRequestFingerprint({
      method: 'POST',
      routePath: '/api/v1/tenancy/organization/memberships',
      body: { name: 'A' },
    });
    const differentBody = buildIdempotencyRequestFingerprint({
      method: 'POST',
      routePath: '/organizations',
      body: { name: 'B' },
    });
    expect(differentMethod).not.toBe(base);
    expect(differentRoute).not.toBe(base);
    expect(differentBody).not.toBe(base);
  });
});

describe('buildIdempotencyRequestFingerprint — the concrete record (G2-6)', () => {
  const routePath = '/api/v1/tenancy/organization/roles/:role_id';
  const body = { name: 'Same body' };

  it('differs when the same template and body target another record', () => {
    const roleA = buildIdempotencyRequestFingerprint({
      method: 'PATCH',
      routePath,
      pathParameters: { role_id: 'role_A' },
      body,
    });
    const roleB = buildIdempotencyRequestFingerprint({
      method: 'PATCH',
      routePath,
      pathParameters: { role_id: 'role_B' },
      body,
    });
    expect(roleB).not.toBe(roleA);
  });

  it('is stable across path-parameter key order', () => {
    const first = buildIdempotencyRequestFingerprint({
      method: 'PATCH',
      routePath: '/api/v1/notify/webhooks/:webhook_id/delivery-attempts/:delivery_attempt_id',
      pathParameters: { webhook_id: 'whk_A', delivery_attempt_id: 'attempt_A' },
      body,
    });
    const reordered = buildIdempotencyRequestFingerprint({
      method: 'PATCH',
      routePath: '/api/v1/notify/webhooks/:webhook_id/delivery-attempts/:delivery_attempt_id',
      pathParameters: { delivery_attempt_id: 'attempt_A', webhook_id: 'whk_A' },
      body,
    });
    expect(reordered).toBe(first);
  });

  it('fingerprints a route without path parameters exactly as before', () => {
    const withoutParameters = buildIdempotencyRequestFingerprint({
      method: 'POST',
      routePath: '/api/v1/tenancy/organization/roles',
      body,
    });
    const withEmptyParameters = buildIdempotencyRequestFingerprint({
      method: 'POST',
      routePath: '/api/v1/tenancy/organization/roles',
      pathParameters: {},
      body,
    });
    expect(withEmptyParameters).toBe(withoutParameters);
  });
});

describe('isIdempotencyRouteExcluded', () => {
  // Matched against the full prefixed Fastify route template (request.routeOptions.url), e.g.
  // `/api/v1/auth/email/login` — the patterns are suffix-anchored so the /api/v{n} prefix is irrelevant.
  it('excludes auth token issuance and api-key creation routes', () => {
    expect(isIdempotencyRouteExcluded('/api/v1/auth/email/login')).toBe(true);
    expect(isIdempotencyRouteExcluded('/api/v1/auth/mfa/login')).toBe(true);
    expect(isIdempotencyRouteExcluded('/api/v1/auth/oauth/google/callback')).toBe(true);
    expect(isIdempotencyRouteExcluded('/api/v1/auth/webauthn/authenticate/verify')).toBe(true);
    expect(isIdempotencyRouteExcluded('/api/v1/auth/refresh')).toBe(true);
    expect(isIdempotencyRouteExcluded('/api/v1/tenancy/organization/api-keys')).toBe(true);
  });

  it('does not exclude account-level or non-issuance routes', () => {
    expect(isIdempotencyRouteExcluded('/api/v1/tenancy/organizations')).toBe(false);
    expect(isIdempotencyRouteExcluded('/api/v1/tenancy/organization/memberships')).toBe(false);
    expect(isIdempotencyRouteExcluded('/api/v1/billing/subscriptions')).toBe(false);
  });
});

describe('responseBodyContainsSecretFields', () => {
  it('detects token and raw key fields in JSON responses', () => {
    expect(
      responseBodyContainsSecretFields(
        JSON.stringify({ data: { access_token: 'jwt', session_public_id: 'sess' } }),
      ),
    ).toBe(true);
    expect(responseBodyContainsSecretFields(JSON.stringify({ data: { raw_key: 'ak_abc' } }))).toBe(
      true,
    );
    expect(
      responseBodyContainsSecretFields(JSON.stringify({ data: { id: 'org-1', name: 'Acme' } })),
    ).toBe(false);
  });

  it('route-audit-#3: flags recovery codes and presigned-URL fields (no-store + no idempotency cache)', () => {
    // MFA recovery codes — plaintext single-use MFA-bypass material.
    expect(
      responseBodyContainsSecretFields(
        JSON.stringify({ data: { recovery_codes: ['ABCD-1234'], method_public_id: 'm1' } }),
      ),
    ).toBe(true);
    // GDPR data-export presigned download URL (carries X-Amz-Signature).
    expect(
      responseBodyContainsSecretFields(
        JSON.stringify({ data: { download_url: 'https://s3/...' } }),
      ),
    ).toBe(true);
    // Upload presign URL.
    expect(
      responseBodyContainsSecretFields(JSON.stringify({ data: { upload_url: 'https://s3/...' } })),
    ).toBe(true);
  });

  it('C-5: flags the signed media URLs', () => {
    for (const field of ['file_url', 'thumbnail_url']) {
      expect(
        responseBodyContainsSecretFields(
          JSON.stringify({ data: { [field]: 'https://s3/key?X-Amz-Signature=abc' } }),
        ),
      ).toBe(true);
    }
  });

  it('launch IA5: flags the Instagram token ciphertext (never cached, never stored)', () => {
    expect(
      responseBodyContainsSecretFields(
        JSON.stringify({ data: { instagram_account: { encrypted_access_token: 'v1:abc' } } }),
      ),
    ).toBe(true);
    expect(
      responseBodyContainsSecretFields('<<<not json "encrypted_access_token": "v1:abc" >>>'),
    ).toBe(true);
  });

  it('sec-C/M #12: catches sensitive fields via the isSensitiveKey backstop (beyond the named allowlist)', () => {
    // Fields NOT in IDEMPOTENCY_SECRET_RESPONSE_FIELD_NAMES but caught by the substring matcher.
    expect(responseBodyContainsSecretFields(JSON.stringify({ data: { client_secret: 's' } }))).toBe(
      true,
    );
    expect(responseBodyContainsSecretFields(JSON.stringify({ data: { csrf_token: 't' } }))).toBe(
      true,
    );
    expect(responseBodyContainsSecretFields(JSON.stringify({ data: { password: 'p' } }))).toBe(
      true,
    );
  });

  // Launch D38: the logs hide a contact's personal data, but it is not a secret — a response
  // carrying it is cached and a repeated key replays it (route 1's answer holds `username`, D35).
  it('caches a response that carries personal data only: username, phone, full name, picture', () => {
    const contact = {
      id: 'con_p3k8w2m9x4r7n1v5a1b2c',
      username: 'jordan.lee',
      phone: '+15550100123',
      full_name: 'Jordan Lee',
      profile_picture_url: 'https://cdn.example.com/jordan.jpg',
    };
    expect(responseBodyContainsSecretFields(JSON.stringify({ data: contact }))).toBe(false);
    expect(
      responseBodyContainsSecretFields(
        JSON.stringify({ data: { instagram_account: { username: 'acme.shop' } } }),
      ),
    ).toBe(false);
  });

  // Launch D40: an email address is personal data too — an automation's create answer carries
  // `is_email_collection_enabled` and `email_request_message` and must replay (AC-5.3).
  it('caches a response that carries an email or an email-named field', () => {
    expect(
      responseBodyContainsSecretFields(
        JSON.stringify({ data: { email: 'jordan.lee@example.com', is_email_verified: true } }),
      ),
    ).toBe(false);
    expect(
      responseBodyContainsSecretFields(
        JSON.stringify({
          data: {
            id: 'aut_m4q8x2k7p9r3t1v5a1b2c',
            is_email_collection_enabled: true,
            email_request_message: { text: 'Your email?' },
          },
        }),
      ),
    ).toBe(false);
    expect(
      responseBodyContainsSecretFields(
        JSON.stringify({ data: { email: 'jordan.lee@example.com', access_token: 'leak' } }),
      ),
    ).toBe(true);
  });

  it('still never caches a response with an access token or a secret beside personal data', () => {
    expect(
      responseBodyContainsSecretFields(
        JSON.stringify({ data: { username: 'jordan.lee', access_token: 'leak' } }),
      ),
    ).toBe(true);
    expect(
      responseBodyContainsSecretFields(
        JSON.stringify({ data: { full_name: 'Jordan Lee', client_secret: 's' } }),
      ),
    ).toBe(true);
  });

  it('fails closed via a substring scan when the response body is not valid JSON', () => {
    // The onSend hook can encounter a non-JSON body; the parse-failure branch must still detect
    // secret-bearing fields rather than caching them.
    expect(responseBodyContainsSecretFields('<<<not json "access_token": "leak" >>>')).toBe(true);
    expect(responseBodyContainsSecretFields('totally benign plaintext response')).toBe(false);
  });
});
