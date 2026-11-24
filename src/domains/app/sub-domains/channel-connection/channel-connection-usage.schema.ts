import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  pgPolicy,
  smallint,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_connections } from './channel-connection.schema.js';

/**
 * `app.channel_connection_usages` — Meta's usage of one connection, per asset and use-case type
 * (routes-final § 1 MC19 as refined by S13, P107): the highest percentage Meta reported in
 * `X-Business-Use-Case-Usage`, when calls may go again, and when it was read. One row per
 * (connection, asset, type); a write keeps the newer `read_at` (an older reading never overwrites a
 * newer one). Postgres holds it (P32); `channel-connection-usage.cache.ts` keeps a short Redis copy.
 * No public id. RLS: the organization arm only — usage is read and written in an organization's
 * scope.
 */
export const channel_connection_usages = appSchema
  .table(
    'channel_connection_usages',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      channel_connection_id: bigint('channel_connection_id', { mode: 'number' }).notNull(),
      /** The asset id Meta keyed the entry by. */
      asset_id: varchar('asset_id', { length: 64 }).notNull(),
      /** Meta's use-case type, lower-cased (`type` in Meta's header). */
      usage_type: varchar('usage_type', { length: 64 }).notNull(),
      /** 0–100. */
      usage_percent: smallint('usage_percent').notNull(),
      /** Set at ≥ 95 % or when Meta named a time to regain access. */
      wait_until: timestamp('wait_until', { withTimezone: true }),
      /** When the answer was read; the newer reading wins. */
      read_at: timestamp('read_at', { withTimezone: true }).notNull(),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'channel_connection_usages_channel_connection_fk',
        columns: [table.organization_id, table.channel_connection_id],
        foreignColumns: [channel_connections.organization_id, channel_connections.id],
      }).onDelete('cascade'),
      // One reading per connection, asset and type (S13), and the composite key's index.
      uniqueIndex('idx_channel_connection_usages_connection_asset_type').on(
        table.organization_id,
        table.channel_connection_id,
        table.asset_id,
        table.usage_type,
      ),
      check(
        'chk_channel_connection_usages_usage_percent',
        sql`${table.usage_percent} BETWEEN 0 AND 100`,
      ),
      check('chk_channel_connection_usages_asset_id', sql`length(${table.asset_id}) > 0`),
      check('chk_channel_connection_usages_usage_type', sql`length(${table.usage_type}) > 0`),
      check(
        'chk_channel_connection_usages_updated',
        sql`${table.updated_at} >= ${table.created_at}`,
      ),
      pgPolicy('channel_connection_usages_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )`,
        withCheck: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )`,
      }),
    ],
  )
  .enableRLS();
