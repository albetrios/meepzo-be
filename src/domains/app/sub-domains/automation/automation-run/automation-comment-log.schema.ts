import { type BuildExtraConfigColumns, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteral, sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import {
  AUTOMATION_COMMENT_LOG_ERROR_TYPES,
  AUTOMATION_COMMENT_LOG_IGNORED_REASONS,
  AUTOMATION_COMMENT_LOG_OVERALL_STATUSES,
  AUTOMATION_COMMENT_LOG_STEP_STATUSES,
  AUTOMATION_COMMENT_LOG_STEPS,
  AUTOMATION_PUBLIC_REPLY_SKIP_REASONS,
  AUTOMATION_RUN_INSTAGRAM_ID_PATTERN,
  AUTOMATION_RUN_WAITING_FOR,
} from './automation-run.constants.js';

/** A comment-log step status column: `off` until the step is reached (schema-routes § 8.12). */
function stepStatusColumn(name: string) {
  return varchar(name, { length: 10 }).notNull().default('off');
}

/** The columns of `app.automation_comment_logs` (routes-final § 4.B.3), as the table is built from them. */
const automationCommentLogColumns = {
  id: bigserial('id', { mode: 'number' }).notNull(),
  /** `acl_…` — unused until a read route (D13). */
  public_id: varchar('public_id', { length: 28 }).notNull(),
  organization_id: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  automation_id: bigint('automation_id', { mode: 'number' }).notNull(),
  /** The automation's name at the time. */
  automation_name: varchar('automation_name', { length: 255 }).notNull(),
  /** `null` when the comment was ignored — a copy, no reference (its parts drop on their own clock, AU36). */
  automation_run_id: bigint('automation_run_id', { mode: 'number' }),
  /** A copy of the run's start (AU36), set with `automation_run_id`. */
  automation_run_started_at: timestamp('automation_run_started_at', { withTimezone: true }),
  contact_id: bigint('contact_id', { mode: 'number' }).notNull(),
  instagram_media_id: varchar('instagram_media_id', { length: 64 }).notNull(),
  instagram_comment_id: varchar('instagram_comment_id', { length: 64 }).notNull(),
  /** The comment's own time (AU28). */
  comment_occurred_at: timestamp('comment_occurred_at', { withTimezone: true }),
  /** Personal data — cleared by the contact erase (AU26). */
  comment_text: text('comment_text'),
  /** Personal data — cleared by the contact erase (AU26). */
  commenter_username: varchar('commenter_username', { length: 64 }),
  /** Personal data — cleared by the contact erase (AU26). */
  commenter_instagram_user_id: varchar('commenter_instagram_user_id', { length: 64 }),
  public_reply_status: stepStatusColumn('public_reply_status'),
  /** The public reply text sent. */
  public_reply_text: text('public_reply_text'),
  public_reply_skip_reason: varchar('public_reply_skip_reason', { length: 20 }),
  public_reply_at: timestamp('public_reply_at', { withTimezone: true }),
  opening_dm_status: stepStatusColumn('opening_dm_status'),
  opening_dm_at: timestamp('opening_dm_at', { withTimezone: true }),
  button_clicked_at: timestamp('button_clicked_at', { withTimezone: true }),
  follow_status: stepStatusColumn('follow_status'),
  follow_at: timestamp('follow_at', { withTimezone: true }),
  follow_confirmed_at: timestamp('follow_confirmed_at', { withTimezone: true }),
  email_status: stepStatusColumn('email_status'),
  email_at: timestamp('email_at', { withTimezone: true }),
  /** Personal data — cleared by the contact erase (AU26). */
  email_received: varchar('email_received', { length: 255 }),
  phone_status: stepStatusColumn('phone_status'),
  phone_at: timestamp('phone_at', { withTimezone: true }),
  /** Personal data — cleared by the contact erase (AU26). */
  phone_received: varchar('phone_received', { length: 50 }),
  messages_status: stepStatusColumn('messages_status'),
  messages_at: timestamp('messages_at', { withTimezone: true }),
  /** "Hide their comment" (D33) — `off` unless the option is on. */
  hide_status: stepStatusColumn('hide_status'),
  hidden_at: timestamp('hidden_at', { withTimezone: true }),
  overall_status: varchar('overall_status', { length: 10 }).notNull().default('started'),
  current_step: varchar('current_step', { length: 15 }),
  failed_step: varchar('failed_step', { length: 15 }),
  waiting_for: varchar('waiting_for', { length: 25 }),
  ignored_reason: varchar('ignored_reason', { length: 30 }),
  error_type: varchar('error_type', { length: 15 }),
  http_status: integer('http_status'),
  error_code: integer('error_code'),
  error_subcode: integer('error_subcode'),
  error_message: text('error_message'),
  error_reason: text('error_reason'),
  /** Never returned. */
  error_stack: text('error_stack'),
  fbtrace_id: varchar('fbtrace_id', { length: 100 }),
  /** The channel's class, codes, type, trace id and HTTP status — never its text (D53). */
  error_response: jsonb('error_response').$type<Record<string, unknown>>(),
  error_at: timestamp('error_at', { withTimezone: true }),
  /** The month split key (P96, AU36). */
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** The table's columns as its extra config (keys, indexes, checks, policy) reads them. */
type AutomationCommentLogTableColumns = BuildExtraConfigColumns<
  'automation_comment_logs',
  typeof automationCommentLogColumns,
  'pg'
>;

/** The two composite references and every index of 4.B.3 — each local to its month part (AU36). */
function automationCommentLogKeysAndIndexes(table: AutomationCommentLogTableColumns) {
  return [
    primaryKey({ name: 'automation_comment_logs_pkey', columns: [table.id, table.created_at] }),
    foreignKey({
      name: 'automation_comment_logs_automation_fk',
      columns: [table.organization_id, table.automation_id],
      foreignColumns: [automations.organization_id, automations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'automation_comment_logs_contact_fk',
      columns: [table.organization_id, table.contact_id],
      foreignColumns: [contacts.organization_id, contacts.id],
    }).onDelete('restrict'),
    // A split table's unique index carries the split key.
    uniqueIndex('idx_automation_comment_logs_public_id').on(table.public_id, table.created_at),
    // The automation reference and one log per comment and automation — plain since the split
    // (AU28): the engine checks it in the last two month parts under the contact lock.
    index('idx_automation_comment_logs_automation_comment').on(
      table.organization_id,
      table.automation_id,
      table.instagram_comment_id,
    ),
    // The duplicate public reply and a retried comment finding its logs.
    index('idx_automation_comment_logs_comment').on(
      table.organization_id,
      table.instagram_comment_id,
    ),
    // A run's log (a copy, no reference).
    index('idx_automation_comment_logs_automation_run')
      .on(table.organization_id, table.automation_run_id)
      .where(sql`${table.automation_run_id} IS NOT NULL`),
    // The contact reference and the erase step.
    index('idx_automation_comment_logs_contact').on(table.organization_id, table.contact_id),
  ];
}

/** The value-list CHECKs of 4.B.3 — the seven step statuses and every other list. */
function automationCommentLogValueChecks(table: AutomationCommentLogTableColumns) {
  const stepStatuses = sqlLiteralList(AUTOMATION_COMMENT_LOG_STEP_STATUSES);
  return [
    check(
      'chk_automation_comment_logs_public_reply_status',
      sql`${table.public_reply_status} IN (${stepStatuses})`,
    ),
    check(
      'chk_automation_comment_logs_opening_dm_status',
      sql`${table.opening_dm_status} IN (${stepStatuses})`,
    ),
    check(
      'chk_automation_comment_logs_follow_status',
      sql`${table.follow_status} IN (${stepStatuses})`,
    ),
    check(
      'chk_automation_comment_logs_email_status',
      sql`${table.email_status} IN (${stepStatuses})`,
    ),
    check(
      'chk_automation_comment_logs_phone_status',
      sql`${table.phone_status} IN (${stepStatuses})`,
    ),
    check(
      'chk_automation_comment_logs_messages_status',
      sql`${table.messages_status} IN (${stepStatuses})`,
    ),
    check(
      'chk_automation_comment_logs_hide_status',
      sql`${table.hide_status} IN (${stepStatuses})`,
    ),
    check(
      'chk_automation_comment_logs_overall_status',
      sql`${table.overall_status} IN (${sqlLiteralList(AUTOMATION_COMMENT_LOG_OVERALL_STATUSES)})`,
    ),
    check(
      'chk_automation_comment_logs_current_step',
      sql`${table.current_step} IN (${sqlLiteralList(AUTOMATION_COMMENT_LOG_STEPS)})`,
    ),
    check(
      'chk_automation_comment_logs_failed_step',
      sql`${table.failed_step} IN (${sqlLiteralList(AUTOMATION_COMMENT_LOG_STEPS)})`,
    ),
    check(
      'chk_automation_comment_logs_waiting_for',
      sql`${table.waiting_for} IN (${sqlLiteralList(AUTOMATION_RUN_WAITING_FOR)})`,
    ),
    check(
      'chk_automation_comment_logs_ignored_reason',
      sql`${table.ignored_reason} IN (${sqlLiteralList(AUTOMATION_COMMENT_LOG_IGNORED_REASONS)})`,
    ),
    check(
      'chk_automation_comment_logs_error_type',
      sql`${table.error_type} IN (${sqlLiteralList(AUTOMATION_COMMENT_LOG_ERROR_TYPES)})`,
    ),
    check(
      'chk_automation_comment_logs_public_reply_skip_reason',
      sql`${table.public_reply_skip_reason} IN (${sqlLiteralList(AUTOMATION_PUBLIC_REPLY_SKIP_REASONS)})`,
    ),
  ];
}

/** The state CHECKs of 4.B.3: ignored ⇔ its reason, failed ⇒ its time, the skipped reply's reason, the run copy. */
function automationCommentLogStateChecks(table: AutomationCommentLogTableColumns) {
  return [
    check(
      'chk_automation_comment_logs_ignored',
      sql`(${table.overall_status} = 'ignored') = (${table.ignored_reason} IS NOT NULL)`,
    ),
    check(
      'chk_automation_comment_logs_failed_has_error',
      sql`${table.overall_status} <> 'failed' OR ${table.error_at} IS NOT NULL`,
    ),
    check(
      'chk_automation_comment_logs_public_reply_skipped',
      sql`(${table.public_reply_status} = 'skipped') = (${table.public_reply_skip_reason} IS NOT NULL)`,
    ),
    check(
      'chk_automation_comment_logs_instagram_ids',
      sql`${table.instagram_media_id} ~ ${sqlLiteral(AUTOMATION_RUN_INSTAGRAM_ID_PATTERN)}
        AND ${table.instagram_comment_id} ~ ${sqlLiteral(AUTOMATION_RUN_INSTAGRAM_ID_PATTERN)}`,
    ),
    check(
      'chk_automation_comment_logs_run_copy',
      sql`(${table.automation_run_id} IS NULL) = (${table.automation_run_started_at} IS NULL)`,
    ),
    check('chk_automation_comment_logs_updated', sql`${table.updated_at} >= ${table.created_at}`),
  ];
}

/**
 * `app.automation_comment_logs` — one comment an automation saw (routes-final § 4.B.3, AU28): the
 * automation that answered the comment and every other match, ignored ones included, with each
 * step's status — the hello (`opening_dm`), the public reply, the hide, the follow, email and phone
 * asks and the message list.
 *
 * @remarks
 * - **Split by month** of `created_at` (P96, AU36): an ignored comment has no run, so the log keeps
 *   its own month; a part is dropped 90 days after its month by the shared upkeep (ROUTE row R49).
 *   Primary key `(id, created_at)`, unique `(public_id, created_at)`.
 * - **One per comment and automation** — checked by the engine in the last two month parts under
 *   the contact lock (the index is plain since the split); one automation answers a comment, the
 *   other matches are logged `ignored` · `comment_already_answered`.
 * - **Keys:** composite references to the automation and the contact (`RESTRICT`); the run is a
 *   copy (`automation_run_id` + `automation_run_started_at`) with no reference, like the messages'.
 * - **Personal data:** the comment text, the commenter's username and id, the email and phone
 *   received — cleared by the contact erase.
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only.
 */
export const automation_comment_logs = appSchema
  .table('automation_comment_logs', automationCommentLogColumns, (table) => [
    ...automationCommentLogKeysAndIndexes(table),
    ...automationCommentLogValueChecks(table),
    ...automationCommentLogStateChecks(table),
    pgPolicy('automation_comment_logs_tenant_isolation', {
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
