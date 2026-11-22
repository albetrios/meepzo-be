import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { PAGINATION } from '@/shared/constants/pagination.constants.js';
import { AES_GCM_ALGORITHM, AES_GCM_IV_LENGTH } from '@/shared/constants/security.constants.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { deriveSecretsSubKey } from '@/shared/utils/security/secrets-sub-key.util.js';

/**
 * Cursor-based pagination query schema.
 * Use `after` as the opaque cursor from the previous page's `meta.pagination.next`.
 */
export const cursorPaginationSchema = z.object({
  after: z.string().max(PAGINATION.MAX_CURSOR_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
});

/** Inferred shape of {@link cursorPaginationSchema} (after coercion / defaults). */
export type CursorPaginationInput = z.infer<typeof cursorPaginationSchema>;

/** Limit-only list queries (no cursor); same default and max as cursor lists. */
export const listLimitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
});

/** Inferred shape of {@link listLimitQuerySchema}. */
export type ListLimitQueryInput = z.infer<typeof listLimitQuerySchema>;

/** Validates an unknown query object as {@link ListLimitQueryInput}; throws on invalid input. */
export function parseListLimitQuery(query: unknown): ListLimitQueryInput {
  return listLimitQuerySchema.parse(query);
}

/**
 * Schema for the JSON payload encoded inside an opaque list cursor. Strict —
 * unknown keys fail decoding so callers cannot tunnel data through the cursor.
 */
