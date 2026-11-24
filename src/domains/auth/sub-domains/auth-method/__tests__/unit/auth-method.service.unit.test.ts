import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '@/shared/errors/index.js';
import { MAX_LINKED_AUTH_METHODS_PER_USER } from '@/shared/constants/security.constants.js';
import { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthMethodRepository } from '@/domains/auth/sub-domains/auth-method/auth-method.repository.js';
import type { VerificationTokenRepository } from '@/domains/auth/sub-domains/auth-method/verification-token/verification-token.repository.js';
import type * as EventBusModule from '@/core/events/event-bus.js';

vi.mock('@/core/events/event-bus.js', async (importOriginal) => {
  const original = await importOriginal<typeof EventBusModule>();
  return {
    ...original,
    eventBus: {
      emit: vi.fn().mockResolvedValue(undefined),
      emitStrict: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock('@/shared/utils/security/password.util.js', () => ({
  hashPassword: vi.fn().mockResolvedValue('hashed'),
  verifyPassword: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock('@/shared/utils/text/email.util.js', () => ({
  isDisposableEmailBlocked: vi.fn(() => false),
}));

vi.mock('@/shared/utils/security/anti-enumeration.util.js', () => ({
  enforceMinimumDuration: vi.fn().mockResolvedValue(undefined),
}));

// resetPassword now runs inside withTransaction + runWithPinnedDatabaseHandle; invoke the
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
      setLocalDatabaseConfig: vi.fn().mockResolvedValue(undefined),
    };
  },
);

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Blanket maintenance passthrough: services this suite touches (directly or via
    // cross-domain imports) may enter maintenance contexts (tombstoning, admin reads) —
    // the real wrapper opens a database.transaction() and CI's unit lane has no Postgres.
    withMaintenanceDatabaseContext: vi.fn(
      async ({ scope: _scope, callback }: { scope: unknown; callback: () => Promise<unknown> }) =>
        callback(),
    ),
    withAppDatabaseContext: vi.fn(
      async ({ scope: _scope, callback }: { scope: unknown; callback: () => Promise<unknown> }) =>
        callback(),
    ),
  };
});

const user = {
  id: 1,
  public_id: 'user_public',
  email: 'user@example.com',
  password_hash: 'hash',
  is_email_verified: false,
  status: 'ACTIVE',
};

describe('AuthMethodService', () => {
  const userService = {
    requireUserRecordByPublicId: vi.fn().mockResolvedValue(user),
    findByEmail: vi.fn().mockResolvedValue(user),
    findById: vi.fn().mockResolvedValue(user),
    updatePassword: vi.fn().mockResolvedValue(user),
    updateEmailVerified: vi.fn().mockResolvedValue(user),
    updateLoginAttempt: vi.fn().mockResolvedValue(user),
  } as unknown as UserService;

  const authMethodRepository = {
    listByUserId: vi.fn().mockResolvedValue([]),
    countActiveByUserId: vi.fn().mockResolvedValue(0),
    acquireCredentialMutationLock: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({ id: 2 }),
    revoke: vi.fn().mockResolvedValue({ id: 2 }),
    revokeUnlessLastLoginCapable: vi.fn().mockResolvedValue({ id: 2 }),
    revokeAllByUserId: vi.fn().mockResolvedValue(1),
    findByProviderUserId: vi.fn().mockResolvedValue(null),
    findTotpByUserId: vi.fn().mockResolvedValue(null),
    updateLastUsedAt: vi.fn().mockResolvedValue(undefined),
    findByIdForUser: vi.fn().mockResolvedValue(null),
    findByPublicIdForUser: vi.fn().mockResolvedValue(null),
    listMfaByUserId: vi.fn().mockResolvedValue([]),
    findMethodRevocationState: vi.fn().mockResolvedValue({ hasActive: false, hasRevoked: false }),
  } as unknown as AuthMethodRepository;

  const verificationTokenRepository = {
    invalidateAllForUser: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({ id: 3 }),
    consumeIfValid: vi.fn(),
    consumeOtpForUser: vi.fn(),
    findValidByTokenHash: vi.fn(),
    markUsed: vi.fn(),
  } as unknown as VerificationTokenRepository;

  const webauthnCredentialRepository = {
    listActiveByUserId: vi.fn().mockResolvedValue([]),
  };

  const service = new AuthMethodService(
    userService,
    authMethodRepository,
    verificationTokenRepository,
    webauthnCredentialRepository as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(user as never);
  });

  it('throws NotFoundError when user record is missing', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
    await expect(service.list('missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.create({
        userPublicId: 'missing',
        body: {
          method_type: 'EMAIL_CODE',
          is_primary: true,
        },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('revokeAllForUser throws when user is not found', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
    await expect(service.revokeAllForUser('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('hasLoginCapableMethod (sec-r5-M3)', () => {
    it('returns true when the user holds a login-capable method (OAUTH/EMAIL_CODE)', async () => {
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([
        { id: 4, user_id: 1, method_type: 'MFA_TOTP' },
        { id: 5, user_id: 1, method_type: 'OAUTH' },
      ] as never);
      await expect(service.hasLoginCapableMethod('user_public')).resolves.toBe(true);
    });

    it('returns false when the user holds only non-login-capable methods (MFA only)', async () => {
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([
        { id: 4, user_id: 1, method_type: 'MFA_TOTP' },
      ] as never);
      await expect(service.hasLoginCapableMethod('user_public')).resolves.toBe(false);
    });

    it('returns false when the user has no auth methods at all', async () => {
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([] as never);
      await expect(service.hasLoginCapableMethod('user_public')).resolves.toBe(false);
    });

    it('throws NotFoundError when the user record is missing', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
      await expect(service.hasLoginCapableMethod('missing')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('isLoginMethodTurnedOff (A-5)', () => {
    const query = {
      userPublicId: 'user_public',
      userId: 1,
      methodType: 'OAUTH',
      provider: 'google',
    };

    it('is true for a revoked method with no active row of it', async () => {
      vi.mocked(authMethodRepository.findMethodRevocationState).mockResolvedValueOnce({
        hasActive: false,
        hasRevoked: true,
      });
      await expect(service.isLoginMethodTurnedOff(query)).resolves.toBe(true);
      expect(authMethodRepository.findMethodRevocationState).toHaveBeenCalledWith(
        1,
        'OAUTH',
        'google',
      );
    });

    it('is false once the method was added back, or when it was never held', async () => {
      vi.mocked(authMethodRepository.findMethodRevocationState).mockResolvedValueOnce({
        hasActive: true,
        hasRevoked: true,
      });
      await expect(service.isLoginMethodTurnedOff(query)).resolves.toBe(false);
      vi.mocked(authMethodRepository.findMethodRevocationState).mockResolvedValueOnce({
        hasActive: false,
        hasRevoked: false,
      });
      await expect(service.isLoginMethodTurnedOff(query)).resolves.toBe(false);
    });
  });

  describe('hasActiveLoginCredential (counts passkeys — bare-account guard)', () => {
    it('returns true on a login-capable method and does not even query passkeys (short-circuit)', async () => {
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([
        { id: 5, user_id: 1, method_type: 'OAUTH' },
      ] as never);
      await expect(service.hasActiveLoginCredential('user_public')).resolves.toBe(true);
      expect(webauthnCredentialRepository.listActiveByUserId).not.toHaveBeenCalled();
    });

    it('returns true for a passkey-only account with no login-capable method', async () => {
      // The key regression: hasLoginCapableMethod would return false here, but a passkey IS a
      // credential — so the account is NOT a claimable bare placeholder.
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([
        { id: 4, user_id: 1, method_type: 'MFA_TOTP' },
      ] as never);
      vi.mocked(webauthnCredentialRepository.listActiveByUserId).mockResolvedValue([
        { id: 9, user_id: 1 },
      ] as never);
      await expect(service.hasActiveLoginCredential('user_public')).resolves.toBe(true);
      expect(webauthnCredentialRepository.listActiveByUserId).toHaveBeenCalledWith(user.id);
    });

    it('A-7: an EMAIL_CODE row on an unverified email is not a credential (send-code pre-registration)', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue({
        ...user,
        is_email_verified: false,
      } as never);
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([
        { id: 6, user_id: 1, method_type: 'EMAIL_CODE' },
      ] as never);
      vi.mocked(webauthnCredentialRepository.listActiveByUserId).mockResolvedValue([] as never);
      await expect(service.hasActiveLoginCredential('user_public')).resolves.toBe(false);
    });

    it('A-7: an EMAIL_CODE row on a verified email still counts', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue({
        ...user,
        is_email_verified: true,
      } as never);
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([
        { id: 6, user_id: 1, method_type: 'EMAIL_CODE' },
      ] as never);
      await expect(service.hasActiveLoginCredential('user_public')).resolves.toBe(true);
    });

    it('returns false when there is no login-capable method and no passkey (truly bare)', async () => {
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([] as never);
      vi.mocked(webauthnCredentialRepository.listActiveByUserId).mockResolvedValue([] as never);
      await expect(service.hasActiveLoginCredential('user_public')).resolves.toBe(false);
    });

    it('throws NotFoundError when the user record is missing', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
      await expect(service.hasActiveLoginCredential('missing')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('lists and mutates auth methods for user', async () => {
    // sec-A5 guard: `delete()` reads the target method then verifies that another
    // login-capable method survives. Provide both so the happy-path mutation
    // continues to exercise the create/delete/revokeAllForUser fan-out.
    // sec-new-B4: delete() now accepts a publicId string and uses findByPublicIdForUser.
    vi.mocked(authMethodRepository.findByPublicIdForUser).mockResolvedValue({
      id: 2,
      public_id: 'testpublicmid000000a',
      user_id: 1,
      method_type: 'OAUTH',
    } as never);
    vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([
      { id: 2, public_id: 'testpublicmid000000a', user_id: 1, method_type: 'OAUTH' },
      { id: 3, public_id: 'testpublicmid000000b', user_id: 1, method_type: 'EMAIL_CODE' },
    ] as never);
    await service.list('user_public');
    await service.create({
      userPublicId: 'user_public',
      body: {
        method_type: 'EMAIL_CODE',
        is_primary: true,
      },
    });
    await service.delete({ userPublicId: 'user_public', methodPublicId: 'testpublicmid000000a' });
    await service.revokeAllForUser('user_public');
    expect(authMethodRepository.create).toHaveBeenCalled();
  });

  it('AC-13.4: refuses to remove the email-code way with 409 email_code_always_on, before any revoke', async () => {
    vi.mocked(authMethodRepository.findByPublicIdForUser).mockResolvedValue({
      id: 4,
      public_id: 'testpublicmid000000c',
      user_id: 1,
      method_type: 'EMAIL_CODE',
    } as never);
    await expect(
      service.delete({ userPublicId: 'user_public', methodPublicId: 'testpublicmid000000c' }),
    ).rejects.toMatchObject({ statusCode: 409, reason: 'email_code_always_on' });
    expect(authMethodRepository.revokeUnlessLastLoginCapable).not.toHaveBeenCalled();
  });

  it('does not persist user-supplied provider identity fields on manual create', async () => {
    await service.create({ userPublicId: 'user_public', body: { method_type: 'EMAIL_CODE' } });
    const createArgs = vi.mocked(authMethodRepository.create).mock.calls.at(-1)?.[0];
    expect(createArgs).not.toHaveProperty('provider');
    expect(createArgs).not.toHaveProperty('provider_user_id');
  });

  it('rejects create once the per-user auth-method cap is reached (under the advisory lock)', async () => {
    vi.mocked(authMethodRepository.countActiveByUserId).mockResolvedValueOnce(
      MAX_LINKED_AUTH_METHODS_PER_USER,
    );
    await expect(
      service.create({ userPublicId: 'user_public', body: { method_type: 'EMAIL_CODE' } }),
    ).rejects.toBeInstanceOf(ConflictError);
    // The lock is taken before the count, and no row is inserted when the cap is hit.
    expect(authMethodRepository.acquireCredentialMutationLock).toHaveBeenCalledWith(user.id);
    expect(authMethodRepository.create).not.toHaveBeenCalled();
  });

  it('rejects manual OAUTH linking (account-takeover guard)', async () => {
    await expect(
      service.create({ userPublicId: 'user_public', body: { method_type: 'OAUTH' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(authMethodRepository.create).not.toHaveBeenCalled();
  });

  it('rejects manual provider identity binding via strict DTO', async () => {
    await expect(
      service.create({
        userPublicId: 'user_public',
        body: {
          method_type: 'OAUTH',
          provider: 'google',
          provider_user_id: 'victim-sub',
        } as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('delete throws when auth method is not found', async () => {
    // sec-new-B4: delete() accepts a publicId string; findByPublicIdForUser returning null triggers NotFoundError.
    vi.mocked(authMethodRepository.findByPublicIdForUser).mockResolvedValue(null);
    await expect(
      service.delete({ userPublicId: 'user_public', methodPublicId: 'testpublicmid000000x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('delete throws NotFoundError when user record is missing', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
    await expect(
      service.delete({ userPublicId: 'missing', methodPublicId: 'testpublicmid000000y' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('delegates repository helpers and links OAuth when missing', async () => {
    const oauthData = {
      user_id: user.id,
      method_type: 'OAUTH',
      provider: 'google',
      provider_user_id: 'gid',
      is_primary: true,
    } as const;

    vi.mocked(authMethodRepository.findByProviderUserId).mockResolvedValue(null);
    await service.findByProviderUserId({ provider: 'google', provider_user_id: 'gid' });
    await service.linkOAuthProviderIfMissing({ ownerPublicId: user.public_id, data: oauthData });
    expect(authMethodRepository.create).toHaveBeenCalledWith(oauthData);

    vi.mocked(authMethodRepository.findByProviderUserId).mockResolvedValue({ id: 9 } as never);
    await service.linkOAuthProviderIfMissing({ ownerPublicId: user.public_id, data: oauthData });
    expect(authMethodRepository.create).toHaveBeenCalledTimes(1);

    await service.linkOAuthProviderIfMissing({
      ownerPublicId: user.public_id,
      data: {
        user_id: user.id,
        method_type: 'PASSWORD',
      },
    });
    await service.findTotpByUserId(user.id);
    await service.createAuthMethodRecord(oauthData);
    await service.updateAuthMethodLastUsedAt({ methodId: 2, userId: user.id });
    await service.findAuthMethodByIdForUser({ methodId: 2, userId: user.id });
    await service.listMfaMethodsByUserId(user.id);
    vi.mocked(authMethodRepository.revoke).mockResolvedValue({ id: 2 } as never);
    await service.revokeAuthMethod({ methodId: 2, userId: user.id });
    expect(authMethodRepository.findTotpByUserId).toHaveBeenCalled();
    expect(authMethodRepository.updateLastUsedAt).toHaveBeenCalled();
    expect(authMethodRepository.findByIdForUser).toHaveBeenCalled();
    expect(authMethodRepository.listMfaByUserId).toHaveBeenCalled();
    expect(authMethodRepository.revoke).toHaveBeenCalled();
  });
});
