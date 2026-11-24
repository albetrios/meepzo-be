import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import { validateEmailSendCode, validateEmailLogin } from '@/domains/auth/auth.validator.js';

describe('auth-method.validator', () => {
  it('validateEmailSendCode accepts email', () => {
    expect(validateEmailSendCode({ email: 'user@example.com' })).toEqual({
      email: 'user@example.com',
    });
  });

  it('validateEmailLogin accepts email + 6-digit code', () => {
    expect(validateEmailLogin({ email: 'user@example.com', code: '482913' })).toEqual({
      email: 'user@example.com',
      code: '482913',
    });
  });

  it('validateEmailLogin rejects a non-6-digit code', () => {
    expect(() => validateEmailLogin({ email: 'user@example.com', code: '48291' })).toThrow(
      ValidationError,
    );
  });
});
