import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  pgPolicy,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { sqlLiteral } from '@/infrastructure/database/utils/sql-literal.util.js';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import {
  INSTAGRAM_ID_MAX_LENGTH,
  INSTAGRAM_ID_PATTERN,
} from '@/shared/constants/instagram.constants.js';

/**
 * `app.channel_connections` — one provider login of an organization for one business
 * (routes-final § 1.3, MC1): for Meta's Unified Login (`provider` `meta`), one business portfolio
 * holding the granted scopes and bringing in its Instagram accounts. One row per organization,
 * provider and business, so a reconnect reuses the row (revoked included). The status moves by
 * actions only (`connected → error` on a broken token, MC11; `error → connected` by a callback,
 * MC5; any → `revoked` on "Disconnect business" or when its last account leaves); there is no soft
 * delete — `revoked` stands in. Meta's usage is kept per asset and type in
 * `app.channel_connection_usages` (S13, P107), not on this row. RLS: the organization policy, plus
 * the retention sweep arm in `USING` only (the daily token check's sweep, MC10).
 */
export const channel_connections = appSchema
  .table(
    'channel_connections',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      /** `meta` only this iteration (MC1). */
      provider: varchar('provider', { length: 20 }).notNull().default('meta'),
      /** Meta's `client_business_id` — the business portfolio; digits only. */
      client_business_id: varchar('client_business_id', {
        length: INSTAGRAM_ID_MAX_LENGTH,
      }).notNull(),
      /** The login configuration used (`META_CONFIG_ID` at the time); not secret. */
      config_id: varchar('config_id', { length: 64 }).notNull(),
      /** `unified` only (one Meta login for Instagram, Facebook and ads, D27). */
      login_type: varchar('login_type', { length: 20 }).notNull().default('unified'),
      /** `connected` · `error` · `revoked`. */
      status: varchar('status', { length: 10 }).notNull().default('connected'),
      status_changed_at: timestamp('status_changed_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
      /** The permissions Meta granted (P41), at most 20. */
      scopes: text('scopes').array().notNull().default([]),
      connected_by_user_id: bigint('connected_by_user_id', { mode: 'number' }).references(
        () => users.id,
        { onDelete: 'set null' },
      ),
      /** The latest connect or reconnect. */
      connected_at: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
      /** The last daily token check (MC10). */
      last_checked_at: timestamp('last_checked_at', { withTimezone: true }),
      /** Meta's code, subcode and HTTP status of the last failed check — never its text. */
      last_check_error: varchar('last_check_error', { length: 500 }),
      /** Set exactly while `revoked`. */
      disconnected_at: timestamp('disconnected_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      uniqueIndex('idx_channel_connections_public_id').on(table.public_id),
      // The children's composite key (organization_id, channel_connection_id) → (organization_id, id).
      uniqueIndex('idx_channel_connections_organization_id_id').on(table.organization_id, table.id),
      // One row per organization, provider and business: a reconnect reuses it (MC5).
      uniqueIndex('idx_channel_connections_organization_business').on(
        table.organization_id,
        table.provider,
        table.client_business_id,
      ),
      // Meta's callbacks matched by business across organizations (MC15, P56).
      index('idx_channel_connections_provider_business').on(
        table.provider,
        table.client_business_id,
      ),
      // The daily token check's sweep across organizations (MC10).
      index('idx_channel_connections_check_due')
        .on(table.last_checked_at)
        .where(sql`${table.status} = 'connected'`),
      index('idx_channel_connections_connected_by_user_id')
        .on(table.connected_by_user_id)
        .where(sql`${table.connected_by_user_id} IS NOT NULL`),
      check('chk_channel_connections_provider', sql`${table.provider} IN ('meta')`),
      check(
        'chk_channel_connections_status',
        sql`${table.status} IN ('connected', 'error', 'revoked')`,
      ),
      check('chk_channel_connections_login_type', sql`${table.login_type} IN ('unified')`),
      check(
        'chk_channel_connections_client_business_id',
        sql`${table.client_business_id} ~ ${sqlLiteral(INSTAGRAM_ID_PATTERN)}`,
      ),
      check(
        'chk_channel_connections_disconnected',
        sql`(${table.status} = 'revoked') = (${table.disconnected_at} IS NOT NULL)`,
      ),
      check('chk_channel_connections_scopes', sql`cardinality(${table.scopes}) <= 20`),
      check('chk_channel_connections_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('channel_connections_tenant_isolation', {
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
