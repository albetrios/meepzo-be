import type { AuthContainer } from './auth.container.js';
import { createAuthSessionHandlers } from './handlers/auth-session.handlers.js';
import { createAuthEmailLoginHandlers } from './handlers/auth-email-login.handlers.js';
import { createAuthEmailConfirmationHandlers } from './handlers/auth-email-confirmation.handlers.js';
import { createAuthOauthHandlers } from './handlers/auth-oauth.handlers.js';
import { createAuthAuthMethodHandlers } from './handlers/auth-auth-method.handlers.js';
import { createAuthMfaHandlers } from './handlers/auth-mfa.handlers.js';
import { createAuthWebauthnHandlers } from './handlers/auth-webauthn.handlers.js';
import { createAuthMeContextHandlers } from './handlers/auth-me-context.handlers.js';

/** Composes the auth domain's Fastify route handler map from per-flow handler factories (session, email verification-code, confirm-email, OAuth, auth-method, MFA, WebAuthn). */
export function createAuthController(container: AuthContainer) {
  return {
    ...createAuthSessionHandlers(container),
    ...createAuthEmailLoginHandlers(container),
    ...createAuthEmailConfirmationHandlers(container),
    ...createAuthOauthHandlers(container),
    ...createAuthAuthMethodHandlers(container),
    ...createAuthMfaHandlers(container),
    ...createAuthWebauthnHandlers(container),
    ...createAuthMeContextHandlers(container),
  };
}
