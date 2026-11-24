import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgPolicy,
  primaryKey,
  smallint,
  timestamp,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';

/**
 * `app.message_month_counts` — messages sent into people's chats by one organization in one
 * calendar month of its time zone, across every channel (feat-instagram-dm-sending routes-final
 * § 6.A.3, SN8, D34, P43 — shared, the plan's `message_month_limit` spans channels), split into 16
 * slots by channel account so accounts never wait on each other's row lock.
 *
 * @remarks
 * - `month_start` is the 1st of the month in `tenancy.organizations.timezone`; `slot` is the channel
 *   account's internal id modulo 16. Raised in the send's claim commit (R42), never recounted; the
 *   month's `used` is the sum of its slots. Kept 13 months (WC-54).
 * - Hot counter rows: the migration sets `fillfactor = 80`. No account column (P6), no `id`.
 * - RLS: the organization policy, plus the retention sweep arm in `USING` only (the 13-month delete
 *   and the month wake read across organizations).
 */
export const message_month_counts = appSchema
  .table(
    'message_month_counts',
    {
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      month_start: date('month_start', { mode: 'string' }).notNull(),
      /** 0–15, from the channel account's internal id. */
      slot: smallint('slot').notNull(),
      count: integer('count').notNull().default(0),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      primaryKey({
        name: 'message_month_counts_pkey',
        columns: [table.organization_id, table.month_start, table.slot],
      }),
      // The 13-month delete (WC-54).
      index('idx_message_month_counts_month').on(table.month_start),
      check('chk_message_month_counts_slot', sql`${table.slot} BETWEEN 0 AND 15`),
      check('chk_message_month_counts_count', sql`${table.count} >= 0`),
      check(
        'chk_message_month_counts_month_start',
        sql`extract(day FROM ${table.month_start}) = 1`,
      ),
      pgPolicy('message_month_counts_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )
          OR ${maintenanceBypassArm('app.global_retention_cleanup')}`,
        withCheck: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )`,
      }),
    ],
  )
  .enableRLS();
