import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  integer,
  pgPolicy,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';

/**
 * `app.instagram_accounts` — the Instagram extension of one channel account (feat-instagram-dm-sending
 * routes-final § 2.A.3, IA8, P42): exactly one row per channel account whose channel is
 * `instagram`, reached through `channel_account_id` (1:1) — its Instagram user id, profile, account
 * type, private flag, webhook stamp and starter-question time.
 *
 * @remarks
 * - No public id, status or connection columns of its own (ROUTE row R6): the account's one id,
 *   its status, its connection and who connected it are the channel account's (`app.channel_accounts`,
 *   P47). One row per organization and Instagram account, so a pick brings a revoked one back with
 *   its settings.
 * - Written only through the extension service (2.A.10): the pick, the profile refresh, the
 *   webhook set-up and the erasure.
 * - RLS: the organization policy, plus the retention sweep arm in `USING` only.
 */
export const instagram_accounts = appSchema
  .table(
    'instagram_accounts',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      /** The channel account this row extends (1:1); composite → `app.channel_accounts`. */
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /**
       * The id from the connection's assigned accounts — the webhooks' `entry.id`, the Graph API
       * paths' id; equal to the channel account's `provider_account_id` (CAQ1). Digits only.
       */
      instagram_user_id: varchar('instagram_user_id', { length: 64 }).notNull(),
      /** Emptied only by the erasure (`profile_erased_at`). */
      username: varchar('username', { length: 64 }),
      biography: text('biography'),
      website: text('website'),
      profile_picture_url: text('profile_picture_url'),
      /** `business` · `creator`; `null` until Meta tells (P120). */
      account_type: varchar('account_type', { length: 20 }),
      /** A private account gets no comment or mention webhooks (AC-2.12, P120). */
      is_private: boolean('is_private').notNull().default(false),
      followers_count: integer('followers_count').notNull().default(0),
      follows_count: integer('follows_count').notNull().default(0),
      media_count: integer('media_count').notNull().default(0),
      webhook_subscribed_at: timestamp('webhook_subscribed_at', { withTimezone: true }),
      /** The last send of its starter questions to Meta (D42); emptied when they change. */
      starter_questions_set_at: timestamp('starter_questions_set_at', { withTimezone: true }),
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
      // The children's composite key (organization_id, instagram_account_id) → (organization_id, id).
      uniqueIndex('idx_instagram_accounts_organization_id_id').on(table.organization_id, table.id),
      // One row per Instagram account per organization: a pick brings a revoked one back.
      uniqueIndex('idx_instagram_accounts_organization_instagram_user').on(
        table.organization_id,
        table.instagram_user_id,
      ),
      // The 1:1 extension of the channel account and its composite key's index (2.A.3).
      uniqueIndex('idx_instagram_accounts_channel_account').on(
        table.organization_id,
        table.channel_account_id,
      ),
      check(
        'chk_instagram_accounts_instagram_user_id',
        sql`${table.instagram_user_id} ~ '^[0-9]{1,64}$'`,
      ),
      check(
        'chk_instagram_accounts_account_type',
        sql`${table.account_type} IS NULL OR ${table.account_type} IN ('business', 'creator')`,
      ),
      check(
        'chk_instagram_accounts_counts',
        sql`${table.followers_count} >= 0 AND ${table.follows_count} >= 0 AND ${table.media_count} >= 0`,
      ),
      check(
        'chk_instagram_accounts_username_unless_erased',
        sql`${table.username} IS NOT NULL OR ${table.profile_erased_at} IS NOT NULL`,
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
