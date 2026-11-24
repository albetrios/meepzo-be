import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import { ValidationError } from '@/shared/errors/index.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import type {
  EmailSendCodeInput,
  EmailLoginInput,
  MfaVerifyInput,
  CreateAuthMethodInput,
  StepUpVerifyInput,
  MfaEnrollInput,
  MfaEnrollConfirmInput,
  MfaLoginVerifyInput,
  OauthCallbackQueryInput,
  EmailConfirmInput,
  RequestEmailConfirmationInput,
} from './auth.dto.js';
import {
  EmailSendCodeDto,
  EmailLoginDto,
  MfaVerifyDto,
  CreateAuthMethodDto,
  StepUpVerifyDto,
  MfaEnrollDto,
  MfaEnrollConfirmDto,
  MfaLoginVerifyDto,
  OauthCallbackQueryDto,
  EmailConfirmDto,
  RequestEmailConfirmationDto,
} from './auth.dto.js';

/** Validates the `POST /api/v1/auth/email/send-code` request body against {@link EmailSendCodeDto}. */
export function validateEmailSendCode(body: unknown): EmailSendCodeInput {
  return parseWithSchema({ schema: EmailSendCodeDto, data: body });
}

/** Validates the `POST /api/v1/auth/email/confirm` request body against {@link EmailConfirmDto}. */
export function validateEmailConfirm(body: unknown): EmailConfirmInput {
  return parseWithSchema({ schema: EmailConfirmDto, data: body });
}

/** Validates the `POST /api/v1/users/me/email-confirmation` body against {@link RequestEmailConfirmationDto}; a request without a body is an empty one. */
export function validateRequestEmailConfirmation(body: unknown): RequestEmailConfirmationInput {
  return parseWithSchema({ schema: RequestEmailConfirmationDto, data: body ?? {} });
}

/** Validates the `POST /api/v1/auth/email/login` request body against {@link EmailLoginDto}. */
export function validateEmailLogin(body: unknown): EmailLoginInput {
  return parseWithSchema({ schema: EmailLoginDto, data: body });
}

/** Validates the `POST /api/v1/auth/me/mfa/verify` request body against {@link MfaVerifyDto}. */
export function validateMfaVerify(body: unknown): MfaVerifyInput {
  return parseWithSchema({ schema: MfaVerifyDto, data: body });
}

/** Validates the `POST /api/v1/auth/me/auth-methods` request body against {@link CreateAuthMethodDto}. */
export function validateCreateAuthMethod(body: unknown): CreateAuthMethodInput {
  return parseWithSchema({ schema: CreateAuthMethodDto, data: body });
}

/** Validates the authenticated `POST /api/v1/auth/step-up` request body against {@link StepUpVerifyDto}. */
export function validateStepUpVerify(body: unknown): StepUpVerifyInput {
  return parseWithSchema({ schema: StepUpVerifyDto, data: body });
}

/** Validates the authenticated `POST /api/v1/auth/me/mfa/enroll` request body against {@link MfaEnrollDto}. */
export function validateMfaEnroll(body: unknown): MfaEnrollInput {
  return parseWithSchema({ schema: MfaEnrollDto, data: body });
}

/** Validates the authenticated `POST /api/v1/auth/me/mfa/enroll/confirm` request body against {@link MfaEnrollConfirmDto}. */
export function validateMfaEnrollConfirm(body: unknown): MfaEnrollConfirmInput {
  return parseWithSchema({ schema: MfaEnrollConfirmDto, data: body });
}

/** Validates the public login-flow MFA step body against {@link MfaLoginVerifyDto} (one of `totp_code` / `recovery_code` required). */
export function validateMfaLoginVerify(body: unknown): MfaLoginVerifyInput {
  return parseWithSchema({ schema: MfaLoginVerifyDto, data: body });
}

/** Validates the OAuth callback querystring (`code` + `state`) against {@link OauthCallbackQueryDto}. */
export function validateOauthCallbackQuery(query: unknown): OauthCallbackQueryInput {
  return parseWithSchema({ schema: OauthCallbackQueryDto, data: query });
}

/**
 * Validates the `:publicId` path param on auth-method routes (sec-new-B4). Returns the
 * 21-character alphanumeric public id; throws {@link ValidationError} when the value is not
 * exactly 21 lowercase alphanumeric characters (the shape produced by {@link generatePublicId}).
 */
export function validateAuthMethodPublicIdParam(authMethodPublicId: string): string {
  if (!/^am_[a-z0-9]{21}$/.test(authMethodPublicId)) {
    throw new ValidationError('errors:validation.invalidAuthMethodId', undefined, undefined, [
      { field: 'auth_method_id', messageKey: 'errors:validation.invalidAuthMethodId' },
    ]);
  }
  return authMethodPublicId;
}

/**
 * Validates the `:mfa_method_id` path param on MFA routes as an opaque public id (route-#10);
 * throws {@link ValidationError} otherwise.
 */
export function validateMfaMethodIdParam(mfaMethodId: string): string {
  return validatePublicIdParam({ value: mfaMethodId, fieldName: 'mfa_method_id' });
}

// Note: validateRefreshToken removed — refresh is now session-based via httpOnly cookie.
