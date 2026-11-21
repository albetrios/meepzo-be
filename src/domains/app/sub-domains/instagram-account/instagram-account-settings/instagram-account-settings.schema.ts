import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  pgPolicy,
  smallint,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';

/**
 * `app.instagram_account_settings` — the connected account's automation switch and public reply
 * safety (routes-final § 1.B.3, IA15): one row per account, created with the defaults by the first
 * connect and kept on a reconnect (IA12). Event processing reads it on every event. RLS: the
 * organization policy, plus the retention sweep arm in `USING` only.
 */
export const instagram_account_settings = appSchema
  .table(
    'instagram_account_settings',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      instagram_account_id: bigint('instagram_account_id', { mode: 'number' }).notNull(),
      /** The master switch — nothing runs while it is off. */
      is_automation_enabled: boolean('is_automation_enabled').notNull().default(true),
      is_public_reply_safety_enabled: boolean('is_public_reply_safety_enabled')
        .notNull()
        .default(false),
      public_reply_chance_percent: smallint('public_reply_chance_percent').notNull().default(80),
      public_reply_hour_limit: smallint('public_reply_hour_limit').notNull().default(60),
      public_reply_gap_min_seconds: smallint('public_reply_gap_min_seconds').notNull().default(20),
      public_reply_gap_max_seconds: smallint('public_reply_gap_max_seconds').notNull().default(60),
      updated_by_user_id: bigint('updated_by_user_id', { mode: 'number' }).references(
        () => users.id,
        { onDelete: 'set null' },
      ),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'instagram_account_settings_instagram_account_fk',
        columns: [table.organization_id, table.instagram_account_id],
        foreignColumns: [instagram_accounts.organization_id, instagram_accounts.id],
      }).onDelete('cascade'),
      // One settings row per account, and the composite key's index.
      uniqueIndex('idx_instagram_account_settings_organization_account').on(
        table.organization_id,
        table.instagram_account_id,
      ),
      index('idx_instagram_account_settings_updated_by_user_id')
        .on(table.updated_by_user_id)
        .where(sql`${table.updated_by_user_id} IS NOT NULL`),
      check(
        'chk_instagram_account_settings_chance',
        sql`${table.public_reply_chance_percent} BETWEEN 0 AND 100`,
      ),
      check(
        'chk_instagram_account_settings_hour_limit',
        sql`${table.public_reply_hour_limit} BETWEEN 1 AND 1000`,
      ),
      check(
        'chk_instagram_account_settings_gap_min',
        sql`${table.public_reply_gap_min_seconds} BETWEEN 5 AND 3600`,
      ),
      check(
        'chk_instagram_account_settings_gap_max',
        sql`${table.public_reply_gap_max_seconds} BETWEEN 5 AND 3600`,
      ),
      check(
        'chk_instagram_account_settings_gap_order',
        sql`${table.public_reply_gap_max_seconds} >= ${table.public_reply_gap_min_seconds}`,
      ),
      check(
        'chk_instagram_account_settings_updated',
        sql`${table.updated_at} >= ${table.created_at}`,
      ),
      pgPolicy('instagram_account_settings_tenant_isolation', {
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
