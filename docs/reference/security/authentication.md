# Authentication

meepzo-be has no passwords (feat-instagram-dm-sending P84 — the password routes and every password code path are removed, every stored hash emptied) — **owner change 2026-11-25 (P251): the four password routes (`POST /auth/login`, `/auth/password/forgot`, `/auth/password/reset`, `/auth/password/change`) are kept disabled behind `PASSWORD_ROUTES_ENABLED` (default `false` → not registered, 404) instead of removed; with the flag on they restore argon2id login with the lockout and per-IP throttle, the reset email and the change after a step-up (code marker `PASSWORD-ROUTES-DISABLED`)**; a person signs in with an emailed six-digit code, Google or Apple (Apple posts its answer to `POST /auth/oauth/apple/callback`, which answers 303 to the app page; a signed-in person with a recent step-up links either with `GET /auth/oauth/{provider}?intent=link`), or a passkey; a person with two-factor sign-in (TOTP) adds the 2FA code — or skips it on a trusted browser. Behind sign-in sit JWT access tokens, session cookies (each session carries its sign-in place), the step-up window, and organization API keys. The `auth.users.password_hash` column stays, empty, and `PASSWORD` remains a stored `auth.auth_methods.method_type` only on historic revoked rows (the CHECK keeps it); the API never accepts or returns it (`LIVE_AUTH_METHOD_TYPES`). Session CSRF and cookie rules are documented in [csrf-and-session-cookies.md](../security/csrf-and-session-cookies.md).

## Current methods

| Method                  | Entry routes                            | Notes                                            |
| ----------------------- | --------------------------------------- | ------------------------------------------------ |
| Email verification-code | `POST /api/v1/auth/email/*`             | Passwordless email flow                          |
| OAuth (Google, Apple)   | `GET /api/v1/auth/oauth/{provider}`     | PKCE + state cookie; Apple answers by `form_post` to `POST /api/v1/auth/oauth/apple/callback` (303) |
| API key                 | `Authorization: Bearer` with key prefix | Organization-scoped permissions                  |
| MFA                     | TOTP + recovery codes                   | Encrypted secrets at rest                        |
| Trusted device          | `POST /api/v1/auth/mfa/login` `trust_device` | Skips the 2FA code on that browser for 30 days (`auth.trusted_devices`, hash only; never for `super_admin` or a 2FA-required organization) |
| Step-up                 | `POST /api/v1/auth/step-up` (email code) · `POST /api/v1/auth/me/mfa/verify` | The email code is a strong step-up without settled 2FA (AT15) |
| WebAuthn / passkeys     | `POST /api/v1/auth/webauthn/*`          | FIDO2 credentials in `auth.webauthn_credentials` |
| Sessions                | `GET /api/v1/auth/me/sessions`          | Each with its `place` (`{ city, country_code }` of the sign-in IP, or null) |

Implementation lives under `src/domains/auth/` (see [sub-domains-layout.md](../architecture/sub-domains-layout.md)).

## Account creation and bot abuse (no CAPTCHA vendor)

There is **no signup endpoint** — account creation is folded into the unified login flows, and both creation paths prove control of the email/identity before granting a session:

- **Email verification-code** — `POST /api/v1/auth/email/send-code` (auto-signs-up an unknown email as a passwordless user, then emails a one-time 6-digit sign-in code (a resend under 60 s is `429 code_resend_too_soon`; a wrong code `401 code_wrong` + `tries_left`, an old one `code_expired`, the 5th wrong try `code_used_up`, 20 wrong a day `429 code_day_limit` — routes-final § 10.A); the account becomes usable only after `POST /api/v1/auth/email/login` consumes a valid code, which proves inbox control and flips `is_email_verified=true`; disposable domains blocked at send time)
- **OAuth** — `GET /api/v1/auth/oauth/{provider}/callback` (new users via `completeOAuthUserSession`; disposable domains blocked before `userService.createFromOAuth`; **claims** a bare invited placeholder — the provider proves control of the email, so the placeholder is flipped to verified and its personal organization provisioned, rather than being blocked by the unverified-account takeover guard)

