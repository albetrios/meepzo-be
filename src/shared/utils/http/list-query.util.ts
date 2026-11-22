/**
 * Common building blocks for organization-scoped list endpoints that support opaque-cursor pagination
 * **plus** server-side search (`q`) and sort (`sort` / `order`). One mechanism shared by every list
 * (memberships, roles, api-keys, …) so the keyset + cursor + filter-binding subtleties live in a
 * single place instead of being hand-rolled per repository.
 *
 * @remarks
 * - **Algorithm**: `q` becomes a case-insensitive `ILIKE` over the configured columns; `sort`/`order`
 *   pick the matching keyset condition (`(created_at,id)`, `(text,id)`, `(integer,id)`, or a
 *   nullable `(text,id)` / `(timestamp,id)` whose value-less rows come last, asc/desc) from
 *   `pagination.util.ts`; the page fetches
 *   `limit + 1` rows to compute `has_more` without a count.
 * - **Filter binding (sec-U12)**: the minted cursor carries a SHA-256 fingerprint of `{q, sort,
 *   order}`. A cursor whose fingerprint no longer matches the current query is ignored (the page
 *   resets to the first page) so a cursor minted under one sort/filter can't yield wrong rows under
 *   another — never silently interleaving pages.
 * - **Side effects**: none (pure query construction); the caller owns the DB round-trip.
 * - **Notes**: columns may live on a joined table — the helper only needs the `AnyColumn`; the
 *   repository's query supplies the join and selects the sort value.
 */
import { createHash } from 'node:crypto';
import { type AnyColumn, and, asc, desc, ilike, type SQL, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  buildAscendingCreatedAtIdCursorCondition,
  buildAscendingIntegerIdCursorCondition,
  buildAscendingNullsLastTextIdCursorCondition,
  buildAscendingNullsLastTimestampIdCursorCondition,
  buildAscendingTextIdCursorCondition,
  buildDescendingCreatedAtIdCursorCondition,
  buildDescendingIntegerIdCursorCondition,
  buildDescendingNullsLastTextIdCursorCondition,
  buildDescendingNullsLastTimestampIdCursorCondition,
  buildDescendingTextIdCursorCondition,
  createOpaqueCursorFromRow,
  type CursorTimestampRow,
  cursorPaginationSchema,
  type ParsedListCursor,
  parseListCursor,
} from './pagination.util.js';

/** Max length of a `q` search term (defensive; the `ILIKE` is escaped regardless). */
const SEARCH_TERM_MAX_LENGTH = 200;

/**
 * A list's `q` search term: trimmed, 1–200 characters. The one rule for every search — a keyset
 * list's ({@link listSearchSortSchema}) and a limit-only read's.
 */
export const searchTermSchema = z.string().trim().min(1).max(SEARCH_TERM_MAX_LENGTH);

/**
 * Builds a `.strict()` list-query schema: cursor pagination + optional `q`, `sort` (constrained to
 * `sortFields`), and `order` (`asc`/`desc`, default `asc`). Reuse per list endpoint DTO.
 */
export function listSearchSortSchema<const Fields extends readonly [string, ...string[]]>(
  sortFields: Fields,
) {
  return cursorPaginationSchema
    .extend({
      q: searchTermSchema.optional(),
      sort: z.enum(sortFields).optional(),
      // Optional (not `.default`) so OpenAPI emits it as an optional query param — a defaulted
      // param serializes as `required`, a breaking contract change. Defaulted to
      // ascending inside resolveKeysetSort instead.
      order: z.enum(['asc', 'desc']).optional(),
    })
    .strict();
}

/** Escapes `ILIKE` wildcards so a user's `%`/`_`/`\` are matched literally (default `ESCAPE '\'`). */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Builds a contained `%term%` `ILIKE` pattern with the user's wildcards escaped. */
export function buildContainsLikePattern(term: string): string {
  return `%${escapeLikeTerm(term)}%`;
}

/** The words of a search, split on whitespace, empty ones dropped. */
export function searchWords(q: string): string[] {
  return q.split(/\s+/).filter((word) => word !== '');
}

