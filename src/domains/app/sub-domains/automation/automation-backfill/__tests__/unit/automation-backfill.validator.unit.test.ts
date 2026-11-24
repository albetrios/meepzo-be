import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import { validateStartAutomationBackfill } from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.validator.js';

/** Route 38's body (feat-instagram-dm-sending routes-final § 4.C.8, AU31): `days` 1–7, nothing else. */
describe('validateStartAutomationBackfill', () => {
  it.each([1, 3, 7])('accepts %i days', (days) => {
    expect(validateStartAutomationBackfill({ days })).toEqual({ days });
  });

  it.each([
    ['zero days', { days: 0 }],
    ['eight days', { days: 8 }],
    ['a fraction', { days: 1.5 }],
    ['a string', { days: '3' }],
    ['no days', {}],
    ['an unknown field', { days: 3, posts: 50 }],
    ['no body', undefined],
  ])('refuses %s with a ValidationError', (_label, body) => {
    expect(() => validateStartAutomationBackfill(body)).toThrow(ValidationError);
  });
});
