import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestRequestAgent } from '@/tests/helpers/test-app.js';
import type { FastifyInstance } from 'fastify';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

describe('Billing - Plans', () => {
  let app: FastifyInstance;
  let request: TestRequestAgent;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    request = testApp.request;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET /api/v1/billing/plans returns 200 with an array', async () => {
    const response = await request.get('/api/v1/billing/plans');

    expect(response.status).toBe(200);
    expect(Array.isArray((response.body as { data: unknown }).data)).toBe(true);
  });

  it('GET /api/v1/billing/plans/:plan_id returns 404 for a well-formed id of no plan', async () => {
    const response = await request.get(`/api/v1/billing/plans/${generatePublicId('plan')}`);

    expect(response.status).toBe(404);
  });

  it('GET /api/v1/billing/plans/:plan_id returns 400 for a plan_id that is not a pln_ id', async () => {
    const response = await request.get('/api/v1/billing/plans/nonexistent-id');

    expect(response.status).toBe(400);
  });
});
