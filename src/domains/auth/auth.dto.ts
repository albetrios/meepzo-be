import { z } from 'zod';
import { trimmedEmail, trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';
import { AUTH_METHOD_TYPE } from '@/domains/auth/sub-domains/auth-method/auth-method.constants.js';
import { OAUTH_FORM_CALLBACK_USER_MAX_LENGTH } from '@/shared/constants/limits.constants.js';
import {
  OAUTH_LINK_INTENT,
  SUPPORTED_OAUTH_PROVIDERS,
} from '@/domains/auth/sub-domains/auth-method/oauth/oauth.types.js';

/** Zod schema for the `POST /api/v1/auth/email/send-code` request body. */
export const EmailSendCodeDto = z
  .object({
    email: trimmedEmail(),
  })
  .strict();
/** Inferred input type of {@link EmailSendCodeDto}. */
export type EmailSendCodeInput = z.infer<typeof EmailSendCodeDto>;

/**
 * The shape of an emailed sign-in code on every route that takes one (email login, step-up): six
 * digits (AT6). A code that is not six digits is a `400` on `code`; a well-formed wrong code is a
 * `401 code_wrong` from the service.
 */
export function emailVerificationCodeField() {
  return z
    .string()
    .trim()
    .regex(/^\d{6}$/);
}

/**
 * Zod schema for the `POST /api/v1/auth/email/login` request body (email + the 6-digit verification
 * code emailed by `email/send-code`).
 */
export const EmailLoginDto = z
  .object({
    email: trimmedEmail(),
    code: emailVerificationCodeField(),
  })
  .strict();
/** Inferred input type of {@link EmailLoginDto}. */
export type EmailLoginInput = z.infer<typeof EmailLoginDto>;

/** Zod schema for the `POST /api/v1/auth/me/mfa/verify` request body (6-digit TOTP code). */
export const MfaVerifyDto = z
  .object({
    code: z.string().trim().length(6).regex(/^\d+$/),
  })
  .strict();
/** Inferred input type of {@link MfaVerifyDto}. */
export type MfaVerifyInput = z.infer<typeof MfaVerifyDto>;

/**
 * Zod schema for the `POST /api/v1/auth/me/auth-methods` request body that links a new auth method
 * to the current user.
 *
 * route-#3: `method_type` is restricted to `EMAIL_CODE` — the only type this endpoint can create
 * as a functional credential-less row. `MFA_*` need an encrypted secret (set via the enroll ceremony), and `OAUTH` proves an external
 * identity (written only by the verified callback). Previously the DTO accepted every auth-method
 * type, so a user could insert a non-functional `MFA_*` row that the last-login-capable
 * credential guard still counted — letting them delete their only real method and lock themselves
 * out. The provider identity fields are likewise never accepted here.
 */
export const CreateAuthMethodDto = z
  .object({
    method_type: z.literal(AUTH_METHOD_TYPE.EMAIL_CODE),
    is_primary: z.boolean().optional().default(false),
  })
  .strict();
/** Inferred input type of {@link CreateAuthMethodDto}. */
export type CreateAuthMethodInput = z.infer<typeof CreateAuthMethodDto>;

/**
 * Zod schema for the `POST /api/v1/auth/step-up` request body — re-authentication by the 6-digit
 * email verification `code` (passwords are off, P84). An MFA account steps up through the MFA
 * verify route instead; `.strict()` rejects unknown keys (a `password` field is a `400`).
 */
export const StepUpVerifyDto = z
  .object({
    code: emailVerificationCodeField(),
  })
  .strict();
/** Inferred input type of {@link StepUpVerifyDto}. */
export type StepUpVerifyInput = z.infer<typeof StepUpVerifyDto>;

// MFA
/**
 * Zod schema for the authenticated `POST /api/v1/auth/me/mfa/enroll` request body
 * (TOTP enrollment INIT — phase 1 of the two-phase ceremony introduced in sec-A
 * finding #3). The init step stages the encrypted TOTP secret in Redis and
 * returns it to the caller; nothing is persisted to Postgres until the matching
 * `POST /auth/me/mfa/enroll/confirm` request verifies a fresh code.
 */
export const MfaEnrollDto = z
  .object({
    method_type: z.enum(['MFA_TOTP']),
  })
  .strict();
/** Inferred input type of {@link MfaEnrollDto}. */
export type MfaEnrollInput = z.infer<typeof MfaEnrollDto>;

/**
 * Zod schema for the authenticated `POST /api/v1/auth/me/mfa/enroll/confirm` request body
 * (TOTP enrollment CONFIRM — phase 2 of the two-phase ceremony). The caller submits a
 * 6-digit TOTP code generated from the secret returned by INIT; on success the server
 * atomically persists the auth_methods row, generates and hashes the recovery codes, and
 * flips `is_mfa_enabled`. On failure (invalid code, expired stage, etc.) nothing changes.
 */
export const MfaEnrollConfirmDto = z
  .object({
    code: z.string().trim().length(6).regex(/^\d+$/),
  })
  .strict();
/** Inferred input type of {@link MfaEnrollConfirmDto}. */
export type MfaEnrollConfirmInput = z.infer<typeof MfaEnrollConfirmDto>;

/** Public login MFA step after the first factor (email code, OAuth or passkey) — no JWT yet. */
export const MfaLoginVerifyDto = z
  .object({
    mfa_session_token: trimmedStringMinMax({ min: 1, max: 128 }),
    totp_code: z.string().trim().length(6).regex(/^\d+$/).optional(),
    recovery_code: trimmedStringMinMax({ min: 8, max: 64 }).optional(),
    /** "Trust this device for 30 days" (AT17) — a right code then sets the `trusted_device` cookie. */
    trust_device: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.totp_code !== undefined || value.recovery_code !== undefined, {
    message: 'errors:validation.totpOrRecoveryCodeRequired',
    path: ['totp_code'],
  });
/** Inferred input type of {@link MfaLoginVerifyDto}; exactly one of `totp_code` or `recovery_code` is required. */
export type MfaLoginVerifyInput = z.infer<typeof MfaLoginVerifyDto>;

// Note: Refresh token is now session-based via httpOnly cookie.
// No DTO needed — the session_id is read from the cookie automatically.

/**
 * Zod schema for the `GET /api/v1/auth/oauth/:provider/callback` query string (`code` + opaque
 * `state`).
 *
 * NOT `.strict()`: this query string is authored by the identity provider, not by us. Google
 * appends `iss`, `scope`, `authuser`, `hd` and `prompt` to every callback and offers no way to
 * suppress them, so a strict schema rejected the provider's own protocol response — the request
 * arrived valid and was thrown away before the handler ran, making Google sign-in impossible.
 *
 * The known extras are declared so they appear in the generated OpenAPI rather than being silently
 * swallowed; `z.looseObject` covers the rest, since a provider may add fields at any time. Only
 * `code` and `state` are ever read — `state` is the CSRF-bearing value and is verified downstream.
 */
export const OauthCallbackQueryDto = z.looseObject({
  code: trimmedStringMinMax({ min: 1, max: 2048 }),
  state: trimmedStringMinMax({ min: 1, max: 512 }),
  /** Google: issuer identifier (`https://accounts.google.com`). */
  iss: z.string().optional(),
  /** Google: space-delimited scopes actually granted. */
  scope: z.string().optional(),
  /** Google: index of the signed-in account in a multi-account session. */
  authuser: z.string().optional(),
  /** Google: hosted-domain of a Workspace account. */
  hd: z.string().optional(),
  /** Google: echo of the `prompt` parameter. */
  prompt: z.string().optional(),
});

/** Inferred input type of {@link OauthCallbackQueryDto}. */
export type OauthCallbackQueryInput = z.infer<typeof OauthCallbackQueryDto>;

// Path params
/**
 * Zod schema for the `:provider` path parameter on OAuth routes (`/api/v1/auth/oauth/:provider`):
 * `google` or `apple` (AT5, AT10) — any other name is a `400` on `provider` (routes-final § 10.B.9);
 * a supported provider whose env vars are unset answers `404` from the service (AT11).
 */
export const oauthProviderParamsDto = z
  .object({
    provider: z.enum(SUPPORTED_OAUTH_PROVIDERS),
  })
  .strict();
/** Inferred input type of {@link oauthProviderParamsDto}. */
export type OauthProviderParamsInput = z.infer<typeof oauthProviderParamsDto>;

/**
 * Zod schema for the `:mfa_method_id` path parameter on `/api/v1/auth/me/mfa/:mfa_method_id`.
 *
 * route-#10: the param is an opaque 21-char public id (not the sequential DB id). `GET /mfa`
 * returns each method's public id as `id`, so this is round-trip compatible; it stops leaking
 * monotonic row ids and matches the public-id convention used everywhere else.
 */
export const mfaMethodIdParamsDto = z
  .object({
    mfa_method_id: z
      .string()
      .trim()
      .regex(/^am_[a-z0-9]{21}$/),
  })
  .strict();
/** Inferred input type of {@link mfaMethodIdParamsDto}. */
export type MfaMethodIdParamsInput = z.infer<typeof mfaMethodIdParamsDto>;

/** Zod schema for the `:auth_method_id` path parameter on `DELETE /api/v1/auth/me/auth-methods/:auth_method_id` (sec-new-B4). */
export const authMethodPublicIdParamsDto = z
  .object({
    auth_method_id: z
      .string()
      .trim()
      .regex(/^am_[a-z0-9]{21}$/),
  })
  .strict();
/** Inferred input type of {@link authMethodPublicIdParamsDto}. */
export type AuthMethodPublicIdParamsInput = z.infer<typeof authMethodPublicIdParamsDto>;

/** Zod schema for the `:session_id` (session public id) path parameter on `/api/v1/auth/me/sessions/:session_id`. */
export const sessionIdParamsDto = z
  .object({
    session_id: trimmedStringMinMax({ min: 1, max: 28 }),
  })
  .strict();
/** Inferred input type of {@link sessionIdParamsDto}. */
export type SessionIdParamsInput = z.infer<typeof sessionIdParamsDto>;

/**
 * Zod schema for the `GET /api/v1/auth/oauth/:provider` query string: `intent=link` starts link
 * mode (AT12 — a bearer and a recent step-up required); without it the route is the public
 * sign-in start. Any other `intent` or field is a `400`.
 */
export const OauthStartQueryDto = z
  .object({
    intent: z.literal(OAUTH_LINK_INTENT).optional(),
  })
  .strict();
/** Inferred input type of {@link OauthStartQueryDto}. */
export type OauthStartQueryInput = z.infer<typeof OauthStartQueryDto>;

/**
 * Zod schema for Apple's form post to `POST /api/v1/auth/oauth/apple/callback` (route 124, AT10):
 * `state` (required), `code` or `error`, and on the first sign-in only `user` — a JSON text with
 * the name, at most {@link OAUTH_FORM_CALLBACK_USER_MAX_LENGTH} characters. `id_token` is
 * accepted and ignored (the code swap of route 143 reads Apple's own). Not `.strict()`: Apple
 * authors this form, as Google authors its callback query.
 */
export const AppleFormCallbackDto = z.looseObject({
  state: trimmedStringMinMax({ min: 1, max: 512 }),
  code: trimmedStringMinMax({ min: 1, max: 2048 }).optional(),
  error: trimmedStringMinMax({ min: 1, max: 200 }).optional(),
  user: z.string().max(OAUTH_FORM_CALLBACK_USER_MAX_LENGTH).optional(),
  id_token: z.string().optional(),
});
/** Inferred input type of {@link AppleFormCallbackDto}. */
export type AppleFormCallbackInput = z.infer<typeof AppleFormCallbackDto>;
