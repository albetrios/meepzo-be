import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  pgPolicy,
  smallint,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteral, sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import {
  BROADCAST_RECIPIENT_REASON_PATTERN,
  BROADCAST_RECIPIENT_STATUSES,
  BROADCAST_RECIPIENT_STATUSES_WITH_REASON,
  BROADCAST_RECIPIENT_VERSION_MAX,
} from './broadcast-recipient.constants.js';

/** The organization arm of the policy: the row is the active organization's. */
function organizationArm(organizationId: unknown): ReturnType<typeof sql> {
  return sql`${organizationId} = (
    SELECT id FROM tenancy.organizations
    WHERE public_id = current_setting('app.current_organization_public_id', true)
  )`;
}

/**
 * `app.broadcast_recipients` — one person a broadcast goes to and what happened to her first message
 * (feat-instagram-dm-sending routes-final § 7.C, BC16, BC17; shared by every channel, P48). No public
 * id, no soft delete, no `*_by_user_id` (7.C.3); never listed — read through the broadcast's numbers.
 *
 * @remarks
 * - **Plain, with a real "once per person" key (P33, P96):** unique
 *   `(organization_id, broadcast_id, contact_id)` — a second row for her is impossible; a `skipped` ·
 *   `owner_chat` row is put back to `waiting` instead (plan §20.10).
 * - **Keys:** composite with `organization_id` — the broadcast (`ON DELETE CASCADE`, so the purge
 *   takes its recipients) and the contact (`ON DELETE RESTRICT`: contacts are erased in place).
 *   `channel_account_id` is a copy for the lane's pick, without a key of its own.
 * - **Checks:** the status list; a reason exactly with `skipped` and `failed` (an `unknown` may keep
 *   the channel's), none with `waiting` or `sent`; `sent_at` exactly when `sent`; the version 1–3.
 * - **Kept 90 days** after it was made (BC16, P92): the hourly, time-budgeted clean-up (WC-53, ROUTE
 *   row R50) through `idx_broadcast_recipients_created_at`.
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only (the clean-up reads
 *   across organizations).
 */
export const broadcast_recipients = appSchema
  .table(
    'broadcast_recipients',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      /** A copy of the broadcast's account, for the lane's pick (7.C.3) — no key of its own. */
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      broadcast_id: bigint('broadcast_id', { mode: 'number' }).notNull(),
      contact_id: bigint('contact_id', { mode: 'number' }).notNull(),
      status: varchar('status', { length: 7 }).notNull().default('waiting'),
      /** Set exactly with `skipped` and `failed` (an `unknown` may carry the channel's). */
      reason: varchar('reason', { length: 30 }),
      /** The version picked for her (1–3) — none while a broadcast message has no versions. */
      version_number: smallint('version_number'),
      /** Set exactly when `sent`. */
      sent_at: timestamp('sent_at', { withTimezone: true }),
      /** Her first message after the broadcast went — set once (`replies` + 1 in that commit). */
      replied_at: timestamp('replied_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'broadcast_recipients_broadcast_fk',
        columns: [table.organization_id, table.broadcast_id],
        foreignColumns: [broadcasts.organization_id, broadcasts.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'broadcast_recipients_contact_fk',
        columns: [table.organization_id, table.contact_id],
        foreignColumns: [contacts.organization_id, contacts.id],
      }).onDelete('restrict'),
      // Once per person per broadcast (BC16) — also the broadcast key's cascade.
      uniqueIndex('idx_broadcast_recipients_broadcast_contact').on(
        table.organization_id,
        table.broadcast_id,
        table.contact_id,
      ),
      // The end duty and the numbers (R47).
      index('idx_broadcast_recipients_broadcast_status').on(
        table.organization_id,
        table.broadcast_id,
        table.status,
      ),
      // The contact key, her erasure and pause, her reply.
      index('idx_broadcast_recipients_contact').on(table.organization_id, table.contact_id),
      // The 90-day clean-up (WC-53, R50).
      index('idx_broadcast_recipients_created_at').on(table.created_at),
      check(
        'chk_broadcast_recipients_status',
        sql`${table.status} IN (${sqlLiteralList(BROADCAST_RECIPIENT_STATUSES)})`,
      ),
      check(
        'chk_broadcast_recipients_reason',
        sql`(${table.reason} IS NULL OR ${table.reason} ~ ${sqlLiteral(BROADCAST_RECIPIENT_REASON_PATTERN)})
          AND (${table.status} NOT IN (${sqlLiteralList(BROADCAST_RECIPIENT_STATUSES_WITH_REASON)}) OR ${table.reason} IS NOT NULL)
          AND (${table.status} NOT IN ('waiting', 'sent') OR ${table.reason} IS NULL)`,
      ),
      check(
        'chk_broadcast_recipients_sent_at',
        sql`(${table.status} = 'sent') = (${table.sent_at} IS NOT NULL)`,
      ),
      check(
        'chk_broadcast_recipients_version_number',
        sql`${table.version_number} IS NULL OR ${table.version_number} BETWEEN 1 AND ${sqlLiteral(BROADCAST_RECIPIENT_VERSION_MAX)}`,
      ),
      check('chk_broadcast_recipients_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('broadcast_recipients_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${organizationArm(table.organization_id)}
          OR ${maintenanceBypassArm('app.global_retention_cleanup')}`,
        withCheck: organizationArm(table.organization_id),
      }),
    ],
  )
  .enableRLS();