/** `ILIKE '%term%'` across `columns`, OR-combined. */
function containsInAnyColumn({
  columns,
  term,
}: {
  columns: readonly (AnyColumn | SQL)[];
  term: string;
}): SQL {
  const pattern = buildContainsLikePattern(term);
  const conditions = columns.map((column) => ilike(column, pattern));
  return (conditions.length === 1 ? conditions[0] : or(...conditions)) as SQL;
}

/**
 * Case-insensitive `ILIKE '%term%'` across `columns` (OR-combined) — columns, or SQL text
 * expressions such as a text array joined into one string. Returns `undefined` when `q` is empty so
 * callers can spread it into `and(...)` unconditionally.
 *
 * @remarks
 * With `everyWord`, each whitespace-separated word of `q` must be in some column, in any order
 * (AND of the per-word ORs) — "iyer meera" finds Meera Iyer. A phrase that matches as a whole still
 * matches, so it only widens the result; a one-word `q` is the same condition either way.
 */
export function buildSearchCondition({
  columns,
  q,
  everyWord = false,
}: {
  columns: readonly (AnyColumn | SQL)[];
  q: string | undefined;
  /** Match every word of `q` anywhere, instead of `q` as one phrase. */
  everyWord?: boolean;
}): SQL | undefined {
  if (!q || columns.length === 0) {
    return undefined;
  }
  const words = everyWord ? searchWords(q) : [q];
  if (words.length === 0) return undefined;
  const conditions = words.map((term) => containsInAnyColumn({ columns, term }));
  return conditions.length === 1 ? conditions[0] : and(...conditions);
}

/**
 * SHA-256 fingerprint of the sort/filter set a cursor was minted under (stable key order). A list
 * with filters beyond `q` passes them in `filters`, so a cursor never crosses to another filter set;
 * without `filters` the fingerprint is the same as before.
 */
