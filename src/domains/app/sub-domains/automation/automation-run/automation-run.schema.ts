import { type BuildExtraConfigColumns, type SQL, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
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
import { AUTOMATION_TRIGGER_TYPES } from '@/domains/app/sub-domains/automation/automation.constants.js';
import {
  AUTOMATION_RUN_CANCEL_REASONS,
  AUTOMATION_RUN_EVENT_KEY_MAX_LENGTH,
  AUTOMATION_RUN_INSTAGRAM_ID_PATTERN,
  AUTOMATION_RUN_QUEUED_AUTOMATIONS_MAX_COUNT,
  AUTOMATION_RUN_SENDING_MESSAGE_KINDS,
  AUTOMATION_RUN_STATUSES,
  AUTOMATION_RUN_STEPS,
  AUTOMATION_RUN_WAITING_FOR,
} from './automation-run.constants.js';
import type { AutomationQueuedEntry } from './automation-run.types.js';

/** The columns of `app.automation_runs` (routes-final § 3.B.3), as the table is built from them. */
const automationRunColumns = {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** `run_…` — carried in button payloads (`<aut_…>::<run_…>`). */
  public_id: varchar('public_id', { length: 28 }).notNull(),
  organization_id: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  automation_id: bigint('automation_id', { mode: 'number' }).notNull(),
  contact_id: bigint('contact_id', { mode: 'number' }).notNull(),
  trigger_type: varchar('trigger_type', { length: 15 }).notNull(),
  /** The commented post; set on `comment`. */
  trigger_instagram_media_id: varchar('trigger_instagram_media_id', { length: 64 }),
  /** The comment; set on `comment`. */
  trigger_instagram_comment_id: varchar('trigger_instagram_comment_id', { length: 64 }),
  /** The story replied to; set on `story_reply`. */
  trigger_instagram_story_id: varchar('trigger_instagram_story_id', { length: 64 }),
  /** Personal data — cleared by the contact erase (AU26). */
  trigger_text: text('trigger_text'),
  status: varchar('status', { length: 10 }).notNull().default('running'),
  current_step: varchar('current_step', { length: 20 }).notNull().default('keyword_match'),
  waiting_for: varchar('waiting_for', { length: 25 }),
  /** Automations queued behind this run's email question (AU21) — the `.strict()` shape of 3.B.6. */
  queued_automations: jsonb('queued_automations')
    .$type<AutomationQueuedEntry[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  /** The webhook event that last moved the run (AU19). */
  last_instagram_event_key: varchar('last_instagram_event_key', {
    length: AUTOMATION_RUN_EVENT_KEY_MAX_LENGTH,
  }).notNull(),
  /** The message claimed for sending (AU19); still set after a crash, so it never goes twice. */
  sending_message_kind: varchar('sending_message_kind', { length: 20 }),
  sending_started_at: timestamp('sending_started_at', { withTimezone: true }),
  error_message: text('error_message'),
  cancel_reason: varchar('cancel_reason', { length: 20 }),
  started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  last_step_at: timestamp('last_step_at', { withTimezone: true }).notNull().defaultNow(),
  waiting_since_at: timestamp('waiting_since_at', { withTimezone: true }),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  failed_at: timestamp('failed_at', { withTimezone: true }),
  cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
  /** `coalesce(completed_at, failed_at, cancelled_at)`, stored — the retention clock (D8). */
  ended_at: timestamp('ended_at', { withTimezone: true }).generatedAlwaysAs(
    sql`coalesce(completed_at, failed_at, cancelled_at)`,
  ),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** The table's columns as its extra config (keys, indexes, checks, policy) reads them. */
type AutomationRunTableColumns = BuildExtraConfigColumns<
  'automation_runs',
  typeof automationRunColumns,
  'pg'
>;

/** The two composite references and every index of 3.B.3 — each declared for the index-hygiene gate. */
function automationRunKeysAndIndexes(table: AutomationRunTableColumns) {
  return [
    foreignKey({
      name: 'automation_runs_automation_fk',
      columns: [table.organization_id, table.automation_id],
      foreignColumns: [automations.organization_id, automations.id],
    }).onDelete('restrict'),
    // Contacts are erased in place, never removed (CT7), so RESTRICT never fires on an erase.
    foreignKey({
      name: 'automation_runs_contact_fk',
      columns: [table.organization_id, table.contact_id],
      foreignColumns: [contacts.organization_id, contacts.id],
    }).onDelete('restrict'),
    uniqueIndex('idx_automation_runs_public_id').on(table.public_id),
    // The parent key of the run events' and comment logs' composite references.
    uniqueIndex('idx_automation_runs_organization_id_id').on(table.organization_id, table.id),
    // One open run per automation × contact (AU17); also the organization's open runs.
    uniqueIndex('idx_automation_runs_one_open')
      .on(table.organization_id, table.automation_id, table.contact_id)
      .where(sql`${table.status} IN ('running', 'waiting')`),
    // The automation reference, "this automation's last run for this contact" (AU17) and the
    // contacts list's automation filter (CT5).
    index('idx_automation_runs_automation_contact').on(
      table.organization_id,
      table.automation_id,
      table.contact_id,
      table.started_at,
    ),
    // The contact reference and the erase step (AU26).
    index('idx_automation_runs_contact').on(
      table.organization_id,
      table.contact_id,
      table.started_at,
    ),
    // A DM finding the run that waits for its answer (AU16).
    index('idx_automation_runs_contact_waiting')
      .on(table.organization_id, table.contact_id, table.waiting_for)
      .where(sql`${table.status} = 'waiting'`),
    // The hourly 7-day scan across organizations (AU25).
    index('idx_automation_runs_waiting_since')
      .on(table.waiting_since_at)
      .where(sql`${table.status} = 'waiting'`),
    // Run retention (D8).
    index('idx_automation_runs_ended').on(table.ended_at).where(sql`${table.ended_at} IS NOT NULL`),
  ];
}

/** The value-list and state CHECKs of 3.B.3 (`chk_automation_runs_<rule>`). */
function automationRunChecks(table: AutomationRunTableColumns) {
  return [
    check(
      'chk_automation_runs_trigger_type',
      sql`${table.trigger_type} IN (${sqlLiteralList(AUTOMATION_TRIGGER_TYPES)})`,
    ),
    check(
      'chk_automation_runs_status',
      sql`${table.status} IN (${sqlLiteralList(AUTOMATION_RUN_STATUSES)})`,
    ),
    check(
      'chk_automation_runs_current_step',
      sql`${table.current_step} IN (${sqlLiteralList(AUTOMATION_RUN_STEPS)})`,
    ),
    check(
      'chk_automation_runs_waiting_for',
      sql`${table.waiting_for} IN (${sqlLiteralList(AUTOMATION_RUN_WAITING_FOR)})`,
    ),
    check(
      'chk_automation_runs_sending_message_kind',
      sql`${table.sending_message_kind} IN (${sqlLiteralList(AUTOMATION_RUN_SENDING_MESSAGE_KINDS)})`,
    ),
    check(
      'chk_automation_runs_cancel_reason',
      sql`${table.cancel_reason} IN (${sqlLiteralList(AUTOMATION_RUN_CANCEL_REASONS)})`,
    ),
    check(
      'chk_automation_runs_waiting',
      sql`(${table.status} = 'waiting') = (${table.waiting_for} IS NOT NULL AND ${table.waiting_since_at} IS NOT NULL)`,
    ),
    check(
      'chk_automation_runs_completed',
      sql`(${table.status} = 'completed') = (${table.completed_at} IS NOT NULL)`,
    ),
    check(
      'chk_automation_runs_failed',
      sql`(${table.status} = 'failed') = (${table.failed_at} IS NOT NULL)`,
    ),
    check(
      'chk_automation_runs_cancelled',
      sql`(${table.status} = 'cancelled') = (${table.cancelled_at} IS NOT NULL)
        AND (${table.status} = 'cancelled') = (${table.cancel_reason} IS NOT NULL)`,
    ),
    check(
      'chk_automation_runs_sending',
      sql`(${table.sending_message_kind} IS NULL) = (${table.sending_started_at} IS NULL)`,
    ),
    check(
      'chk_automation_runs_trigger_targets',
      sql`(${table.trigger_type} <> 'comment' OR (${table.trigger_instagram_media_id} IS NOT NULL AND ${table.trigger_instagram_comment_id} IS NOT NULL))
        AND (${table.trigger_type} <> 'story_reply' OR ${table.trigger_instagram_story_id} IS NOT NULL)`,
    ),
    check(
      'chk_automation_runs_instagram_ids',
      sql`${table.trigger_instagram_media_id} ~ ${sqlLiteral(AUTOMATION_RUN_INSTAGRAM_ID_PATTERN)}
        AND ${table.trigger_instagram_comment_id} ~ ${sqlLiteral(AUTOMATION_RUN_INSTAGRAM_ID_PATTERN)}
        AND ${table.trigger_instagram_story_id} ~ ${sqlLiteral(AUTOMATION_RUN_INSTAGRAM_ID_PATTERN)}`,
    ),
    check(
      'chk_automation_runs_queued_automations',
      sql`jsonb_typeof(${table.queued_automations}) = 'array' AND jsonb_array_length(${table.queued_automations}) <= ${sqlLiteral(AUTOMATION_RUN_QUEUED_AUTOMATIONS_MAX_COUNT)}`,
    ),
    check('chk_automation_runs_updated', sql`${table.updated_at} >= ${table.created_at}`),
  ];
}

/**
 * `app.automation_runs` — one automation flow for one contact (routes-final § 3.B.3): its trigger,
 * its status and step, what it waits for, the automations queued behind its email question, the
 * message it is sending and the event that last moved it.
 *
 * @remarks
 * - **Keys:** composite `(organization_id, automation_id)` → `app.automations` and
 *   `(organization_id, contact_id)` → `app.contacts`, both `RESTRICT` (an automation is only
 *   soft-deleted, a contact erased in place). The unique `(organization_id, id)` index is the parent
 *   key of the run events and comment logs.
 * - **One open run** per automation × contact (`idx_automation_runs_one_open`, AU17).
 * - **At most once (AU19):** `sending_message_kind` / `sending_started_at` are set together before a
 *   send and cleared when its result is recorded; a claim still set means the outcome is unknown.
 * - **States:** `waiting` ⇔ `waiting_for` and `waiting_since_at`; each final status ⇔ its time
 *   (`cancelled` ⇔ its reason too); `ended_at` is generated — the 180-day retention clock (D8).
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only — the 7-day
 *   wait scan and run retention read across organizations; each change runs in its organization's
 *   own context.
 */
export const automation_runs = appSchema
  .table('automation_runs', automationRunColumns, (table) => [
    ...automationRunKeysAndIndexes(table),
    ...automationRunChecks(table),
    pgPolicy('automation_runs_tenant_isolation', {
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

/**
 * SQL condition for the contacts list's `automation_id` filter (CT5): the contact had a run of
 * this automation — in any status, so a deleted automation's runs still count.
 *
 * @remarks
 * - **Algorithm:** `EXISTS (a run of the pair)` in the contact's own organization; the probe reads
 *   `idx_automation_runs_automation_contact` (`organization_id, automation_id, contact_id, …`).
 * - **Notes:** exported by the run schema for the contact repository's list (a join-only schema
 *   import inside the app domain, as `membershipHoldsRole`); the automation's internal id comes
 *   from `AutomationService.findAutomationIdForFilter`.
 */
export function contactHadRunOfAutomation(automationId: number): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${automation_runs}
    WHERE ${automation_runs.organization_id} = ${contacts.organization_id}
      AND ${automation_runs.automation_id} = ${automationId}
      AND ${automation_runs.contact_id} = ${contacts.id}
  )`;
}