**Invitation onboarding.** A user added to an organization by email gets a pre-created **bare** account (no credential, `is_email_verified=false`) so the `invited` membership has a `user_id`. "Bare" is determined by `AuthMethodService.hasActiveLoginCredential` — **no** login-capable auth method (`OAUTH`/`EMAIL_CODE`), **and no WebAuthn passkey** — so an account holding any real credential (including a passkey-only account) is never misclassified as claimable, regardless of its `is_email_verified` state. An `EMAIL_CODE` row on a still-unverified email is not counted (A-7): the first code sign-in verifies the email, so that row was never used — `send-code` leaves it for any address anyone types, and counting it let a stranger's send-code block the owner's OAuth sign-in. The invitee onboards via email verification-code or OAuth — both **claim** the bare row **and flip `is_email_verified=true`** because completing either flow proves control of the inbox. Accepting the invitation (`POST /api/v1/tenancy/invitations/{invitation_id}/accept`) requires authentication, an email **matching** the invitee, **and a verified email** — so a forwarded invite token cannot be used to join without proving email control. A bare invited row is created **without** a personal organization, so each onboarding path provisions one when it claims the account (email verification-code on the first successful login, OAuth post-commit) — best-effort + idempotent. Because that write is best-effort, the personal-organization **read path self-heals**: `GET /users/me` and `POST /auth/switch-to-personal` (via `ensurePersonalOrganization`) provision the organization on demand when personal is enabled and it is missing, so a swallowed signup-time failure never leaves a user stuck without a personal workspace.

**A removed login method stays closed (A-5).** Once the owner removes their `EMAIL_CODE` method, `POST /api/v1/auth/email/login` refuses a valid code with **403** `errors:loginMethodTurnedOff` (checked after the code is consumed, so only the mailbox holder learns it; adding the method back reopens the path); once they remove an OAuth method, that provider's callback refuses the sign-in the same way instead of re-linking a fresh row. A user who never held the method (an OAuth-only account signing in by email code for the first time) is unaffected.

**Invite-email squatting — eliminated.** Removing passwords (P84) closed the prior squatting vector (where a knower of an invited address could set a password on the bare row *without* proving email control). Now **every** account-creation / claim path (email verification-code, OAuth) requires email-control proof before a session is issued, so a bare invited row can only be claimed by someone who actually receives mail at that address.

**Disposable email:** `isDisposableEmailBlocked()` (package `disposable-email-domains-js`) runs on email verification-code send, OAuth user creation, and membership invitations. When blocked, the API returns **400** with `errors:disposableEmail`. Toggle with `BLOCK_DISPOSABLE_EMAIL` (default `true`).

**Rate limits:** Public auth routes (`/email/*`, `/oauth/*`, MFA challenge) use `STRICT_PUBLIC_RATE_LIMIT` — **5 requests per minute per IP** in production (`5000` when `RATE_LIMIT_RELAXED_CAPS` is set, as it is for local development and the test suite). Excess traffic receives **429**. Token refresh (`POST /auth/refresh`) uses `REFRESH_RATE_LIMIT` — **30 per minute per IP** in production, `5000` under `RATE_LIMIT_RELAXED_CAPS` like the others (a frontend E2E run refreshes every tab from one loopback IP). The email code carries its own limits on top (no env flag relaxes them): a resend under `VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS` (60 s) is **429** `code_resend_too_soon` with `retry_after_seconds` + `Retry-After`; each code allows `VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS` (5) wrong tries (`401 code_wrong` + `tries_left`, then `code_used_up`); one email may spend `EMAIL_CODE_WRONG_TRIES_PER_DAY` (20) wrong tries a day before **429** `code_day_limit` — counted in Redis by the email's hash, so an unknown email answers exactly like a known one. The 2FA code at sign-in answers `401 mfa_code_wrong` + `tries_left` and then **429** `mfa_locked` with `Retry-After`. Every protected route adds a **failed-authentication budget** per client address (D-2): once an address has 60 failed authentications in a minute — a request that presents an `Authorization` header or `X-Api-Key` and earns 401; a request with no credential is not counted — every credentialed request from it receives **429** `rate_limited` with `Retry-After`, before the API-key lookup or the session check (`5000` under `RATE_LIMIT_RELAXED_CAPS`; `src/shared/middlewares/rate-limit/failed-authentication-rate-limit.ts`). The global per-IP limit (`RATE_LIMIT_MAX`) runs as an app-level `onRequest` hook, ahead of route authentication and on unknown URLs, so a 401 or 404 counts against it too; a route with its own preset keeps the preset instead. Every IP-keyed limit (global, presets, failed authentication) keys an IPv6 caller on its /64 and an IPv4-mapped address on its IPv4 form (`rateLimitIpKey`, D-3).

**CAPTCHA (Cloudflare Turnstile):** When `CAPTCHA_PROVIDER=turnstile` and `CAPTCHA_SECRET` are set, public auth routes require `X-Captcha-Token` from the client widget:

- `POST /api/v1/auth/email/send-code`
- `POST /api/v1/auth/email/login`
- `POST /api/v1/auth/mfa/login`
- `POST /api/v1/auth/webauthn/authenticate/options` (passkey sign-in)

OAuth initiation (`GET /api/v1/auth/oauth/:provider`) carries no captcha: it only returns the
provider's authorization URL, and the provider authenticates the user.

