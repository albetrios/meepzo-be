import { type BuildExtraConfigColumns, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  smallint,
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
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import {
  AUTOMATION_ALSO_START_FROM_VALUES,
  AUTOMATION_CHANNELS,
  AUTOMATION_DEFAULT_REPLY_MODES,
  AUTOMATION_KEYWORDS_MAX_COUNT,
  AUTOMATION_MESSAGES_MAX_COUNT,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_NEXT_POST_STATUSES,
  AUTOMATION_PUBLIC_REPLY_HOUR_LIMITS,
  AUTOMATION_PUBLIC_REPLY_LINES_WITH_REPLY_LIKE_PERSON_MIN_COUNT,
  AUTOMATION_PUBLIC_REPLY_TEXTS_MAX_COUNT,
  AUTOMATION_REF_CODE_PATTERN,
  AUTOMATION_STARTER_QUESTIONS_MAX_COUNT,
  AUTOMATION_STATUSES,
  AUTOMATION_STEPS_MAX_BYTES,
  AUTOMATION_STOPPED_REASONS,
  AUTOMATION_TAG_MAX_LENGTH,
  AUTOMATION_TARGET_SCOPES,
  AUTOMATION_TRIGGER_TYPES,
} from './automation.constants.js';
import type { AutomationSteps } from './automation-steps.dto.js';
import {
  INSTAGRAM_ID_MAX_LENGTH,
  INSTAGRAM_ID_PATTERN,
} from '@/shared/constants/instagram.constants.js';

/** The columns of `app.automations` (routes-final § 4.A.3), as the table is built from them. */
const automationColumns = {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  public_id: varchar('public_id', { length: 28 }).notNull(),
  organization_id: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  /** The channel account the automation runs on (AU34, P48) — set at create, never changed. */
  channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
  /** The account's channel, copied at create (AU34). */
  channel: varchar('channel', { length: 10 }).notNull().default('instagram'),
  name: varchar('name', { length: 255 }).notNull(),
  status: varchar('status', { length: 10 }).notNull().default('draft'),
  trigger_type: varchar('trigger_type', { length: 20 }).notNull(),
  also_start_from: text('also_start_from').array().notNull().default([]),
  target_scope: varchar('target_scope', { length: 10 }).notNull().default('any'),
  /** The `specific` post or shared post, or the post a `next` automation linked to; digits only. */
  target_instagram_media_id: varchar('target_instagram_media_id', {
    length: INSTAGRAM_ID_MAX_LENGTH,
  }),
  /** The `specific` story; digits only. */
  target_instagram_story_id: varchar('target_instagram_story_id', {
    length: INSTAGRAM_ID_MAX_LENGTH,
  }),
  /** `between`: the owner's start; `next`: the go-live time (AU20). */
  target_starts_at: timestamp('target_starts_at', { withTimezone: true }),
  /** `between`: the owner's end; `next`: always empty. */
  target_ends_at: timestamp('target_ends_at', { withTimezone: true }),
  next_post_status: varchar('next_post_status', { length: 10 }),
  next_post_linked_at: timestamp('next_post_linked_at', { withTimezone: true }),
  /** Trimmed, lowercased, deduplicated. */
  keywords: text('keywords').array().notNull().default([]),
  ref_code: varchar('ref_code', { length: 64 }),
  starter_questions: text('starter_questions').array().notNull().default([]),
  ad_id: varchar('ad_id', { length: INSTAGRAM_ID_MAX_LENGTH }),
  trigger_tag: varchar('trigger_tag', { length: 50 }),
  default_reply_mode: varchar('default_reply_mode', { length: 12 }),
  is_public_reply_enabled: boolean('is_public_reply_enabled').notNull().default(false),
  public_reply_texts: text('public_reply_texts').array().notNull().default([]),
  is_public_reply_mention_enabled: boolean('is_public_reply_mention_enabled')
    .notNull()
    .default(true),
  is_reply_like_person_enabled: boolean('is_reply_like_person_enabled').notNull().default(false),
  /** Empty = 60 (`AUTOMATION_PUBLIC_REPLY_HOUR_LIMIT_DEFAULT`). */
  public_reply_hour_limit: smallint('public_reply_hour_limit'),
  is_hide_comment_after_direct_message_enabled: boolean(
    'is_hide_comment_after_direct_message_enabled',
  )
    .notNull()
    .default(false),
  /** What it sends (AU8) — one object, ≤ 64 KB. */
  steps: jsonb('steps').$type<AutomationSteps>().notNull().default({}),
  stopped_reason: varchar('stopped_reason', { length: 20 }),
  stopped_at: timestamp('stopped_at', { withTimezone: true }),
  /** Pause + Cancel: its waiting messages made before this count as cancelled (AU14). */
  cancelled_before_at: timestamp('cancelled_before_at', { withTimezone: true }),
  /** The last run start — moved only when over 60 s old (AU19). */
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

/** A live-level rule: a `draft` passes, a `live` or `paused` row must hold it (AU9). */
function liveRule({
  table,
  rule,
}: {
  table: AutomationTableColumns;
  rule: ReturnType<typeof sql>;
}) {
  return sql`${table.status} = 'draft' OR (${rule})`;
}

/** The account reference and every index of 4.A.3 — each declared for the index-hygiene gate. */
function automationKeysAndIndexes(table: AutomationTableColumns) {
  return [
    foreignKey({
      name: 'automations_channel_account_fk',
      columns: [table.organization_id, table.channel_account_id],
      foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
    }).onDelete('restrict'),
    uniqueIndex('idx_automations_public_id').on(table.public_id),
    // The composite parent key of runs, logs, counts, reply states, backfills and contacts' keys.
    uniqueIndex('idx_automations_organization_id_id').on(table.organization_id, table.id),
    // The account reference; not partial, so it covers soft-deleted rows.
    index('idx_automations_organization_id_channel_account_id').on(
      table.organization_id,
      table.channel_account_id,
    ),
    // One index per list sort over one account's automations (AU10).
    index('idx_automations_account_created_at_id')
      .on(table.organization_id, table.channel_account_id, table.created_at, table.id)
      .where(sql`${table.deleted_at} IS NULL`),
    index('idx_automations_account_name_id')
      .on(table.organization_id, table.channel_account_id, table.name, table.id)
      .where(sql`${table.deleted_at} IS NULL`),
    // last_triggered_at nulls last in both directions: one index each way (launch follow-up 2).
    index('idx_automations_account_last_triggered_at_id')
      .on(
        table.organization_id,
        table.channel_account_id,
        table.last_triggered_at.asc().nullsLast(),
        table.id,
      )
      .where(sql`${table.deleted_at} IS NULL`),
    index('idx_automations_account_last_triggered_at_desc_id')
      .on(
        table.organization_id,
        table.channel_account_id,
        table.last_triggered_at.desc().nullsLast(),
        table.id.desc(),
      )
      .where(sql`${table.deleted_at} IS NULL`),
    // The list's `q` over the name, any case.
    index('idx_automations_name_trgm')
      .using('gin', table.name.op('gin_trgm_ops'))
      .where(sql`${table.deleted_at} IS NULL`),
    // An event's candidates, of the event's account only.
    index('idx_automations_live_triggers')
      .on(table.organization_id, table.channel_account_id, table.trigger_type)
      .where(sql`${table.status} = 'live' AND ${table.deleted_at} IS NULL`),
    // A comment's post-linked automations and "already targeted".
    index('idx_automations_target_media')
      .on(table.organization_id, table.channel_account_id, table.target_instagram_media_id)
      .where(sql`${table.target_instagram_media_id} IS NOT NULL AND ${table.deleted_at} IS NULL`),
    // The linking sweep's live, waiting "next post" automations per account (AU20, WC-43).
    index('idx_automations_next_post_waiting')
      .on(table.organization_id, table.channel_account_id)
      .where(
        sql`${table.next_post_status} = 'waiting' AND ${table.status} = 'live' AND ${table.deleted_at} IS NULL`,
      ),
    // `ref_code` unique per account, drafts included (D43).
    uniqueIndex('idx_automations_account_ref_code')
      .on(table.organization_id, table.channel_account_id, table.ref_code)
      .where(sql`${table.ref_code} IS NOT NULL AND ${table.deleted_at} IS NULL`),
    // Tombstone purge: only the soft-deleted rows, so live writes never maintain it.
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

/** The every-save CHECKs (AU9 level 1): value lists, lengths, counts, ranges, `steps` an object. */
function automationEverySaveChecks(table: AutomationTableColumns) {
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
      'chk_automations_channel',
      sql`${table.channel} IN (${sqlLiteralList(AUTOMATION_CHANNELS)})`,
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
      'chk_automations_also_start_from',
      sql`${table.also_start_from} <@ ARRAY[${sqlLiteralList(AUTOMATION_ALSO_START_FROM_VALUES)}]::text[] AND cardinality(${table.also_start_from}) <= 2 AND array_position(${table.also_start_from}, NULL) IS NULL`,
    ),
    check('chk_automations_target_dates', sql`${table.target_ends_at} > ${table.target_starts_at}`),
    check(
      'chk_automations_next_post_linked',
      sql`(${table.next_post_status} IS NOT DISTINCT FROM 'linked') = (${table.next_post_linked_at} IS NOT NULL)`,
    ),
    check(
      'chk_automations_keywords',
      sql`cardinality(${table.keywords}) <= ${sqlLiteral(AUTOMATION_KEYWORDS_MAX_COUNT)} AND array_position(${table.keywords}, NULL) IS NULL`,
    ),
    check(
      'chk_automations_ref_code',
      sql`${table.ref_code} ~ ${sqlLiteral(AUTOMATION_REF_CODE_PATTERN)}`,
    ),
    check(
      'chk_automations_starter_questions',
      sql`cardinality(${table.starter_questions}) <= ${sqlLiteral(AUTOMATION_STARTER_QUESTIONS_MAX_COUNT)} AND array_position(${table.starter_questions}, NULL) IS NULL`,
    ),
    check(
      'chk_automations_instagram_ids',
      sql`${table.target_instagram_media_id} ~ ${sqlLiteral(INSTAGRAM_ID_PATTERN)} AND ${table.target_instagram_story_id} ~ ${sqlLiteral(INSTAGRAM_ID_PATTERN)} AND ${table.ad_id} ~ ${sqlLiteral(INSTAGRAM_ID_PATTERN)}`,
    ),
    check(
      'chk_automations_trigger_tag',
      sql`char_length(btrim(${table.trigger_tag})) BETWEEN 1 AND ${sqlLiteral(AUTOMATION_TAG_MAX_LENGTH)}`,
    ),
    check(
      'chk_automations_default_reply_mode',
      sql`${table.default_reply_mode} IN (${sqlLiteralList(AUTOMATION_DEFAULT_REPLY_MODES)})`,
    ),
    check(
      'chk_automations_public_reply_texts',
      sql`cardinality(${table.public_reply_texts}) <= ${sqlLiteral(AUTOMATION_PUBLIC_REPLY_TEXTS_MAX_COUNT)} AND array_position(${table.public_reply_texts}, NULL) IS NULL`,
    ),
    check(
      'chk_automations_public_reply_hour_limit',
      sql`${table.public_reply_hour_limit} IN (${sqlLiteralList(AUTOMATION_PUBLIC_REPLY_HOUR_LIMITS)})`,
    ),
    check(
      'chk_automations_steps',
      sql`jsonb_typeof(${table.steps}) = 'object' AND octet_length(${table.steps}::text) <= ${sqlLiteral(AUTOMATION_STEPS_MAX_BYTES)}`,
    ),
    check(
      'chk_automations_stopped_reason',
      sql`${table.stopped_reason} IN (${sqlLiteralList(AUTOMATION_STOPPED_REASONS)})`,
    ),
    check(
      'chk_automations_stopped',
      sql`(${table.stopped_reason} IS NULL) = (${table.stopped_at} IS NULL)`,
    ),
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

/** The go-live CHECKs (AU9 level 2), each `status = 'draft' OR (…)` (plan §18.5). */
function automationLiveChecks(table: AutomationTableColumns) {
  return [
    check(
      'chk_automations_live_trigger_fields',
      liveRule({
        table,
        rule: sql`(${table.trigger_type} <> 'ref_link' OR ${table.ref_code} IS NOT NULL)
        AND (${table.trigger_type} <> 'starter_question' OR cardinality(${table.starter_questions}) BETWEEN 1 AND ${sqlLiteral(AUTOMATION_STARTER_QUESTIONS_MAX_COUNT)})
        AND (${table.trigger_type} NOT IN ('ad_comment', 'ad_message') OR ${table.ad_id} IS NOT NULL)
        AND (${table.trigger_type} NOT IN ('tag_added', 'tag_removed') OR ${table.trigger_tag} IS NOT NULL)
        AND (${table.trigger_type} <> 'default_reply' OR ${table.default_reply_mode} IS NOT NULL)
        AND (${table.trigger_type} <> 'dm_keyword' OR cardinality(${table.keywords}) >= 1)`,
      }),
    ),
    check(
      'chk_automations_live_target',
      liveRule({
        table,
        rule: sql`(${table.trigger_type} = 'comment' OR ${table.target_scope} IN ('any', 'specific'))
        AND (${table.trigger_type} IN ('comment', 'story_reply', 'shared_post') OR ${table.target_scope} = 'any')
        AND (${table.target_scope} <> 'specific' OR ${table.trigger_type} = 'story_reply' OR (${table.target_instagram_media_id} IS NOT NULL AND ${table.target_instagram_story_id} IS NULL))
        AND (${table.target_scope} <> 'specific' OR ${table.trigger_type} <> 'story_reply' OR (${table.target_instagram_story_id} IS NOT NULL AND ${table.target_instagram_media_id} IS NULL))
        AND (${table.target_scope} NOT IN ('any', 'between') OR (${table.target_instagram_media_id} IS NULL AND ${table.target_instagram_story_id} IS NULL))
        AND (${table.target_scope} <> 'next' OR ${table.target_instagram_story_id} IS NULL)`,
      }),
    ),
    check(
      'chk_automations_live_also_start_from',
      liveRule({
        table,
        rule: sql`CASE ${table.trigger_type}
          WHEN 'comment' THEN ${table.also_start_from} <@ ARRAY['story_reply', 'dm']::text[]
          WHEN 'story_reply' THEN ${table.also_start_from} <@ ARRAY['dm']::text[]
          WHEN 'dm_keyword' THEN ${table.also_start_from} <@ ARRAY['story_reply']::text[]
          ELSE cardinality(${table.also_start_from}) = 0
        END`,
      }),
    ),
    check(
      'chk_automations_live_next_post',
      liveRule({
        table,
        rule: sql`(${table.target_scope} = 'next') = (${table.next_post_status} IS NOT NULL)
        AND (${table.target_scope} <> 'next' OR (${table.target_starts_at} IS NOT NULL AND ${table.target_ends_at} IS NULL))
        AND (${table.target_scope} <> 'next' OR (${table.next_post_status} = 'linked') = (${table.target_instagram_media_id} IS NOT NULL))`,
      }),
    ),
    check(
      'chk_automations_live_between',
      liveRule({
        table,
        rule: sql`${table.target_scope} <> 'between' OR (${table.target_starts_at} IS NOT NULL AND ${table.target_ends_at} IS NOT NULL)`,
      }),
    ),
    check(
      'chk_automations_live_public_reply',
      liveRule({
        table,
        rule: sql`NOT ${table.is_public_reply_enabled}
        OR (${table.trigger_type} IN ('comment', 'ad_comment') AND cardinality(${table.public_reply_texts}) >= 1
          AND (NOT ${table.is_reply_like_person_enabled} OR cardinality(${table.public_reply_texts}) >= ${sqlLiteral(AUTOMATION_PUBLIC_REPLY_LINES_WITH_REPLY_LIKE_PERSON_MIN_COUNT)}))`,
      }),
    ),
    check(
      'chk_automations_live_hide',
      liveRule({
        table,
        rule: sql`NOT ${table.is_hide_comment_after_direct_message_enabled} OR ${table.trigger_type} IN ('comment', 'ad_comment')`,
      }),
    ),
    check(
      'chk_automations_live_messages',
      liveRule({
        table,
        rule: sql`jsonb_typeof(${table.steps} -> 'messages') = 'array' AND jsonb_array_length(${table.steps} -> 'messages') BETWEEN 1 AND ${sqlLiteral(AUTOMATION_MESSAGES_MAX_COUNT)}`,
      }),
    ),
    check(
      'chk_automations_live_hello_next_button',
      liveRule({
        table,
        rule: sql`${table.steps} -> 'hello' -> 'on' IS DISTINCT FROM 'true'::jsonb
        OR NOT jsonb_path_exists(${table.steps}, '$.hello.versions[*] ? (!exists(@.buttons[*] ? (@.action == "next")))')`,
      }),
    ),
  ];
}

/**
 * `app.automations` — one automation of one channel account, shared by every channel (routes-final
 * § 4.A.3, P48): how it starts (flat columns), its public reply and its pacing, and one `steps`
 * object for what it sends.
 *
 * @remarks
 * - **Keys:** the account link is the composite `(organization_id, channel_account_id)` →
 *   `app.channel_accounts (organization_id, id)`, `ON DELETE RESTRICT` (an account is revoked, never
 *   deleted) — set at create, never changed. `channel` is copied from the account. The unique
 *   `(organization_id, id)` index is the parent key of runs, logs, counts, reply states and the two
 *   contact keys (`contacts.first_automation_id`, `contact_tag_events.source_automation_id`, both
 *   `ON DELETE SET NULL (<column>)`, added by this table's migration — § 4.3).
 * - **Two levels of checks (AU9):** every save — lists, lengths, counts, ranges, `steps` an object
 *   ≤ 64 KB; go-live — `status = 'draft' OR (…)`, so a `live` or `paused` row must pass. The API
 *   runs every rule first and answers with the problems, never a constraint error.
 * - **Status by actions only (AU3):** `draft` → `live` ⇄ `paused`; an automatic stop
 *   (`stopped_reason`) keeps it `live`.
 * - **Counters (AU19):** in `app.automation_counts`; only `last_triggered_at` stays here.
 * - **Soft delete (AU16):** `deleted_at`, an optional reason; `other` needs a note.
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only.
 */
export const automations = appSchema
  .table('automations', automationColumns, (table) => [
    ...automationKeysAndIndexes(table),
    ...automationEverySaveChecks(table),
    ...automationLiveChecks(table),
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
