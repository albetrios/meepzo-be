import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  pgPolicy,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_connections } from '@/domains/app/sub-domains/channel-connection/channel-connection.schema.js';

/**
 * `app.channel_accounts` — one connected inbox of an organization, whatever its channel
 * (feat-instagram-dm-sending routes-final § 1B.3, P42): an Instagram professional account now, a
 * Facebook Page later (D27). Many per organization up to the plan's limit (D26, counted at the pick
 * under the organization lock); one row per organization and provider account, so a pick brings a
 * revoked one back; one not-revoked row per provider account across organizations (CAQ1, P60).
 *
 * @remarks
 * - The account holds its status (`connected` · `error` · `revoked`, CA4), the owner's pause, the
 *   team's suspend, the plan stop (`plan_stop_reason` + `plan_stopped_at`, CA3, P99) and the
 *   automation switch (`is_automation_enabled`).
 * - The Instagram part lives on `app.instagram_accounts`, 1:1 through its `channel_account_id`.
 * - No soft delete: `revoked` stands in, and the row stays until the organization is deleted.
 * - RLS: the organization policy, plus the retention sweep arm in `USING` only (the subscription
 *   check and the plan-change sweep read across organizations).
 */
export const channel_accounts = appSchema
  .table(
    'channel_accounts',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      /** `instagram` (D27: a Facebook Page later). */
      channel: varchar('channel', { length: 20 }).notNull().default('instagram'),
      /** The connection the account came through; a reconnect from another portfolio moves it (MC6). */
      channel_connection_id: bigint('channel_connection_id', { mode: 'number' }).notNull(),
      /** The account's id at the provider — Instagram's user id (CAQ1); digits. */
      provider_account_id: varchar('provider_account_id', { length: 64 }).notNull(),
      /** What the app shows (Instagram: `@username`). */
      display_name: varchar('display_name', { length: 100 }).notNull(),
      connection_status: varchar('connection_status', { length: 20 })
        .notNull()
        .default('connected'),
      /** The automation switch (P42): off = new events skipped, not saved for later. */
      is_automation_enabled: boolean('is_automation_enabled').notNull().default(true),
      /** The owner's pause (route 9). */
      paused_at: timestamp('paused_at', { withTimezone: true }),
      paused_by_user_id: bigint('paused_by_user_id', { mode: 'number' }).references(
        () => users.id,
        { onDelete: 'set null' },
      ),
      /** The team's suspend (P18) — no route this iteration. */
      suspended_at: timestamp('suspended_at', { withTimezone: true }),
      /** `plan_limit` · `plan_ended` · `plan_downgrade` (CA3, P99). */
      plan_stop_reason: varchar('plan_stop_reason', { length: 14 }),
      plan_stopped_at: timestamp('plan_stopped_at', { withTimezone: true }),
      connected_by_user_id: bigint('connected_by_user_id', { mode: 'number' }).references(
        () => users.id,
        { onDelete: 'set null' },
      ),
      connected_at: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
      disconnected_at: timestamp('disconnected_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'channel_accounts_channel_connection_fk',
        columns: [table.organization_id, table.channel_connection_id],
        foreignColumns: [channel_connections.organization_id, channel_connections.id],
      }).onDelete('restrict'),
      uniqueIndex('idx_channel_accounts_public_id').on(table.public_id),
      // The parent key of every channel_account_id.
      uniqueIndex('idx_channel_accounts_organization_id_id').on(table.organization_id, table.id),
      // One row per organization and provider account: a pick brings a revoked one back (AC-2.5).
      uniqueIndex('idx_channel_accounts_organization_provider_account').on(
        table.organization_id,
        table.channel,
        table.provider_account_id,
      ),
      // One organization at a time per provider account (CAQ1, P60).
      uniqueIndex('idx_channel_accounts_provider_account_live')
        .on(table.channel, table.provider_account_id)
        .where(sql`${table.connection_status} <> 'revoked'`),
      // Route 6: the organization's not-revoked accounts of a channel, oldest connected first.
      index('idx_channel_accounts_organization_channel')
        .on(table.organization_id, table.channel, table.connected_at)
        .where(sql`${table.connection_status} <> 'revoked'`),
      // The composite key's index and "the accounts of a connection".
      index('idx_channel_accounts_connection').on(
        table.organization_id,
        table.channel_connection_id,
      ),
      // The 10-minute subscription check pages the connected accounts across organizations.
      index('idx_channel_accounts_connected_check')
        .on(table.id)
        .where(sql`${table.connection_status} = 'connected'`),
      index('idx_channel_accounts_connected_by_user_id')
        .on(table.connected_by_user_id)
        .where(sql`${table.connected_by_user_id} IS NOT NULL`),
      index('idx_channel_accounts_paused_by_user_id')
        .on(table.paused_by_user_id)
        .where(sql`${table.paused_by_user_id} IS NOT NULL`),
      // The month wake and the plan change (rev 5).
      index('idx_channel_accounts_plan_stop')
        .on(table.organization_id, table.plan_stop_reason)
        .where(sql`${table.plan_stop_reason} IS NOT NULL`),
      check('chk_channel_accounts_channel', sql`${table.channel} IN ('instagram')`),
      check(
        'chk_channel_accounts_connection_status',
        sql`${table.connection_status} IN ('connected', 'error', 'revoked')`,
      ),
      check(
        'chk_channel_accounts_disconnected',
        sql`(${table.connection_status} = 'revoked') = (${table.disconnected_at} IS NOT NULL)`,
      ),
      check(
        'chk_channel_accounts_paused_by',
        sql`${table.paused_by_user_id} IS NULL OR ${table.paused_at} IS NOT NULL`,
      ),
      check(
        'chk_channel_accounts_provider_account_id',
        sql`${table.provider_account_id} ~ '^[0-9]{1,64}$'`,
      ),
      check('chk_channel_accounts_display_name', sql`length(${table.display_name}) > 0`),
      check(
        'chk_channel_accounts_plan_stop',
        sql`(${table.plan_stop_reason} IS NULL OR ${table.plan_stop_reason} IN ('plan_limit', 'plan_ended', 'plan_downgrade'))
    AND (${table.plan_stop_reason} IS NULL) = (${table.plan_stopped_at} IS NULL)`,
      ),
      check('chk_channel_accounts_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('channel_accounts_tenant_isolation', {
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