export const listCursorPayloadSchema = z
  .object({
    created_at: z.iso.datetime(),
    /**
     * The minting row's sort value as text — a text value as itself, a timestamp as its
     * microsecond UTC text, an integer as its decimal text. `null` — the row had none, under a
     * nulls-last sort (`buildAscendingNullsLastTextIdCursorCondition`,
     * `buildAscendingNullsLastTimestampIdCursorCondition`), so the next page continues inside the
     * value-less rows instead of restarting.
     */
    sort_value: z.string().nullable().optional(),
    public_id: z.string().min(1).max(28).optional(),
    id: z.number().int().positive().optional(),
    /**
     * sec-U12: SHA-256 (hex) of the normalized filter set that minted this
     * cursor. Repositories that bind their filters to the cursor recompute
     * the fingerprint per request and reject mismatches, so an admin cannot
     * replay a cursor minted under filter set A against filter set B.
     * Optional: only lists whose filters change the result set bind one (the audit list and
     * the shared keyset helper, `finishKeysetPage`).
     */
    filter_fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

/** Inferred type of {@link listCursorPayloadSchema}; the fields encoded inside an opaque cursor. */
export type ListCursorPayload = z.infer<typeof listCursorPayloadSchema>;

/**
 * Result of {@link parseListCursor}: a validated opaque cursor payload whose `created_at`
 * is the row's PostgreSQL timestamp as UTC ISO text with microseconds (a JS `Date` would
 * truncate to milliseconds and skip or repeat rows created within one millisecond).
 */
export type ParsedListCursor = {
  kind: 'opaque';
  created_at: string;
  /** The sort value as text; `null` when the minting row had none (a nulls-last sort). */
  sort_value?: string | null;
  public_id?: string;
  id?: number;
  /** Optional SHA-256 fingerprint of the minting filter set (sec-U12). */
  filter_fingerprint?: string;
};

/** Domain-separation label of the list-cursor key (a sub-key of `SECRETS_ENCRYPTION_KEY`). */
const LIST_CURSOR_KEY_LABEL = 'list-cursor';
const LIST_CURSOR_AUTH_TAG_LENGTH = 16;

/**
 * Encodes a cursor payload as an opaque token: AES-256-GCM under the `list-cursor` sub-key,
 * `base64url(iv | authTag | ciphertext)`.
 *
 * @remarks
 * - **Why encrypted:** the payload carries the row's internal id (the keyset tie-breaker) and
 *   the filter fingerprint. Encrypted, the internal id never leaves the server readable, and the
 *   auth tag makes a cursor that was not minted here — edited, forged, or minted under another
 *   key — decode as nothing.
 * - **Failure modes:** none — a random 12-byte IV per cursor.
 * - **Side effects:** none.
 * - **Notes:** rotating `SECRETS_ENCRYPTION_KEY` invalidates outstanding cursors; those lists
 *   restart at the first page.
 */
export function encodeListCursor(payload: ListCursorPayload): string {
  const iv = randomBytes(AES_GCM_IV_LENGTH);
  const cipher = createCipheriv(AES_GCM_ALGORITHM, deriveSecretsSubKey(LIST_CURSOR_KEY_LABEL), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/**
 * Decrypts and validates an opaque cursor; returns `null` when it is malformed, was not minted by
 * {@link encodeListCursor} under the current key, or fails validation.
 */
export function decodeListCursor(cursor: string): ListCursorPayload | null {
  try {
    const data = Buffer.from(cursor, 'base64url');
    if (data.length <= AES_GCM_IV_LENGTH + LIST_CURSOR_AUTH_TAG_LENGTH) {
      return null;
    }
    const iv = data.subarray(0, AES_GCM_IV_LENGTH);
    const authTag = data.subarray(
      AES_GCM_IV_LENGTH,
      AES_GCM_IV_LENGTH + LIST_CURSOR_AUTH_TAG_LENGTH,
    );
    const ciphertext = data.subarray(AES_GCM_IV_LENGTH + LIST_CURSOR_AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(
      AES_GCM_ALGORITHM,
      deriveSecretsSubKey(LIST_CURSOR_KEY_LABEL),
      iv,
    );
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = listCursorPayloadSchema.safeParse(JSON.parse(plaintext.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Parses the `after` query parameter into a {@link ParsedListCursor}.
 * Returns `null` (first page) when `after` is absent, empty, or cannot be
 * decoded as a cursor this server issued (an encrypted, opaque token — never a bare id).
 */
export function parseListCursor(after: string | undefined): ParsedListCursor | null {
  if (after === undefined || after.length === 0) {
    return null;
  }
  const opaque = decodeListCursor(after);
  if (opaque) {
    return omitUndefined({
      kind: 'opaque' as const,
      created_at: opaque.created_at,
      sort_value: opaque.sort_value,
      public_id: opaque.public_id,
      id: opaque.id,
      filter_fingerprint: opaque.filter_fingerprint,
    });
  }
  return null;
}

/**
 * Projects the PostgreSQL timestamp as UTC ISO text without losing microseconds.
 * Select it as `cursor_created_at` alongside public row fields; serializers omit it.
 * The underlying timestamp remains the indexed ORDER BY and comparison column.
 */
export function cursorTimestampSelection(createdAtColumn: AnyColumn): SQL<string> {
  return sql<string>`to_char(${createdAtColumn} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** A list row that selected {@link cursorTimestampSelection} as `cursor_created_at`. */
export type CursorTimestampRow = { cursor_created_at: string };

/**
 * Builds an encrypted cursor from a row that selected `cursor_created_at` via
 * {@link cursorTimestampSelection} — required, so a list that forgets it fails to compile.
 */
export function createOpaqueCursorFromRow(
  row: CursorTimestampRow & {
    sort_value?: string | null;
    public_id?: string;
    id: number;
    filter_fingerprint?: string;
  },
): string {
  return encodeListCursor(
    omitUndefined({
      created_at: row.cursor_created_at,
      sort_value: row.sort_value,
      public_id: row.public_id,
      id: row.id,
      filter_fingerprint: row.filter_fingerprint,
    }),
  );
}

/** Returns the numeric id encoded in `cursor` for ascending-id pagination, or `undefined` for the first page. */
export function resolveAscendingIdAfter(cursor: ParsedListCursor | null): number | undefined {
  if (cursor === null) {
    return undefined;
  }
  return cursor.id;
}

/** Builds a Drizzle `WHERE` clause for ascending-by-id pagination; returns `undefined` for the first page. */
export function buildAscendingIdCursorCondition({
  idColumn,
  cursor,
}: {
  idColumn: AnyColumn;
  cursor: ParsedListCursor | null;
}): SQL | undefined {
  const afterId = resolveAscendingIdAfter(cursor);
  if (afterId === undefined) {
    return undefined;
  }
  return gt(idColumn, afterId);
}

/**
 * Builds a Drizzle `WHERE` clause for ascending pagination on
 * `(created_at, id)`. Compares the full ISO timestamp retained by the opaque
 * cursor, including PostgreSQL microseconds, with the id as an exact tie-breaker.
 */
export function buildAscendingCreatedAtIdCursorCondition({
  createdAtColumn,
  idColumn,
  cursor,
}: {
  createdAtColumn: AnyColumn;
  idColumn: AnyColumn;
  cursor: ParsedListCursor | null;
}): SQL | undefined {
  if (cursor === null) {
    return undefined;
  }
  const timestamp = sql`${cursor.created_at}::timestamptz`;
  const cursorId = cursor.id;
  if (cursorId === undefined) {
    return gt(createdAtColumn, timestamp);
  }
  return or(
    gt(createdAtColumn, timestamp),
    and(eq(createdAtColumn, timestamp), gt(idColumn, cursorId)),
  )!;
}

/**
 * Builds a Drizzle `WHERE` clause for ascending pagination on
 * `(text_column, id)`, e.g. sort by name then id. Requires `sort_value` and
 * `id` to be present in the cursor.
 */
export function buildAscendingTextIdCursorCondition({
  textColumn,
  idColumn,
  cursor,
}: {
  textColumn: AnyColumn;
  idColumn: AnyColumn;
  cursor: ParsedListCursor | null;
}): SQL | undefined {
  if (cursor === null) {
    return undefined;
  }
  const sortValue = cursor.sort_value;
  // A NOT NULL text sort never mints a null value; one that does restarts the list.
  if (sortValue === undefined || sortValue === null || cursor.id === undefined) {
    return undefined;
  }
  return or(gt(textColumn, sortValue), and(eq(textColumn, sortValue), gt(idColumn, cursor.id)))!;
}

/**
 * Builds a Drizzle `WHERE` clause for descending pagination on
 * `(created_at, id)`. Mirrors {@link buildAscendingCreatedAtIdCursorCondition}
 * but uses `<` so newer rows come first.
 */
export function buildDescendingCreatedAtIdCursorCondition({
  createdAtColumn,
  idColumn,
  cursor,
}: {
  createdAtColumn: AnyColumn;
  idColumn: AnyColumn;
  cursor: ParsedListCursor | null;
}): SQL | undefined {
  if (cursor === null) {
    return undefined;
  }
  const timestamp = sql`${cursor.created_at}::timestamptz`;
  const cursorId = cursor.id;
  if (cursorId === undefined) {
    return lt(createdAtColumn, timestamp);
  }
  return or(
    lt(createdAtColumn, timestamp),
    and(eq(createdAtColumn, timestamp), lt(idColumn, cursorId)),
  )!;
}

/**
 * Builds a Drizzle `WHERE` clause for descending pagination on `(text_column, id)`.
 * Mirrors {@link buildAscendingTextIdCursorCondition} but uses `<` (id still tie-breaks
 * ascending, matching a `ORDER BY text DESC, id ASC` page). Requires `sort_value` + `id`.
 */
export function buildDescendingTextIdCursorCondition({
  textColumn,
  idColumn,
  cursor,
}: {
  textColumn: AnyColumn;
  idColumn: AnyColumn;
  cursor: ParsedListCursor | null;
}): SQL | undefined {
  if (cursor === null) {
    return undefined;
  }
  const sortValue = cursor.sort_value;
  // A NOT NULL text sort never mints a null value; one that does restarts the list.
  if (sortValue === undefined || sortValue === null || cursor.id === undefined) {
    return undefined;
  }
  return or(lt(textColumn, sortValue), and(eq(textColumn, sortValue), gt(idColumn, cursor.id)))!;
}

/**
 * How a keyset sort value is compared in SQL: text as itself, a timestamp or an integer cast from
 * the cursor's text (`sort_value` is always text inside the cursor).
 */
type KeysetValueType = 'text' | 'timestamp' | 'integer';

/** The cursor's `sort_value` as the SQL value its column compares against. */
function keysetValueSql({
  sortValue,
  valueType,
}: {
  sortValue: string;
  valueType: KeysetValueType;
}): SQL | string {
  if (valueType === 'timestamp') return sql`${sortValue}::timestamptz`;
  if (valueType === 'integer') return sql`${sortValue}::integer`;
  return sortValue;
}

/**
 * The keyset condition of a NULLABLE sort whose rows without a value page after every value, in
 * both directions (`ORDER BY value ASC|DESC NULLS LAST, id ASC`) — a text sort (routes-final § 2
 * CQ2, CTC4) or a timestamp sort (§ 3 AQ9, AUC6).
 *
 * @remarks
 * - **Algorithm:** a cursor minted on a row WITH a value `v` continues past it the way the plain
 *   keyset does (`value > v` ascending, `value < v` descending, or `value = v AND id > cursor
 *   id`) and then into every value-less row (`OR value IS NULL`); a cursor minted on a row WITHOUT
 *   a value (`sort_value: null`) continues inside the value-less rows only (`value IS NULL AND id
 *   > cursor id`). The id tie-break stays ascending in both directions, as the plain text
 *   keyset's. A timestamp travels as its microsecond UTC text and is cast back (`::timestamptz`).
 * - **Failure modes:** none — a cursor without `sort_value` or `id` is no cursor (the first page).
 * - **Side effects:** none.
 * - **Notes:** a row without a value mints `sort_value: null`, which the cursor schema carries,
 *   so paging into the value-less tail never restarts the list.
 */
function buildNullsLastValueIdCursorCondition({
  valueColumn,
  idColumn,
  cursor,
  direction,
  valueType,
}: {
  valueColumn: AnyColumn;
  idColumn: AnyColumn;
  cursor: ParsedListCursor | null;
  direction: 'asc' | 'desc';
  valueType: Exclude<KeysetValueType, 'integer'>;
}): SQL | undefined {
  if (cursor === null) {
    return undefined;
  }
  const sortValue = cursor.sort_value;
  if (sortValue === undefined || cursor.id === undefined) {
    return undefined;
  }
  if (sortValue === null) {
    return and(isNull(valueColumn), gt(idColumn, cursor.id))!;
  }
  const value = keysetValueSql({ sortValue, valueType });
  const pastValue = direction === 'asc' ? gt(valueColumn, value) : lt(valueColumn, value);
  return or(pastValue, and(eq(valueColumn, value), gt(idColumn, cursor.id)), isNull(valueColumn))!;
}

/**
 * Builds a Drizzle `WHERE` clause for ascending pagination on a NULLABLE `(text_column, id)` whose
 * rows without a value come last (`ORDER BY text ASC NULLS LAST, id ASC`) — e.g. contacts by
 * username (routes-final § 2 CQ2). Requires `sort_value` (`null` for a value-less row) and `id`.
 */
export function buildAscendingNullsLastTextIdCursorCondition({
  textColumn,
  idColumn,
  cursor,
}: {
  textColumn: AnyColumn;
  idColumn: AnyColumn;
  cursor: ParsedListCursor | null;
}): SQL | undefined {
  return buildNullsLastValueIdCursorCondition({
    valueColumn: textColumn,
    idColumn,
    cursor,
    direction: 'asc',
    valueType: 'text',
  });
}

/**
 * Builds a Drizzle `WHERE` clause for descending pagination on a NULLABLE `(text_column, id)` whose
 * rows without a value still come last (`ORDER BY text DESC NULLS LAST, id ASC`). Mirrors
 * {@link buildAscendingNullsLastTextIdCursorCondition} with `<` on the value.
 */
export function buildDescendingNullsLastTextIdCursorCondition({
  textColumn,
  idColumn,
  cursor,
}: {
  textColumn: AnyColumn;
  idColumn: AnyColumn;
  cursor: ParsedListCursor | null;
}): SQL | undefined {
  return buildNullsLastValueIdCursorCondition({
    valueColumn: textColumn,
    idColumn,
    cursor,
    direction: 'desc',
    valueType: 'text',
  });
}

/**
 * Builds a Drizzle `WHERE` clause for ascending pagination on a NULLABLE `(timestamp_column, id)`
 * whose rows without a value come last (`ORDER BY ts ASC NULLS LAST, id ASC`) — e.g. automations
 * by `last_triggered_at`, never-triggered last (routes-final § 3 AQ9). Requires `sort_value` (the
 * timestamp as {@link cursorTimestampSelection} text, `null` for a value-less row) and `id`.
 */
export function buildAscendingNullsLastTimestampIdCursorCondition({
  timestampColumn,
  idColumn,
  cursor,
}: {
  timestampColumn: AnyColumn;
  idColumn: AnyColumn;
  cursor: ParsedListCursor | null;
}): SQL | undefined {
  return buildNullsLastValueIdCursorCondition({
    valueColumn: timestampColumn,
    idColumn,
    cursor,
    direction: 'asc',
    valueType: 'timestamp',
  });
}

/**
 * Builds a Drizzle `WHERE` clause for descending pagination on a NULLABLE `(timestamp_column, id)`
 * whose rows without a value still come last (`ORDER BY ts DESC NULLS LAST, id ASC`). Mirrors
 * {@link buildAscendingNullsLastTimestampIdCursorCondition} with `<` on the value.
 */
export function buildDescendingNullsLastTimestampIdCursorCondition({
  timestampColumn,
  idColumn,
  cursor,
}: {
  timestampColumn: AnyColumn;
  idColumn: AnyColumn;
  cursor: ParsedListCursor | null;
}): SQL | undefined {
  return buildNullsLastValueIdCursorCondition({
    valueColumn: timestampColumn,
    idColumn,
    cursor,
    direction: 'desc',
    valueType: 'timestamp',
  });
}

/**
 * The keyset condition of a NOT NULL integer sort (`ORDER BY n ASC|DESC, id ASC`) — e.g.
 * automations by `completed_run_count` (routes-final § 3 AQ9, AUC6). The value travels as its
 * decimal text in `sort_value` and is cast back (`::integer`).
 *
 * @remarks
 * - **Algorithm:** `n > v` ascending or `n < v` descending, or `n = v AND id > cursor id` — the id
 *   tie-break ascending in both directions, as the text keyset's.
 * - **Failure modes:** none — a cursor without `sort_value` (or with `null`, which a NOT NULL sort
 *   never mints) or without `id` is no cursor: the list restarts.
 * - **Side effects:** none.
 */
function buildIntegerIdCursorCondition({
  integerColumn,
  idColumn,
  cursor,
  direction,
}: {
  integerColumn: AnyColumn;
  idColumn: AnyColumn;
  cursor: ParsedListCursor | null;
  direction: 'asc' | 'desc';
}): SQL | undefined {
  if (cursor === null) {
    return undefined;
  }
  const sortValue = cursor.sort_value;
  if (sortValue === undefined || sortValue === null || cursor.id === undefined) {
    return undefined;
  }
  const value = keysetValueSql({ sortValue, valueType: 'integer' });
  const pastValue = direction === 'asc' ? gt(integerColumn, value) : lt(integerColumn, value);
  return or(pastValue, and(eq(integerColumn, value), gt(idColumn, cursor.id)))!;
}

/**
 * Builds a Drizzle `WHERE` clause for ascending pagination on a NOT NULL `(integer_column, id)`
 * (`ORDER BY n ASC, id ASC`). Requires `sort_value` (the decimal text) and `id`.
 */
export function buildAscendingIntegerIdCursorCondition({
  integerColumn,
  idColumn,
  cursor,
}: {
  integerColumn: AnyColumn;
  idColumn: AnyColumn;
  cursor: ParsedListCursor | null;
}): SQL | undefined {
  return buildIntegerIdCursorCondition({ integerColumn, idColumn, cursor, direction: 'asc' });
}

/**
 * Builds a Drizzle `WHERE` clause for descending pagination on a NOT NULL `(integer_column, id)`
 * (`ORDER BY n DESC, id ASC`). Mirrors {@link buildAscendingIntegerIdCursorCondition} with `<`.
 */
export function buildDescendingIntegerIdCursorCondition({
  integerColumn,
  idColumn,
  cursor,
}: {
  integerColumn: AnyColumn;
  idColumn: AnyColumn;
  cursor: ParsedListCursor | null;
}): SQL | undefined {
  return buildIntegerIdCursorCondition({ integerColumn, idColumn, cursor, direction: 'desc' });
}
