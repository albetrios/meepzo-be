import { type BuildExtraConfigColumns, type SQL, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  primaryKey,
  smallint,
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
  AUTOMATION_RUN_LAST_MESSAGE_NUMBER_MAX,
  AUTOMATION_RUN_ONCE_KEY_MAX_LENGTH,
  AUTOMATION_RUN_STATUSES,
  AUTOMATION_RUN_STEPS,
  AUTOMATION_RUN_WAITING_FOR,
} from './automation-run.constants.js';
import type { AutomationRunVersionNumbers } from './automation-run.types.js';

/** The columns of `app.automation_runs` (routes-final § 4.B.3), as the table is built from them. */
const automationRunColumns = {
  id: bigserial('id', { mode: 'number' }).notNull(),
  /** `run_…` — carried in button payloads (`<aut_…>::<run_…>`). */
  public_id: varchar('public_id', { length: 28 }).notNull(),
  organization_id: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  automation_id: bigint('automation_id', { mode: 'number' }).notNull(),
  contact_id: bigint('contact_id', { mode: 'number' }).notNull(),
  /** How this run started — one of the 15 ways (AU21; may differ through "also start from"). */
  trigger_type: varchar('trigger_type', { length: 20 }).notNull(),
  /** The commented, shared or ad post. */
  trigger_instagram_media_id: varchar('trigger_instagram_media_id', { length: 64 }),
  /** The comment; set on the three comment ways. */
  trigger_instagram_comment_id: varchar('trigger_instagram_comment_id', { length: 64 }),
  /** The story replied to or mentioned in. */
  trigger_instagram_story_id: varchar('trigger_instagram_story_id', { length: 64 }),
  /** The event's own time — the 7-day clock (D9). */
  trigger_occurred_at: timestamp('trigger_occurred_at', { withTimezone: true }).notNull(),
  /** The plan's `post_key` (D13): at most one DM per automation, person and key. */
  once_key: varchar('once_key', { length: AUTOMATION_RUN_ONCE_KEY_MAX_LENGTH }).notNull(),
  status: varchar('status', { length: 10 }).notNull().default('running'),
  current_step: varchar('current_step', { length: 20 }).notNull().default('keyword_match'),
  waiting_for: varchar('waiting_for', { length: 25 }),
  /** The event that last moved the run — a retried event finds its work done. */
  last_instagram_event_key: varchar('last_instagram_event_key', {
    length: AUTOMATION_RUN_EVENT_KEY_MAX_LENGTH,
  }).notNull(),
  /** The first DM `sent` or `unknown` (the once rule reads it). */
  direct_message_sent_at: timestamp('direct_message_sent_at', { withTimezone: true }),
  /** The highest list message sent, 1–10 (the plan's `last_message_no`). */
  last_message_number: smallint('last_message_number'),
  /** The plan's `version_nos`: each step's version or wording, the asks, the tag chain. */
  version_numbers: jsonb('version_numbers')
    .$type<AutomationRunVersionNumbers>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  error_message: text('error_message'),
  cancel_reason: varchar('cancel_reason', { length: 20 }),
  /**
   * The month split key (P96, AU36) — whole milliseconds, since every copy of the run key (events,
   * open keys, logs, messages) is written from the application's `Date`.
   */
  started_at: timestamp('started_at', { withTimezone: true })
    .notNull()
    .default(sql`date_trunc('milliseconds', now())`),
  last_step_at: timestamp('last_step_at', { withTimezone: true }).notNull().defaultNow(),
  waiting_since_at: timestamp('waiting_since_at', { withTimezone: true }),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  failed_at: timestamp('failed_at', { withTimezone: true }),
  cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
  /** `coalesce(completed_at, failed_at, cancelled_at)`, stored — when the run ended. */
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

/** The keys and every index of 4.B.3 — each local to its month part (AU36). */
function automationRunKeysAndIndexes(table: AutomationRunTableColumns) {
  return [
    primaryKey({ name: 'automation_runs_pkey', columns: [table.id, table.started_at] }),
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
    // A split table's unique index carries the split key.
    uniqueIndex('idx_automation_runs_public_id').on(table.public_id, table.started_at),
    // The parent key of the run events' and open keys' composite references.
    uniqueIndex('idx_automation_runs_organization_id_id').on(
      table.organization_id,
      table.id,
      table.started_at,
    ),
    // Her open run of an automation — a look-up since rev 5; the rule is the key table (AU37).
    index('idx_automation_runs_one_open')
      .on(table.organization_id, table.automation_id, table.contact_id)
      .where(sql`${table.status} IN ('running', 'waiting')`),
    // The automation reference and the contacts list's automation filter (CT5).
    index('idx_automation_runs_automation_contact').on(
      table.organization_id,
      table.automation_id,
      table.contact_id,
      table.started_at,
    ),
    // The contact reference, the erase and a retried event's runs.
    index('idx_automation_runs_contact').on(
      table.organization_id,
      table.contact_id,
      table.started_at,
    ),
    // A message or tap finding the run that waits for it.
    index('idx_automation_runs_contact_waiting')
      .on(table.organization_id, table.contact_id, table.waiting_for)
      .where(sql`${table.status} = 'waiting'`),
    // The hourly 7-day scan across organizations (WC-45).
    index('idx_automation_runs_waiting_since')
      .on(table.waiting_since_at)
      .where(sql`${table.status} = 'waiting'`),
    // The once rule (AU22): a DM already went for this automation, person and key.
    index('idx_automation_runs_once')
      .on(table.organization_id, table.automation_id, table.contact_id, table.once_key)
      .where(sql`${table.direct_message_sent_at} IS NOT NULL`),
  ];
}

/** The ways to start that carry a comment (`chk_automation_runs_trigger_targets`). */
const COMMENT_TRIGGER_TYPES = sqlLiteralList(['comment', 'live_comment', 'ad_comment']);

/** The value-list and state CHECKs of 4.B.3 (`chk_automation_runs_<rule>`). */
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
      'chk_automation_runs_trigger_targets',
      sql`(${table.trigger_type} NOT IN (${COMMENT_TRIGGER_TYPES}) OR (${table.trigger_instagram_media_id} IS NOT NULL AND ${table.trigger_instagram_comment_id} IS NOT NULL))
        AND (${table.trigger_type} NOT IN ('story_reply', 'story_mention') OR ${table.trigger_instagram_story_id} IS NOT NULL)`,
    ),
    check(
      'chk_automation_runs_instagram_ids',
      sql`${table.trigger_instagram_media_id} ~ ${sqlLiteral(AUTOMATION_RUN_INSTAGRAM_ID_PATTERN)}
        AND ${table.trigger_instagram_comment_id} ~ ${sqlLiteral(AUTOMATION_RUN_INSTAGRAM_ID_PATTERN)}
        AND ${table.trigger_instagram_story_id} ~ ${sqlLiteral(AUTOMATION_RUN_INSTAGRAM_ID_PATTERN)}`,
    ),
    check(
      'chk_automation_runs_started_at_milliseconds',
      sql`${table.started_at} = date_trunc('milliseconds', ${table.started_at})`,
    ),
    check('chk_automation_runs_once_key', sql`length(${table.once_key}) BETWEEN 1 AND 255`),
    check(
      'chk_automation_runs_last_message_number',
      sql`${table.last_message_number} BETWEEN 1 AND ${sqlLiteral(AUTOMATION_RUN_LAST_MESSAGE_NUMBER_MAX)}`,
    ),
    check(
      'chk_automation_runs_version_numbers',
      sql`jsonb_typeof(${table.version_numbers}) = 'object'`,
    ),
    check('chk_automation_runs_updated', sql`${table.updated_at} >= ${table.created_at}`),
  ];
}

