import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { captchaPreHandler } from '@/shared/middlewares/security/captcha.middleware.js';
import {
  requireRecentStepUpPreHandler,
  requireRecentStepUpWhenQueryIs,
  requireStrongRecentStepUpPreHandler,
} from '@/shared/middlewares/core/recent-step-up.middleware.js';
import {
  MODERATE_AUTHED_RATE_LIMIT,
  REFRESH_RATE_LIMIT,
  STRICT_AUTHED_RATE_LIMIT,
  STRICT_PUBLIC_RATE_LIMIT,
} from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { createPerEmailRateLimitPreHandler } from '@/shared/middlewares/rate-limit/per-email-rate-limit.js';
import { authenticateWhenBearerPresent } from '@/shared/middlewares/core/auth.middleware.js';
import { OAUTH_FORM_CALLBACK_BODY_LIMIT_BYTES } from '@/shared/constants/limits.constants.js';
import { createAuthController } from './auth.controller.js';
import { OAUTH_LINK_INTENT } from '@/domains/auth/sub-domains/auth-method/oauth/oauth.types.js';
import {
  AppleFormCallbackDto,
  authMethodPublicIdParamsDto,
  CreateAuthMethodDto,
  EmailConfirmDto,
  EmailLoginDto,
  EmailSendCodeDto,
  MfaEnrollConfirmDto,
  MfaEnrollDto,
  MfaLoginVerifyDto,
  MfaVerifyDto,
  mfaMethodIdParamsDto,
  OauthCallbackQueryDto,
  oauthProviderParamsDto,
  OauthStartQueryDto,
  sessionIdParamsDto,
  StepUpVerifyDto,
} from './auth.dto.js';
import {
  webauthnAuthenticateOptionsDto,
  webauthnAuthenticateVerifyDto,
  webauthnCredentialIdParamsDto,
  webauthnRegisterVerifyDto,
} from './sub-domains/auth-webauthn/webauthn.dto.js';