export function computeListFilterFingerprint(parts: {
  q: string | undefined;
  sort: string;
  order: 'asc' | 'desc';
  filters?: Readonly<Record<string, unknown>> | undefined;
}): string {
  const normalized = {
    q: parts.q ?? '',
    sort: parts.sort,
    order: parts.order,
    ...(parts.filters === undefined ? {} : { filters: parts.filters }),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * A sortable column plus how to read its cursor `sort_value` from a result row (every sort but a
 * NOT NULL `created_at` one).
 */
export interface KeysetSortColumn<Row> {
  column: AnyColumn;
  /**
   * `created_at` — a timestamp; `text`; `integer` — a whole number (routes-final § 3 AQ9). A NOT
   * NULL timestamp keysets on the row's `cursor_created_at`; every other sort on `sort_value`.
   */
  kind: 'text' | 'created_at' | 'integer';
  /**
   * `'last'`: the column is NULLABLE and the rows without a value page after every value, in both
   * directions (`NULLS LAST`), instead of dropping out after the first page. Built for `text`
   * sorts (routes-final § 2 CQ2) and `created_at` (timestamp) sorts (§ 3 AQ9); a nullable integer
   * sort adds its keyset builder in `resolveKeysetOrder`.
   */
  nulls?: 'last';
  /**
   * Extract the sort value for the opaque cursor as text — required for `text`, `integer` and a
   * nulls-last `created_at` sort (the timestamp as `cursorTimestampSelection` text, keeping
   * microseconds); `null` for a row without one under a nulls-last sort.
   */
  getSortValue?: (row: Row) => string | null;
}

/** The `ORDER BY` and keyset `WHERE` of one resolved sort. */
interface KeysetOrder {
  orderBy: SQL[];
  cursorCondition: SQL | undefined;
}

/**
 * The `ORDER BY` and keyset condition of a nulls-last sort in one direction (text or timestamp).
 *
 * @remarks
 * `NULLS LAST` is said explicitly, since Postgres puts nulls first on a `DESC` sort by default; the
 * `id` tie-break stays ascending in both directions, matching the nulls-last keyset builders.
 * Throws on a kind no builder handles yet — a programming error, caught by the first test of the
 * list that declares it.
 */
function resolveNullsLastKeysetOrder({
  column,
  kind,
  idColumn,
  order,
  cursor,
}: {
  column: AnyColumn;
  kind: KeysetSortColumn<unknown>['kind'];
  idColumn: AnyColumn;
  order: 'asc' | 'desc';
  cursor: ParsedListCursor | null;
}): KeysetOrder {
  const orderBy = [
    order === 'desc' ? sql`${column} DESC NULLS LAST` : sql`${column} ASC NULLS LAST`,
    asc(idColumn),
  ];
  if (kind === 'text') {
    const build =
      order === 'desc'
        ? buildDescendingNullsLastTextIdCursorCondition
        : buildAscendingNullsLastTextIdCursorCondition;
    return { orderBy, cursorCondition: build({ textColumn: column, idColumn, cursor }) };
  }
  if (kind === 'created_at') {
    const build =
      order === 'desc'
        ? buildDescendingNullsLastTimestampIdCursorCondition
        : buildAscendingNullsLastTimestampIdCursorCondition;
    return { orderBy, cursorCondition: build({ timestampColumn: column, idColumn, cursor }) };
  }
  throw new Error(
    `A nulls-last keyset sort is built for text and timestamp columns only, not "${kind}"`,
  );
}

/**
 * The `ORDER BY` and keyset condition of one sort column in one direction — the one place a new
 * sort kind adds its builders.
 *
 * @remarks
 * - **Algorithm:** `(created_at, id)` orders both columns the same way; a text sort, an integer
 *   sort and a nulls-last sort keep the `id` tie-break ascending in both directions (matching their
 *   keyset builders); a nulls-last sort says `NULLS LAST` explicitly.
 * - **Failure modes:** throws on a nulls-last sort of a kind no builder handles yet (an integer) —
 *   a programming error, caught by the first test of the list that declares it.
 */
function resolveKeysetOrder<Row>({
  spec,
  idColumn,
  order,
  cursor,
}: {
  spec: KeysetSortColumn<Row>;
  idColumn: AnyColumn;
  order: 'asc' | 'desc';
  cursor: ParsedListCursor | null;
}): KeysetOrder {
  const { column, kind } = spec;
  const idAsc = asc(idColumn);
  if (spec.nulls === 'last') {
    return resolveNullsLastKeysetOrder({ column, kind, idColumn, order, cursor });
  }
  if (kind === 'created_at') {
    return order === 'desc'
      ? {
          orderBy: [desc(column), desc(idColumn)],
          cursorCondition: buildDescendingCreatedAtIdCursorCondition({
            createdAtColumn: column,
            idColumn,
            cursor,
          }),
        }
      : {
          orderBy: [asc(column), idAsc],
          cursorCondition: buildAscendingCreatedAtIdCursorCondition({
            createdAtColumn: column,
            idColumn,
            cursor,
          }),
        };
  }
  if (kind === 'integer') {
    const build =
      order === 'desc'
        ? buildDescendingIntegerIdCursorCondition
        : buildAscendingIntegerIdCursorCondition;
    return {
      orderBy: [order === 'desc' ? desc(column) : asc(column), idAsc],
      cursorCondition: build({ integerColumn: column, idColumn, cursor }),
    };
  }
  // text keyset — id tie-break stays ascending in both directions (matches the text keyset builders)
  return order === 'desc'
    ? {
        orderBy: [desc(column), idAsc],
        cursorCondition: buildDescendingTextIdCursorCondition({
          textColumn: column,
          idColumn,
          cursor,
        }),
      }
    : {
        orderBy: [asc(column), idAsc],
        cursorCondition: buildAscendingTextIdCursorCondition({
          textColumn: column,
          idColumn,
          cursor,
        }),
      };
}

/**
 * Resolves a validated `(sort, order)` into the Drizzle `ORDER BY`, the matching keyset `WHERE`
 * condition, and a `sort_value` extractor — reusing the `pagination.util.ts` keyset builders. A
 * cursor whose `filter_fingerprint` doesn't match the current query is treated as absent (resets to
 * the first page). `idColumn` tie-breaks ascending on a text, integer or nulls-last sort (matching
 * the keyset builders) and follows the order on a `(created_at, id)` sort. A column declared
 * `nulls: 'last'` pages its value-less rows after every value, in both directions. The column's
 * `getSortValue`, when it has one, mints the cursor's `sort_value`.
 */
export function resolveKeysetSort<Row>(args: {
  columns: Record<string, KeysetSortColumn<Row>>;
  idColumn: AnyColumn;
  defaultSort: string;
  sort: string | undefined;
  order?: 'asc' | 'desc' | undefined;
  q?: string | undefined;
  /** The list's other filters, folded into the cursor fingerprint. */
  filters?: Readonly<Record<string, unknown>> | undefined;
  after: string | undefined;
}): {
  sortField: string;
  orderBy: SQL[];
  cursorCondition: SQL | undefined;
  sortValueFor: (row: Row) => string | null | undefined;
  filterFingerprint: string;
} {
  const sortField = args.sort ?? args.defaultSort;
  const spec = args.columns[sortField] ?? args.columns[args.defaultSort];
  if (!spec) {
    throw new Error(
      `No keyset sort column configured for "${sortField}" or default "${args.defaultSort}"`,
    );
  }
  // `order` is optional at the boundary (so OpenAPI emits an optional param); default to ascending.
  const effectiveOrder = args.order ?? 'asc';
  const filterFingerprint = computeListFilterFingerprint({
    q: args.q,
    sort: sortField,
    order: effectiveOrder,
    filters: args.filters,
  });

  // Ignore a cursor minted under a different sort/filter — restart rather than interleave pages.
  let cursor: ParsedListCursor | null = parseListCursor(args.after);
  if (cursor?.filter_fingerprint !== undefined && cursor.filter_fingerprint !== filterFingerprint) {
    cursor = null;
  }

  const sortValueFor: (row: Row) => string | null | undefined =
    spec.getSortValue ?? (() => undefined);
  const { orderBy, cursorCondition } = resolveKeysetOrder({
    spec,
    idColumn: args.idColumn,
    order: effectiveOrder,
    cursor,
  });
  return { sortField, orderBy, cursorCondition, sortValueFor, filterFingerprint };
}

/**
 * Turns a `limit + 1` fetch into a page result: slices to `limit`, computes `has_more`, and mints
 * the next opaque cursor from the last row (embedding `sort_value` / `filter_fingerprint` when the
 * list has them). Rows must expose `id` and `cursor_created_at` (selected with
 * `cursorTimestampSelection`, keeping PostgreSQL microseconds). The one page builder for every
 * keyset list — plain `(created_at, id)` lists pass only `limit` (and `total` when counted).
 */
export function finishKeysetPage<
  Row extends CursorTimestampRow & { id: number; public_id?: string },
>({
  rows,
  args,
}: {
  rows: Row[];
  args: {
    limit: number;
    total?: number | null;
    sortValueFor?: (row: Row) => string | null | undefined;
    filterFingerprint?: string;
  };
}): {
  items: Row[];
  total: number | null;
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
} {
  const hasMore = rows.length > args.limit;
  const items = hasMore ? rows.slice(0, args.limit) : rows;
  const last = items.at(-1);
  let next_cursor: string | null = null;
  if (hasMore && last !== undefined) {
    const sortValue = args.sortValueFor?.(last);
    // exactOptionalPropertyTypes: omit undefined-valued optional keys rather than pass `undefined`.
    next_cursor = createOpaqueCursorFromRow({
      cursor_created_at: last.cursor_created_at,
      id: last.id,
      ...(last.public_id !== undefined ? { public_id: last.public_id } : {}),
      ...(sortValue !== undefined ? { sort_value: sortValue } : {}),
      ...(args.filterFingerprint !== undefined
        ? { filter_fingerprint: args.filterFingerprint }
        : {}),
    });
  }
  return {
    items,
    total: args.total ?? null,
    limit: args.limit,
    has_more: hasMore,
    next_cursor,
  };
}
