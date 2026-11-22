import { describe, expect, it } from 'vitest';
import { cleanStorableJson, cleanStorableText } from '@/shared/utils/text/storable-text.util.js';

const NUL = '\u0000';
const LONE_HIGH_SURROGATE = '\ud83d';
const LONE_LOW_SURROGATE = '\ude00';
const REPLACEMENT_CHARACTER = '�';

/**
 * Text Postgres can store (launch D53): `text` and `jsonb` refuse NUL and lone surrogates, and one
 * such character in a provider's payload would fail the whole insert.
 */
describe('cleanStorableText', () => {
  it('drops every NUL', () => {
    expect(cleanStorableText(`${NUL}a${NUL}${NUL}b${NUL}`)).toBe('ab');
  });

  it('replaces each lone surrogate with U+FFFD, as String.prototype.toWellFormed does', () => {
    expect(cleanStorableText(`a${LONE_HIGH_SURROGATE}b${LONE_LOW_SURROGATE}`)).toBe(
      `a${REPLACEMENT_CHARACTER}b${REPLACEMENT_CHARACTER}`,
    );
    expect(cleanStorableText(`${LONE_LOW_SURROGATE}${LONE_HIGH_SURROGATE}`)).toBe(
      `${REPLACEMENT_CHARACTER}${REPLACEMENT_CHARACTER}`,
    );
  });

  it('keeps a whole pair, a NUL between its halves included', () => {
    expect(cleanStorableText('hi 😀')).toBe('hi 😀');
    expect(cleanStorableText(`${LONE_HIGH_SURROGATE}${NUL}${LONE_LOW_SURROGATE}`)).toBe('😀');
  });

  it.each(['', 'Price please?', 'નમસ્તે', 'line\nbreak\ttab', REPLACEMENT_CHARACTER])(
    'leaves %j as it is',
    (text) => {
      expect(cleanStorableText(text)).toBe(text);
    },
  );
});

describe('cleanStorableJson', () => {
  it('cleans every string at any depth, object keys included, and leaves the other values', () => {
    const value = {
      [`field${NUL}`]: `comments${NUL}`,
      value: {
        id: 12,
        is_echo: false,
        none: null,
        texts: [`a${NUL}`, [`b${LONE_HIGH_SURROGATE}`], { [`k${LONE_LOW_SURROGATE}`]: 'c' }],
      },
    };

    expect(cleanStorableJson(value)).toEqual({
      field: 'comments',
      value: {
        id: 12,
        is_echo: false,
        none: null,
        texts: ['a', [`b${REPLACEMENT_CHARACTER}`], { [`k${REPLACEMENT_CHARACTER}`]: 'c' }],
      },
    });
  });

  it.each([[undefined], [null], [7], [true]])('returns %j as it is', (value) => {
    expect(cleanStorableJson(value)).toBe(value);
  });

  it('never changes the value it was given', () => {
    const value = { text: `a${NUL}`, list: [`b${NUL}`] };
    const before = structuredClone(value);
    cleanStorableJson(value);
    expect(value).toEqual(before);
  });

  it('keeps a key named __proto__ an own property, never the prototype', () => {
    const cleaned = cleanStorableJson(JSON.parse('{"__proto__":{"polluted":"yes"}}')) as object;
    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype);
    expect(Object.hasOwn(cleaned, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
