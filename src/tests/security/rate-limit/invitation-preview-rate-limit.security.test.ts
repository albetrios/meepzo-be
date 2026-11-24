import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  // Production posture: caps are NOT relaxed, so the invitation preview keeps its 30/min cap.
  RATE_LIMIT_RELAXED_CAPS: false as boolean,
}));

vi.mock('@/shared/config/env.config.js', () => ({
  env: mockEnv,
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({
  Sentry: { addBreadcrumb: vi.fn() },
}));

/**
 * feat-instagram-dm-sending AC-12.6 (route 118, TN11): the invitation preview is PUBLIC, so its own
 * per-IP cap is what stops a token-guessing loop — the 31st call a minute from one IP is a 429.
 */
describe('Security: invitation preview rate limit (429 on the 31st call a minute)', () => {
  const apps: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    vi.resetModules();
    while (apps.length > 0) {
      const application = apps.pop();
      if (application) await application.close();
    }
  });

  it('answers the first 30 and refuses the 31st from one IP', async () => {
    vi.resetModules();
    const { INVITATION_PREVIEW_RATE_LIMIT } = await import(
      '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js'
    );
    const application = Fastify();
    await application.register(rateLimit, { global: false });
    application.post(
      '/tenancy/membership-invitations/:membership_invitation_id/preview',
      { ...INVITATION_PREVIEW_RATE_LIMIT },
      async () => ({ data: { state: 'valid' } }),
    );
    await application.ready();
    apps.push(application);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const response = await application.inject({
        method: 'POST',
        url: `/tenancy/membership-invitations/inv_${attempt}/preview`,
        payload: { token: `guess-${attempt}` },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
