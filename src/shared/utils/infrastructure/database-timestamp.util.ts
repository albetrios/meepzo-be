import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Postgres `now()` for Drizzle `.set()` on timestamptz columns.
 * Use instead of `new Date()` so `updated_at >= created_at` check constraints hold
 * when a row is updated immediately after insert (DB clock vs JS clock skew).
 */
export const databaseNowTimestamp: SQL = sql`now()`;

/**
 * `updated_at` for a change of a row that another transaction may have inserted just now:
 * `greatest(created_at, now())` — Postgres `now()`, never before the row's own `created_at`.
 *
 * @remarks
 * - **Algorithm:** `now()` is the time the transaction began. A transaction that began before
 *   another one's insert committed still sees and changes the new row (READ COMMITTED), so a plain
 *   `now()` would lie before that row's `created_at`.
 * - **Failure modes:** none of its own — it prevents one: a table with `updated_at >= created_at`
 *   (`chk_<table>_updated`) would refuse the change (23514) and roll the whole unit back.
 * - **Side effects:** none; a SQL fragment, reusable across statements on the column's table.
 * - **Notes:** works in an `UPDATE … SET` and in an `ON CONFLICT … DO UPDATE SET` (the column names
 *   the stored row there).
 */
export function databaseUpdatedAtTimestamp(createdAtColumn: AnyPgColumn): SQL {
  return sql`greatest(${createdAtColumn}, now())`;
}
