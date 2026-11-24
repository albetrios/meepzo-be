import { describe, expect, it } from 'vitest';
import { loadRouteRegistryFromCatalog } from '@/tests/helpers/route-catalog-registry.js';

/**
 * Public-route allowlist pin.
 *
 * The set of unauthenticated (`PUBLIC`) routes must EXACTLY match the hand-maintained
 * allowlist below. A new route accidentally registered without authentication — or
 * authentication silently dropped from an existing route — changes the `PUBLIC` set in
 * `docs/routes.txt` and fails this test. Combined with `routes:catalog:check` (which keeps
 * the catalog in sync with the actual route registrations), this makes "exposing a route
 * to the public internet" a deliberate, reviewed decision rather than an accident.
 *
 * To intentionally add or remove a public route, update `EXPECTED_PUBLIC_ROUTES` in the
 * same change — the diff is the audit record.
 */

// Keep sorted (`METHOD path`) for readable diffs. Every entry is an unauthenticated route.
const EXPECTED_PUBLIC_ROUTES: readonly string[] = [
  // Liveness / readiness probes (no body, no secrets).
  'GET /livez',
  'GET /readyz',
  // Auth — unauthenticated credential / token issuance, OAuth, and passkey login.
  // Logout is intentionally excluded: the route skips app.authenticate to allow expired-token
  // revocation, but the handler still requires an Authorization bearer token.
  'GET /api/v1/auth/oauth/:provider',
  'GET /api/v1/auth/oauth/:provider/callback',
  'GET /api/v1/auth/oauth/providers',
  'POST /api/v1/auth/email/confirm',
  'POST /api/v1/auth/email/login',
  'POST /api/v1/auth/email/send-code',
  'POST /api/v1/auth/mfa/login',
  'POST /api/v1/auth/webauthn/authenticate/options',
  'POST /api/v1/auth/webauthn/authenticate/verify',
  // Billing — public plan catalog + Stripe-signature-verified webhook ingress
  // (`/billing/webhook` sits behind the raw-body HMAC verification preHandler, and a request without
  // its signature header is refused before the body is read; see stripe-webhook.routes.ts).
  'GET /api/v1/billing/plans',
  'GET /api/v1/billing/plans/:plan_id',
  'POST /api/v1/billing/webhook',
  // App — Meta's Instagram deauthorize and data-deletion callbacks (launch routes 7–8): no JWT,
  // Meta's form-encoded `signed_request` is HMAC-verified with the Instagram app secret before the
  // handler (instagram-account-meta-callback-ingress.plugin.ts).
  'POST /api/v1/app/social/instagram/data-deletion',
  'POST /api/v1/app/social/instagram/deauthorize',
  // App — Meta's Instagram webhook (routes-final § 4.A): the subscription check is proved by the
  // verify token (constant time), the delivery by `X-Hub-Signature-256` over the raw body
  // (instagramWebhookIngressPlugin, before anything is parsed); see instagram-webhook.routes.ts.
  'GET /api/v1/app/social/instagram/webhook',
  'POST /api/v1/app/social/instagram/webhook',
  // Tenancy — the invitation page (feat-instagram-dm-sending route 118, TN11): answers only for the
  // emailed token (SHA-256 matched in a SECURITY DEFINER resolver; a wrong token or id is one 404),
  // 30 a minute per IP; an optional bearer only tells whether the signed-in email is the invited one.
  'POST /api/v1/tenancy/membership-invitations/:membership_invitation_id/preview',
];

describe('Security: public route allowlist', () => {
  const actualPublicRoutes = loadRouteRegistryFromCatalog()
    .filter((route) => route.access === 'public')
    .map((route) => `${route.method} ${route.path}`)
    .sort();
  const expectedPublicRoutes = [...EXPECTED_PUBLIC_ROUTES].sort();

  it('exposes exactly the reviewed set of unauthenticated routes', () => {
    const newlyPublic = actualPublicRoutes.filter((route) => !expectedPublicRoutes.includes(route));
    const noLongerPublic = expectedPublicRoutes.filter(
      (route) => !actualPublicRoutes.includes(route),
    );

    expect(
      { newlyPublic, noLongerPublic },
      'Public-route surface drifted from the allowlist. ' +
        `Newly PUBLIC (must be a deliberate, security-reviewed decision): ${
          newlyPublic.join(', ') || 'none'
        }. No longer PUBLIC: ${noLongerPublic.join(', ') || 'none'}. ` +
        'If intended, update EXPECTED_PUBLIC_ROUTES; otherwise add authentication to the route.',
    ).toEqual({ newlyPublic: [], noLongerPublic: [] });
  });

  it('keeps the public surface bounded (guards against a broad accidental opening)', () => {
    expect(actualPublicRoutes).toHaveLength(EXPECTED_PUBLIC_ROUTES.length);
  });
});
