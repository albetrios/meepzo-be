import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import { validateListInstagramMediaQuery } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.validator.js';

/** The field named by the `ValidationError` a query raises. */
function failingFields(query: unknown): string[] {
  try {
    validateListInstagramMediaQuery(query);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return ((error as ValidationError).errors ?? []).map((item) => item.field);
  }
  throw new Error('expected the query to fail');
}

/**
 * The pickers' query (routes 5–6, routes-final § 1.C.8, 1.C.9): Instagram's paging — `limit` 1–50,
 * default 25; `after` 1–1000 characters, passed back untouched; strict.
 */
describe('validateListInstagramMediaQuery', () => {
  it('defaults limit to 25 with no cursor', () => {
    expect(validateListInstagramMediaQuery({})).toEqual({ limit: 25 });
  });

  it('coerces limit from the query string and keeps the cursor as sent', () => {
    expect(
      validateListInstagramMediaQuery({
        limit: '50',
        after: 'QVFIUmlwbnFsM3N2cV9lZAFdCa0hDeV9qMVliT0Vu',
      }),
    ).toEqual({ limit: 50, after: 'QVFIUmlwbnFsM3N2cV9lZAFdCa0hDeV9qMVliT0Vu' });
    expect(validateListInstagramMediaQuery({ limit: '1' })).toEqual({ limit: 1 });
  });

  it.each(['0', '51', '2.5', 'many'])('refuses limit %s with 400 on limit', (limit) => {
    expect(failingFields({ limit })).toEqual(['limit']);
  });

  it('refuses an empty or over-long cursor with 400 on after', () => {
    expect(failingFields({ after: '' })).toEqual(['after']);
    expect(failingFields({ after: 'a'.repeat(1001) })).toEqual(['after']);
    expect(validateListInstagramMediaQuery({ after: 'a'.repeat(1000) }).after).toHaveLength(1000);
  });

  it('refuses an unknown query field', () => {
    expect(() => validateListInstagramMediaQuery({ offset: '10' })).toThrow(ValidationError);
  });
});