/**
 * `app.automation_runs` — one person going through one automation (routes-final § 4.B.3, AU21–AU27,
 * AU36): how it started and its once key, the 7-day clock, its status, step and wait, the versions it
 * picked, the first DM and the last list message, and the event that last moved it.
 *
 * @remarks
 * - **Split by month** of `started_at` (`PARTITION BY RANGE`, one part per UTC month, P96, AU36): the
 *   parts come from `app.fn_create_monthly_partitions` (the migration's first parts, then the shared
 *   upkeep, ROUTE row R49, which drops a part once every run in it ended 90 days ago). Every key
 *   carries the split key — primary key `(id, started_at)`, unique `(public_id, started_at)` and the
 *   parent key `(organization_id, id, started_at)` of the run events and the open-run keys.
 * - **Keys:** composite `(organization_id, automation_id)` → `app.automations` and
 *   `(organization_id, contact_id)` → `app.contacts`, both `RESTRICT` (an automation is only
 *   soft-deleted, a contact erased in place).
 * - **One open run** per automation and person: the key table `app.automation_run_open_keys` (AU37,
 *   P100) — a unique index on a split table holds only inside one part, so
 *   `idx_automation_runs_one_open` is a look-up.
 * - **States:** `waiting` ⇔ `waiting_for` and `waiting_since_at`; each final status ⇔ its time
 *   (`cancelled` ⇔ its reason too); `ended_at` is generated.
 * - **No text:** her free text is never kept (D46); the content of what it sends is the automation's
 *   `steps`, read at send (AU35).
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only (the 7-day scan
 *   and the open-key repair read across organizations); each change runs in its organization's scope.
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
 * this automation — in any status and any kept part, so a deleted automation's runs still count.
 *
 * @remarks
 * - **Algorithm:** `EXISTS (a run of the pair)` in the contact's own organization; the probe reads
 *   `idx_automation_runs_automation_contact` in each part.
 * - **Notes:** exported by the run schema for the contact repository's list (a join-only schema
 *   import inside the app domain); the automation's internal id comes from
 *   `AutomationService.findAutomationIdForFilter`.
 */
export function contactHadRunOfAutomation(automationId: number): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${automation_runs}
    WHERE ${automation_runs.organization_id} = ${contacts.organization_id}
      AND ${automation_runs.automation_id} = ${automationId}
      AND ${automation_runs.contact_id} = ${contacts.id}
  )`;
}
