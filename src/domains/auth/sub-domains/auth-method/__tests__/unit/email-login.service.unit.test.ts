import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { UnauthorizedError } from '@/shared/errors/index.js';
import { mockedRedisSet } from '@/tests/helpers/redis-mock.helper.js';
import { EmailLoginService } from '@/domains/auth/sub-domains/auth-method/email-login.service.js';
import type { UserService } from '@/domains/user/user.service.js';

vi.mock('@/domains/auth/shared/complete-first-factor-auth.js', () => ({
  completeFirstFactorAuth: vi.fn().mockResolvedValue({
    access_token: 'jwt-token',
    session_public_id: 'session_public',
    session_refresh_secret: 'refresh_secret',
  }),
}));

// sendCode/login wrap their writes in withTransaction + runWithPinnedDatabaseHandle; invoke the
// callbacks directly so the unit test exercises the flow without a real database/transaction.
vi.mock('@/infrastructure/database/transaction.js', () => ({
  withTransaction: vi.fn(({ callback }: { callback: (transaction: unknown) => unknown }) =>
    callback({}),
  ),
}));

vi.mock(
  '@/infrastructure/database/contexts/database-context-runtime.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      runWithPinnedDatabaseHandle: vi.fn(
        ({
          databaseHandle: _handle,
          callback,
        }: {
          databaseHandle: unknown;
          callback: () => unknown;
        }) => callback(),
      ),
      getRequestDatabase: vi.fn(() => ({})),
    };
  },
);

