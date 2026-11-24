import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { env } from '@/shared/config/env.config.js';
import type { FastifyInstance } from 'fastify';
import type { UserService } from '@/domains/user/user.service.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import type { MembershipService } from '@/domains/tenancy/sub-domains/membership/membership.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import type { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import { AuthMethodRepository } from './sub-domains/auth-method/auth-method.repository.js';
import { VerificationTokenRepository } from './sub-domains/auth-method/verification-token/verification-token.repository.js';
import { AuthSessionRepository } from './sub-domains/auth-session/auth-session.repository.js';
import { AuthService } from './auth.service.js';
import { AuthMethodService } from './sub-domains/auth-method/auth-method.service.js';
import { EmailLoginService } from './sub-domains/auth-method/email-login.service.js';
import { EmailConfirmationService } from './sub-domains/auth-method/email-confirmation.service.js';
import { OAuthService } from './sub-domains/auth-method/oauth/oauth.service.js';
import { MfaService } from './sub-domains/auth-mfa/auth-mfa.service.js';
import { WebauthnService } from './sub-domains/auth-webauthn/webauthn.service.js';
import { WebauthnCredentialRepository } from './sub-domains/auth-webauthn/webauthn-credential.repository.js';
import { AuthSessionService } from './sub-domains/auth-session/auth-session.service.js';
import { createSessionPlaceLookup } from './sub-domains/auth-session/session-place.js';
import { AuthMeContextService } from './auth-me-context.service.js';
import { TrustedDeviceRepository } from './sub-domains/auth-trusted-device/auth-trusted-device.repository.js';
import { TrustedDeviceService } from './sub-domains/auth-trusted-device/auth-trusted-device.service.js';

/** DI container shape for the auth domain: aggregates every sub-domain service consumed by routes, handlers, and other domains. */
export type AuthContainer = {
  authService: AuthService;
  authMethodService: AuthMethodService;
  emailLoginService: EmailLoginService;
  /** Confirm your email (feat-instagram-dm-sending § 11.B): route 133 in the user routes, route 134 here. */
  emailConfirmationService: EmailConfirmationService;
  oauthService: OAuthService;
  mfaService: MfaService;
  webauthnService: WebauthnService;
  authSessionService: AuthSessionService;
  authMeContextService: AuthMeContextService;
};

/** Builds the auth-domain {@link AuthContainer}: instantiates auth-method, email verification-code, confirm-email, OAuth, MFA, WebAuthn, and session services with their repositories and Redis. */
export function createAuthContainer({
  userService,
  organizationSettingsService,
  organizationService,
  authorizationService,
  membershipService,
  planAccessService,
}: {
  userService: UserService;
  organizationSettingsService: OrganizationSettingsService;
  organizationService: OrganizationService;
  authorizationService: AuthorizationService;
  /** Launch ROUTE #4: the caller's roles for /auth/me/context; the worker process omits it. */
  membershipService?: MembershipService;
  /** Owner decision D3: the active organization's `plan_access` for /auth/me/context; the worker omits it. */
  planAccessService?: Pick<SubscriptionService, 'getPlanAccess'>;
}): AuthContainer {
  const authMethodRepository = new AuthMethodRepository();
  const verificationTokenRepository = new VerificationTokenRepository();
  const authSessionRepository = new AuthSessionRepository();

  const trustedDeviceService = new TrustedDeviceService(new TrustedDeviceRepository());
  const authSessionService = new AuthSessionService(
    userService,
    authSessionRepository,
    trustedDeviceService,
    createSessionPlaceLookup({ databasePath: env.SESSION_PLACE_DATABASE_PATH }),
  );
  const authMethodService = new AuthMethodService(
    userService,
    authMethodRepository,
    verificationTokenRepository,
  );
  const mfaService = new MfaService(
    userService,
    authMethodService,
    authSessionService,
    redisConnection,
    organizationSettingsService,
    trustedDeviceService,
  );
  const authService = new AuthService(userService, authSessionService);
  const emailLoginService = new EmailLoginService(
    userService,
    verificationTokenRepository,
    organizationSettingsService,
    mfaService,
    authSessionService,
    authMethodService,
    redisConnection,
  );
  const emailConfirmationService = new EmailConfirmationService(
    userService,
    verificationTokenRepository,
  );
  const webauthnCredentialRepository = new WebauthnCredentialRepository();
  const webauthnService = new WebauthnService(
    userService,
    authSessionService,
    webauthnCredentialRepository,
    redisConnection,
    organizationSettingsService,
    mfaService,
    authMethodService,
  );
  const oauthService = new OAuthService(
    userService,
    authMethodService,
    authSessionService,
    redisConnection,
    organizationSettingsService,
    mfaService,
  );

  const authMeContextService = new AuthMeContextService(
    userService,
    organizationService,
    authorizationService,
    membershipService,
    planAccessService,
  );

  return {
    authService,
    authMethodService,
    emailLoginService,
    emailConfirmationService,
    oauthService,
    mfaService,
    webauthnService,
    authSessionService,
    authMeContextService,
  };
}

/** Decorates the Fastify instance with `app.authDomain` so routes and other domains can consume the auth services. */
export function registerAuthContainer(application: FastifyInstance): void {
  application.decorate(
    'authDomain',
    createAuthContainer({
      userService: application.userDomain.userService,
      organizationSettingsService: application.tenancyDomain.organizationSettingsService,
      organizationService: application.tenancyDomain.organizationService,
      authorizationService: application.tenancyDomain.authorizationService,
      membershipService: application.tenancyDomain.membershipService,
      planAccessService: application.billingDomain.subscriptionService,
    }),
  );
}
