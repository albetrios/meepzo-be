import { type BuildExtraConfigColumns, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteral, sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import {
  RECORD_DELETE_NOTE_MAX_LENGTH,
  RECORD_DELETE_REASON,
  RECORD_DELETE_REASON_VALUES,
} from '@/shared/constants/record-fields.constants.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import {
  AUTOMATION_INSTAGRAM_ID_PATTERN,
  AUTOMATION_KEYWORDS_MAX_COUNT,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_NEXT_POST_STATUSES,
  AUTOMATION_PUBLIC_REPLY_TEXTS_MAX_COUNT,
  AUTOMATION_STATUSES,
  AUTOMATION_TAGS_MAX_COUNT,
  AUTOMATION_TARGET_SCOPES,
  AUTOMATION_TRIGGER_TYPES,
} from './automation.constants.js';
import type {
  AutomationFinalMessage,
  AutomationFollowRequestMessage,
  AutomationOpeningMessage,
  AutomationTextMessage,
} from './automation.types.js';

/** The columns of `app.automations` (routes-final § 3.A.3), as the table is built from them. */
const automationColumns = {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  public_id: varchar('public_id', { length: 28 }).notNull(),
  organization_id: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  /** The Instagram account the automation runs on (AU27) — set at create, never changed. */
  instagram_account_id: bigint('instagram_account_id', { mode: 'number' }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  status: varchar('status', { length: 10 }).notNull().default('inactive'),
  trigger_type: varchar('trigger_type', { length: 15 }).notNull(),
  target_scope: varchar('target_scope', { length: 10 }).notNull().default('any'),
  /** The `specific` post, or the post a `next` automation linked to; digits only. */
  target_instagram_media_id: varchar('target_instagram_media_id', { length: 64 }),
  /** The `specific` story; digits only. */
  target_instagram_story_id: varchar('target_instagram_story_id', { length: 64 }),
  next_post_starts_at: timestamp('next_post_starts_at', { withTimezone: true }),
  next_post_ends_at: timestamp('next_post_ends_at', { withTimezone: true }),
  next_post_status: varchar('next_post_status', { length: 10 }),
  next_post_linked_at: timestamp('next_post_linked_at', { withTimezone: true }),
  is_dm_keyword_trigger_enabled: boolean('is_dm_keyword_trigger_enabled').notNull().default(true),
  /** Trimmed, lowercased, deduplicated (AU7). */
  keywords: text('keywords').array().notNull().default([]),
  tags: text('tags').array().notNull().default([]),
  is_public_reply_enabled: boolean('is_public_reply_enabled').notNull().default(false),
  public_reply_texts: text('public_reply_texts').array().notNull().default([]),
  is_opening_message_enabled: boolean('is_opening_message_enabled').notNull().default(true),
  opening_message: jsonb('opening_message').$type<AutomationOpeningMessage>(),
  is_follow_required: boolean('is_follow_required').notNull().default(false),
  follow_request_message: jsonb('follow_request_message').$type<AutomationFollowRequestMessage>(),
  is_email_collection_enabled: boolean('is_email_collection_enabled').notNull().default(false),
  /** `null` = the default email question. */
  email_request_message: jsonb('email_request_message').$type<AutomationTextMessage>(),
  is_phone_collection_enabled: boolean('is_phone_collection_enabled').notNull().default(false),
  /** `null` = the default phone question. */
  phone_request_message: jsonb('phone_request_message').$type<AutomationTextMessage>(),
  /** Always set (D19). */
  final_message: jsonb('final_message').$type<AutomationFinalMessage>().notNull(),
  /** `+ 1` in SQL at each completed run (AU10). */
  completed_run_count: integer('completed_run_count').notNull().default(0),
  /** The last run start (AU10). */
  last_triggered_at: timestamp('last_triggered_at', { withTimezone: true }),
  created_by_user_id: bigint('created_by_user_id', { mode: 'number' }).references(() => users.id, {
    onDelete: 'set null',
  }),
  updated_by_user_id: bigint('updated_by_user_id', { mode: 'number' }).references(() => users.id, {
    onDelete: 'set null',
  }),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
  delete_reason: varchar('delete_reason', { length: 20 }),
  delete_note: varchar('delete_note', { length: RECORD_DELETE_NOTE_MAX_LENGTH }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** The table's columns as its extra config (keys, indexes, checks, policy) reads them. */
type AutomationTableColumns = BuildExtraConfigColumns<
  'automations',
  typeof automationColumns,
  'pg'
>;

/** The account reference and every index of 3.A.3 — each declared for the index-hygiene gate. */
function automationKeysAndIndexes(table: AutomationTableColumns) {
  return [
    foreignKey({
      name: 'automations_instagram_account_fk',
      columns: [table.organization_id, table.instagram_account_id],
      foreignColumns: [instagram_accounts.organization_id, instagram_accounts.id],
    }).onDelete('restrict'),
    uniqueIndex('idx_automations_public_id').on(table.public_id),
    // The runs' and comment logs' composite key (organization_id, automation_id) → (organization_id, id).
    uniqueIndex('idx_automations_organization_id_id').on(table.organization_id, table.id),
    // The account reference (AU27) and the list's instagram_account_id filter; not partial.
    index('idx_automations_organization_id_instagram_account_id').on(
      table.organization_id,
      table.instagram_account_id,
    ),
    // One index per list sort over the live automations, each serving both directions (AU13, AQ9).
    index('idx_automations_organization_id_created_at_id')
      .on(table.organization_id, table.created_at, table.id)
      .where(sql`${table.deleted_at} IS NULL`),
    index('idx_automations_organization_id_name_id')
      .on(table.organization_id, table.name, table.id)
      .where(sql`${table.deleted_at} IS NULL`),
    index('idx_automations_organization_id_last_triggered_at_id')
      .on(table.organization_id, table.last_triggered_at, table.id)
      .where(sql`${table.deleted_at} IS NULL`),
    index('idx_automations_organization_id_completed_run_count_id')
      .on(table.organization_id, table.completed_run_count, table.id)
      .where(sql`${table.deleted_at} IS NULL`),
    // The list's `q` over the name, any case (AU13).
    index('idx_automations_name_trgm')
      .using('gin', table.name.op('gin_trgm_ops'))
      .where(sql`${table.deleted_at} IS NULL`),
    // An event's candidates, of the event's account only (AU16, AU27).
    index('idx_automations_live_triggers')
      .on(table.organization_id, table.instagram_account_id, table.trigger_type)
      .where(sql`${table.status} = 'live' AND ${table.deleted_at} IS NULL`),
    // A comment's post-linked automations (AU16) and "already targeted" (AU15).
    index('idx_automations_target_media')
      .on(table.organization_id, table.instagram_account_id, table.target_instagram_media_id)
      .where(sql`${table.target_instagram_media_id} IS NOT NULL AND ${table.deleted_at} IS NULL`),
    // Linking and the overlap check, per account (AU9, AU15).
    index('idx_automations_next_post_waiting')
      .on(table.organization_id, table.instagram_account_id, table.next_post_ends_at)
      .where(sql`${table.next_post_status} = 'waiting' AND ${table.deleted_at} IS NULL`),
    // The 15-minute expiry scan across organizations (AU15, D9).
    index('idx_automations_next_post_expiry')
      .on(table.next_post_ends_at)
      .where(sql`${table.next_post_status} = 'waiting' AND ${table.deleted_at} IS NULL`),
    // Tombstone purge (AQ7): only the soft-deleted rows, so live writes never maintain it.
    index('idx_automations_tombstoned')
      .on(table.deleted_at)
      .where(sql`${table.deleted_at} IS NOT NULL`),
    index('idx_automations_created_by_user_id')
      .on(table.created_by_user_id)
      .where(sql`${table.created_by_user_id} IS NOT NULL`),
    index('idx_automations_updated_by_user_id')
      .on(table.updated_by_user_id)
      .where(sql`${table.updated_by_user_id} IS NOT NULL`),
  ];
}

/** The value-list, name, scope, target and "next post" CHECKs (3.A.3). */
function automationScopeChecks(table: AutomationTableColumns) {
  return [
    check(
      'chk_automations_status',
      sql`${table.status} IN (${sqlLiteralList(AUTOMATION_STATUSES)})`,
    ),
    check(
      'chk_automations_trigger_type',
      sql`${table.trigger_type} IN (${sqlLiteralList(AUTOMATION_TRIGGER_TYPES)})`,
    ),
    check(
      'chk_automations_target_scope',
      sql`${table.target_scope} IN (${sqlLiteralList(AUTOMATION_TARGET_SCOPES)})`,
    ),
    check(
      'chk_automations_next_post_status',
      sql`${table.next_post_status} IN (${sqlLiteralList(AUTOMATION_NEXT_POST_STATUSES)})`,
    ),
    check(
      'chk_automations_name',
      sql`char_length(btrim(${table.name})) BETWEEN 1 AND ${sqlLiteral(AUTOMATION_NAME_MAX_LENGTH)}`,
    ),
    check(
      'chk_automations_next_only_comment',
      sql`${table.target_scope} <> 'next' OR ${table.trigger_type} = 'comment'`,
    ),
    check(
      'chk_automations_dm_scope',
      sql`${table.trigger_type} <> 'dm' OR ${table.target_scope} = 'any'`,
    ),
    check(
      'chk_automations_dm_keyword_trigger',
      sql`${table.trigger_type} <> 'dm' OR ${table.is_dm_keyword_trigger_enabled}`,
    ),
    check(
      'chk_automations_dm_needs_keywords',
      sql`${table.trigger_type} <> 'dm' OR cardinality(${table.keywords}) >= 1`,
    ),
    check(
      'chk_automations_specific_target',
      sql`(${table.target_scope} <> 'specific' OR ${table.trigger_type} <> 'comment' OR (${table.target_instagram_media_id} IS NOT NULL AND ${table.target_instagram_story_id} IS NULL))
        AND (${table.target_scope} <> 'specific' OR ${table.trigger_type} <> 'story_reply' OR (${table.target_instagram_story_id} IS NOT NULL AND ${table.target_instagram_media_id} IS NULL))
        AND (${table.target_scope} <> 'any' OR (${table.target_instagram_media_id} IS NULL AND ${table.target_instagram_story_id} IS NULL))
        AND (${table.target_scope} <> 'next' OR ${table.target_instagram_story_id} IS NULL)`,
    ),
    check(
      'chk_automations_next_post_fields',
      sql`(${table.target_scope} = 'next') = (${table.next_post_status} IS NOT NULL)
        AND (${table.target_scope} = 'next') = (${table.next_post_starts_at} IS NOT NULL)
        AND (${table.target_scope} = 'next') = (${table.next_post_ends_at} IS NOT NULL)`,
    ),
    check(
      'chk_automations_next_post_window',
      sql`${table.next_post_ends_at} > ${table.next_post_starts_at}`,
    ),
    check(
      'chk_automations_next_post_linked',
      sql`(${table.next_post_status} IS NOT DISTINCT FROM 'linked') = (${table.next_post_linked_at} IS NOT NULL)
        AND (${table.target_scope} <> 'next' OR (${table.next_post_status} IS NOT DISTINCT FROM 'linked') = (${table.target_instagram_media_id} IS NOT NULL))`,
    ),
  ];
}

/** The array, message, counter, soft-delete and `updated` CHECKs (3.A.3). */
function automationContentChecks(table: AutomationTableColumns) {
  return [
    check(
      'chk_automations_keywords',
      sql`cardinality(${table.keywords}) <= ${sqlLiteral(AUTOMATION_KEYWORDS_MAX_COUNT)} AND array_position(${table.keywords}, NULL) IS NULL`,
    ),
    check(
      'chk_automations_tags',
      sql`cardinality(${table.tags}) <= ${sqlLiteral(AUTOMATION_TAGS_MAX_COUNT)} AND array_position(${table.tags}, NULL) IS NULL`,
    ),
    check(
      'chk_automations_public_reply_texts',
      sql`cardinality(${table.public_reply_texts}) <= ${sqlLiteral(AUTOMATION_PUBLIC_REPLY_TEXTS_MAX_COUNT)} AND array_position(${table.public_reply_texts}, NULL) IS NULL`,
    ),
    check(
      'chk_automations_public_reply',
      sql`NOT ${table.is_public_reply_enabled} OR (${table.trigger_type} = 'comment' AND cardinality(${table.public_reply_texts}) >= 1)`,
    ),
    check(
      'chk_automations_message_objects',
      sql`(${table.opening_message} IS NULL OR jsonb_typeof(${table.opening_message}) = 'object')
        AND (${table.follow_request_message} IS NULL OR jsonb_typeof(${table.follow_request_message}) = 'object')
        AND (${table.email_request_message} IS NULL OR jsonb_typeof(${table.email_request_message}) = 'object')
        AND (${table.phone_request_message} IS NULL OR jsonb_typeof(${table.phone_request_message}) = 'object')
        AND jsonb_typeof(${table.final_message}) = 'object'`,
    ),
    check(
      'chk_automations_enabled_steps_have_messages',
      sql`(NOT ${table.is_opening_message_enabled} OR ${table.opening_message} IS NOT NULL)
        AND (NOT ${table.is_follow_required} OR ${table.follow_request_message} IS NOT NULL)`,
    ),
    check(
      'chk_automations_comment_opening_button',
      sql`${table.trigger_type} <> 'comment' OR NOT ${table.is_opening_message_enabled} OR coalesce(jsonb_typeof(${table.opening_message} -> 'button_title') = 'string', false)`,
    ),
    check(
      'chk_automations_instagram_ids',
      sql`${table.target_instagram_media_id} ~ ${sqlLiteral(AUTOMATION_INSTAGRAM_ID_PATTERN)} AND ${table.target_instagram_story_id} ~ ${sqlLiteral(AUTOMATION_INSTAGRAM_ID_PATTERN)}`,
    ),
    check('chk_automations_completed_run_count', sql`${table.completed_run_count} >= 0`),
    check(
      'chk_automations_delete_reason',
      sql`${table.delete_reason} IN (${sqlLiteralList(RECORD_DELETE_REASON_VALUES)})`,
    ),
    check(
      'chk_automations_delete_reason_when_deleted',
      sql`${table.delete_reason} IS NULL OR ${table.deleted_at} IS NOT NULL`,
    ),
    check(
      'chk_automations_delete_note_when_other',
      sql`${table.delete_reason} IS DISTINCT FROM ${sqlLiteral(RECORD_DELETE_REASON.OTHER)} OR ${table.delete_note} IS NOT NULL`,
    ),
    check('chk_automations_updated', sql`${table.updated_at} >= ${table.created_at}`),
  ];
}

/**
 * `app.automations` — one automation of one Instagram account: its trigger, its target, its
 * keywords and tags, the message of each step and the counters the run engine keeps (routes-final
 * § 3.A.3).
 *
 * @remarks
 * - **Keys:** the account link is the composite `(organization_id, instagram_account_id)` →
 *   `app.instagram_accounts (organization_id, id)`, `ON DELETE RESTRICT` (an account is revoked,
 *   never deleted) — set by the server at create from the organization's not-revoked account and
 *   never changed (AU27). The unique `(organization_id, id)` index is the parent key of the runs'
 *   and comment logs' composite references (sub-domain 3.B).
 * - **Always complete (AU8):** the final message always; the opening and follow messages whenever
 *   their step is on; on a comment automation with the opening message on, its button
 *   (`chk_automations_comment_opening_button`, AQ2 — a missing `button_title` is refused too: the
 *   check never ends in NULL, which a CHECK lets through, D56). The service checks every rule
 *   first, so a caller gets a `400` naming the field, never a constraint error.
 * - **"Next post" (AU9, AU15):** the window and `next_post_status` are set exactly on `next`; the
 *   media id is set exactly when `linked`. The 15-minute expiry and linking change only
 *   `waiting` rows.
 * - **Counters (AU10):** `completed_run_count` and `last_triggered_at` are the run engine's, never
 *   a DTO's.
 * - **Soft delete (AU12):** `deleted_at` with the reason and note of the confirm drawer, as
 *   `tenancy.roles`; no restore; purged 180 days later (AQ7).
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only — the expiry
 *   scan reads across organizations and each change runs in its organization's own context.
 */
export const automations = appSchema
  .table('automations', automationColumns, (table) => [
    ...automationKeysAndIndexes(table),
    ...automationScopeChecks(table),
    ...automationContentChecks(table),
    pgPolicy('automations_tenant_isolation', {
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
  ])
  .enableRLS();
