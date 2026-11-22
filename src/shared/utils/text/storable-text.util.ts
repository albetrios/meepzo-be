/** The one character besides a lone surrogate that Postgres refuses in `text` and `jsonb`. */
const NUL_CHARACTER = '\u0000';
/** A lone surrogate: under the `u` flag a whole pair is one code point, never this category. */
const LONE_SURROGATE_PATTERN = /\p{Surrogate}/gu;
/** What a lone surrogate becomes, as `String.prototype.toWellFormed` writes it. */
const REPLACEMENT_CHARACTER = '�';

/**
 * `text` as Postgres can store it: every NUL dropped, every lone surrogate replaced by U+FFFD.
 *
 * @remarks
 * - **Algorithm:** NUL first, so a pair split by one is a pair again; the rest is
 *   `String.prototype.toWellFormed` (spelled as a pattern — the compiler's library is ES2022).
 * - **Failure modes:** none; any other text comes back unchanged.
 * - **Side effects:** none.
 */
export function cleanStorableText(text: string): string {
  return text.replaceAll(NUL_CHARACTER, '').replace(LONE_SURROGATE_PATTERN, REPLACEMENT_CHARACTER);
}

/**
 * A JSON value with every string in it — object keys included, at any depth — as Postgres can store
 * it ({@link cleanStorableText}): for a payload someone else wrote, before it goes into a `jsonb`
 * or `text` column.
 *
 * @remarks
 * - **Algorithm:** builds a new value; the one given is never changed. Two keys that become the same
 *   keep the last one's value, as JSON does.
 * - **Failure modes:** none of its own; a value nested deeper than the call stack throws
 *   `RangeError`, as `JSON.stringify` does on it.
 * - **Side effects:** none.
 * - **Notes:** check a provider's signature over the raw bytes first — a cleaned payload no longer
 *   matches them.
 */
export function cleanStorableJson(value: unknown): unknown {
  if (typeof value === 'string') return cleanStorableText(value);
  if (Array.isArray(value)) return value.map((item) => cleanStorableJson(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [cleanStorableText(key), cleanStorableJson(item)]),
    );
  }
  return value;
}
