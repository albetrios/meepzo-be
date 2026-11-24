import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgPolicy,
  smallint,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';

/**
 * `app.instagram_send_lanes` — one row per Instagram channel account and lane (feat-instagram-dm-sending
 * routes-final § 6.A.3, SN12, D4): `slow` (opening DMs), `reply` (public replies and hides), `fast`
 * (every other DM) and `broadcast`. Made in the pick's commit (MC7), never deleted while the account
 * lives.
 *
 * @remarks
 * - A lane holds its turn (`turn_number`, `working_turn`, `lease_until` — set exactly while
 *   `working`), its box and gap, the slow lane's day count and the account's one test claim, the
 *   fast lane's `sending_count`, and its **error stop** only (`stop_reason` — a stop group of SN5;
 *   `stop_until` empty = the owner must act). The owner's pause, the team's suspend and the plan stop
 *   are the channel account's (1B, CA3, P99) — a lane turn reads them; the lane carries no copy.
 * - The slow row also keeps the stored "will go / may expire" estimate the 10-minute job writes
 *   (`estimate_*`, S29 — ROUTE row R18 stores it here instead of a Redis copy, P305).
 * - Hot counter rows: the migration sets `fillfactor = 80` (HOT updates, plan §37.2).
 * - RLS: the organization policy, plus the retention sweep arm in `USING` only (the repair duties
 *   read lane ids across organizations, SN6).
 */
