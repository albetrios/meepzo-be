import { describe, expect, it } from 'vitest';
import { validateConnectInstagramAccount } from '@/domains/app/sub-domains/instagram-account/instagram-account.validator.js';
import { ValidationError } from '@/shared/errors/index.js';

describe('validateConnectInstagramAccount', () => {
  it('accepts a code and keeps a trailing #_ for the Instagram client to strip', () => {
    expect(validateConnectInstagramAccount({ code: ' AQB-code#_ ' })).toEqual({
      code: 'AQB-code#_',
    });
  });

  it('accepts a code of exactly 2000 characters', () => {
    const code = 'a'.repeat(2000);
    expect(validateConnectInstagramAccount({ code }).code).toBe(code);
  });

  it.each([
    ['missing', {}],
    ['empty', { code: '' }],
    ['blank', { code: '  ' }],
    ['over 2000 characters', { code: 'a'.repeat(2001) }],
    ['not a string', { code: 42 }],
  ])('refuses a code that is %s with a ValidationError on code', (_case, body) => {
    try {
      validateConnectInstagramAccount(body);
      expect.unreachable('a ValidationError was expected');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).errors?.map((item) => item.field)).toContain('code');
    }
  });

  it('refuses an unknown field', () => {
    expect(() => validateConnectInstagramAccount({ code: 'AQB', state: 'x' })).toThrow(
      ValidationError,
    );
  });
});