Schema default is `CAPTCHA_PROVIDER=disabled` (no check; production and every hosted deploy — `HOSTED_DEPLOYMENT=true` — require `turnstile`). A missing token is **401** `errors:captchaRequired`; a token Cloudflare refuses is **401** `errors:captchaInvalid`. When Cloudflare cannot answer — an outage, a non-200 or unreadable siteverify response, or the `turnstile` circuit open — the request is **503** `errors:captchaProviderUnavailable` (with `Retry-After` while the circuit is open): the client retries rather than re-solving a captcha that was never judged. `CAPTCHA_FAIL_OPEN=true` skips the check during such an outage instead; the schema rejects it in production. Optional `CAPTCHA_BYPASS_HEADER` (with `CAPTCHA_BYPASS_ALLOWED`, non-production only) allows local testing.

**Production boot guard.** A production deploy with the default `CAPTCHA_PROVIDER=disabled` would run email verification-code (send + login), MFA challenge, and passkey sign-in without any captcha. Boot fails in production unless Turnstile is fully configured (see `src/shared/config/env-schema.ts`):

| Posture                   | Required env                                    | Auth-route behavior                                                   |
| ------------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| **Production (required)** | `CAPTCHA_PROVIDER=turnstile` + `CAPTCHA_SECRET` | Verify `X-Captcha-Token`; fail-closed on missing or invalid tokens.   |
| **Development**           | Default `CAPTCHA_PROVIDER=disabled`             | No check runs; optional `CAPTCHA_BYPASS_HEADER` for local UX.         |

With `CAPTCHA_PROVIDER=disabled` (the default outside production) the middleware skips the check entirely.

**Local CAPTCHA (opt-in).** `pnpm setup:local --only-env --with-captcha` turns Turnstile on locally with Cloudflare's published always-pass **test** keys (the real widget and siteverify round trip on `localhost`) and sets `CAPTCHA_BYPASS_ALLOWED=true` so k6 and the API smoke test pass with the dev `X-Captcha-Bypass` header; `--without-captcha` turns it off. A test secret's results always name the hostname `example.com`, so the verifier skips its hostname pin for Cloudflare test secrets only — and **production and hosted-deploy boot reject a Cloudflare test `CAPTCHA_SECRET`** (`1x…AA` / `2x…AA` / `3x…AA`), so a deployed backend always pins and never runs on a secret that passes every token.

## Email verification-code environment safety

`EmailLoginService.sendCode` **never** returns the raw sign-in code in the JSON body. The code leaves the service only via the `AUTH_EVENT.EMAIL_VERIFICATION_CODE_REQUESTED` event payload (consumed by the mail handler) and the resulting email — identical behavior across every environment. Login is `POST /api/v1/auth/email/login` with `{ email, code }` (`^\d{6}$`, else `400`), gated by a per-code try counter keyed by the email's hash and the day counter above. Codes are six digits (`VERIFICATION_CODE_CHARSET`), live `VERIFICATION_CODE_TTL_MINUTES` (15) and are persisted only as a keyed, user-scoped HMAC (never plaintext, never bare sha256).

**Verify-attempt cap resets on each fresh code.** The per-code try counter is cleared whenever a new code is sent to that email; the day counter is not (a successful sign-in clears it). This closes a victim-lockout DoS: without it, an attacker who burned the cap would keep the legitimate owner locked out of redeeming a new code. Brute-force is not weakened — each issued code is an independent random target over a large keyspace, only one code is live at a time (each send invalidates the prior), a successful login invalidates any remaining code, and `send-code` is rate-limited per email + IP.

| Guard                     | When it runs                                                  |
| ------------------------- | ------------------------------------------------------------- |
| Zod `FRONTEND_URL` refine | Boot — when set, `FRONTEND_URL` must be a valid `http(s)` URL |
| Zod `FRONTEND_URL` production refine | Boot in production — `FRONTEND_URL` must be set, to an `https` URL |

**Test code path:** tests subscribe to `AUTH_EVENT.EMAIL_VERIFICATION_CODE_REQUESTED` via the `captureNextVerificationCode(email)` helper in `src/tests/helpers/verification-code.helper.ts` to obtain the raw code for assertions.

**Deployed environments:** development accepts any valid public `FRONTEND_URL`; production requires one, over `https` — unset, every emailed link (verification code, invitation) would point at the local-dev fallback `http://localhost:5173`. The previous environment-based inline-token leak and its localhost-only `FRONTEND_URL` restriction have been removed.

## WebAuthn (passkeys)

Passkeys use `@simplewebauthn/server` with challenges stored in Redis (`webauthn:challenge:*`, 5-minute TTL).

