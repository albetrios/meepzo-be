import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';

/**
 * `app.instagram_account_settings` — one Instagram channel account's sending limits, stop words and
 * behaviour switches (feat-instagram-dm-sending routes-final § 2.B.3, IA12, ROUTE row R7): one row
 * per account, keyed by `channel_account_id` (P47), made empty by the pick and kept on a reconnect.
 * RLS: the organization policy, plus the retention sweep arm in `USING` only.
 *
 * @remarks
 * Every limit is nullable — empty means the settings file's value
 * (`instagram-account-settings.constants.ts`, D22, P4). The automation switch lives on
 * `app.channel_accounts` (P42); public reply safety is per automation (D32).
 */
export const instagram_account_settings = appSchema
  .table(
    'instagram_account_settings',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /** Opening DMs an hour (1–750 here, 1–700 through the API); also replaces the new-account limit (D5). */
      opening_hour_limit: smallint('opening_hour_limit'),
      /** Opening DMs a day — read only while the settings file's day limit is on (D5). */
      opening_day_limit: integer('opening_day_limit'),
      /** Fast messages an hour (D11). */
      fast_hour_limit: integer('fast_hour_limit'),
      /** Automatic messages to one person an hour — a loop guard (D11). */
      person_hour_limit: smallint('person_hour_limit'),
      /** Broadcast messages an hour (D68). */
      broadcast_hour_limit: smallint('broadcast_hour_limit'),
      is_automatic_notice_enabled: boolean('is_automatic_notice_enabled').notNull().default(false),
      /** The owner's own stop words, lower case, added to the settings file's (D49). */
      extra_stop_words: text('extra_stop_words').array().notNull().default([]),
      /** Replies under comments start comment automations (D64). */
      is_comment_reply_trigger_enabled: boolean('is_comment_reply_trigger_enabled')
        .notNull()
        .default(true),
      /** One run per person per post (D65). */
      is_once_per_person_per_post_enabled: boolean('is_once_per_person_per_post_enabled')
        .notNull()
        .default(true),
      /** Mark her message seen after a reply (D66, Meta-test-gated, P36). */
      is_mark_seen_after_reply_enabled: boolean('is_mark_seen_after_reply_enabled')
        .notNull()
        .default(false),
      /** The extra delay before each answer, low end in seconds (D67, PRO — P83). */
      extra_delay_seconds_min: smallint('extra_delay_seconds_min'),
      /** The extra delay's high end, in seconds (D67). */
      extra_delay_seconds_max: smallint('extra_delay_seconds_max'),
      updated_by_user_id: bigint('updated_by_user_id', { mode: 'number' }).references(
        () => users.id,
        { onDelete: 'set null' },
      ),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'instagram_account_settings_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('restrict'),
      // One settings row per channel account, and the composite key's index.
      uniqueIndex('idx_instagram_account_settings_organization_account').on(
        table.organization_id,
        table.channel_account_id,
      ),
      index('idx_instagram_account_settings_updated_by_user_id')
        .on(table.updated_by_user_id)
        .where(sql`${table.updated_by_user_id} IS NOT NULL`),
      check(
        'chk_instagram_account_settings_opening_hour_limit',
        sql`${table.opening_hour_limit} IS NULL OR ${table.opening_hour_limit} BETWEEN 1 AND 750`,
      ),
      check(
        'chk_instagram_account_settings_opening_day_limit',
        sql`${table.opening_day_limit} IS NULL OR ${table.opening_day_limit} > 0`,
      ),
      check(
        'chk_instagram_account_settings_fast_hour_limit',
        sql`${table.fast_hour_limit} IS NULL OR ${table.fast_hour_limit} > 0`,
      ),
      check(
        'chk_instagram_account_settings_person_hour_limit',
        sql`${table.person_hour_limit} IS NULL OR ${table.person_hour_limit} > 0`,
      ),
      check(
        'chk_instagram_account_settings_broadcast_hour_limit',
        sql`${table.broadcast_hour_limit} IS NULL OR ${table.broadcast_hour_limit} BETWEEN 1 AND 2000`,
      ),
      check(
        'chk_instagram_account_settings_extra_stop_words',
        sql`cardinality(${table.extra_stop_words}) <= 50 AND array_position(${table.extra_stop_words}, NULL) IS NULL`,
      ),
      check(
        'chk_instagram_account_settings_extra_delay',
        sql`(${table.extra_delay_seconds_min} IS NULL) = (${table.extra_delay_seconds_max} IS NULL) AND (${table.extra_delay_seconds_min} IS NULL OR (${table.extra_delay_seconds_min} BETWEEN 1 AND 20 AND ${table.extra_delay_seconds_max} BETWEEN 1 AND 20 AND ${table.extra_delay_seconds_min} <= ${table.extra_delay_seconds_max}))`,
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
