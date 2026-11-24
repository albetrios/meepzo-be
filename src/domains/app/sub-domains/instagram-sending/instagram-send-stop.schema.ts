import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';

/**
 * `app.instagram_send_stops` — the history of every stop of an account's lane, or of all its lanes
 * (feat-instagram-dm-sending routes-final § 6.A.3, SN13): the lane (`all` for a plan stop or an
 * account-wide one), the reason (a stop group of SN5, or a plan stop of CA3), Meta's codes, when it
 * started, its planned end, and when and by what it ended (`time` · `test` · `owner` · `team`).
 *
 * @remarks
 * - Written in the commit that starts the stop; its end sets `ended_at` and `ended_by` together.
 *   Route 63 shows each lane's current stop from the lane row; this history serves the team and the
 *   "stop over 1 hour" email (WC-57).
 * - A plain table, deleted after 90 days by the hourly, time-budgeted clean-up (WC-53, P92).
 * - RLS: the organization policy, plus the retention sweep arm in `USING` only (the clean-up).
 */
export const instagram_send_stops = appSchema
  .table(
    'instagram_send_stops',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /** `slow` · `reply` · `fast` · `broadcast` · `all`. */
      lane: varchar('lane', { length: 9 }).notNull(),
      /** A stop group (SN5) or a plan stop (`plan_limit` · `plan_ended` · `plan_downgrade`). */
      reason: varchar('reason', { length: 24 }).notNull(),
      error_code: integer('error_code'),
      error_subcode: integer('error_subcode'),
      started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
      /** The planned end; empty = until the owner acts. */
      stop_until: timestamp('stop_until', { withTimezone: true }),
      ended_at: timestamp('ended_at', { withTimezone: true }),
      /** `time` · `test` · `owner` · `team` — set exactly with `ended_at`. */
      ended_by: varchar('ended_by', { length: 5 }),
    },
    (table) => [
      foreignKey({
        name: 'instagram_send_stops_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('cascade'),
      // An account's history, newest first — and the composite key's index.
      index('idx_instagram_send_stops_account_started').on(
        table.organization_id,
        table.channel_account_id,
        table.started_at.desc(),
      ),
      // The 90-day delete (WC-53).
      index('idx_instagram_send_stops_started').on(table.started_at),
      check(
        'chk_instagram_send_stops_lane',
        sql`${table.lane} IN ('slow', 'reply', 'fast', 'broadcast', 'all')`,
      ),
      check(
        'chk_instagram_send_stops_reason',
        sql`${table.reason} IN ('too_fast', 'instagram_down', 'access_off', 'app_not_approved', 'account_flagged', 'blocked', 'wrong_permission', 'account_not_shared', 'login_expired', 'plan_limit', 'plan_ended', 'plan_downgrade')`,
      ),
      check(
        'chk_instagram_send_stops_ended',
        sql`(${table.ended_at} IS NULL) = (${table.ended_by} IS NULL)
    AND (${table.ended_by} IS NULL OR ${table.ended_by} IN ('time', 'test', 'owner', 'team'))
    AND (${table.ended_at} IS NULL OR ${table.ended_at} >= ${table.started_at})`,
      ),
      pgPolicy('instagram_send_stops_tenant_isolation', {
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
