import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';

/**
 * `app.instagram_accounts` — the organization's connected Instagram professional account
 * (routes-final § 1.A.3, IA11): one row per organization and Instagram account, so a reconnect
 * reuses the row (revoked included) and its settings come back; many per organization up to the
 * plan's limit (D26, counted at the pick under the organization lock) and one not-revoked row per
 * Instagram account across all organizations. Since feat-instagram-dm-sending ROUTE row R5 the row
 * is the Instagram part of a channel account (`channel_account_id`, 1:1 — routes-final § 2.A.3); the
 * connection and its token are the channel account's. Its `public_id`, status and connection columns
 * mirror the channel account's until ROUTE row R6 drops them (P116). The status moves by
 * actions only (`connected` → `expired` | `error` through the guarded change, IA9; any →
 * `revoked` on a disconnect, IA14); there is no soft delete — `revoked` stands in, and the row
 * stays until the organization is deleted. `token_expires_at` stays empty (the connection's token
 * never ends, D24; dropped at ROUTE row R6).
 * RLS: the organization policy, plus the retention sweep arm in `USING` only.
 */
export const instagram_accounts = appSchema
  .table(
    'instagram_accounts',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      /** The channel account this row extends (1:1, R5); composite → `app.channel_accounts`. */
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /** `/me` `user_id` — equals the webhook `entry.id`; digits only. */
      instagram_user_id: varchar('instagram_user_id', { length: 64 }).notNull(),
      /**
       * The id the Graph calls take; under Unified Login it equals `instagram_user_id` (the pick
       * writes it, P111) — dropped at ROUTE row R6. Digits only.
       */
      instagram_app_user_id: varchar('instagram_app_user_id', { length: 64 }).notNull(),
      username: varchar('username', { length: 64 }),
      name: varchar('name', { length: 255 }),
      biography: text('biography'),
      website: text('website'),
      profile_picture_url: text('profile_picture_url'),
      followers_count: integer('followers_count').notNull().default(0),
      follows_count: integer('follows_count').notNull().default(0),
      media_count: integer('media_count').notNull().default(0),
      /** The permissions granted on Instagram's consent screen. */
      scopes: text('scopes').array().notNull().default([]),
      connection_status: varchar('connection_status', { length: 20 })
        .notNull()
        .default('connected'),
      connection_status_changed_at: timestamp('connection_status_changed_at', {
        withTimezone: true,
      })
        .notNull()
        .defaultNow(),
      token_expires_at: timestamp('token_expires_at', { withTimezone: true }),
      webhook_subscribed_at: timestamp('webhook_subscribed_at', { withTimezone: true }),
      connected_by_user_id: bigint('connected_by_user_id', { mode: 'number' }).references(
        () => users.id,
        { onDelete: 'set null' },
      ),
      connected_at: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
      disconnected_at: timestamp('disconnected_at', { withTimezone: true }),
      profile_synced_at: timestamp('profile_synced_at', { withTimezone: true }),
      profile_erased_at: timestamp('profile_erased_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'instagram_accounts_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('restrict'),
      uniqueIndex('idx_instagram_accounts_public_id').on(table.public_id),
      // The children's composite key (organization_id, instagram_account_id) → (organization_id, id).
      uniqueIndex('idx_instagram_accounts_organization_id_id').on(table.organization_id, table.id),
      // One row per Instagram account per organization: a reconnect reuses it (IA11).
      uniqueIndex('idx_instagram_accounts_organization_instagram_user').on(
        table.organization_id,
        table.instagram_user_id,
      ),
      // The 1:1 extension of the channel account and its composite key's index (2.A.3).
      uniqueIndex('idx_instagram_accounts_channel_account').on(
        table.organization_id,
        table.channel_account_id,
      ),
      // One organization at a time per Instagram account.
      uniqueIndex('idx_instagram_accounts_instagram_user_live')
        .on(table.instagram_user_id)
        .where(sql`${table.connection_status} <> 'revoked'`),
      // Meta's callbacks resolve every row of an app-scoped id, any status (IA6).
      index('idx_instagram_accounts_instagram_app_user_id').on(table.instagram_app_user_id),
      index('idx_instagram_accounts_connected_by_user_id')
        .on(table.connected_by_user_id)
        .where(sql`${table.connected_by_user_id} IS NOT NULL`),
      check(
        'chk_instagram_accounts_connection_status',
        sql`${table.connection_status} IN ('connected', 'expired', 'error', 'revoked')`,
      ),
      check(
        'chk_instagram_accounts_instagram_user_id',
        sql`${table.instagram_user_id} ~ '^[0-9]{1,64}$'`,
      ),
      check(
        'chk_instagram_accounts_instagram_app_user_id',
        sql`${table.instagram_app_user_id} ~ '^[0-9]{1,64}$'`,
      ),
      check(
        'chk_instagram_accounts_counts',
        sql`${table.followers_count} >= 0 AND ${table.follows_count} >= 0 AND ${table.media_count} >= 0`,
      ),
      check('chk_instagram_accounts_scopes', sql`cardinality(${table.scopes}) <= 20`),
      check(
        'chk_instagram_accounts_username_unless_revoked',
        sql`${table.username} IS NOT NULL OR ${table.connection_status} = 'revoked'`,
      ),
      check(
        'chk_instagram_accounts_disconnected',
        sql`(${table.connection_status} = 'revoked') = (${table.disconnected_at} IS NOT NULL)`,
      ),
      check(
        'chk_instagram_accounts_profile_erased',
        sql`${table.profile_erased_at} IS NULL OR ${table.connection_status} = 'revoked'`,
      ),
      check('chk_instagram_accounts_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('instagram_accounts_tenant_isolation', {
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