export const instagram_send_lanes = appSchema
  .table(
    'instagram_send_lanes',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /** `slow` · `reply` · `fast` · `broadcast`. */
      lane: varchar('lane', { length: 9 }).notNull(),
      /** `ready` · `working` · `sleeping` · `stopped` (fast: `ready`, `stopped`). */
      state: varchar('state', { length: 8 }).notNull().default('ready'),
      next_run_at: timestamp('next_run_at', { withTimezone: true }),
      /** Set exactly while `working`. */
      lease_until: timestamp('lease_until', { withTimezone: true }),
      box_start: timestamp('box_start', { withTimezone: true }),
      last_sent_at: timestamp('last_sent_at', { withTimezone: true }),
      half_speed_until: timestamp('half_speed_until', { withTimezone: true }),
      /** `box` · `gap` · `hour_limit` · `day_limit` · `not_before` · `stop` · `test`. */
      wait_reason: varchar('wait_reason', { length: 12 }),
      /** The lane's ticket count; a ticket names the turn it was made for. */
      turn_number: bigint('turn_number', { mode: 'number' }).notNull().default(0),
      /** The turn being worked; set exactly while `working`. */
      working_turn: bigint('working_turn', { mode: 'number' }),
      /** Slow only: the place 1–5 in the new : old mix. */
      pick_count: smallint('pick_count').notNull().default(0),
      /** Slow only, the day limit (off by default). */
      day_date: date('day_date', { mode: 'string' }),
      day_count: integer('day_count'),
      /** The current error stop group (SN5) or empty. */
      stop_reason: varchar('stop_reason', { length: 24 }),
      /** When the error stop ends; empty while stopped = the owner must act. */
      stop_until: timestamp('stop_until', { withTimezone: true }),
      /** How many stops of the current group in a row (the 15 → 360 minute ladder). */
      stop_count: smallint('stop_count').notNull().default(0),
      stop_error_code: integer('stop_error_code'),
      stop_error_subcode: integer('stop_error_subcode'),
      stop_cleared_at: timestamp('stop_cleared_at', { withTimezone: true }),
      /** Slow row only: the account's one test claim. */
      testing_lane: varchar('testing_lane', { length: 9 }),
      testing_until: timestamp('testing_until', { withTimezone: true }),
      /** Fast row only: messages on their way (≤ 20). */
      sending_count: smallint('sending_count').notNull().default(0),
      /** Slow row only: the stored waiting estimate (S29, WC-24). */
      estimate_waiting_count: integer('estimate_waiting_count'),
      estimate_will_go_count: integer('estimate_will_go_count'),
      estimate_may_expire_count: integer('estimate_may_expire_count'),
      estimate_done_at: timestamp('estimate_done_at', { withTimezone: true }),
      estimated_at: timestamp('estimated_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'instagram_send_lanes_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('cascade'),
      // Four rows per account, and the composite key's index.
      uniqueIndex('idx_instagram_send_lanes_account_lane').on(
        table.organization_id,
        table.channel_account_id,
        table.lane,
      ),
      // The repair's cross-organization reads (SN6): lanes due a turn, and leases running out.
      index('idx_instagram_send_lanes_next_run')
        .on(table.next_run_at)
        .where(sql`${table.state} IN ('ready', 'sleeping')`),
      index('idx_instagram_send_lanes_lease')
        .on(table.lease_until)
        .where(sql`${table.state} = 'working'`),
      check(
        'chk_instagram_send_lanes_lane',
        sql`${table.lane} IN ('slow', 'reply', 'fast', 'broadcast')`,
      ),
      check(
        'chk_instagram_send_lanes_state',
        sql`${table.state} IN ('ready', 'working', 'sleeping', 'stopped')
    AND (${table.lane} <> 'fast' OR ${table.state} IN ('ready', 'stopped'))`,
      ),
      check(
        'chk_instagram_send_lanes_working',
        sql`(${table.state} = 'working') = (${table.lease_until} IS NOT NULL)
    AND (${table.state} = 'working') = (${table.working_turn} IS NOT NULL)`,
      ),
      check(
        'chk_instagram_send_lanes_wait_reason',
        sql`${table.wait_reason} IS NULL OR ${table.wait_reason} IN ('box', 'gap', 'hour_limit', 'day_limit', 'not_before', 'stop', 'test')`,
      ),
      check(
        'chk_instagram_send_lanes_turn',
        sql`${table.turn_number} >= 0 AND (${table.working_turn} IS NULL OR ${table.working_turn} BETWEEN 0 AND ${table.turn_number})`,
      ),
      check(
        'chk_instagram_send_lanes_pick_count',
        sql`${table.pick_count} BETWEEN 0 AND 5 AND (${table.lane} = 'slow' OR ${table.pick_count} = 0)`,
      ),
      check(
        'chk_instagram_send_lanes_day',
        sql`(${table.day_date} IS NULL) = (${table.day_count} IS NULL)
    AND (${table.day_count} IS NULL OR (${table.lane} = 'slow' AND ${table.day_count} >= 0))`,
      ),
      check(
        'chk_instagram_send_lanes_stop',
        sql`(${table.stop_reason} IS NULL OR ${table.stop_reason} IN ('too_fast', 'instagram_down', 'access_off', 'app_not_approved', 'account_flagged', 'blocked', 'wrong_permission', 'account_not_shared', 'login_expired'))
    AND (${table.stop_reason} IS NOT NULL OR (${table.stop_until} IS NULL AND ${table.stop_error_code} IS NULL AND ${table.stop_error_subcode} IS NULL))
    AND ${table.stop_count} >= 0`,
      ),
      check(
        'chk_instagram_send_lanes_testing',
        sql`(${table.testing_lane} IS NULL) = (${table.testing_until} IS NULL)
    AND (${table.testing_lane} IS NULL OR (${table.lane} = 'slow' AND ${table.testing_lane} IN ('slow', 'reply', 'fast', 'broadcast')))`,
      ),
      check(
        'chk_instagram_send_lanes_sending_count',
        sql`${table.sending_count} BETWEEN 0 AND 20 AND (${table.lane} = 'fast' OR ${table.sending_count} = 0)`,
      ),
      check(
        'chk_instagram_send_lanes_estimate',
        sql`(${table.estimated_at} IS NULL OR ${table.lane} = 'slow')
    AND (${table.estimated_at} IS NOT NULL OR (${table.estimate_waiting_count} IS NULL AND ${table.estimate_will_go_count} IS NULL AND ${table.estimate_may_expire_count} IS NULL AND ${table.estimate_done_at} IS NULL))
    AND (${table.estimate_waiting_count} IS NULL OR ${table.estimate_waiting_count} >= 0)
    AND (${table.estimate_will_go_count} IS NULL OR ${table.estimate_will_go_count} >= 0)
    AND (${table.estimate_may_expire_count} IS NULL OR ${table.estimate_may_expire_count} >= 0)`,
      ),
      check('chk_instagram_send_lanes_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('instagram_send_lanes_tenant_isolation', {
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
