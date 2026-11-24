import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedPlans,
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
  STUDIO_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

describe('Plan Sub-Domain — Integration', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    const user = await createTestUser();
    token = await generateTestToken({ userId: user.public_id });
  });

  describe('GET /api/v1/billing/plans', () => {
    it('returns 200 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/plans'),
      });
      expect(response.statusCode).toBe(200);
    });

    it('returns 200 for authenticated request', async () => {
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/plans'),
        token,
      });
      expect(response.statusCode).toBe(200);
    });

    it('returns cache headers and 304 on repeat fetch with If-None-Match', async () => {
      const firstResponse = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/plans'),
        token,
      });
      expect(firstResponse.statusCode).toBe(200);
      const etag = firstResponse.headers.etag;
      expect(etag).toBeDefined();
      expect(firstResponse.headers['cache-control']).toContain('max-age=300');

      const secondResponse = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/plans'),
        token,
        headers: { 'if-none-match': String(etag) },
      });
      expect(secondResponse.statusCode).toBe(304);
      expect(secondResponse.body).toBe('');
    });
  });

  // Routes 100–101 against the Flowdm catalog (routes-final 8.A; AC-11.1).
  describe('the Flowdm catalog (8.A)', () => {
    async function seedCatalog() {
      const rows = await seedPlans();
      return new Map(rows.map((row) => [row.name, row.public_id]));
    }

    it('route 100 answers Free, Creator and Studio cheapest first, typed features, no PRO bundle, no limits', async () => {
      await seedCatalog();
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/plans'),
      });
      expect(response.statusCode).toBe(200);
      const plans = (response.json() as { data: Array<Record<string, unknown>> }).data;
      expect(plans.map((plan) => plan.name)).toEqual(['Free', 'Creator', 'Studio']);
      expect(plans.map((plan) => plan.features)).toEqual([
        FREE_PLAN_FEATURES,
        CREATOR_PLAN_FEATURES,
        STUDIO_PLAN_FEATURES,
      ]);
      expect(
        plans.map((plan) => [plan.price_monthly, plan.price_yearly, plan.price_yearly_per_month]),
      ).toEqual([
        ['0.00', null, null],
        ['29.00', '276.00', '23.00'],
        ['79.00', '756.00', '63.00'],
      ]);
      for (const plan of plans) {
        expect(plan).not.toHaveProperty('limits');
        expect(plan.features).not.toHaveProperty('is_pro_enabled');
        expect(String(plan.id)).toMatch(/^pln_[a-z0-9]{21}$/);
      }
    });

    it('route 101 answers one active plan and 404 for a switched-off one', async () => {
      const ids = await seedCatalog();
      const creator = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath(`/billing/plans/${ids.get('Creator')}`),
      });
      expect(creator.statusCode).toBe(200);
      expect((creator.json() as { data: unknown }).data).toMatchObject({
        name: 'Creator',
        price_yearly_per_month: '23.00',
        features: CREATOR_PLAN_FEATURES,
      });

      for (const name of ['Starter', 'Growth', 'Pro']) {
        const off = await injectUnauthenticated(app, {
          method: 'GET',
          url: testApiPath(`/billing/plans/${ids.get(name)}`),
        });
        expect(off.statusCode).toBe(404);
      }
    });

    it('route 101 answers 400 for a plan_id that is not a pln_ id, 404 for an unknown one', async () => {
      const malformed = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/plans/not-a-plan-id'),
      });
      expect(malformed.statusCode).toBe(400);
      const unknown = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath(`/billing/plans/${generatePublicId('plan')}`),
      });
      expect(unknown.statusCode).toBe(404);
    });
  });
});
