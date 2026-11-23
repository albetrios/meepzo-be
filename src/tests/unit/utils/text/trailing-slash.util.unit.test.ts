import { describe, expect, it } from 'vitest';
import { withoutTrailingSlashes } from '@/shared/utils/text/trailing-slash.util.js';

/** A configured base URL joined to a path without a doubled slash. */
describe('withoutTrailingSlashes', () => {
  it('drops one or many slashes at the end', () => {
    expect(withoutTrailingSlashes('https://app.example.com/')).toBe('https://app.example.com');
    expect(withoutTrailingSlashes('https://app.example.com///')).toBe('https://app.example.com');
  });

  it('keeps every slash before the end', () => {
    expect(withoutTrailingSlashes('https://app.example.com/base//path')).toBe(
      'https://app.example.com/base//path',
    );
  });

  it('leaves text without a trailing slash as it is, and empties text of only slashes', () => {
    expect(withoutTrailingSlashes('http://localhost:5173')).toBe('http://localhost:5173');
    expect(withoutTrailingSlashes('')).toBe('');
    expect(withoutTrailingSlashes('///')).toBe('');
  });

  it('stays fast on a long run of slashes that is not at the end', () => {
    const text = `${'/'.repeat(100_000)}x`;
    expect(withoutTrailingSlashes(text)).toBe(text);
  });
});
