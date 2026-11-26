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
import { sqlLiteral, sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import { INTERNATIONAL_PHONE_NUMBER_PATTERN } from '@/shared/constants/record-fields.constants.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { users } from '@/domains/user/user.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { CHANNEL_ACCOUNT_CHANNELS } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import {
  CONTACT_CAME_IN_VIA_VALUES,
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_EMAIL_PATTERN,
  CONTACT_NOTE_MAX_CHARACTERS,
  CONTACT_TAGS_MAX_COUNT,
} from './contact.constants.js';
import {
  INSTAGRAM_ID_MAX_LENGTH,
  INSTAGRAM_ID_PATTERN,
} from '@/shared/constants/instagram.constants.js';

/**
 * `app.contacts` — one person who wrote to or commented on one of the organization's channel
 * accounts, of any channel (routes-final § 3, 3.A.3; P48 — Instagram the only channel now).
 *
 * @remarks
 * - **Keys:** one live contact per organization, channel account and provider person id — the upsert
 *   target (CT18; the column keeps its launch name `instagram_user_id`). The account link is the
 *   composite `(organization_id, channel_account_id)` → `app.channel_accounts (organization_id, id)`,
 *   `ON DELETE RESTRICT` (an account is revoked, never deleted). The unique `(organization_id, id)`
 *   index is the parent key of the runs', the activity row's and the tag events' references.
 * - **Activity (S5, P97):** the fast-changing times and counts live in the 1:1
 *   {@link contact_activities}; this row holds identity, search fields, tags and the owner's and her
 *   own choices (note, pause, opt-out), so an inbound event no longer rewrites it.
 * - **Writers:** the contact service only (CT1) — the owner's routes and event processing call it.
 * - **Erase (CT11):** route 23 sets `deleted_at`, clears every personal column (now with the note,
 *   the opt-out, the pause and the came-in ref) and deletes the activity row; `chk_contacts_erased`
 *   holds it. `first_automation_id`, `came_in_via` and `channel` stay.
 * - **`first_automation_id`:** its key into `app.automations` (`ON DELETE SET NULL
 *   (first_automation_id)`) is the automations migration's (sub-domain 4 builds after contacts).
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
      /** The channel account the contact came from (CT2, P48). */
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /** A copy of the account's channel (CT3, D27). */
      channel: varchar('channel', { length: 10 }).notNull().default('instagram'),
      /** The provider's person id (the webhook's `sender.id` / `from.id`); digits only; cleared on erase. */
      instagram_user_id: varchar('instagram_user_id', { length: INSTAGRAM_ID_MAX_LENGTH }),
      username: varchar('username', { length: 64 }),
      full_name: varchar('full_name', { length: 255 }),
      /** An Instagram CDN link that expires — refreshed at each profile read. */
      profile_picture_url: text('profile_picture_url'),
      /** `null` = unknown. */
      followers_count: integer('followers_count'),
      /** The last follow check; `null` = never checked. */
      is_following_account: boolean('is_following_account'),
      follow_checked_at: timestamp('follow_checked_at', { withTimezone: true }),
      email: varchar('email', { length: 254 }),
      email_collected_at: timestamp('email_collected_at', { withTimezone: true }),
      /** Normalised: an optional `+`, then 10–15 digits. */
      phone: varchar('phone', { length: 20 }),
      phone_collected_at: timestamp('phone_collected_at', { withTimezone: true }),
      tags: text('tags').array().notNull().default([]),
      /** The owner's private note, 1–2,000 characters (CT5); never sent to her. */
      note: text('note'),
      /** She wrote a stop word (CT6, D49); only her own new action clears it. */
      opted_out_at: timestamp('opted_out_at', { withTimezone: true }),
      /** The owner paused automations for her (CT5, D71). */
      automations_off_at: timestamp('automations_off_at', { withTimezone: true }),
      /** Who paused her; a user delete empties it (K6). */
      automations_off_by_user_id: bigint('automations_off_by_user_id', {
        mode: 'number',
      }).references(() => users.id, { onDelete: 'set null' }),
      /** The automation of her first run; set once (CT3). */
      first_automation_id: bigint('first_automation_id', { mode: 'number' }),
      /** The way to start of her first run (a `trigger_type`); set with `first_automation_id`. */
      came_in_via: varchar('came_in_via', { length: 20 }),
      /** The ref code or ad id of her first run; cleared on erase. */
      came_in_ref: varchar('came_in_ref', { length: 64 }),
      first_seen_at: timestamp('first_seen_at', { withTimezone: true }).notNull(),
      /** The erase time (CT11). */
      deleted_at: timestamp('deleted_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'contacts_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('restrict'),
      uniqueIndex('idx_contacts_public_id').on(table.public_id),
      // The runs', activities' and tag events' composite key (organization_id, contact_id).
      uniqueIndex('idx_contacts_organization_id_id').on(table.organization_id, table.id),
      // The upsert target (CT18); erased rows hold NULL, which never collides (CT9).
      uniqueIndex('idx_contacts_organization_account_instagram_user').on(
        table.organization_id,
        table.channel_account_id,
        table.instagram_user_id,
      ),
      // The contact-side list sorts, led by the account (CT2); the "last message" sort reads
      // contact_activities (S5). The username sort has one index per direction.
      index('idx_contacts_account_first_seen_at_id')
        .on(table.organization_id, table.channel_account_id, table.first_seen_at, table.id)
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_contacts_account_username_id')
        .on(table.organization_id, table.channel_account_id, table.username, table.id)
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_contacts_account_username_desc_id')
        .on(
          table.organization_id,
          table.channel_account_id,
          table.username.desc().nullsLast(),
          table.id,
        )
        .where(sql`${table.deleted_at} IS NULL`),
      // The list's `q` (CT12, S6), led by the account through btree_gin: the repository searches
      // this exact expression.
      index('idx_contacts_search_trgm')
        .using(
          'gin',
          table.channel_account_id,
          sql`(coalesce(${table.username}, '') || ' ' || coalesce(${table.full_name}, '') || ' ' || coalesce(${table.email}, '') || ' ' || coalesce(${table.phone}, '')) gin_trgm_ops`,
        )
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_contacts_tags_gin')
        .using('gin', table.channel_account_id, table.tags)
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_contacts_first_automation')
        .on(table.organization_id, table.first_automation_id)
        .where(sql`${table.first_automation_id} IS NOT NULL`),
      index('idx_contacts_automations_off_by_user_id')
        .on(table.automations_off_by_user_id)
        .where(sql`${table.automations_off_by_user_id} IS NOT NULL`),
      check(
        'chk_contacts_channel',
        sql`${table.channel} IN (${sqlLiteralList(CHANNEL_ACCOUNT_CHANNELS)})`,
      ),
      check(
        'chk_contacts_instagram_user_id',
        sql`${table.instagram_user_id} ~ ${sqlLiteral(INSTAGRAM_ID_PATTERN)}`,
      ),
      check(
        'chk_contacts_email',
        sql`char_length(${table.email}) <= ${sqlLiteral(CONTACT_EMAIL_MAX_LENGTH)} AND ${table.email} ~ ${sqlLiteral(CONTACT_EMAIL_PATTERN)}`,
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
        'chk_contacts_note',
        sql`char_length(${table.note}) BETWEEN 1 AND ${sqlLiteral(CONTACT_NOTE_MAX_CHARACTERS)}`,
      ),
      check(
        'chk_contacts_automations_off',
        sql`${table.automations_off_by_user_id} IS NULL OR ${table.automations_off_at} IS NOT NULL`,
      ),
      check(
        'chk_contacts_came_in_via',
        sql`${table.came_in_via} IN (${sqlLiteralList(CONTACT_CAME_IN_VIA_VALUES)})`,
      ),
      check(
        'chk_contacts_erased',
        sql`(${table.deleted_at} IS NULL) = (${table.instagram_user_id} IS NOT NULL)
          AND (
            ${table.deleted_at} IS NULL
            OR (
              num_nonnulls(${table.username}, ${table.full_name}, ${table.profile_picture_url}, ${table.followers_count}, ${table.is_following_account}, ${table.follow_checked_at}, ${table.email}, ${table.email_collected_at}, ${table.phone}, ${table.phone_collected_at}, ${table.note}, ${table.opted_out_at}, ${table.automations_off_at}, ${table.automations_off_by_user_id}, ${table.came_in_ref}) = 0
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
