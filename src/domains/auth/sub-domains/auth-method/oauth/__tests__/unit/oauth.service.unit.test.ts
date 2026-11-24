import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { OAuthService } from '@/domains/auth/sub-domains/auth-method/oauth/oauth.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import type { OAuthProfile } from '@/domains/auth/sub-domains/auth-method/oauth/oauth.types.js';

vi.mock('@/domains/auth/sub-domains/auth-method/oauth/oauth-state.js', () => ({
  assertOAuthProviderSupported: vi.fn((provider: string) => provider),
  createOAuthState: vi
    .fn()
    .mockResolvedValue({ state: 'oauth-state', codeVerifier: 'verifier', nonce: 'nonce' }),
  consumeOAuthState: vi
    .fn()
    .mockResolvedValue({ provider: 'google', codeVerifier: 'verifier', nonceHash: 'nonce-hash' }),
  hashOAuthNonce: vi.fn().mockReturnValue('nonce-hash'),
  readLiveOAuthStateSeconds: vi.fn().mockResolvedValue(420),
  rememberOAuthProviderUser: vi.fn().mockResolvedValue(undefined),
  takeOAuthProviderUser: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/domains/auth/sub-domains/auth-method/oauth/oauth-pkce.js', () => ({
  derivePkceCodeChallengeS256: vi.fn().mockReturnValue('code-challenge'),
}));

vi.mock('@/domains/auth/sub-domains/auth-method/oauth/providers/google-oauth.provider.js', () => ({
  isGoogleOAuthConfigured: vi.fn().mockReturnValue(true),
  buildGoogleOAuthRedirectUrl: vi.fn().mockReturnValue('https://google.example/oauth'),
  exchangeGoogleOAuthCode: vi.fn().mockResolvedValue({
    email: 'oauth@example.com',
    name: 'OAuth User',
    avatar_url: 'https://google.example/avatar.png',
    provider_user_id: 'google-user-123',
  } satisfies OAuthProfile),
}));

vi.mock('@/domains/auth/sub-domains/auth-method/oauth/providers/apple-oauth.provider.js', () => ({
  isAppleOAuthConfigured: vi.fn().mockReturnValue(true),
  buildAppleOAuthRedirectUrl: vi.fn().mockReturnValue('https://apple.example/auth'),
  buildAppleAppCallbackUrl: vi.fn(
    (query: Record<string, string>) =>
      `https://app.example/callback/apple?${new URLSearchParams(query).toString()}`,
  ),
  exchangeAppleOAuthCode: vi.fn().mockResolvedValue({
    email: 'apple@example.com',
    provider_user_id: 'apple-sub-456',
  } satisfies OAuthProfile),
}));

vi.mock('@/domains/auth/sub-domains/auth-method/oauth/oauth-user-session.js', () => ({
  completeOAuthUserSession: vi.fn().mockResolvedValue({
    access_token: 'oauth-access',
    session_public_id: 'session_oauth',
  }),
}));

