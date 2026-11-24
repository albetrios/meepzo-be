import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  primaryKey,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';

/**
 * `app.instagram_send_minute_counts` — messages sent per account, count group and minute: gate 2
 * (feat-instagram-dm-sending routes-final § 6.A.3, SN3, D18). Raised in the same commit that marks a
 * message `sending`; gate 2 sums the last 61 minutes against the group's hour limit.
 *
 * @remarks
 * - Count groups `open` (slow) · `reply` · `fast` · `broadcast`; `minute_start` is Postgres's clock,
 *   to the minute. Rows over 2 hours old are deleted by the repair (WC-20).
 * - Hot counter rows: the migration sets `fillfactor = 80`. No public id, no `id`.
 * - RLS: the organization policy, plus the retention sweep arm in `USING` only (the repair).
 */
export const instagram_send_minute_counts = appSchema
  .table(
    'instagram_send_minute_counts',
    {
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /** `open` · `reply` · `fast` · `broadcast`. */
      count_group: varchar('count_group', { length: 9 }).notNull(),
      minute_start: timestamp('minute_start', { withTimezone: true }).notNull(),
      count: integer('count').notNull().default(0),
    },
    (table) => [
      primaryKey({
        name: 'instagram_send_minute_counts_pkey',
        columns: [
          table.organization_id,
          table.channel_account_id,
          table.count_group,
          table.minute_start,
        ],
      }),
      foreignKey({
        name: 'instagram_send_minute_counts_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('cascade'),
      // The 2-hour delete (WC-20).
      index('idx_instagram_send_minute_counts_minute').on(table.minute_start),
      check(
        'chk_instagram_send_minute_counts_count_group',
        sql`${table.count_group} IN ('open', 'reply', 'fast', 'broadcast')`,
      ),
      check('chk_instagram_send_minute_counts_count', sql`${table.count} >= 0`),
      pgPolicy('instagram_send_minute_counts_tenant_isolation', {
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
