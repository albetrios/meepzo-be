import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import {
  validateCreateAuthMethod,
  validateEmailLogin,
  validateStepUpVerify,
} from '@/domains/auth/auth.validator.js';

describe('auth.validator', () => {
  it('validateEmailLogin accepts a 6-digit code (AT6)', () => {
    expect(validateEmailLogin({ email: 'user@example.com', code: '482913' })).toEqual({
      email: 'user@example.com',
      code: '482913',
    });
  });

  it.each(['AB2CD3', '12345', '1234567', '12 345', ''])(
    'validateEmailLogin rejects %j — the code is exactly six digits (400 on code)',
    (code) => {
      expect(() => validateEmailLogin({ email: 'user@example.com', code })).toThrow(
        ValidationError,
      );
    },
  );

  it('validateStepUpVerify takes the 6-digit email code and refuses a password (P84)', () => {
    expect(validateStepUpVerify({ code: '482913' })).toEqual({ code: '482913' });
    expect(() => validateStepUpVerify({ password: 'secret' })).toThrow(ValidationError);
    expect(() => validateStepUpVerify({ code: 'AB2CD3' })).toThrow(ValidationError);
  });

  it('validateCreateAuthMethod accepts a canonical method_type', () => {
    expect(validateCreateAuthMethod({ method_type: 'EMAIL_CODE' })).toMatchObject({
      method_type: 'EMAIL_CODE',
      is_primary: false,
    });
  });

  it('validateCreateAuthMethod rejects non-canonical method_type casing', () => {
    expect(() => validateCreateAuthMethod({ method_type: 'oauth' })).toThrow(ValidationError);
  });

  it('validateCreateAuthMethod rejects manual provider identity binding', () => {
    expect(() =>
      validateCreateAuthMethod({
        method_type: 'OAUTH',
        provider: 'google',
        provider_user_id: 'victim-sub',
      }),
    ).toThrow(ValidationError);
  });

  // route-#3: only EMAIL_CODE is a functional credential-less row; PASSWORD/MFA_*/OAUTH would be
  // non-functional phantom rows that defeat the last-login-capable-credential guard.
  it.each(['PASSWORD', 'OAUTH', 'MFA_TOTP', 'MFA_SMS', 'MFA_EMAIL'])(
    'validateCreateAuthMethod rejects credential-bearing type %s (phantom-row lockout)',
    (methodType) => {
      expect(() => validateCreateAuthMethod({ method_type: methodType })).toThrow(ValidationError);
    },
  );

  it('validateCreateAuthMethod accepts EMAIL_CODE (the only valid bare-row type)', () => {
    expect(validateCreateAuthMethod({ method_type: 'EMAIL_CODE' })).toMatchObject({
      method_type: 'EMAIL_CODE',
    });
  });
});