/** Fastify plugin that registers all `/api/v1/auth/*` routes — logout, refresh, email verification-code login, the confirm-email link, OAuth, MFA, WebAuthn, sessions, and auth-method management (no password routes, P84). */
export const authRoutesPlugin: FastifyPluginAsync = async (app) => {
  const controller = createAuthController(app.authDomain);
  const zodApplication = app.withTypeProvider<ZodTypeProvider>();

  // Public — strict rate limits on the email-code endpoints.
  // Per-identity (per-email) throttle layered on top of the IP-only STRICT_PUBLIC_RATE_LIMIT.
  // Applied to unauthenticated credential and outbound-email endpoints so abuse cannot bypass
  // the cap by rotating spoofed IPs (defense in depth alongside Turnstile CAPTCHA).
  // A standalone limiter, so it counts even though the route's IP limit already ran this request.
  const perEmailRateLimit = createPerEmailRateLimitPreHandler(app);

  zodApplication.post(
    '/logout',
    {
      ...STRICT_PUBLIC_RATE_LIMIT,
      schema: {
        summary: 'Logout current session',
        description:
          'Invalidates the current session and refresh token. Requires a valid bearer token.',
        tags: ['Auth'],
      },
    },
    controller.logout,
  );
  zodApplication.post('/email/send-code', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    preHandler: [perEmailRateLimit, captchaPreHandler],
    schema: {
      summary: 'Send email sign-in code',
      description:
        'Sends a one-time 6-digit verification code to the provided email address for passwordless login or sign-up. Answers the same for a known and an unknown email (no account enumeration): resend_after_seconds (when a new code may be asked) and expires_in_seconds (900). A resend within 60 seconds of the last code is refused with 429 code_resend_too_soon and retry_after_seconds.',
      tags: ['Email Login'],
      body: EmailSendCodeDto,
    },
    handler: controller.sendEmailCode,
  });
  zodApplication.post('/email/login', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    preHandler: [captchaPreHandler],
    schema: {
      summary: 'Log in with an email verification code',
      description:
        'Validates the 6-digit email verification code and returns an access token + session on success. If MFA is enabled, returns a challenge requiring a second factor. Refusals carry a reason: 401 code_wrong (+ tries_left; also an unknown email or a used code), 401 code_expired (the newest code is over 15 minutes old), 401 code_used_up (5 wrong tries on this code), 429 code_day_limit (+ retry_after_seconds; 20 wrong tries for this email in 24 hours).',
      tags: ['Email Login'],
      body: EmailLoginDto,
    },
    handler: controller.emailLogin,
  });
  // Route 134 (feat-instagram-dm-sending UN7): the emailed link's page posts its token here. No
  // captcha — the 32-byte token is the proof and a guess space no captcha would shrink; the strict
  // public limit (as the former reset route) bounds probing.
  zodApplication.post('/email/confirm', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    schema: {
      summary: 'Confirm the email with the emailed link',
      description:
        "Public — body { token }, the token of the link `POST /users/me/email-confirmation` emailed. Consumes the one-use token and marks the person's email confirmed: 200 { is_email_verified: true }. A person whose email is already confirmed (a code sign-in confirmed it) gets the same success with nothing changed. An unknown, spent or expired (over 24 hours) token is 400 with reason email_confirm_token_invalid. No session is made.",
      tags: ['Email Login'],
      body: EmailConfirmDto,
    },
    handler: controller.confirmEmail,
  });
  zodApplication.get(
    '/oauth/providers',
    {
      ...STRICT_PUBLIC_RATE_LIMIT,
      schema: {
        summary: 'List available OAuth providers',
        description:
          'Returns the configured sign-in providers of Google and Apple ({ providers: ["google", "apple"] }); a provider whose settings are unset is left out.',
        tags: ['OAuth'],
      },
    },
    controller.listOauthProviders,
  );
  // No captcha: this only returns the provider's authorization URL (with a PKCE/state nonce);
  // Google/Apple authenticate the user themselves, and the strict public rate limit still
  // applies. A Turnstile challenge here was the slowest part of "Sign in with Google".
  // `intent=link` (AT12) needs a bearer and a recent step-up — read optionally, so the route stays
  // the PUBLIC sign-in start without it.
  zodApplication.get('/oauth/:provider', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    preHandler: [
      authenticateWhenBearerPresent,
      requireRecentStepUpWhenQueryIs({ field: 'intent', value: OAUTH_LINK_INTENT }),
    ],
    schema: {
      summary: 'Initiate OAuth flow',
      description:
        'Returns the OAuth provider authorization URL and nonce cookie for a browser client to begin the flow (provider google or apple; any other is a 400 on provider; a provider whose settings are unset is a 404). Apple is asked for response_mode=form_post with the name and email scopes, so it posts its answer to POST /auth/oauth/apple/callback. With intent=link (a bearer and a recent step-up required — 401 without a bearer, 403 recent_step_up_required without the step-up) the flow links that Google or Apple account to the signed-in person instead of signing in.',
      tags: ['OAuth'],
      params: oauthProviderParamsDto,
      querystring: OauthStartQueryDto,
    },
    handler: controller.oauthRedirect,
  });
  // Apple's form callback (AT10, route 124): Apple posts application/x-www-form-urlencoded, the
  // only body parser of this encapsulated context (so any other body answers 415), under a 16 KiB
  // limit (413). No captcha (Apple posts it) and no cookie of ours arrives on this cross-site POST
  // — the nonce cookie is checked by the app's GET …/apple/callback. The one named exception to
  // the method→status policy: it answers 303 (P85, METHOD_STATUS_POLICY_EXCEPTIONS).
  await app.register(async (formApplication) => {
    formApplication.removeAllContentTypeParsers();
    formApplication.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );
    // Named like the outer one on purpose: the route catalogue and the OpenAPI extractor find a
    // route by that name.
    const zodApplication = formApplication.withTypeProvider<ZodTypeProvider>();
    zodApplication.post('/oauth/apple/callback', {
      ...STRICT_PUBLIC_RATE_LIMIT,
      bodyLimit: OAUTH_FORM_CALLBACK_BODY_LIMIT_BYTES,
      schema: {
        summary: "Apple's sign-in form callback",
        description:
          "Apple posts its sign-in answer here (response_mode=form_post) as an application/x-www-form-urlencoded form: state, code or error, user (Apple's JSON with the name, sent the first time only, at most 4 KiB) and id_token (ignored here). Never signs anyone in: it checks the state is live without using it up, keeps the user JSON next to the state for the state's life, and answers 303 with Location <FRONTEND_URL>/callback/apple?code&state — the app then calls GET /auth/oauth/apple/callback with the nonce cookie. Apple's error answers 303 to the same page with reason oauth_cancelled (user_cancelled_authorize) or oauth_failed; an unknown, spent or expired state answers 303 with reason oauth_expired. A missing state is a 400; a body over 16 KiB a 413; a body that is not a form a 415. The one named exception to the method→status policy (303).",
        tags: ['OAuth'],
        body: AppleFormCallbackDto,
      },
      handler: controller.appleFormCallback,
    });
  });
  zodApplication.get('/oauth/:provider/callback', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    schema: {
      summary: 'OAuth callback',
      description:
        "Handles the OAuth provider callback after user authorization (google or apple; for Apple the app calls it after POST /auth/oauth/apple/callback sent the browser to its page). Uses the state once and checks the nonce cookie, swaps the code for tokens, matches the person by the provider account (Apple's later sign-ins may carry no email), then by email, and signs in — creating the person or linking the provider to a verified account. In link mode (the flow began with intent=link) it links that Google or Apple account to the signed-in person, even with another email, and answers the linked way instead of a session; an account already linked to someone else is a 409 provider_account_in_use. Refusals carry a reason: 401 oauth_expired (state missing, spent, expired or not this browser's), 401 oauth_failed (the provider refused the code or its answer did not verify), 403 oauth_link_needs_verified_email, 403 login_method_turned_off, 401 account_not_active.",
      tags: ['OAuth'],
      params: oauthProviderParamsDto,
      querystring: OauthCallbackQueryDto,
    },
    handler: controller.oauthCallback,
  });
  zodApplication.post(
    '/mfa/login',
    {
      ...STRICT_PUBLIC_RATE_LIMIT,
      // sec-new-A1: add bot-protection at the MFA step. The mfa_session_token is
      // single-use (GETDEL), so per-email rate-limiting is already enforced at
      // the first factor that mints the token (POST /auth/email/login). Captcha here adds a second
      // friction layer against automated TOTP guessing from accumulated tokens.
      preHandler: [captchaPreHandler],
      schema: {
        summary: 'Complete MFA during login',
        description:
          "Completes the login flow for an MFA-enabled account. Requires the short-lived mfa_session_token issued by the first factor (email code, OAuth or passkey), plus a valid TOTP or recovery code. Returns access and refresh tokens and sets the session cookie on success. With trust_device true a right code also sets the httpOnly trusted_device cookie for 30 days: the next sign-in on this browser skips the code — never when one of the person's organizations requires 2FA, never for a super_admin, and never for a step-up (at most 10 trusted devices per person; an 11th ends the oldest). A wrong code answers 401 mfa_code_wrong with tries_left; over 10 wrong codes in 15 minutes answers 429 mfa_locked with retry_after_seconds; an unknown or expired mfa_session_token answers 401 mfa_session_invalid.",
        tags: ['MFA'],
        body: MfaLoginVerifyDto,
      },
    },
    controller.verifyMfaLogin,
  );
  zodApplication.post('/webauthn/authenticate/options', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    preHandler: [perEmailRateLimit, captchaPreHandler],
    schema: {
      summary: 'Begin passkey authentication',
      description:
        'Returns WebAuthn authentication options and an opaque challenge token for a passwordless login ceremony. The client echoes the challenge back at /auth/webauthn/authenticate/verify. Public endpoint used during login.',
      tags: ['WebAuthn'],
      body: webauthnAuthenticateOptionsDto,
    },
    handler: controller.webauthnAuthenticateOptions,
  });
  zodApplication.post('/webauthn/authenticate/verify', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    schema: {
      summary: 'Complete passkey authentication',
      description:
        'Verifies the assertion response from a WebAuthn authentication ceremony and, on success, returns access and refresh tokens and sets the session cookie. Public endpoint used during login.',
      tags: ['WebAuthn'],
      body: webauthnAuthenticateVerifyDto,
    },
    handler: controller.webauthnAuthenticateVerify,
  });
  zodApplication.post(
    '/refresh',
    {
      ...REFRESH_RATE_LIMIT,
      schema: {
        summary: 'Refresh access token',
        description:
          'Exchanges a valid session cookie for a new short-lived access token. The session_id httpOnly cookie is sent automatically by the browser. When ALLOWED_ORIGINS is set, an Origin header must match that allowlist (403 otherwise); a request without Origin (a non-browser client) must send X-CSRF-Token matching the csrf_token cookie (403 otherwise).',
        tags: ['Token'],
      },
    },
    controller.refreshToken,
  );
  zodApplication.post(
    '/switch-to-personal',
    {
      onRequest: [app.authenticate],
      // Per-user cap: each switch re-mints a JWT and hits the DB, so throttle like the other
      // moderate authed operations rather than leaving it on the global limiter alone.
      ...MODERATE_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Switch to personal organization',
        description:
          "Re-mints the access token scoped to the caller's personal organization (no body — the server resolves it; never 403 for membership — only 403 with reason `mfa_required` when the caller has set their own personal organization to require MFA and this session has not proved a second factor). Returns a new access token; the client swaps its Bearer to it. Also returns the active organization (with its `plan_access`), `my_permissions` and `global_role`, so the client repaints without a follow-up `GET /auth/me/context`.",
        tags: ['Organization'],
      },
    },
    controller.switchToPersonalOrganization,
  );
  zodApplication.post(
    '/switch-to-organization',
    {
      onRequest: [app.authenticate],
      ...MODERATE_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Switch active organization',
        description:
          "Re-mints the access token scoped to the given organization after validating the caller's active membership (403 if not a member). When the organization's security policy requires MFA and this session has not proved a second factor, returns 403 with reason `mfa_required` — complete `POST /auth/me/mfa/verify` (or enroll MFA) and switch again; the re-minted token then carries `amr: ['mfa']`. Returns a new access token; the client swaps its Bearer to it, together with the active organization (with its `plan_access` — `active`, `grace` or `read_only`), `my_permissions` and `global_role`, so the client repaints without a follow-up `GET /auth/me/context`. The organization is also remembered as the caller's login default: the next sign-in opens it while the membership stays active.",
        tags: ['Organization'],
        body: z.object({
          organization_id: z
            .string()
            .min(1)
            .describe('Target organization id (`org_…`) the caller is an active member of.'),
        }),
      },
    },
    controller.switchToOrganization,
  );

  // Authenticated
  zodApplication.post(
    '/step-up',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Step-up (re-authenticate)',
        description:
          'Opens a short "recent step-up" window on this session, required before sensitive credential mutations. Re-verify with the 6-digit email code (send one with POST /auth/email/send-code). For a person without settled two-factor sign-in the window is strong: it can revoke sessions and remove a passkey, a sign-in way or a 2FA factor. A person with settled 2FA is refused with 403 mfa_step_up_required and steps up with POST /auth/me/mfa/verify instead (a factor enrolled in the last 72 hours under an email-code window is not settled yet). Answers { stepped_up, factor }. A wrong code answers 401 code_wrong with tries_left, 401 code_expired or 401 code_used_up.',
        tags: ['Auth'],
        body: StepUpVerifyDto,
      },
    },
    controller.stepUp,
  );
  zodApplication.post(
    '/me/mfa/enroll',
    {
      onRequest: [app.authenticate],
      preHandler: [requireRecentStepUpPreHandler],
      config: { ...STRICT_AUTHED_RATE_LIMIT.config },
      schema: {
        summary: 'Begin MFA enrollment (phase 1 of 2)',
        description:
          'Stages a TOTP secret in Redis and returns it with a provisioning URI for authenticator app setup. Phase 2 (`POST /auth/me/mfa/enroll/confirm`) verifies a fresh code and atomically persists the auth method, generates recovery codes, and flips is_mfa_enabled. Nothing is written to Postgres at this step.',
        tags: ['MFA'],
        body: MfaEnrollDto,
      },
    },
    controller.enrollMfa,
  );
  zodApplication.post(
    '/me/mfa/enroll/confirm',
    {
      onRequest: [app.authenticate],
      preHandler: [requireRecentStepUpPreHandler],
      config: { ...STRICT_AUTHED_RATE_LIMIT.config },
      schema: {
        summary: 'Confirm MFA enrollment (phase 2 of 2)',
        description:
          'Verifies a 6-digit TOTP code against the secret staged by `POST /auth/me/mfa/enroll`. On success the auth method is persisted, recovery codes are generated and hashed, and is_mfa_enabled is flipped. The current session is marked as having proved a second factor (organizations requiring MFA admit it after the next switch or refresh). The plaintext recovery codes are returned EXACTLY ONCE in this response.',
        tags: ['MFA'],
        body: MfaEnrollConfirmDto,
      },
    },
    controller.confirmEnrollMfa,
  );
  zodApplication.post(
    '/me/webauthn/register/options',
    {
      onRequest: [app.authenticate],
      preHandler: [requireRecentStepUpPreHandler],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Begin passkey registration',
        description:
          'Returns WebAuthn registration options and an opaque challenge token the client echoes back at /auth/me/webauthn/register/verify. Requires recent step-up authentication.',
        tags: ['WebAuthn'],
        body: z.object({}).strict(),
      },
    },
    controller.webauthnRegisterOptions,
  );
  zodApplication.post(
    '/me/webauthn/register/verify',
    {
      onRequest: [app.authenticate],
      preHandler: [requireRecentStepUpPreHandler],
      config: { ...STRICT_AUTHED_RATE_LIMIT.config },
      schema: {
        summary: 'Complete passkey registration',
        description:
          'Verifies the attestation response from a WebAuthn registration ceremony and persists the credential. Requires recent step-up authentication.',
        tags: ['WebAuthn'],
        body: webauthnRegisterVerifyDto,
      },
    },
    controller.webauthnRegisterVerify,
  );
  zodApplication.get(
    '/me/webauthn/credentials',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'List registered passkeys',
        description:
          'Returns the authenticated user’s active WebAuthn passkeys (opaque id, device type, transports, created/last-used timestamps). Never returns credential material or the raw WebAuthn credential blob.',
        tags: ['WebAuthn'],
      },
    },
    controller.webauthnListCredentials,
  );
  zodApplication.delete<{ Params: { credential_id: string } }>(
    '/me/webauthn/credentials/:credential_id',
    {
      onRequest: [app.authenticate],
      // Destructive: a strong step-up (2FA, or the email code without settled 2FA — AT15; sec-A2).
      preHandler: [requireStrongRecentStepUpPreHandler],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Revoke a passkey',
        description:
          'Revokes one of the authenticated user’s passkeys by its opaque id. Requires a strong recent step-up on this session: the 2FA code (POST /auth/me/mfa/verify), or the email code (POST /auth/step-up) for a person without settled 2FA. Refused with 409 if it would remove a passkey-only user’s last remaining login credential.',
        tags: ['WebAuthn'],
        params: webauthnCredentialIdParamsDto,
      },
    },
    controller.webauthnRevokeCredential,
  );
  zodApplication.get(
    '/me/mfa',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'List enrolled MFA methods',
        description: 'Returns all MFA methods enrolled by the authenticated user.',
        tags: ['MFA'],
      },
    },
    controller.listMfaMethods,
  );
  zodApplication.delete<{ Params: { mfa_method_id: string } }>(
    '/me/mfa/:mfa_method_id',
    {
      onRequest: [app.authenticate],
      // Destructive: a strong step-up (2FA, or the email code without settled 2FA — AT15; sec-A2).
      preHandler: [requireStrongRecentStepUpPreHandler],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Remove MFA method',
        description:
          "Deletes an enrolled MFA method. Requires a strong recent step-up on this session: the 2FA code (POST /auth/me/mfa/verify), or the email code (POST /auth/step-up) for a person without settled 2FA. Cannot remove the last MFA method if MFA is required by organization policy. Removing the last one turns 2FA off and ends every trusted device of the person (and clears this browser's trusted_device cookie).",
        tags: ['MFA'],
        params: mfaMethodIdParamsDto,
      },
    },
    controller.deleteMfa,
  );
  zodApplication.delete(
    '/me/sessions',
    {
      onRequest: [app.authenticate],
      // sec-A7: a stolen bearer must not be able to kick the legitimate user out of their
      // own browser. Requiring recent step-up forces the attacker to also possess the
      // second factor (sec-A1 blocks the email-code step-up path for accounts with settled 2FA).
      // A STRONG step-up is required: 2FA, or the email code for a person without settled 2FA
      // (AT15 — their mailbox can already sign them in, so it gives no new power).
      preHandler: [requireStrongRecentStepUpPreHandler],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Revoke all sessions',
        description:
          "Revokes all active sessions for the authenticated user except the current one, and ends every trusted device but this browser's (its trusted_device cookie). Requires a strong recent step-up on this session: the 2FA code (POST /auth/me/mfa/verify), or the email code (POST /auth/step-up) for a person without settled 2FA.",
        tags: ['Session'],
      },
    },
    controller.revokeAllSessions,
  );
  zodApplication.post(
    '/me/mfa/verify',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Verify MFA code',
        description:
          "Validates a TOTP code as an authenticated MFA step-up. On success the current session is marked as having proved a second factor, so organizations requiring MFA admit it: re-mint the token (switch organization or refresh) to receive `amr: ['mfa']`. A factor enrolled under an email-code step-up window opens only a weak step-up window (enough to enroll, not to revoke sessions or delete a credential) for 72 hours after enrollment, and always on the session that enrolled it — meanwhile the email code (POST /auth/step-up) still opens a strong one.",
        tags: ['MFA'],
        body: MfaVerifyDto,
      },
    },
    controller.verifyMfa,
  );
  zodApplication.get(
    '/me/context',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Get my session context',
        description:
          "Returns the authenticated caller's identity, active organization (with its `type` and `plan_access`: `state` `active` — a live plan, Free never ends —, `grace` — a lapsed paid plan, writes allowed until `grace_ends_at` — or `read_only` — a lapsed or cancelled paid plan since `grace_ends_at`, the automation writes under /app/automations answer 403 `organization_read_only`; `trial_ends_at` while a trial runs), their own membership there (`membership_id` — the id of their `GET /app/memberships` row), the roles they hold (`my_role_ids`, and `my_roles` naming each with its `name`, `tone` and `is_system` — the main role first), the permission codes they hold in that organization, and their global role. One authoritative call for rendering a permission-aware UI — identical for personal and team organizations; without an active organization or a live membership `membership_id` is null and the role lists are empty. The organizations the caller belongs to are NOT here: that list is paginated and lives at GET /users/me/organizations.",
        tags: ['Auth'],
      },
    },
    controller.getMeContext,
  );
  zodApplication.get(
    '/me/auth-methods',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'List my auth methods',
        description:
          'Returns all authentication methods (OAuth, email code, MFA) linked to the authenticated user.',
        tags: ['Auth Method'],
      },
    },
    controller.listAuthMethods,
  );
  zodApplication.post(
    '/me/auth-methods',
    {
      onRequest: [app.authenticate],
      preHandler: [requireRecentStepUpPreHandler],
      config: { ...STRICT_AUTHED_RATE_LIMIT.config },
      schema: {
        summary: 'Add auth method',
        description:
          "Links a new authentication method (e.g. OAuth provider) to the authenticated user's account.",
        tags: ['Auth Method'],
        body: CreateAuthMethodDto,
      },
    },
    controller.createAuthMethod,
  );
  zodApplication.delete<{ Params: { auth_method_id: string } }>(
    '/me/auth-methods/:auth_method_id',
    {
      onRequest: [app.authenticate],
      // Destructive: a strong step-up (2FA, or the email code without settled 2FA — AT15; sec-A2).
      preHandler: [requireStrongRecentStepUpPreHandler],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Remove auth method',
        description:
          "Removes an authentication method from the user's account. Requires a strong recent step-up on this session: the 2FA code (POST /auth/me/mfa/verify), or the email code (POST /auth/step-up) for a person without settled 2FA. The email-code way can never be removed (409 email_code_always_on); the last sign-in way cannot be removed either.",
        tags: ['Auth Method'],
        params: authMethodPublicIdParamsDto,
      },
    },
    controller.deleteAuthMethod,
  );
  zodApplication.get(
    '/me/sessions',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'List my active sessions',
        description:
          'Returns all active sessions for the authenticated user, including the source IP and parsed device/browser info.',
        tags: ['Session'],
      },
    },
    controller.listSessions,
  );
  zodApplication.delete<{ Params: { session_id: string } }>(
    '/me/sessions/:session_id',
    {
      onRequest: [app.authenticate],
      // sec-A7: see the comment on DELETE /me/sessions above — same threat model (strong step-up).
      preHandler: [requireStrongRecentStepUpPreHandler],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Revoke a specific session',
        description:
          'Revokes a specific session by its ID. Cannot revoke the current session (use logout instead). Requires a strong recent step-up on this session: the 2FA code (POST /auth/me/mfa/verify), or the email code (POST /auth/step-up) for a person without settled 2FA.',
        tags: ['Session'],
        params: sessionIdParamsDto,
      },
    },
    controller.revokeSession,
  );
};
