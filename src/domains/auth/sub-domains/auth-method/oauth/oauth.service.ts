import type { Redis } from 'ioredis';
import { ConflictError, NotFoundError, UnauthorizedError } from '@/shared/errors/index.js';
import { assertUserAccountActive } from '@/shared/utils/auth/account-status.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import { AUTH_METHOD_TYPE } from '@/domains/auth/sub-domains/auth-method/auth-method.constants.js';
import {
  SUPPORTED_OAUTH_PROVIDERS,
  type OAuthLinkTarget,
  type OAuthProfile,
  type OAuthProvider,
} from './oauth.types.js';
import {
  assertOAuthProviderSupported,
  consumeOAuthState,
  createOAuthState,
  hashOAuthNonce,
  readLiveOAuthStateSeconds,
  rememberOAuthProviderUser,
  takeOAuthProviderUser,
} from './oauth-state.js';
import { derivePkceCodeChallengeS256 } from './oauth-pkce.js';
import {
  buildGoogleOAuthRedirectUrl,
  exchangeGoogleOAuthCode,
  isGoogleOAuthConfigured,
} from './providers/google-oauth.provider.js';
import {
  buildAppleAppCallbackUrl,
  buildAppleOAuthRedirectUrl,
  exchangeAppleOAuthCode,
  isAppleOAuthConfigured,
} from './providers/apple-oauth.provider.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import type { MfaService } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa.service.js';
import { completeOAuthUserSession } from './oauth-user-session.js';
import type { FirstFactorAuthResult } from '@/domains/auth/shared/complete-first-factor-auth.js';

export type { OAuthProvider } from './oauth.types.js';

/** Apple's `error` value when the person cancelled on Apple's page. */
const APPLE_USER_CANCELLED_ERROR = 'user_cancelled_authorize';

/** Whether a provider's env vars are all set, per provider. */
const OAUTH_PROVIDER_CONFIGURED: Readonly<Record<OAuthProvider, () => boolean>> = {
  google: isGoogleOAuthConfigured,
  apple: isAppleOAuthConfigured,
};

/**
 * Apple's form post (route 124), as the route schema accepted it.
 *
 * @remarks
 * Notes: `id_token` is not carried — route 143's code swap reads Apple's own; `user` is Apple's
 * JSON text (the name), sent on the first sign-in only.
 */
export interface AppleFormCallbackInput {
  state: string;
  code?: string | undefined;
  error?: string | undefined;
  user?: string | undefined;
}

/**
 * The live auth method a link-mode callback linked (or found already linked) — AT12.
 *
 * @remarks
 * Notes: the `auth.auth_methods` row as `AuthMethodService.list` reads it; the handler answers it
 * through the auth-method serializer.
 */
export type LinkedOAuthMethod = Awaited<ReturnType<AuthMethodService['list']>>[number];

/**
 * What the OAuth callback answers: a sign-in (session or the 2FA screen), or in link mode the
 * linked way.
 *
 * @remarks
 * Notes: the handler tells them apart by `linked_auth_method` (link mode — no session is minted)
 * and `mfa_required`.
 */
export type OAuthCallbackResult =
  | FirstFactorAuthResult
  | { linked_auth_method: LinkedOAuthMethod; user_public_id: string };

