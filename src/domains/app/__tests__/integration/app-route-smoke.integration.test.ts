import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  loadRoutesForDomain,
  buildRouteSmokeCases,
  assertRouteSmokeUnauthenticated,
} from '@/tests/helpers/route-http-coverage.helper.js';
import type { FastifyInstance } from 'fastify';

/**
 * Meta's provider routes, as `METHOD path`: PUBLIC, and each proved by what only Meta sends — the
 * deauthorize and data-deletion callbacks (routes 7–8) by a form-encoded `signed_request`, the
 * webhook delivery (route 17) by `X-Hub-Signature-256` over the raw body, and the webhook's
 * subscription check (route 16) by `hub.mode`, `hub.verify_token` and `hub.challenge` in the query.
 * An empty anonymous request is not their contract (it answers `400` or `415`, never the declared
 * `200` the catalog smoke expects of a public route) — as the billing smoke test leaves out its
 * Stripe webhook. Their dedicated integration tests cover them: route 16's `200` challenge echo,
 * `400 invalid_webhook_verify_token` and `503 instagram_webhook_not_configured` in
 * `instagram-webhook.integration.test.ts`.
 */
const META_PROVIDER_ROUTE_KEYS: ReadonlySet<string> = new Set([
  'POST /api/v1/app/social/instagram/deauthorize',
  'POST /api/v1/app/social/instagram/data-deletion',
  'GET /api/v1/app/social/instagram/webhook',
  'POST /api/v1/app/social/instagram/webhook',
]);

const appRoutes = loadRoutesForDomain('app').filter(
  (route) => !META_PROVIDER_ROUTE_KEYS.has(`${route.method} ${route.path}`),
);

/**
 * Every `app` domain route in `docs/routes.txt` refuses an anonymous caller (the Instagram account
 * routes, contacts and the webhook events list today; automations as they land) — Meta's provider
 * routes excepted (above). The focused HTTP contracts live beside each sub-domain.
 */
describe('App route smoke (catalog)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  for (const route of appRoutes) {
    it(`${route.method} ${route.path} rejects unauthenticated or allows public`, async () => {
      const user = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: user.id });
      const smokeCase = buildRouteSmokeCases(route, organization.public_id);
      await assertRouteSmokeUnauthenticated(app, smokeCase);
    });
  }
});
