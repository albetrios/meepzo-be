import { describe, it, expect } from 'vitest';
import {
  VERIFICATION_CODE_CHARSET,
  VERIFICATION_CODE_LENGTH,
  generateVerificationCode,
  hashVerificationCode,
  normalizeVerificationCode,
} from '@/domains/auth/sub-domains/auth-method/verification-code.js';

describe('verification-code util', () => {
  it('generates a digits-only code of the configured length (AT6)', () => {
    const charsetMatcher = new RegExp(`^[${VERIFICATION_CODE_CHARSET}]+$`);
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const code = generateVerificationCode();
      expect(code).toHaveLength(VERIFICATION_CODE_LENGTH);
      expect(code).toMatch(charsetMatcher);
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('the charset is the ten digits', () => {
    expect(VERIFICATION_CODE_CHARSET).toBe('0123456789');
  });

  it('normalizes input case-insensitively and strips whitespace/hyphens (a letter code issued before AT6 still matches)', () => {
    expect(normalizeVerificationCode(' ab cd-ef ')).toBe('ABCDEF');
    expect(normalizeVerificationCode('AbCdEf')).toBe('ABCDEF');
  });

  it('hashVerificationCode is a deterministic 64-char hex, keyed per (type,user,code)', () => {
    const base = { tokenType: 'EMAIL_CODE', userId: 7, code: 'ABCDEF' };
    expect(hashVerificationCode(base)).toBe(hashVerificationCode(base));
    expect(hashVerificationCode(base)).toMatch(/^[a-f0-9]{64}$/);
    // Different code, different user, and different type all change the digest.
    expect(hashVerificationCode(base)).not.toBe(hashVerificationCode({ ...base, code: 'ZZZZZZ' }));
    expect(hashVerificationCode(base)).not.toBe(hashVerificationCode({ ...base, userId: 8 }));
    expect(hashVerificationCode(base)).not.toBe(
      hashVerificationCode({ ...base, tokenType: 'PASSWORD_RESET' }),
    );
  });

  it('hashes case-insensitively (normalized before hashing)', () => {
    expect(hashVerificationCode({ tokenType: 'EMAIL_CODE', userId: 7, code: 'abcdef' })).toBe(
      hashVerificationCode({ tokenType: 'EMAIL_CODE', userId: 7, code: 'ABCDEF' }),
    );
  });

  it('is not a bare sha256 of the code (keyed/peppered)', async () => {
    const { createHash } = await import('node:crypto');
    const bareSha = createHash('sha256').update('ABCDEF').digest('hex');
    expect(hashVerificationCode({ tokenType: 'EMAIL_CODE', userId: 7, code: 'ABCDEF' })).not.toBe(
      bareSha,
    );
  });
});
