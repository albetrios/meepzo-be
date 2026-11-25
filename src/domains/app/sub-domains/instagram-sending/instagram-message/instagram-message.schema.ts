import { type BuildExtraConfigColumns, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  primaryKey,
  smallint,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { INSTAGRAM_MESSAGE_ID_MAX_LENGTH } from '@/shared/constants/instagram.constants.js';
import { sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { automation_runs } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import {
  INSTAGRAM_DIRECT_MESSAGE_TYPES,
  INSTAGRAM_MESSAGE_KINDS,
  INSTAGRAM_MESSAGE_REASONS,
  INSTAGRAM_MESSAGE_STATUSES,
  INSTAGRAM_MESSAGE_TYPES,
} from './instagram-message.constants.js';

/** The columns of `app.instagram_messages` (routes-final § 6.B.3), as the table is built from them. */
const instagramMessageColumns = {
  id: bigserial('id', { mode: 'number' }).notNull(),
  /** `igm_…` (P22, kickoff choice of R19). */
  public_id: varchar('public_id', { length: 28 }).notNull(),
  organization_id: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  /** A copy of the account (the pick), no reference. */
  channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
  /** A copy; empty only for a broadcast. */
  automation_id: bigint('automation_id', { mode: 'number' }),
  /** The run; empty only for a broadcast. */
  automation_run_id: bigint('automation_run_id', { mode: 'number' }),
  /** The broadcast (sub-domain 7); set exactly for a broadcast message. */
  broadcast_id: bigint('broadcast_id', { mode: 'number' }),
  /** The week split key: the run's start, or the broadcast recipient's creation time. */
  automation_run_started_at: timestamp('automation_run_started_at', {
    withTimezone: true,
  }).notNull(),
  /** A copy of the person, no reference. */
  contact_id: bigint('contact_id', { mode: 'number' }).notNull(),
  message_type: varchar('message_type', { length: 16 }).notNull(),
  /** The list place (D29): 1–10, a broadcast's 1–3; set exactly for those two types. */
  message_number: smallint('message_number'),
  message_kind: varchar('message_kind', { length: 14 }).notNull(),
  version_number: smallint('version_number'),
  wording_number: smallint('wording_number'),
  /** Which reply text was picked. */
  text_number: smallint('text_number'),
  lane: varchar('lane', { length: 9 }).notNull(),
  /** `private_reply` · `direct` · `comment_reply` · `comment_hide`; empty only for a follow check. */
  channel: varchar('channel', { length: 14 }),
  /** True for every message into her chat — the month count's (D34). */
  is_counted_as_direct_message: boolean('is_counted_as_direct_message').notNull(),
  status: varchar('status', { length: 9 }).notNull().default('waiting'),
  reason: varchar('reason', { length: 30 }),
  /** The earliest send time. */
  not_before: timestamp('not_before', { withTimezone: true }),
  /** A copy of the run's comment or message time — the 7-day clock (D9). */
  trigger_occurred_at: timestamp('trigger_occurred_at', { withTimezone: true }),
  tries: smallint('tries').notNull().default(0),
  asks: smallint('asks').notNull().default(0),
  /** Meta's `mid` once sent — the own-echo lookup (WHQ1) and a tap's proof. */
  instagram_message_id: varchar('instagram_message_id', {
    length: INSTAGRAM_MESSAGE_ID_MAX_LENGTH,
  }),
  sending_at: timestamp('sending_at', { withTimezone: true }),
  sent_at: timestamp('sent_at', { withTimezone: true }),
  error_code: integer('error_code'),
  error_subcode: integer('error_subcode'),
  /** When the owner's retry put this failed row back (D72) — set at most once. */
  owner_retry_at: timestamp('owner_retry_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** The table's columns as its checks read them. */
type InstagramMessageTableColumns = BuildExtraConfigColumns<
  'instagram_messages',
  typeof instagramMessageColumns,
  'pg'
>;

/** The CHECKs of 6.B.3 (plan §19.1 checks 1–8): kinds, statuses, reasons, lanes and their pairs. */
function instagramMessageChecks(table: InstagramMessageTableColumns) {
  return [
    check(
      'chk_instagram_messages_type',
      sql`${table.message_type} IN (${sqlLiteralList(INSTAGRAM_MESSAGE_TYPES)})`,
    ),
    check(
      'chk_instagram_messages_kind',
      sql`${table.message_kind} IN (${sqlLiteralList(INSTAGRAM_MESSAGE_KINDS)})`,
    ),
    check(
      'chk_instagram_messages_status',
      sql`${table.status} IN (${sqlLiteralList(INSTAGRAM_MESSAGE_STATUSES)})`,
    ),
    check(
      'chk_instagram_messages_reason',
      sql`${table.reason} IN (${sqlLiteralList(INSTAGRAM_MESSAGE_REASONS)})`,
    ),
    check(
      'chk_instagram_messages_status_reason',
      sql`(${table.status} NOT IN ('waiting', 'sending') OR ${table.reason} IS NULL)
        AND (${table.status} NOT IN ('failed', 'skipped', 'cancelled', 'expired') OR ${table.reason} IS NOT NULL)`,
    ),
    check(
      'chk_instagram_messages_lane_channel',
      sql`(${table.lane} = 'slow' AND ${table.channel} = 'private_reply')
        OR (${table.lane} = 'reply' AND ${table.channel} IN ('comment_reply', 'comment_hide'))
        OR (${table.lane} = 'fast' AND (${table.channel} IS NULL OR ${table.channel} IN ('direct', 'private_reply')))
        OR (${table.lane} = 'broadcast' AND ${table.channel} = 'direct')`,
    ),
    check(
      'chk_instagram_messages_type_lane',
      sql`(${table.message_type} = 'public_reply') = (${table.channel} IS NOT DISTINCT FROM 'comment_reply')
        AND (${table.message_type} = 'hide_comment') = (${table.channel} IS NOT DISTINCT FROM 'comment_hide')
        AND (${table.message_type} = 'follow_check') = (${table.channel} IS NULL)
        AND (${table.message_type} = 'broadcast') = (${table.lane} = 'broadcast')`,
    ),
    check(
      'chk_instagram_messages_source',
      sql`num_nonnulls(${table.automation_run_id}, ${table.broadcast_id}) = 1
        AND (${table.message_type} = 'broadcast') = (${table.broadcast_id} IS NOT NULL)
        AND (${table.automation_id} IS NULL) = (${table.broadcast_id} IS NOT NULL)`,
    ),
    check(
      'chk_instagram_messages_numbers',
      sql`(${table.message_number} IS NOT NULL) = (${table.message_type} IN ('message', 'broadcast'))
        AND ${table.message_number} BETWEEN 1 AND (CASE WHEN ${table.message_type} = 'broadcast' THEN 3 ELSE 10 END)
        AND ${table.version_number} BETWEEN 1 AND 3
        AND ${table.wording_number} BETWEEN 1 AND 10
        AND ${table.text_number} BETWEEN 1 AND 10`,
    ),
    check(
      'chk_instagram_messages_counted',
      sql`${table.is_counted_as_direct_message} = (${table.message_type} IN (${sqlLiteralList(INSTAGRAM_DIRECT_MESSAGE_TYPES)}))`,
    ),
    check(
      'chk_instagram_messages_sending',
      sql`(${table.status} = 'sending') = (${table.sending_at} IS NOT NULL)`,
    ),
    check(
      'chk_instagram_messages_sent',
      sql`(${table.status} = 'sent') = (${table.sent_at} IS NOT NULL)`,
    ),
    check('chk_instagram_messages_counters', sql`${table.tries} >= 0 AND ${table.asks} >= 0`),
    check(
      'chk_instagram_messages_error',
      sql`${table.error_subcode} IS NULL OR ${table.error_code} IS NOT NULL`,
    ),
    check('chk_instagram_messages_updated', sql`${table.updated_at} >= ${table.created_at}`),
  ];
}

/**
 * `app.instagram_messages` — one message we send or plan to send to her, of a run or of a broadcast
 * (feat-instagram-dm-sending routes-final § 6.B.3, SN16, SN17; plan §19.1). It holds no text: the
 * lane reads it from the automation (or broadcast) at the last moment (6.B.10).
 *
 * @remarks
 * - **Split by the ISO week of its run's start** (`automation_run_started_at`, P33, P13; a broadcast
 *   row puts its recipient's creation time there): the migration
 *   `20261125090000_app_instagram_messages.sql` makes the parts (`app.fn_create_weekly_partitions`)
 *   and a DEFAULT part; the shared upkeep (ROUTE row R49) drops a part about 30 days after its week.
 *   Drizzle declares the parent only. Primary key `(id, automation_run_started_at)`.
 * - **Keys:** `(organization_id, automation_run_id, automation_run_started_at)` → the run, `CASCADE`;
 *   `(organization_id, broadcast_id)` → `app.broadcasts`, `CASCADE` (SN17, added by sub-domain 7's
 *   migration `20261125120000_app_broadcasts.sql`, ROUTE row R22). The account, automation and contact are copies without
 *   a reference; nothing points into this table.
 * - **One row per run, type and list place** (`idx_instagram_messages_run_type`, `NULLS NOT
 *   DISTINCT` in the migration — Drizzle's index builder has no such flag): asking again, or her next
 *   action after an `unknown`, reuses the row.
 * - **Status machine (SN16):** `waiting` → `sending` → `sent` · `unknown` · `failed`; `waiting` →
 *   `skipped` · `cancelled` · `expired`; `unknown` → `waiting` once on her next action (D17); `failed`
 *   → `waiting` once by the owner's retry (SN18). Only the result save changes a claimed row.
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only.
 */
export const instagram_messages = appSchema
  .table('instagram_messages', instagramMessageColumns, (table) => [
    primaryKey({
      name: 'instagram_messages_pkey',
      columns: [table.id, table.automation_run_started_at],
    }),
    foreignKey({
      name: 'instagram_messages_automation_run_fk',
      columns: [table.organization_id, table.automation_run_id, table.automation_run_started_at],
      foreignColumns: [
        automation_runs.organization_id,
        automation_runs.id,
        automation_runs.started_at,
      ],
    }).onDelete('cascade'),
    // The broadcast's messages (SN17) — added by sub-domain 7's migration (ROUTE row R22).
    foreignKey({
      name: 'instagram_messages_broadcast_fk',
      columns: [table.organization_id, table.broadcast_id],
      foreignColumns: [broadcasts.organization_id, broadcasts.id],
    }).onDelete('cascade'),
    uniqueIndex('idx_instagram_messages_public_id').on(
      table.public_id,
      table.automation_run_started_at,
    ),
    uniqueIndex('idx_instagram_messages_run_type')
      .on(
        table.organization_id,
        table.automation_run_id,
        table.message_type,
        table.message_number,
        table.message_kind,
        table.automation_run_started_at,
      )
      .where(sql`${table.automation_run_id} IS NOT NULL`),
    index('idx_instagram_messages_automation_run').on(
      table.organization_id,
      table.automation_run_id,
      table.automation_run_started_at,
    ),
    index('idx_instagram_messages_pick')
      .on(table.channel_account_id, table.lane, table.not_before)
      .where(sql`${table.status} = 'waiting'`),
    index('idx_instagram_messages_automation_waiting')
      .on(table.organization_id, table.automation_id)
      .where(sql`${table.status} = 'waiting'`),
    // A broadcast's messages, and the broadcast key's cascade (R22).
    index('idx_instagram_messages_broadcast')
      .on(table.organization_id, table.broadcast_id, table.status)
      .where(sql`${table.broadcast_id} IS NOT NULL`),
    index('idx_instagram_messages_instagram_message_id')
      .on(table.channel_account_id, table.instagram_message_id)
      .where(sql`${table.instagram_message_id} IS NOT NULL`),
    index('idx_instagram_messages_person_sent')
      .on(table.contact_id, table.sent_at)
      .where(sql`${table.status} = 'sent'`),
    index('idx_instagram_messages_automation_failed')
      .on(table.organization_id, table.automation_id, table.created_at)
      .where(sql`${table.status} = 'failed'`),
    index('idx_instagram_messages_contact').on(
      table.organization_id,
      table.contact_id,
      table.created_at,
    ),
    index('idx_instagram_messages_expiry')
      .on(table.trigger_occurred_at)
      .where(sql`${table.status} = 'waiting' AND ${table.lane} IN ('slow', 'reply')`),
    index('idx_instagram_messages_sending')
      .on(table.channel_account_id, table.sending_at)
      .where(sql`${table.status} = 'sending'`),
    ...instagramMessageChecks(table),
    pgPolicy('instagram_messages_tenant_isolation', {
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