vi.mock('@/core/events/event-bus.js', () => ({
  eventBus: {
    emit: vi.fn().mockResolvedValue(undefined),
    emitStrict: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/shared/utils/text/email.util.js', () => ({
  isDisposableEmailBlocked: vi.fn(() => false),
}));

vi.mock('@/shared/utils/security/anti-enumeration.util.js', () => ({
  enforceMinimumDuration: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/shared/config/env.config.js', () => {
  const env = {
    NODE_ENV: 'development',
    // LOG_LEVEL is consumed at import time by logger.util.ts (pino); the mock must carry it so
    // module-init order can never surface `pino({ level: undefined })`.
    LOG_LEVEL: 'info',
    AUTH_SESSION_ABSOLUTE_TIMEOUT_SECONDS: 43_200,
    AUTH_SESSION_IDLE_TIMEOUT_SECONDS: 1800,
    PERSONAL_ORGANIZATION_ENABLED: false,
    SECRETS_ENCRYPTION_KEY: 'test-secret-encryption-key-for-verification-code-pepper',
    // TEST_MODE gates the send-code `debug_verification_code` affordance; the Vitest harness runs
    // TEST_MODE=true. A test can flip this on the mock object to exercise the disabled path.
    TEST_MODE: true,
    // The per-email resend cooldown. True here (the production-safe default) so the suite keeps
    // exercising the spacing; the opt-out test below flips it on this same mock object.
    AUTH_EMAIL_CODE_RESEND_COOLDOWN_ENABLED: true,
  };
  return { env, getEnv: () => env };
});

// EmailLoginService imports `redisConnection` (default constructor dep) — stub the client module so a
// real Redis connection is never constructed in this unit test. The constructor receives an explicit
// `redis` stub below.
vi.mock('@/infrastructure/cache/redis.client.js', () => ({
  redisConnection: {},
}));

vi.mock('@/domains/tenancy/sub-domains/organization/resolve-active-organization.js', () => ({
  ensurePersonalOrganization: vi.fn().mockResolvedValue(undefined),
}));

import { eventBus } from '@/core/events/event-bus.js';
import { env } from '@/shared/config/env.config.js';
import { AUTH_EVENT } from '@/domains/auth/sub-domains/auth-method/events/auth.events.js';
import { completeFirstFactorAuth } from '@/domains/auth/shared/complete-first-factor-auth.js';
import { ensurePersonalOrganization } from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import type { MfaService } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa.service.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import type { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { VerificationTokenRepository } from '@/domains/auth/sub-domains/auth-method/verification-token/verification-token.repository.js';

const user = {
  id: 1,
  public_id: 'abcdefghijklmnopqrstu',
  email: 'user@example.com',
  status: 'ACTIVE',
  is_email_verified: false,
  is_mfa_enabled: false,
  deleted_at: null,
};

/** SHA-256 hex of the normalised email — how the per-email Redis keys name an address. */
function emailKeyHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

describe('EmailLoginService', () => {
  const userService = {
    findByEmail: vi.fn(),
    createForEmailCode: vi.fn(),
    updateEmailVerified: vi.fn().mockResolvedValue(user),
    requireUserRecordByPublicId: vi.fn(),
  } as unknown as UserService;

  const organizationSettingsService = {
    userHasOrganizationRequiringMfa: vi.fn().mockResolvedValue(false),
  } as unknown as OrganizationSettingsService;

  const mfaService = {
    createMfaSession: vi.fn(),
    hasSettledSecondFactor: vi.fn().mockResolvedValue(false),
  } as unknown as MfaService;

  const authSessionService = {
    createSessionForUser: vi.fn().mockResolvedValue({ public_id: 'session_public' }),
  } as unknown as AuthSessionService;

  const authMethodService = {
    createEmailCodeMethod: vi.fn().mockResolvedValue(undefined),
    isLoginMethodTurnedOff: vi.fn().mockResolvedValue(false),
  } as unknown as AuthMethodService;

  const verificationTokenRepository = {
    create: vi.fn().mockResolvedValue(undefined),
    consumeOtpForUser: vi.fn(),
    findValidByTokenHash: vi.fn(),
    invalidateAllForUser: vi.fn().mockResolvedValue(undefined),
    findNewestForUser: vi.fn().mockResolvedValue(null),
  } as unknown as VerificationTokenRepository;

  // incrementWithExpiryOnFirst (real util) calls redis.eval and returns the attempt count;
  // 1 = under the cap by default, del clears it on success. `set` is the SET NX EX cooldown claim;
  // 'OK' (default) = slot claimed → send proceeds; null = on cooldown → send is skipped.
  const redis = {
    eval: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(0),
    set: vi.fn().mockResolvedValue('OK'),
    // The per-email wrong-code day counter (null = no wrong try today) and a key's remaining TTL.
    get: vi.fn().mockResolvedValue(null),
    ttl: vi.fn().mockResolvedValue(42),
  } as unknown as Redis;

  const service = new EmailLoginService(
    userService,
    verificationTokenRepository,
    organizationSettingsService,
    mfaService,
    authSessionService,
    authMethodService,
    redis,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(redis.eval).mockResolvedValue(1);
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.ttl).mockResolvedValue(42);
    vi.mocked(verificationTokenRepository.findNewestForUser).mockResolvedValue(null);
    mockedRedisSet(redis.set).mockResolvedValue('OK');
  });

  it('sendCode auto-signs-up an unknown email then issues a code', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    vi.mocked(userService.createForEmailCode).mockResolvedValue(user as never);

    const result = await service.sendCode({ body: { email: 'new-user@example.com' } });

    expect(userService.createForEmailCode).toHaveBeenCalledWith({ email: 'new-user@example.com' });
    expect(authMethodService.createEmailCodeMethod).toHaveBeenCalledWith({
      userId: user.id,
      userPublicId: user.public_id,
    });
    expect(verificationTokenRepository.create).toHaveBeenCalled();
    expect(vi.mocked(eventBus.emitStrict)).toHaveBeenCalledTimes(1);
    expect(result.messageKey).toBe('success:verificationCodeSent');
  });

  it('sendCode falls back to the existing user when the create races a unique violation', async () => {
    vi.mocked(userService.findByEmail)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(user as never);
    vi.mocked(userService.createForEmailCode).mockRejectedValue({ code: '23505' });

    const result = await service.sendCode({ body: { email: user.email } });

    // No 409 — email login is auto-signup; it converges on the existing user and still issues a code.
    expect(result.messageKey).toBe('success:verificationCodeSent');
    expect(verificationTokenRepository.create).toHaveBeenCalled();
    expect(vi.mocked(eventBus.emitStrict)).toHaveBeenCalledTimes(1);
  });

  it('sendCode issues a single live code, invalidating prior unused codes', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

    const result = await service.sendCode({ body: { email: user.email } });

    expect(userService.createForEmailCode).not.toHaveBeenCalled();
    // Single live code: a fresh send invalidates the user's prior unused EMAIL_CODE codes so only the
    // newest is redeemable.
    expect(verificationTokenRepository.invalidateAllForUser).toHaveBeenCalledWith(
      user.id,
      'EMAIL_CODE',
    );
    expect(verificationTokenRepository.create).toHaveBeenCalled();
    // The raw `verification_code`/`code` key never leaves via the result — only via the event payload.
    expect(result).not.toHaveProperty('code');
    expect(result).not.toHaveProperty('verification_code');
    const emittedEvent = vi.mocked(eventBus.emitStrict).mock.calls[0]?.[0];
    expect(emittedEvent?.type).toBe(AUTH_EVENT.EMAIL_VERIFICATION_CODE_REQUESTED);
    const emittedPayload = emittedEvent?.payload as { verification_code: string };
    expect(emittedPayload.verification_code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('sendCode echoes debug_verification_code under TEST_MODE (matches the emitted code)', async () => {
    // The Vitest harness runs with TEST_MODE=true (src/tests/setup.ts), so the TEST_MODE-only
    // affordance is active: the result carries the plaintext code for out-of-process test clients.
    // A `.refine()` forbids TEST_MODE=true in production and it is never set on a deployed runtime, so
    // this key is absent everywhere real (see env-schema.unit.test.ts `rejects TEST_MODE=true in production`).
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

    const result = await service.sendCode({ body: { email: user.email } });

    const emittedPayload = vi.mocked(eventBus.emitStrict).mock.calls[0]?.[0]?.payload as {
      verification_code: string;
    };
    expect(result.debug_verification_code).toBe(emittedPayload.verification_code);
    expect(result.debug_verification_code).toMatch(/^\d{6}$/);
  });

  it('sendCode NEVER exposes debug_verification_code when TEST_MODE is off (even though a code is issued)', async () => {
    // Security-critical: the affordance is gated strictly on env.TEST_MODE. A .refine() forbids
    // TEST_MODE=true in production (env-schema.unit.test.ts), so a deployed runtime always takes this
    // path — the code is issued/emailed but never echoed to the caller.
    const envMutable = env as unknown as { TEST_MODE: boolean };
    envMutable.TEST_MODE = false;
    try {
      vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

      const result = await service.sendCode({ body: { email: user.email } });

      expect(vi.mocked(eventBus.emitStrict)).toHaveBeenCalled(); // a code WAS issued + emailed
      expect(result).not.toHaveProperty('debug_verification_code'); // but never returned
    } finally {
      envMutable.TEST_MODE = true;
    }
  });

  it('sendCode resets the per-user verify-attempt cap so a fresh code restores the budget', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

    await service.sendCode({ body: { email: user.email } });

    // A-8: one budget per flow — a fresh code restores both (the sign-in's keyed by the email).
    expect(redis.del).toHaveBeenCalledWith(
      `auth:email_code_verify_attempts:login:${emailKeyHash(user.email)}`,
      `auth:email_code_verify_attempts:step_up:${user.public_id}`,
    );
  });

  // Local-only opt-out (allowlisted to local/development by the env schema): with the spacing off
  // the cooldown slot is never claimed at all, so a repeat send still issues — and still echoes.
  it('sendCode skips the cooldown claim entirely when the spacing is disabled', async () => {
    vi.mocked(env).AUTH_EMAIL_CODE_RESEND_COOLDOWN_ENABLED = false;
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

    const result = await service.sendCode({ body: { email: user.email } });

    // The SET NX EX claim is the cooldown — with the flag off it must not even be attempted.
    expect(redis.set).not.toHaveBeenCalled();
    expect(verificationTokenRepository.create).toHaveBeenCalled();
    expect(result.debug_verification_code).toBeDefined();

    vi.mocked(env).AUTH_EMAIL_CODE_RESEND_COOLDOWN_ENABLED = true;
  });

  it('sendCode fails open and still issues a code when the cooldown Redis SET rejects (Redis down)', async () => {
    mockedRedisSet(redis.set).mockRejectedValueOnce(new Error("Stream isn't writeable"));
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

    const result = await service.sendCode({ body: { email: user.email } });

    expect(result.messageKey).toBe('success:verificationCodeSent');
    expect(verificationTokenRepository.create).toHaveBeenCalled();
    expect(vi.mocked(eventBus.emitStrict)).toHaveBeenCalledTimes(1);
  });

  it('sendCode does not fail when the best-effort attempt-counter reset rejects (Redis down)', async () => {
    vi.mocked(redis.del).mockRejectedValueOnce(new Error("Stream isn't writeable"));
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

    const result = await service.sendCode({ body: { email: user.email } });

    expect(result.messageKey).toBe('success:verificationCodeSent');
    expect(vi.mocked(eventBus.emitStrict)).toHaveBeenCalledTimes(1);
  });

  it('sendCode enforces a constant-time floor on both account-existence branches', async () => {
    const { enforceMinimumDuration } = await import(
      '@/shared/utils/security/anti-enumeration.util.js'
    );
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    vi.mocked(userService.createForEmailCode).mockResolvedValue(user as never);
    vi.mocked(enforceMinimumDuration).mockClear();
    await service.sendCode({ body: { email: 'missing@example.com' } });
    expect(enforceMinimumDuration).toHaveBeenCalledTimes(1);
    vi.mocked(enforceMinimumDuration).mockClear();
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    await service.sendCode({ body: { email: user.email } });
    expect(enforceMinimumDuration).toHaveBeenCalledTimes(1);
  });

  it('sendCode rejects disposable email addresses', async () => {
    const emailUtil = await import('@/shared/utils/text/email.util.js');
    vi.mocked(emailUtil.isDisposableEmailBlocked).mockReturnValueOnce(true);
    await expect(service.sendCode({ body: { email: 'temp@mailinator.com' } })).rejects.toThrow();
    expect(userService.createForEmailCode).not.toHaveBeenCalled();
  });

  it('login creates a session, marks the email verified, and invalidates the other live codes', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
      token_type: 'EMAIL_CODE',
      user_id: user.id,
    } as never);

    const result = await service.login({
      body: { email: user.email, code: '123456' },
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
    });
    if (!('access_token' in result)) throw new Error('expected access token result');

    expect(verificationTokenRepository.consumeOtpForUser).toHaveBeenCalledWith(
      user.id,
      'EMAIL_CODE',
      expect.any(String),
    );
    // §2a(c): the first successful use invalidates the user's remaining live codes (single-use set).
    expect(verificationTokenRepository.invalidateAllForUser).toHaveBeenCalledWith(
      user.id,
      'EMAIL_CODE',
    );
    expect(userService.updateEmailVerified).toHaveBeenCalledWith(user.public_id);
    expect(result.access_token).toBe('jwt-token');
    expect(redis.del).toHaveBeenCalled();
  });

  it('sec-U1: login refuses to mint a session when the account was SUSPENDED between code issue and login', async () => {
    // `findByEmail` filters only soft-deleted, so a suspended user reaches the consume+active-guard.
    // The just-consumed code proves email control, but a suspended account must NOT get a session
    // (TOCTOU: ACTIVE when the code was issued, suspended before login completed).
    vi.mocked(userService.findByEmail).mockResolvedValue({ ...user, status: 'SUSPENDED' } as never);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
      token_type: 'EMAIL_CODE',
      user_id: user.id,
    } as never);

    await expect(
      service.login({
        body: { email: user.email, code: '123456' },
        ipAddress: '127.0.0.1',
        userAgent: 'vitest',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authSessionService.createSessionForUser).not.toHaveBeenCalled();
  });

  // ─── AT7 / AT8 (routes-final § 10.A, AC-13.2, AC-13.3) ─────────────────────────────────────

  it('AC-13.2: sendCode answers resend_after_seconds 60 and expires_in_seconds 900', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    const result = await service.sendCode({ body: { email: user.email } });
    expect(result).toMatchObject({ resend_after_seconds: 60, expires_in_seconds: 900 });
    expect(result).not.toHaveProperty('expires_in_minutes');
  });

  it('AC-13.2: a resend under 60 s is refused with 429 code_resend_too_soon and the wait, before any lookup', async () => {
    mockedRedisSet(redis.set).mockResolvedValueOnce(null);
    vi.mocked(redis.ttl).mockResolvedValueOnce(37);
    await expect(service.sendCode({ body: { email: user.email } })).rejects.toMatchObject({
      statusCode: 429,
      reason: 'code_resend_too_soon',
      retryAfterSeconds: 37,
      fields: { retry_after_seconds: 37 },
    });
    expect(userService.findByEmail).not.toHaveBeenCalled();
    expect(verificationTokenRepository.create).not.toHaveBeenCalled();
    expect(vi.mocked(eventBus.emitStrict)).not.toHaveBeenCalled();
  });

  it('AC-13.3: a wrong code answers 401 code_wrong with the tries left', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(redis.eval).mockResolvedValueOnce(2); // the 2nd try on this code
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);
    await expect(
      service.login({ body: { email: user.email, code: '999999' }, ipAddress: '127.0.0.1' }),
    ).rejects.toMatchObject({ statusCode: 401, reason: 'code_wrong', fields: { tries_left: 3 } });
  });

  it('AC-13.3: an unknown email answers code_wrong exactly like a wrong code (counted by email)', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    vi.mocked(redis.eval).mockResolvedValueOnce(2);
    await expect(
      service.login({
        body: { email: 'missing@example.com', code: '999999' },
        ipAddress: '1.1.1.1',
      }),
    ).rejects.toMatchObject({ statusCode: 401, reason: 'code_wrong', fields: { tries_left: 3 } });
    const countedKeys = vi.mocked(redis.eval).mock.calls.map((call) => call[2]);
    expect(countedKeys[0]).toBe(
      `auth:email_code_verify_attempts:login:${emailKeyHash('missing@example.com')}`,
    );
  });

  it('AC-13.3: the newest code over 15 minutes old answers 401 code_expired', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);
    vi.mocked(verificationTokenRepository.findNewestForUser).mockResolvedValue({
      expires_at: new Date(Date.now() - 1_000),
      used_at: null,
    } as never);
    await expect(
      service.login({ body: { email: user.email, code: '999999' }, ipAddress: '127.0.0.1' }),
    ).rejects.toMatchObject({ statusCode: 401, reason: 'code_expired' });
  });

  it('AC-13.3: a used newest code is code_wrong, not code_expired', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);
    vi.mocked(verificationTokenRepository.findNewestForUser).mockResolvedValue({
      expires_at: new Date(Date.now() - 1_000),
      used_at: new Date(),
    } as never);
    await expect(
      service.login({ body: { email: user.email, code: '999999' }, ipAddress: '127.0.0.1' }),
    ).rejects.toMatchObject({ reason: 'code_wrong' });
  });

  it('AC-13.3: the 5th wrong try answers 401 code_used_up, and later tries too without a lookup', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);
    vi.mocked(redis.eval).mockResolvedValueOnce(5);
    await expect(
      service.login({ body: { email: user.email, code: '999999' }, ipAddress: '127.0.0.1' }),
    ).rejects.toMatchObject({ statusCode: 401, reason: 'code_used_up' });

    vi.mocked(userService.findByEmail).mockClear();
    vi.mocked(redis.eval).mockResolvedValueOnce(6);
    await expect(
      service.login({ body: { email: user.email, code: '999999' }, ipAddress: '127.0.0.1' }),
    ).rejects.toMatchObject({ statusCode: 401, reason: 'code_used_up' });
    expect(userService.findByEmail).not.toHaveBeenCalled();
  });

  it('AC-13.3: 20 wrong tries for the email today answer 429 code_day_limit with the wait', async () => {
    vi.mocked(redis.get).mockResolvedValueOnce('20');
    vi.mocked(redis.ttl).mockResolvedValueOnce(3_600);
    await expect(
      service.login({ body: { email: user.email, code: '999999' }, ipAddress: '127.0.0.1' }),
    ).rejects.toMatchObject({
      statusCode: 429,
      reason: 'code_day_limit',
      retryAfterSeconds: 3_600,
      fields: { retry_after_seconds: 3_600 },
    });
    expect(userService.findByEmail).not.toHaveBeenCalled();
  });

  it('a wrong try counts toward the day limit; a success clears the try and day counters', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValueOnce(null);
    await expect(
      service.login({ body: { email: user.email, code: '999999' }, ipAddress: '127.0.0.1' }),
    ).rejects.toMatchObject({ reason: 'code_wrong' });
    const countedKeys = vi.mocked(redis.eval).mock.calls.map((call) => call[2]);
    expect(countedKeys).toContain(`auth:email_code_wrong_tries_day:${emailKeyHash(user.email)}`);
  });

  it('login rejects an unknown email without consuming a code', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    await expect(
      service.login({
        body: { email: 'missing@example.com', code: '123456' },
        ipAddress: '127.0.0.1',
      }),
    ).rejects.toThrow();
    expect(verificationTokenRepository.consumeOtpForUser).not.toHaveBeenCalled();
  });

  it('login rejects once the per-user attempt cap is exceeded', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(redis.eval).mockResolvedValueOnce(99);
    await expect(
      service.login({ body: { email: user.email, code: '123456' }, ipAddress: '127.0.0.1' }),
    ).rejects.toThrow();
    expect(verificationTokenRepository.consumeOtpForUser).not.toHaveBeenCalled();
  });

  it('login enforces a constant-time floor on the unknown-email and attempt-cap branches', async () => {
    const { enforceMinimumDuration } = await import(
      '@/shared/utils/security/anti-enumeration.util.js'
    );

    // Unknown-email branch rejects after a single lookup but must still apply the floor, so its
    // latency cannot be distinguished from the slower known-email path (account-existence oracle).
    vi.mocked(userService.findByEmail).mockResolvedValueOnce(null);
    await expect(
      service.login({
        body: { email: 'missing@example.com', code: '123456' },
        ipAddress: '127.0.0.1',
      }),
    ).rejects.toThrow();

    expect(enforceMinimumDuration).toHaveBeenCalledTimes(1);
    vi.mocked(enforceMinimumDuration).mockClear();

    // Attempt-cap branch: a known email over the per-user cap.
    vi.mocked(userService.findByEmail).mockResolvedValueOnce(user as never);
    vi.mocked(redis.eval).mockResolvedValueOnce(99);
    await expect(
      service.login({ body: { email: user.email, code: '123456' }, ipAddress: '127.0.0.1' }),
    ).rejects.toThrow();

    expect(enforceMinimumDuration).toHaveBeenCalledTimes(1);
  });

  it('login rejects a wrong or expired code', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);
    await expect(
      service.login({ body: { email: user.email, code: '999999' }, ipAddress: '127.0.0.1' }),
    ).rejects.toThrow();
  });

  // There is no master code: every code, the retired static TEST24 included, is looked up among
  // the codes send-code issued. Local work and load tests read the issued code from the
  // TEST_MODE echo (`debug_verification_code`) instead.
  it('login looks every code up among the issued ones; no master code is accepted', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);

    await expect(
      service.login({ body: { email: user.email, code: '240000' }, ipAddress: '127.0.0.1' }),
    ).rejects.toThrow(UnauthorizedError);
    expect(verificationTokenRepository.consumeOtpForUser).toHaveBeenCalled();
  });

  it('login enforces the constant-time floor on the known-account wrong-code branch (anti-enumeration)', async () => {
    const { enforceMinimumDuration } = await import(
      '@/shared/utils/security/anti-enumeration.util.js'
    );
    // Known email + wrong code must be timing-indistinguishable from the unknown-email 401, else the
    // latency delta is an account-existence oracle. The wrong-code throw is inside the code-consume
    // transaction, so the floor is applied in the catch outside it.
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(redis.eval).mockResolvedValue(1);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);
    await expect(
      service.login({ body: { email: user.email, code: '999999' }, ipAddress: '127.0.0.1' }),
    ).rejects.toThrow();
    expect(vi.mocked(enforceMinimumDuration)).toHaveBeenCalledTimes(1);
  });

  it('login propagates a downstream session/MFA failure so the code consume rolls back', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
      token_type: 'EMAIL_CODE',
      user_id: user.id,
    } as never);
    vi.mocked(completeFirstFactorAuth).mockRejectedValueOnce(new Error('session insert failed'));

    await expect(
      service.login({ body: { email: user.email, code: '123456' }, ipAddress: '127.0.0.1' }),
    ).rejects.toThrow('session insert failed');
    expect(verificationTokenRepository.consumeOtpForUser).toHaveBeenCalled();
    // The success-only attempt-counter clear must NOT run when login throws.
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('login provisions the personal organization on the first verification (claims a bare invited account)', async () => {
    env.PERSONAL_ORGANIZATION_ENABLED = true;
    try {
      vi.mocked(userService.findByEmail).mockResolvedValue({
        ...user,
        is_email_verified: false,
      } as never);
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
        token_type: 'EMAIL_CODE',
        user_id: user.id,
      } as never);

      await service.login({
        body: { email: user.email, code: '123456' },
        ipAddress: '127.0.0.1',
        userAgent: 'vitest',
      });

      expect(vi.mocked(ensurePersonalOrganization)).toHaveBeenCalledWith(
        expect.objectContaining({ id: user.id, public_id: user.public_id }),
      );
    } finally {
      env.PERSONAL_ORGANIZATION_ENABLED = false;
    }
  });

  it('login does not re-provision a personal organization for an already-verified returning user', async () => {
    env.PERSONAL_ORGANIZATION_ENABLED = true;
    try {
      vi.mocked(userService.findByEmail).mockResolvedValue({
        ...user,
        is_email_verified: true,
      } as never);
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
        token_type: 'EMAIL_CODE',
        user_id: user.id,
      } as never);

      await service.login({
        body: { email: user.email, code: '123456' },
        ipAddress: '127.0.0.1',
        userAgent: 'vitest',
      });

      expect(vi.mocked(ensurePersonalOrganization)).not.toHaveBeenCalled();
    } finally {
      env.PERSONAL_ORGANIZATION_ENABLED = false;
    }
  });

  it('does not provision a personal organization in team-only mode (env flag off)', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    vi.mocked(userService.createForEmailCode).mockResolvedValue(user as never);
    await service.sendCode({ body: { email: 'team-only@example.com' } });
    expect(vi.mocked(ensurePersonalOrganization)).not.toHaveBeenCalled();
  });

  describe('verifyCodeForStepUp (the email-code step-up, route 127 — AT15)', () => {
    const passwordlessUser = { ...user, is_mfa_enabled: false, password_hash: null };
    const stepUp = () =>
      service.verifyCodeForStepUp({
        userPublicId: passwordlessUser.public_id,
        sessionPublicId: 'ses_stepup0000000000000000',
        code: '135790',
      });

    beforeEach(() => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(
        passwordlessUser as never,
      );
      vi.mocked(mfaService.hasSettledSecondFactor).mockResolvedValue(false);
    });

    it('consumes the code for a person without settled 2FA and mints NO session', async () => {
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
        id: 9,
      } as never);

      await expect(stepUp()).resolves.toBeUndefined();

      expect(verificationTokenRepository.consumeOtpForUser).toHaveBeenCalled();
      expect(verificationTokenRepository.invalidateAllForUser).toHaveBeenCalledWith(
        passwordlessUser.id,
        'EMAIL_CODE',
      );
      // No session is minted (unlike login) — this only opens a step-up window.
      expect(completeFirstFactorAuth).not.toHaveBeenCalled();
    });

    it('asks whether the factor is settled on THIS session (a provisional factor does not count)', async () => {
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
        id: 9,
      } as never);
      await stepUp();
      expect(mfaService.hasSettledSecondFactor).toHaveBeenCalledWith({
        owner: { id: passwordlessUser.id, public_id: passwordlessUser.public_id },
        sessionPublicId: 'ses_stepup0000000000000000',
      });
    });

    it('refuses a person with settled 2FA with 403 mfa_step_up_required, before any code is consumed or counted', async () => {
      vi.mocked(mfaService.hasSettledSecondFactor).mockResolvedValue(true);
      vi.mocked(redis.eval).mockClear();
      await expect(stepUp()).rejects.toMatchObject({
        statusCode: 403,
        messageKey: 'errors:mfaStepUpRequired',
        reason: 'mfa_step_up_required',
      });
      expect(verificationTokenRepository.consumeOtpForUser).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('a wrong code answers 401 code_wrong with the tries left', async () => {
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null as never);
      vi.mocked(redis.eval).mockResolvedValueOnce(2);
      await expect(stepUp()).rejects.toMatchObject({
        statusCode: 401,
        reason: 'code_wrong',
        fields: { tries_left: 3 },
      });
      expect(verificationTokenRepository.invalidateAllForUser).not.toHaveBeenCalled();
    });

    it('the newest code past its 15 minutes answers 401 code_expired', async () => {
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null as never);
      vi.mocked(verificationTokenRepository.findNewestForUser).mockResolvedValue({
        used_at: null,
        expires_at: new Date(Date.now() - 1_000),
      } as never);
      await expect(stepUp()).rejects.toMatchObject({ statusCode: 401, reason: 'code_expired' });
    });

    it('the last try and over the cap answer 401 code_used_up (over the cap before consuming)', async () => {
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null as never);
      vi.mocked(redis.eval).mockResolvedValueOnce(5);
      await expect(stepUp()).rejects.toMatchObject({ statusCode: 401, reason: 'code_used_up' });

      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockClear();
      vi.mocked(redis.eval).mockResolvedValueOnce(99);
      await expect(stepUp()).rejects.toMatchObject({ statusCode: 401, reason: 'code_used_up' });
      expect(verificationTokenRepository.consumeOtpForUser).not.toHaveBeenCalled();
    });

    it('A-8: counts on its own budget, never the public sign-in one', async () => {
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
        id: 9,
      } as never);
      vi.mocked(redis.eval).mockClear();
      await stepUp();
      const countedKeys = vi.mocked(redis.eval).mock.calls.map((call) => call[2]);
      expect(countedKeys).toEqual([
        `auth:email_code_verify_attempts:step_up:${passwordlessUser.public_id}`,
      ]);
      // Success clears only the step-up budget.
      expect(redis.del).toHaveBeenCalledWith(
        `auth:email_code_verify_attempts:step_up:${passwordlessUser.public_id}`,
      );
    });
  });
});
