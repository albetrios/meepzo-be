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
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteral } from '@/infrastructure/database/utils/sql-literal.util.js';
import { INTERNATIONAL_PHONE_NUMBER_PATTERN } from '@/shared/constants/record-fields.constants.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { CONTACT_TAGS_MAX_COUNT } from './contact.constants.js';

/**
 * `app.contacts` — one Instagram user who interacted with one of the organization's Instagram
 * accounts: commented, sent a DM, replied to a story or clicked a button (routes-final § 2.3).
 *
 * @remarks
 * - **Keys:** one live contact per organization, Instagram account and Instagram user — the upsert
 *   target (CT13). The account link is the composite `(organization_id, instagram_account_id)` →
 *   `app.instagram_accounts (organization_id, id)`, `ON DELETE RESTRICT` (an account is revoked,
 *   never deleted). The unique `(organization_id, id)` index is the parent key of the runs'
 *   composite reference (sub-domain 3).
 * - **Writers:** event processing only, through the contact service (CT2); no `*_by_user_id` (K6).
 * - **Erase (D22, CT7):** route 10 sets `deleted_at` and clears every personal column —
 *   `chk_contacts_erased` holds it. The row stays so its runs stay; an erased row's
 *   `instagram_user_id` is `NULL`, which never collides in the upsert index, so the same person's
 *   next event starts a fresh contact (CT9).
 * - **Times:** `last_message_received_at` is never null (CT10) — a contact is only ever born from
 *   an event; `last_direct_message_received_at` moves on a DM, story reply or button click only.
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only.
 */
export const contacts = appSchema
  .table(
    'contacts',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      /** The Instagram account the contact came from (CT13). */
      instagram_account_id: bigint('instagram_account_id', { mode: 'number' }).notNull(),
      /** The webhook's `sender.id` / `from.id`; digits only; cleared on erase. */
      instagram_user_id: varchar('instagram_user_id', { length: 64 }),
      username: varchar('username', { length: 64 }),
      full_name: varchar('full_name', { length: 255 }),
      /** An Instagram CDN link that expires — refreshed at each profile read. */
      profile_picture_url: text('profile_picture_url'),
      /** `null` = unknown. */
      followers_count: integer('followers_count'),
      /** The last follow check; `null` = never checked. */
      is_following_account: boolean('is_following_account'),
      follow_checked_at: timestamp('follow_checked_at', { withTimezone: true }),
      email: varchar('email', { length: 255 }),
      email_collected_at: timestamp('email_collected_at', { withTimezone: true }),
      /** Normalised: an optional `+`, then 10–15 digits (CT10). */
      phone: varchar('phone', { length: 20 }),
      phone_collected_at: timestamp('phone_collected_at', { withTimezone: true }),
      tags: text('tags').array().notNull().default([]),
      first_seen_at: timestamp('first_seen_at', { withTimezone: true }).notNull(),
      last_message_received_at: timestamp('last_message_received_at', {
        withTimezone: true,
      }).notNull(),
      /** The latest DM, story reply or button click — a comment never sets it. */
      last_direct_message_received_at: timestamp('last_direct_message_received_at', {
        withTimezone: true,
      }),
      /** `null` = never; drives the 24-hour opening-DM rule. */
      last_message_sent_at: timestamp('last_message_sent_at', { withTimezone: true }),
      /** The erase time (CT7). */
      deleted_at: timestamp('deleted_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'contacts_instagram_account_fk',
        columns: [table.organization_id, table.instagram_account_id],
        foreignColumns: [instagram_accounts.organization_id, instagram_accounts.id],
      }).onDelete('restrict'),
      uniqueIndex('idx_contacts_public_id').on(table.public_id),
      // The runs' composite key (organization_id, contact_id) → (organization_id, id).
      uniqueIndex('idx_contacts_organization_id_id').on(table.organization_id, table.id),
      // The upsert target (CT13); erased rows hold NULL, which never collides (CT9).
      uniqueIndex('idx_contacts_organization_account_instagram_user').on(
        table.organization_id,
        table.instagram_account_id,
        table.instagram_user_id,
      ),
      // One index per list sort over the live contacts (CT6, CQ2): the time sorts read theirs both
      // ways; the username sort has one per direction, its contacts without a username last in both.
      index('idx_contacts_organization_id_last_message_received_at_id')
        .on(table.organization_id, table.last_message_received_at, table.id)
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_contacts_organization_id_first_seen_at_id')
        .on(table.organization_id, table.first_seen_at, table.id)
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_contacts_organization_id_username_id')
        .on(table.organization_id, table.username, table.id)
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_contacts_organization_id_username_desc_id')
        .on(table.organization_id, table.username.desc().nullsLast(), table.id)
        .where(sql`${table.deleted_at} IS NULL`),
      // The list's `q`: the repository searches this exact expression (CT4).
      index('idx_contacts_search_trgm')
        .using(
          'gin',
          sql`(coalesce(${table.username}, '') || ' ' || coalesce(${table.full_name}, '') || ' ' || coalesce(${table.email}, '')) gin_trgm_ops`,
        )
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_contacts_tags_gin')
        .using('gin', table.tags)
        .where(sql`${table.deleted_at} IS NULL`),
      check('chk_contacts_instagram_user_id', sql`${table.instagram_user_id} ~ '^[0-9]{1,64}$'`),
      check(
        'chk_contacts_email',
        sql`${table.email} = lower(${table.email}) AND ${table.email} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`,
      ),
      check(
        'chk_contacts_phone',
        sql`${table.phone} ~ ${sqlLiteral(INTERNATIONAL_PHONE_NUMBER_PATTERN)}`,
      ),
      check(
        'chk_contacts_email_collected',
        sql`(${table.email} IS NULL) = (${table.email_collected_at} IS NULL)`,
      ),
      check(
        'chk_contacts_phone_collected',
        sql`(${table.phone} IS NULL) = (${table.phone_collected_at} IS NULL)`,
      ),
      check(
        'chk_contacts_follow_checked',
        sql`(${table.is_following_account} IS NULL) = (${table.follow_checked_at} IS NULL)`,
      ),
      check('chk_contacts_followers_count', sql`${table.followers_count} >= 0`),
      check('chk_contacts_profile_picture_url', sql`${table.profile_picture_url} ~ '^https://'`),
      check(
        'chk_contacts_tags',
        sql`cardinality(${table.tags}) <= ${sqlLiteral(CONTACT_TAGS_MAX_COUNT)} AND array_position(${table.tags}, NULL) IS NULL`,
      ),
      check(
        'chk_contacts_erased',
        sql`(${table.deleted_at} IS NULL) = (${table.instagram_user_id} IS NOT NULL)
          AND (
            ${table.deleted_at} IS NULL
            OR (
              num_nonnulls(${table.username}, ${table.full_name}, ${table.profile_picture_url}, ${table.followers_count}, ${table.is_following_account}, ${table.follow_checked_at}, ${table.email}, ${table.email_collected_at}, ${table.phone}, ${table.phone_collected_at}) = 0
              AND cardinality(${table.tags}) = 0
            )
          )`,
      ),
      check('chk_contacts_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('contacts_tenant_isolation', {
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
