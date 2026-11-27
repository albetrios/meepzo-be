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
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteral, sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { CHANNEL_ACCOUNT_CHANNELS } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { segments } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.schema.js';
import type { SegmentConditions } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import type { AutomationMessage } from '@/domains/app/sub-domains/automation/automation-steps.dto.js';
import {
  BROADCAST_CANCEL_REASONS,
  BROADCAST_MESSAGES_MAX_BYTES,
  BROADCAST_MESSAGES_MAX_COUNT,
  BROADCAST_MODES,
  BROADCAST_NAME_MAX_LENGTH,
  BROADCAST_STATUSES,
} from './broadcast.constants.js';

/** The organization arm of the policy: the row is the active organization's. */
function organizationArm(organizationId: unknown): ReturnType<typeof sql> {
  return sql`${organizationId} = (
    SELECT id FROM tenancy.organizations
    WHERE public_id = current_setting('app.current_organization_public_id', true)
  )`;
}

/** The columns of `app.broadcasts` (7.A.3). */
const broadcastColumns = {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  public_id: varchar('public_id', { length: 28 }).notNull(),
  organization_id: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  /** The account whose contacts it goes to (BC5) — set at create, never changed. */
  channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
  /** A copy of the account's channel (P48, P99). */
  channel: varchar('channel', { length: 10 }).notNull().default('instagram'),
  name: varchar('name', { length: 255 }).notNull(),
  status: varchar('status', { length: 17 }).notNull().default('draft'),
  /** Chosen at send (BC10); `now` until then. */
  mode: varchar('mode', { length: 15 }).notNull().default('now'),
  /** The saved audience (BC8) — or none; set null when the segment is purged or deleted in draft. */
  segment_id: bigint('segment_id', { mode: 'number' }),
  /** The one-off conditions in a draft; the copy of the audience once sent (BC10). */
  conditions: jsonb('conditions').$type<SegmentConditions>(),
  /** 0–3 in a draft, 1–3 once sent, in the automation's message-list shape (BC8). */
  messages: jsonb('messages').$type<AutomationMessage[]>().notNull().default(sql`'[]'::jsonb`),
  /** The live automation of the same account its button starts (BC8, 7.A.10), or none. */
  start_automation_id: bigint('start_automation_id', { mode: 'number' }),
  scheduled_at: timestamp('scheduled_at', { withTimezone: true }),
  ends_at: timestamp('ends_at', { withTimezone: true }),
  started_at: timestamp('started_at', { withTimezone: true }),
  /** When the audience task's last piece committed (WC-40, 7.A.10 — the end duty reads it, R46). */
  audience_built_at: timestamp('audience_built_at', { withTimezone: true }),
  finished_at: timestamp('finished_at', { withTimezone: true }),
  cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
  cancel_reason: varchar('cancel_reason', { length: 16 }),
  matched: integer('matched').notNull().default(0),
  sent: integer('sent').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  replies: integer('replies').notNull().default(0),
  taps: integer('taps').notNull().default(0),
  created_by_user_id: bigint('created_by_user_id', { mode: 'number' }).references(() => users.id, {
    onDelete: 'set null',
  }),
  updated_by_user_id: bigint('updated_by_user_id', { mode: 'number' }).references(() => users.id, {
    onDelete: 'set null',
  }),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** The table's columns as its checks read them. */
type BroadcastTableColumns = BuildExtraConfigColumns<'broadcasts', typeof broadcastColumns, 'pg'>;

/** The CHECKs of `app.broadcasts` (7.A.3): the value lists, the limits, what each status implies. */
function broadcastChecks(table: BroadcastTableColumns) {
  return [
    check(
      'chk_broadcasts_channel',
      sql`${table.channel} IN (${sqlLiteralList(CHANNEL_ACCOUNT_CHANNELS)})`,
    ),
    check(
      'chk_broadcasts_name',
      sql`char_length(btrim(${table.name})) BETWEEN 1 AND ${sqlLiteral(BROADCAST_NAME_MAX_LENGTH)}`,
    ),
    check('chk_broadcasts_status', sql`${table.status} IN (${sqlLiteralList(BROADCAST_STATUSES)})`),
    check('chk_broadcasts_mode', sql`${table.mode} IN (${sqlLiteralList(BROADCAST_MODES)})`),
    check(
      'chk_broadcasts_cancel_reason',
      sql`${table.cancel_reason} IN (${sqlLiteralList(BROADCAST_CANCEL_REASONS)})`,
    ),
    check(
      'chk_broadcasts_messages',
      sql`jsonb_typeof(${table.messages}) = 'array'
        AND jsonb_array_length(${table.messages}) <= ${sqlLiteral(BROADCAST_MESSAGES_MAX_COUNT)}
        AND octet_length(${table.messages}::text) <= ${sqlLiteral(BROADCAST_MESSAGES_MAX_BYTES)}
        AND (${table.status} IN ('draft', 'cancelled') OR jsonb_array_length(${table.messages}) >= 1)`,
    ),
    check(
      'chk_broadcasts_conditions',
      sql`(${table.conditions} IS NULL OR jsonb_typeof(${table.conditions}) = 'object')
        AND (${table.status} IN ('draft', 'cancelled') OR ${table.conditions} IS NOT NULL)
        AND (${table.status} <> 'draft' OR ${table.segment_id} IS NULL OR ${table.conditions} IS NULL)`,
    ),
    check(
      'chk_broadcasts_scheduled_at',
      sql`(${table.mode} = 'scheduled') = (${table.scheduled_at} IS NOT NULL)`,
    ),
    check(
      'chk_broadcasts_ends_at',
      sql`(${table.mode} = 'when_chat_opens') = (${table.ends_at} IS NOT NULL)`,
    ),
    check(
      'chk_broadcasts_cancelled',
      sql`(${table.status} = 'cancelled') = (${table.cancelled_at} IS NOT NULL)
        AND (${table.cancel_reason} IS NULL) = (${table.cancelled_at} IS NULL)`,
    ),
    check(
      'chk_broadcasts_numbers',
      sql`${table.matched} >= 0 AND ${table.sent} >= 0 AND ${table.skipped} >= 0
        AND ${table.failed} >= 0 AND ${table.replies} >= 0 AND ${table.taps} >= 0`,
    ),
    check(
      'chk_broadcasts_deleted',
      sql`${table.deleted_at} IS NULL OR ${table.status} IN ('draft', 'done', 'cancelled')`,
    ),
    check(
      'chk_broadcasts_audience_built',
      sql`${table.audience_built_at} IS NULL OR ${table.started_at} IS NOT NULL`,
    ),
    check('chk_broadcasts_updated', sql`${table.updated_at} >= ${table.created_at}`),
  ];
}

/**
 * `app.broadcasts` — 1 to 3 messages of one channel account and its audience (feat-instagram-dm-sending
 * routes-final § 7.A, BC1, BC8–BC11; shared by every channel, P48): the draft, then the send with
 * its mode and the copy of its conditions, its times and its six numbers (routes 70–76).
 *
 * @remarks
 * - **Keys:** composite with `organization_id`, so nothing names another organization's row — the
 *   account (`ON DELETE CASCADE`, 7.3; set at create, never changed — BC5), the saved segment
 *   (`ON DELETE SET NULL (segment_id)`) and the automation the button starts
 *   (`start_automation_id`, `ON DELETE SET NULL (start_automation_id)` — BC8, P213). `channel` is the
 *   account's, copied (P48, P99). The unique `(organization_id, id)` index is the parent key of the
 *   recipients (ROUTE row R23) and the messages (`app.instagram_outgoing_messages.broadcast_id`, SN17).
 * - **Status by actions only (BC9):** the transitions are guarded `UPDATE … WHERE status IN (…)`
 *   statements in the repository; the CHECKs hold what each status implies — the messages (1–3) and
 *   the conditions once sent, `scheduled_at` exactly for `scheduled`, `ends_at` exactly for
 *   `when_chat_opens`, `cancelled_at` with `cancel_reason` exactly when `cancelled`.
 * - **Soft delete (BC4, BC11, P9):** `deleted_at`, only in `draft`, `done` or `cancelled`
 *   (`chk_broadcasts_deleted`); the hourly purge (WC-62, ROUTE row R50) removes it for good 90 days
 *   later (P75) through `idx_broadcasts_tombstoned`, its messages by cascade.
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only — the start and
 *   end duties (R47) and the purge read across organizations (7.3).
 */
export const broadcasts = appSchema
  .table('broadcasts', broadcastColumns, (table) => [
    foreignKey({
      name: 'broadcasts_channel_account_fk',
      columns: [table.organization_id, table.channel_account_id],
      foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
    }).onDelete('cascade'),
    // `ON DELETE SET NULL (segment_id)` in the migration — Drizzle has no column-list form.
    foreignKey({
      name: 'broadcasts_segment_fk',
      columns: [table.organization_id, table.segment_id],
      foreignColumns: [segments.organization_id, segments.id],
    }).onDelete('set null'),
    // `ON DELETE SET NULL (start_automation_id)` in the migration.
    foreignKey({
      name: 'broadcasts_start_automation_fk',
      columns: [table.organization_id, table.start_automation_id],
      foreignColumns: [automations.organization_id, automations.id],
    }).onDelete('set null'),
    uniqueIndex('idx_broadcasts_public_id').on(table.public_id),
    // The parent key of the recipients (R23) and the messages (SN17).
    uniqueIndex('idx_broadcasts_organization_id_id').on(table.organization_id, table.id),
    // The account key's cascade (every broadcast of the account, soft-deleted too), full.
    index('idx_broadcasts_channel_account').on(table.organization_id, table.channel_account_id),
    // Route 70 newest first (the default sort) over one account's live broadcasts.
    index('idx_broadcasts_account_created_at_id')
      .on(table.organization_id, table.channel_account_id, table.created_at.desc(), table.id.desc())
      .where(sql`${table.deleted_at} IS NULL`),
    // Route 70 by name.
    index('idx_broadcasts_account_name_id')
      .on(table.organization_id, table.channel_account_id, table.name, table.id)
      .where(sql`${table.deleted_at} IS NULL`),
    // The start duty (WC-28, R47).
    index('idx_broadcasts_scheduled_at')
      .on(table.scheduled_at)
      .where(sql`${table.status} = 'scheduled'`),
    // Intake's "does a broadcast wait for her" (R47).
    index('idx_broadcasts_account_waiting_for_chats')
      .on(table.organization_id, table.channel_account_id)
      .where(sql`${table.status} = 'waiting_for_chats'`),
    // The end duty (WC-29, R47).
    index('idx_broadcasts_waiting_ends_at')
      .on(table.ends_at)
      .where(sql`${table.status} = 'waiting_for_chats'`),
    index('idx_broadcasts_to_settle')
      .on(table.organization_id, table.id)
      .where(sql`${table.status} IN ('sending', 'cancelled')`),
    // The purge (BC4, WC-62).
    index('idx_broadcasts_tombstoned')
      .on(table.deleted_at)
      .where(sql`${table.deleted_at} IS NOT NULL`),
    // The segment key's SET NULL and the segment delete's draft step (BC17).
    index('idx_broadcasts_segment')
      .on(table.organization_id, table.segment_id)
      .where(sql`${table.segment_id} IS NOT NULL`),
    index('idx_broadcasts_start_automation')
      .on(table.organization_id, table.start_automation_id)
      .where(sql`${table.start_automation_id} IS NOT NULL`),
    index('idx_broadcasts_created_by_user_id')
      .on(table.created_by_user_id)
      .where(sql`${table.created_by_user_id} IS NOT NULL`),
    index('idx_broadcasts_updated_by_user_id')
      .on(table.updated_by_user_id)
      .where(sql`${table.updated_by_user_id} IS NOT NULL`),
    ...broadcastChecks(table),
    pgPolicy('broadcasts_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: sql`${organizationArm(table.organization_id)}
          OR ${maintenanceBypassArm('app.global_retention_cleanup')}`,
      withCheck: organizationArm(table.organization_id),
    }),
  ])
  .enableRLS();
