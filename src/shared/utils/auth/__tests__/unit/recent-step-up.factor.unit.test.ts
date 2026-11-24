import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import {
  recordRecentStepUp,
  hasRecentStepUp,
  hasRecentStrongStepUp,
} from '@/shared/utils/auth/recent-step-up.util.js';

/**
 * Factor gating (item #8, AT15): the step-up sentinel stores the factor that opened the window.
 * `mfa` and `email_code` (opened only for a person without settled 2FA — route 127 refuses the
 * rest) satisfy the strong gate on destructive credential/session mutations; a `provisional_mfa`
 * window (a factor enrolled under an email-code window, A-1) can ENROLL but never satisfy it.
 */
describe('recent-step-up util — factor gating', () => {
  let store: Map<string, string>;
  const mockRedis = {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  } as unknown as Redis;

  beforeEach(() => {
    store = new Map();
    vi.clearAllMocks();
  });

  it.each(['mfa', 'email_code'] as const)(
    'a %s step-up satisfies both the normal and the strong gate',
    async (factor) => {
      await recordRecentStepUp({
        redis: mockRedis,
        userPublicId: 'u',
        sessionPublicId: 's',
        factor,
      });
      await expect(
        hasRecentStepUp({ redis: mockRedis, userPublicId: 'u', sessionPublicId: 's' }),
      ).resolves.toBe(true);
      await expect(
        hasRecentStrongStepUp({ redis: mockRedis, userPublicId: 'u', sessionPublicId: 's' }),
      ).resolves.toBe(true);
    },
  );

  it('a provisional_mfa step-up satisfies the normal (enroll) gate but NOT the strong gate', async () => {
    await recordRecentStepUp({
      redis: mockRedis,
      userPublicId: 'u',
      sessionPublicId: 's',
      factor: 'provisional_mfa',
    });
    await expect(
      hasRecentStepUp({ redis: mockRedis, userPublicId: 'u', sessionPublicId: 's' }),
    ).resolves.toBe(true);
    await expect(
      hasRecentStrongStepUp({ redis: mockRedis, userPublicId: 'u', sessionPublicId: 's' }),
    ).resolves.toBe(false);
  });

  it('hasRecentStrongStepUp fails closed with no session id', async () => {
    await recordRecentStepUp({
      redis: mockRedis,
      userPublicId: 'u',
      sessionPublicId: 's',
      factor: 'mfa',
    });
    await expect(
      hasRecentStrongStepUp({ redis: mockRedis, userPublicId: 'u', sessionPublicId: undefined }),
    ).resolves.toBe(false);
  });

  it('a stored legacy `password` window (passwords are off, P84) satisfies neither gate as a strong factor', async () => {
    store.set('step-up:u:s', 'password');
    await expect(
      hasRecentStrongStepUp({ redis: mockRedis, userPublicId: 'u', sessionPublicId: 's' }),
    ).resolves.toBe(false);
  });

  it('fails the strong gate closed on a stored value that is not a strong factor', async () => {
    store.set('step-up:u:s', 'not-a-factor');
    await expect(
      hasRecentStrongStepUp({ redis: mockRedis, userPublicId: 'u', sessionPublicId: 's' }),
    ).resolves.toBe(false);
  });
});
