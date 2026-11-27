import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgPolicy,
  primaryKey,
  timestamp,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';

/**
 * `app.instagram_send_day_counts` — one account's message results of one day of its organization's
 * time zone (feat-instagram-dm-sending scale review S8, P97): sent, not sure (`unknown`), skipped
 * and of those "chat closed", expired. Route 63's "today" line reads this one row instead of
 * scanning the account's week parts of `app.instagram_outgoing_messages`.
 *
 * @remarks
 * - Raised by the one shared result save (`saveSendResult`, ROUTE row R42) in the result's own
 *   commit; kept 13 months with the month counts (the hourly clean-up, WC-54's batch).
 * - Hot counter rows: the migration sets `fillfactor = 80`. No `id`.
 * - RLS: the organization policy, plus the retention sweep arm in `USING` only (the clean-up).
 */
export const instagram_send_day_counts = appSchema
  .table(
    'instagram_send_day_counts',
    {
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /** The day in `tenancy.organizations.timezone`. */
      day_date: date('day_date', { mode: 'string' }).notNull(),
      sent_count: integer('sent_count').notNull().default(0),
      unknown_count: integer('unknown_count').notNull().default(0),
      skipped_count: integer('skipped_count').notNull().default(0),
      /** Of `skipped_count`, those skipped `window_closed`. */
      skipped_window_closed_count: integer('skipped_window_closed_count').notNull().default(0),
      expired_count: integer('expired_count').notNull().default(0),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      primaryKey({
        name: 'instagram_send_day_counts_pkey',
        columns: [table.organization_id, table.channel_account_id, table.day_date],
      }),
      foreignKey({
        name: 'instagram_send_day_counts_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('cascade'),
      // The clean-up's delete by age.
      index('idx_instagram_send_day_counts_day').on(table.day_date),
      check(
        'chk_instagram_send_day_counts_counts',
        sql`${table.sent_count} >= 0 AND ${table.unknown_count} >= 0 AND ${table.skipped_count} >= 0
    AND ${table.skipped_window_closed_count} BETWEEN 0 AND ${table.skipped_count} AND ${table.expired_count} >= 0`,
      ),
      pgPolicy('instagram_send_day_counts_tenant_isolation', {
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
