import type { PgTable, AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * The record tables an upload can be bound to (C-2), by the `bound_resource` each stores — the
 * sweep that tombstones the uploads of a record that is gone (G2-5) reads them.
 *
 * @remarks
 * - **Notes:** a join-only read of the records' tables (`NOT EXISTS`), the same exception the upload
 *   schema already takes for the tenancy and user tables. Keep it in step with the `resource` each
 *   record's `uploadFields` names — pinned by `upload-bound-records.unit.test.ts`.
 */
export const UPLOAD_BOUND_RECORD_TABLES: Readonly<
  Record<string, { table: PgTable; publicId: AnyPgColumn }>
> = {};