| Route                                             | Auth   | Purpose                                                 |
| ------------------------------------------------- | ------ | ------------------------------------------------------- |
| `POST /api/v1/auth/me/webauthn/register/options`  | JWT    | Begin enrolment (returns `options` + `challenge_token`) |
| `POST /api/v1/auth/me/webauthn/register/verify`   | JWT    | Complete enrolment; persists public key                 |
| `POST /api/v1/auth/webauthn/authenticate/options` | Public | Begin sign-in (`email` required)                        |
| `POST /api/v1/auth/webauthn/authenticate/verify`  | Public | Complete sign-in; issues JWT + session cookie           |

Environment:

- `WEBAUTHN_RP_ID` — relying party hostname (defaults to first `ALLOWED_ORIGINS` host or `localhost`)
- `WEBAUTHN_RP_NAME` — display name in the passkey prompt (default `meepzo-be`)
- Request `Origin` header is preferred for verification when present

MFA recovery codes (10 single-use) remain under the MFA sub-domain for TOTP backup.

## Step-up, trusted devices and sessions

**Step-up.** Sensitive changes need a step-up on **this** session within `RECENT_STEP_UP_TTL_SECONDS` (10 minutes). `POST /api/v1/auth/step-up` takes only `{ code }` — an email code sent with `POST /auth/email/send-code` — and opens an `email_code` window; for a person with a **settled** 2FA factor it answers `403 mfa_step_up_required`, and they step up with the 2FA code (`POST /api/v1/auth/me/mfa/verify`, an `mfa` window). The step-up has its own try counter, so a stranger spending the public sign-in budget cannot lock the owner out of it. Destructive changes (revoking sessions, deleting a passkey / MFA method / auth method, the admin delete / suspend) need a **strong** window — `mfa`, or `email_code` (which only a person without settled 2FA can open, AT15) — and answer `403 strongStepUpRequired` otherwise; a TOTP factor enrolled in the last 72 hours under an email-code step-up is not settled yet, and its own code opens only a weak (`provisional_mfa`) window. The email-code way cannot be removed (`409 email_code_always_on`).

**Trusted devices.** `POST /api/v1/auth/mfa/login` with `trust_device: true` sets the httpOnly `trusted_device` cookie (path `/api/v1/auth`, `TRUSTED_DEVICE_DAYS` 30 days) and stores only its SHA-256 in `auth.trusted_devices` (`tdv_` ids; at most `TRUSTED_DEVICES_MAX` 10 a person — an 11th ends the oldest). A later sign-in (email code, OAuth callback, passkey) on that browser skips the 2FA code, except for a `GLOBAL_ADMIN_EMAILS` account or a member of an organization that requires 2FA. Trust ends early when the last 2FA factor is removed, on `DELETE /auth/me/sessions` (this browser's is kept), and on account delete or suspend.

**Sessions and their place.** Every sign-in stores the city and country of its IP (`auth.sessions.place_city`, `place_country`), read from the optional DB-IP Lite database at `SESSION_PLACE_DATABASE_PATH`; `POST /auth/refresh` from a new IP moves the IP and the place. Without the file the place is `null`. `GET /api/v1/auth/me/sessions` returns it as `place`.

## Related

- [frontend-auth-guide.md](../api/frontend-auth-guide.md) — frontend SPA integration (Bearer + reactive refresh, headers, organization switching)
- [csrf-and-session-cookies.md](../security/csrf-and-session-cookies.md)
- [api-versioning.md](../api/api-versioning.md)
- [data-lifecycle-deletion.md](../data/data-lifecycle-deletion.md) — session retention
- [`src/domains/auth/auth.overview.md`](../../../src/domains/auth/auth.overview.md) — domain overview, the credential types, anti-enumeration invariant
- [`src/domains/auth/sub-domains/auth-method/auth-method.overview.md`](../../../src/domains/auth/sub-domains/auth-method/auth-method.overview.md) — credential records, token flows
- [`src/domains/auth/sub-domains/auth-mfa/auth-mfa.overview.md`](../../../src/domains/auth/sub-domains/auth-mfa/auth-mfa.overview.md) — TOTP enrolment and challenge
- [`src/domains/auth/sub-domains/auth-webauthn/auth-webauthn.overview.md`](../../../src/domains/auth/sub-domains/auth-webauthn/auth-webauthn.overview.md) — passkey ceremonies
- [`src/POLICIES.md`](../../../src/POLICIES.md) — `JWT_*`, `EMAIL_CODE/VERIFICATION_CODE_*`, `MFA_*`, `TRUSTED_DEVICE*`, `STRICT_PUBLIC_RATE_LIMIT` policy constants
