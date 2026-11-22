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
import { automation_runs } from './automation-run.schema.js';

/** A comment-log step status column: `off` until the step is reached (schema-routes § 8.12). */
function stepStatusColumn(name: string) {
  return varchar(name, { length: 10 }).notNull().default('off');
}

/** The columns of `app.automation_comment_logs` (routes-final § 3.B.3), as the table is built from them. */
const automationCommentLogColumns = {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** `acl_…` — unused until a read route (D13). */
  public_id: varchar('public_id', { length: 28 }).notNull(),
  organization_id: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  automation_id: bigint('automation_id', { mode: 'number' }).notNull(),
  /** The automation's name at the time. */
  automation_name: varchar('automation_name', { length: 255 }).notNull(),
  /** `null` when the comment was ignored (AU24). */
  automation_run_id: bigint('automation_run_id', { mode: 'number' }),
  contact_id: bigint('contact_id', { mode: 'number' }).notNull(),
  instagram_media_id: varchar('instagram_media_id', { length: 64 }).notNull(),
  instagram_comment_id: varchar('instagram_comment_id', { length: 64 }).notNull(),
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
  final_dm_status: stepStatusColumn('final_dm_status'),
  final_dm_at: timestamp('final_dm_at', { withTimezone: true }),
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
  /** Instagram's class, codes, type, trace id and HTTP status — never its text (D53). */
  error_response: jsonb('error_response').$type<Record<string, unknown>>(),
  error_at: timestamp('error_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** The table's columns as its extra config (keys, indexes, checks, policy) reads them. */
type AutomationCommentLogTableColumns = BuildExtraConfigColumns<
  'automation_comment_logs',
  typeof automationCommentLogColumns,
  'pg'
>;

/** The three composite references and every index of 3.B.3 — each declared for the index-hygiene gate. */
function automationCommentLogKeysAndIndexes(table: AutomationCommentLogTableColumns) {
  return [
    foreignKey({
      name: 'automation_comment_logs_automation_fk',
      columns: [table.organization_id, table.automation_id],
      foreignColumns: [automations.organization_id, automations.id],
    }).onDelete('restrict'),
    // The migration writes `ON DELETE SET NULL (automation_run_id)` — only the run column is
    // cleared when run retention removes the run (organization_id stays NOT NULL); Drizzle cannot
    // express the column list.
    foreignKey({
      name: 'automation_comment_logs_automation_run_fk',
      columns: [table.organization_id, table.automation_run_id],
      foreignColumns: [automation_runs.organization_id, automation_runs.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'automation_comment_logs_contact_fk',
      columns: [table.organization_id, table.contact_id],
      foreignColumns: [contacts.organization_id, contacts.id],
    }).onDelete('restrict'),
    uniqueIndex('idx_automation_comment_logs_public_id').on(table.public_id),
    // One log per comment × automation (AU24), and the automation reference.
    uniqueIndex('idx_automation_comment_logs_automation_comment').on(
      table.organization_id,
      table.automation_id,
      table.instagram_comment_id,
    ),
    // The duplicate check (AU20) and a retried comment finding its logs (AU16).
    index('idx_automation_comment_logs_comment').on(
      table.organization_id,
      table.instagram_comment_id,
    ),
    // The run reference (`SET NULL`).
    index('idx_automation_comment_logs_automation_run')
      .on(table.organization_id, table.automation_run_id)
      .where(sql`${table.automation_run_id} IS NOT NULL`),
    // The contact reference and the erase step (AU26).
    index('idx_automation_comment_logs_contact').on(table.organization_id, table.contact_id),
    // The hour limit and the gap (AU20).
    index('idx_automation_comment_logs_public_replies')
      .on(table.organization_id, table.public_reply_at)
      .where(sql`${table.public_reply_status} = 'sent'`),
    // The automation's last reply text (AU20).
    index('idx_automation_comment_logs_automation_public_replies')
      .on(table.organization_id, table.automation_id, table.public_reply_at)
      .where(sql`${table.public_reply_status} = 'sent'`),
    // Comment-log retention across organizations (D8).
    index('idx_automation_comment_logs_created').on(table.created_at),
  ];
}

/** The value-list CHECKs of 3.B.3 — the five step statuses and every other list. */
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
      'chk_automation_comment_logs_final_dm_status',
      sql`${table.final_dm_status} IN (${stepStatuses})`,
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

/** The state CHECKs of 3.B.3: ignored ⇔ its reason, failed ⇒ its time, the skipped reply's reason. */
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
    check('chk_automation_comment_logs_updated', sql`${table.updated_at} >= ${table.created_at}`),
  ];
}

/**
 * `app.automation_comment_logs` — the step results of one comment × automation (routes-final
 * § 3.B.3, AU24): the automation that answered the comment and every other match, ignored ones
 * included.
 *
 * @remarks
 * - **One per comment × automation** (`idx_automation_comment_logs_automation_comment`); one
 *   automation answers a comment, the other matches are logged `ignored` ·
 *   `comment_already_answered` (AU16, D26).
 * - **Keys (AU24):** composite references to the automation (`RESTRICT`), the contact
 *   (`RESTRICT`, NOT NULL — every log carries its contact) and the run (`ON DELETE SET NULL
 *   (automation_run_id)` — a run removed after 180 days leaves its log). The engine writes the log
 *   in the run's own short transactions, so both are committed with or before it.
 * - **Reply safety** counts the organization's `sent` public replies here (AU20): the duplicate,
 *   the hour limit and the gap — Postgres is the only source of truth.
 * - **Personal data:** the comment text, the commenter's username and Instagram id, the email and
 *   phone received — masked in logs and cleared by the contact erase (AU26).
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only (comment-log
 *   retention reads and deletes across organizations).
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