/** The name in Apple's first-time `user` JSON (`{"name":{"firstName","lastName"},"email"}`), or undefined. */
function readAppleUserName(userJson: string | null): string | undefined {
  if (!userJson) return undefined;
  try {
    const parsed = JSON.parse(userJson) as { name?: { firstName?: unknown; lastName?: unknown } };
    const parts = [parsed.name?.firstName, parsed.name?.lastName].filter(
      (part): part is string => typeof part === 'string' && part.trim().length > 0,
    );
    return parts.length > 0 ? parts.map((part) => part.trim()).join(' ') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Coordinates the OAuth authorize-and-callback dance for Google and Apple (routes 122–124, 143).
 *
 * @remarks
 * - **Algorithm:** `getRedirectUrl` mints a CSRF `state` plus an RFC 7636 PKCE verifier and a
 *   browser nonce via {@link createOAuthState} — in link mode (AT12) the state also binds the
 *   signed-in person and session — and returns the provider authorize URL (Google: the S256
 *   `code_challenge`; Apple: `response_mode=form_post` and the nonce's hash as Apple's `nonce`)
 *   and the `nonce` the handler sets as a cookie. `receiveAppleFormCallback` (route 124) checks
 *   the state is live without using it up, keeps Apple's first-time `user` JSON next to it and
 *   answers where to send the browser. `handleCallback` (route 143) consumes the `state` once via
 *   {@link consumeOAuthState} — which also enforces the browser nonce — swaps the code with the
 *   provider, then either signs the person in ({@link completeOAuthUserSession}) or, in link
 *   mode, links the provider account to the bound person ({@link OAuthService.linkProviderAccount}).
 * - **Failure modes:** an unknown or unconfigured provider → `NotFoundError` (404, AT11); a
 *   missing/mismatched `state` or browser nonce → 401 `oauth_expired`; the provider refusing →
 *   401 `oauth_failed`; the provider down → 503; link mode: the account someone else's → 409
 *   `provider_account_in_use`.
 * - **Side effects:** Redis (`oauth:state:*`, `oauth:provider-user:*`), `auth.auth_methods`,
 *   `auth.sessions`, a signed JWT. No event-bus emit.
 * - **Notes:** the `state` is single-use (deleted on `consumeOAuthState`); PKCE (Google) and the
 *   `id_token` nonce (Apple) bind the code to this flow, the nonce cookie to this browser.
 */
export class OAuthService {
  constructor(
    private readonly userService: UserService,
    private readonly authMethodService: AuthMethodService,
    private readonly authSessionService: AuthSessionService,
    private readonly redis: Redis,
    private readonly organizationSettingsService: OrganizationSettingsService,
    private readonly mfaService: MfaService,
  ) {}

  /** The configured providers of Google and Apple (route 122, AT14). */
  listProviders(): { providers: string[] } {
    return {
      providers: SUPPORTED_OAUTH_PROVIDERS.filter((provider) =>
        OAUTH_PROVIDER_CONFIGURED[provider](),
      ),
    };
  }

  /** The provider, when it is supported and configured; else 404 (an unset Apple reads as unknown, AT11). */
  private requireConfiguredProvider(provider: string): OAuthProvider {
    const normalizedProvider = assertOAuthProviderSupported(provider);
    if (!OAUTH_PROVIDER_CONFIGURED[normalizedProvider]()) {
      throw new NotFoundError('OAuth provider');
    }
    return normalizedProvider;
  }

  async getRedirectUrl({
    provider,
    link,
  }: {
    provider: string;
    link?: OAuthLinkTarget | undefined;
  }): Promise<{ redirect_url: string; nonce: string }> {
    const normalizedProvider = this.requireConfiguredProvider(provider);
    const { state, codeVerifier, nonce } = await createOAuthState({
      redis: this.redis,
      provider: normalizedProvider,
      link,
    });

    if (normalizedProvider === 'apple') {
      return {
        redirect_url: buildAppleOAuthRedirectUrl({ state, nonce: hashOAuthNonce(nonce) }),
        nonce,
      };
    }
    const codeChallenge = derivePkceCodeChallengeS256(codeVerifier);
    return { redirect_url: buildGoogleOAuthRedirectUrl({ state, codeChallenge }), nonce };
  }

  /**
   * Apple's form post (route 124): where to send the browser — never signs anyone in.
   *
   * @remarks
   * - **Algorithm:** Apple's `error` → the app's callback page with `reason` `oauth_cancelled`
   *   (`user_cancelled_authorize`) or `oauth_failed`; an unknown, spent or expired state →
   *   `oauth_expired`; no `code` → `oauth_failed`; else Apple's `user` JSON (sent on the first
   *   sign-in only) is kept next to the state for the state's remaining life and the browser goes
   *   to `<FRONTEND_URL>/callback/apple?code&state`. A later post without `user` leaves the kept
   *   one alone.
   * - **Failure modes:** none — every outcome is a place to send the browser.
   * - **Side effects:** may write `oauth:provider-user:<state>` (Redis).
   * - **Notes:** the state is only read here; the app's `GET …/apple/callback` uses it once.
   */
  async receiveAppleFormCallback(input: AppleFormCallbackInput): Promise<string> {
    if (input.error !== undefined) {
      return buildAppleAppCallbackUrl({
        reason: input.error === APPLE_USER_CANCELLED_ERROR ? 'oauth_cancelled' : 'oauth_failed',
      });
    }
    const secondsLeft = await readLiveOAuthStateSeconds({
      redis: this.redis,
      provider: 'apple',
      state: input.state,
    });
    if (secondsLeft === null) return buildAppleAppCallbackUrl({ reason: 'oauth_expired' });
    if (!input.code) return buildAppleAppCallbackUrl({ reason: 'oauth_failed' });
    if (input.user) {
      await rememberOAuthProviderUser({
        redis: this.redis,
        state: input.state,
        userJson: input.user,
        ttlSeconds: secondsLeft,
      });
    }
    return buildAppleAppCallbackUrl({ code: input.code, state: input.state });
  }

  async handleCallback(options: {
    provider: string;
    code: string;
    state: string | undefined;
    nonce?: string | undefined;
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
  }): Promise<OAuthCallbackResult> {
    const ipAddress = options.ipAddress ?? '127.0.0.1';
    const consumed = await consumeOAuthState({
      redis: this.redis,
      provider: options.provider,
      state: options.state,
      nonce: options.nonce,
    });
    const normalizedProvider = consumed.provider;

    const profile = await this.exchangeCode({
      provider: normalizedProvider,
      code: options.code,
      state: options.state as string,
      codeVerifier: consumed.codeVerifier,
      nonceHash: consumed.nonceHash,
      requestId: options.requestId,
    });

    if (consumed.link) {
      return this.linkProviderAccount({
        provider: normalizedProvider,
        profile,
        link: consumed.link,
      });
    }

    const session = await completeOAuthUserSession({
      userService: this.userService,
      authMethodService: this.authMethodService,
      authSessionService: this.authSessionService,
      organizationSettingsService: this.organizationSettingsService,
      mfaService: this.mfaService,
      provider: normalizedProvider,
      profile,
      ipAddress,
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });

    if ('mfa_required' in session) {
      return session;
    }

    return {
      access_token: session.access_token,
      session_public_id: session.session_public_id,
      session_refresh_secret: session.session_refresh_secret,
    };
  }

  /** Swaps the code with the provider; for Apple, adds the name route 124 kept (first sign-in only). */
  private async exchangeCode(options: {
    provider: OAuthProvider;
    code: string;
    state: string;
    codeVerifier: string;
    nonceHash: string;
    requestId?: string | undefined;
  }): Promise<OAuthProfile> {
    if (options.provider === 'google') {
      return exchangeGoogleOAuthCode(
        omitUndefined({
          code: options.code,
          codeVerifier: options.codeVerifier,
          requestId: options.requestId,
        }),
      );
    }
    const userJson = await takeOAuthProviderUser({ redis: this.redis, state: options.state });
    const profile = await exchangeAppleOAuthCode(
      omitUndefined({
        code: options.code,
        expectedNonce: options.nonceHash,
        requestId: options.requestId,
      }),
    );
    return omitUndefined({ ...profile, name: readAppleUserName(userJson) });
  }

  /**
   * Link mode (AT12): links the provider account to the person the state bound, even when it
   * carries another email, and answers the linked way.
   *
   * @remarks
   * - **Algorithm:** the bound person must still be active and the bound session live (else 401
   *   `oauth_expired`); the provider account live on someone else → 409
   *   `provider_account_in_use`; already this person's → answered as it is; else a new live
   *   `OAUTH` row — which also clears a "turned off" mark on that provider (A-5: the mark is a
   *   revoked row with no live one).
   * - **Failure modes:** as above; database errors propagate.
   * - **Side effects:** may insert one `auth.auth_methods` row.
   * - **Notes:** the handler records `auth.oauth.link` (WARNING). No session is minted.
   */
  async linkProviderAccount({
    provider,
    profile,
    link,
  }: {
    provider: OAuthProvider;
    profile: OAuthProfile;
    link: OAuthLinkTarget;
  }): Promise<{ linked_auth_method: LinkedOAuthMethod; user_public_id: string }> {
    const user = await this.userService.findUserRecordByPublicId(link.user_public_id);
    const session = user
      ? await this.authSessionService.findActiveSessionByPublicId(link.session_public_id)
      : null;
    if (!(user && session)) {
      throw new UnauthorizedError('errors:oauthInvalidState').withReason('oauth_expired');
    }
    assertUserAccountActive({ status: user.status, deleted_at: user.deleted_at });

    const existing = await this.authMethodService.findByProviderUserId({
      provider,
      provider_user_id: profile.provider_user_id,
    });
    if (existing && existing.user_id !== user.id) {
      throw new ConflictError('errors:oauthProviderAccountInUse').withReason(
        'provider_account_in_use',
      );
    }
    if (!existing) {
      await this.authMethodService.linkOAuthProviderIfMissing({
        ownerPublicId: user.public_id,
        data: {
          user_id: user.id,
          method_type: AUTH_METHOD_TYPE.OAUTH,
          provider,
          provider_user_id: profile.provider_user_id,
          is_primary: false,
          created_by_user_id: user.id,
        },
      });
    }

    const methods = await this.authMethodService.list(user.public_id);
    const linked = methods.find(
      (method) =>
        method.provider === provider && method.provider_user_id === profile.provider_user_id,
    );
    if (!linked) {
      throw new UnauthorizedError('errors:oauthInvalidState').withReason('oauth_expired');
    }
    return { linked_auth_method: linked, user_public_id: user.public_id };
  }
}