describe('OAuthService', () => {
  const redis = {} as never;
  const userService = {
    findUserRecordByPublicId: vi.fn(),
  };
  const authMethodService = {
    findByProviderUserId: vi.fn(),
    linkOAuthProviderIfMissing: vi.fn(),
    list: vi.fn(),
  };
  const authSessionService = { findActiveSessionByPublicId: vi.fn() };
  const organizationSettingsService = {
    userHasOrganizationRequiringMfa: vi.fn().mockResolvedValue(false),
  } as never;
  const mfaService = { createMfaSession: vi.fn() } as never;
  const service = new OAuthService(
    userService as unknown as UserService,
    authMethodService as unknown as AuthMethodService,
    authSessionService as unknown as AuthSessionService,
    redis,
    organizationSettingsService,
    mfaService,
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('listProviders answers the configured ones of Google and Apple — never GitHub', async () => {
    expect(service.listProviders()).toEqual({ providers: ['google', 'apple'] });
    const { isAppleOAuthConfigured } = await import(
      '@/domains/auth/sub-domains/auth-method/oauth/providers/apple-oauth.provider.js'
    );
    vi.mocked(isAppleOAuthConfigured).mockReturnValueOnce(false);
    expect(service.listProviders()).toEqual({ providers: ['google'] });
  });

  it('getRedirectUrl returns Google redirect plus a browser nonce', async () => {
    const result = await service.getRedirectUrl({ provider: 'google' });
    expect(result.redirect_url).toContain('google');
    expect(result.nonce).toBe('nonce');
  });

  it("getRedirectUrl gives Apple the nonce's hash and binds link mode into the state", async () => {
    const { createOAuthState } = await import(
      '@/domains/auth/sub-domains/auth-method/oauth/oauth-state.js'
    );
    const { buildAppleOAuthRedirectUrl } = await import(
      '@/domains/auth/sub-domains/auth-method/oauth/providers/apple-oauth.provider.js'
    );
    const link = { user_public_id: 'usr_a', session_public_id: 'ses_a' };
    const result = await service.getRedirectUrl({ provider: 'apple', link });
    expect(result.redirect_url).toContain('apple');
    expect(buildAppleOAuthRedirectUrl).toHaveBeenCalledWith({
      state: 'oauth-state',
      nonce: 'nonce-hash',
    });
    expect(createOAuthState).toHaveBeenCalledWith(expect.objectContaining({ link }));
  });

  it('getRedirectUrl answers 404 for a supported provider whose settings are unset (AT11)', async () => {
    const { isAppleOAuthConfigured } = await import(
      '@/domains/auth/sub-domains/auth-method/oauth/providers/apple-oauth.provider.js'
    );
    vi.mocked(isAppleOAuthConfigured).mockReturnValueOnce(false);
    await expect(service.getRedirectUrl({ provider: 'apple' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('handleCallback completes OAuth session for Google', async () => {
    const result = await service.handleCallback({
      provider: 'google',
      code: 'auth-code',
      state: 'oauth-state',
      nonce: 'nonce',
    });
    if (!('access_token' in result)) throw new Error('expected oauth session');
    expect(result.access_token).toBe('oauth-access');
    expect(result.session_public_id).toBe('session_oauth');
  });

  it('handleCallback uses default ip address when omitted', async () => {
    const { completeOAuthUserSession } = await import(
      '@/domains/auth/sub-domains/auth-method/oauth/oauth-user-session.js'
    );
    await service.handleCallback({
      provider: 'google',
      code: 'auth-code',
      state: 'oauth-state',
      nonce: 'nonce',
    });
    expect(completeOAuthUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: '127.0.0.1' }),
    );
  });

  it('handleCallback swaps Apple codes with the state nonce and adds the kept name', async () => {
    const { consumeOAuthState, takeOAuthProviderUser } = await import(
      '@/domains/auth/sub-domains/auth-method/oauth/oauth-state.js'
    );
    const { exchangeAppleOAuthCode } = await import(
      '@/domains/auth/sub-domains/auth-method/oauth/providers/apple-oauth.provider.js'
    );
    const { completeOAuthUserSession } = await import(
      '@/domains/auth/sub-domains/auth-method/oauth/oauth-user-session.js'
    );
    vi.mocked(consumeOAuthState).mockResolvedValueOnce({
      provider: 'apple',
      codeVerifier: 'verifier',
      nonceHash: 'apple-nonce-hash',
    });
    vi.mocked(takeOAuthProviderUser).mockResolvedValueOnce(
      JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' } }),
    );

    await service.handleCallback({
      provider: 'apple',
      code: 'apple-code',
      state: 'oauth-state',
      nonce: 'nonce',
    });

    expect(exchangeAppleOAuthCode).toHaveBeenCalledWith({
      code: 'apple-code',
      expectedNonce: 'apple-nonce-hash',
    });
    expect(completeOAuthUserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'apple',
        profile: {
          email: 'apple@example.com',
          provider_user_id: 'apple-sub-456',
          name: 'Ada Lovelace',
        },
      }),
    );
  });

  it('handleCallback exchanges Google codes with the PKCE verifier', async () => {
    const { consumeOAuthState } = await import(
      '@/domains/auth/sub-domains/auth-method/oauth/oauth-state.js'
    );
    const { exchangeGoogleOAuthCode } = await import(
      '@/domains/auth/sub-domains/auth-method/oauth/providers/google-oauth.provider.js'
    );
    vi.mocked(consumeOAuthState).mockResolvedValueOnce({
      provider: 'google',
      codeVerifier: 'gverifier',
      nonceHash: 'nonce-hash',
    });
    await service.handleCallback({
      provider: 'google',
      code: 'google-code',
      state: 'oauth-state',
      nonce: 'nonce',
      requestId: 'req-google',
    });
    expect(exchangeGoogleOAuthCode).toHaveBeenCalledWith({
      code: 'google-code',
      codeVerifier: 'gverifier',
      requestId: 'req-google',
    });
  });

  describe('receiveAppleFormCallback (route 124)', () => {
    it('keeps the user JSON with the state and sends the browser on with code and state', async () => {
      const { rememberOAuthProviderUser } = await import(
        '@/domains/auth/sub-domains/auth-method/oauth/oauth-state.js'
      );
      const location = await service.receiveAppleFormCallback({
        state: 'oauth-state',
        code: 'apple-code',
        user: '{"name":{"firstName":"Ada"}}',
      });
      expect(location).toBe('https://app.example/callback/apple?code=apple-code&state=oauth-state');
      expect(rememberOAuthProviderUser).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'oauth-state', ttlSeconds: 420 }),
      );
    });

    it('maps Apple errors and a spent state to the failed page reasons', async () => {
      const { readLiveOAuthStateSeconds } = await import(
        '@/domains/auth/sub-domains/auth-method/oauth/oauth-state.js'
      );
      await expect(
        service.receiveAppleFormCallback({ state: 's', error: 'user_cancelled_authorize' }),
      ).resolves.toContain('reason=oauth_cancelled');
      await expect(
        service.receiveAppleFormCallback({ state: 's', error: 'invalid_request' }),
      ).resolves.toContain('reason=oauth_failed');
      vi.mocked(readLiveOAuthStateSeconds).mockResolvedValueOnce(null);
      await expect(service.receiveAppleFormCallback({ state: 's', code: 'c' })).resolves.toContain(
        'reason=oauth_expired',
      );
    });
  });

  describe('linkProviderAccount (link mode, AT12)', () => {
    const link = { user_public_id: 'usr_a', session_public_id: 'ses_a' };
    const profile = { provider_user_id: 'google-sub-9', email: 'other@example.com' };
    const person = { id: 7, public_id: 'usr_a', status: 'ACTIVE', deleted_at: null };

    beforeEach(() => {
      userService.findUserRecordByPublicId.mockResolvedValue(person);
      authSessionService.findActiveSessionByPublicId.mockResolvedValue({ public_id: 'ses_a' });
    });

    it('refuses an account linked to someone else with provider_account_in_use', async () => {
      authMethodService.findByProviderUserId.mockResolvedValue({ user_id: 99 });
      const error = await service
        .linkProviderAccount({ provider: 'google', profile, link })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ reason: 'provider_account_in_use' });
      expect(authMethodService.linkOAuthProviderIfMissing).not.toHaveBeenCalled();
    });

    it('links the account even with another email and answers the linked way', async () => {
      authMethodService.findByProviderUserId.mockResolvedValue(null);
      const row = { public_id: 'aum_1', provider: 'google', provider_user_id: 'google-sub-9' };
      authMethodService.list.mockResolvedValue([row]);
      const result = await service.linkProviderAccount({ provider: 'google', profile, link });
      expect(authMethodService.linkOAuthProviderIfMissing).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerPublicId: 'usr_a',
          data: expect.objectContaining({ user_id: 7, provider_user_id: 'google-sub-9' }),
        }),
      );
      expect(result).toEqual({ linked_auth_method: row, user_public_id: 'usr_a' });
    });

    it('refuses when the bound session has ended — 401 oauth_expired', async () => {
      authSessionService.findActiveSessionByPublicId.mockResolvedValue(null);
      await expect(
        service.linkProviderAccount({ provider: 'google', profile, link }),
      ).rejects.toMatchObject({ statusCode: 401, reason: 'oauth_expired' });
    });
  });
});
