import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
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
import { sqlLiteral, sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import {
  AUTOMATION_BACKFILL_FAIL_REASONS,
  AUTOMATION_BACKFILL_LAST_ERROR_MAX_LENGTH,
  AUTOMATION_BACKFILL_STATUSES,
  PAST_COMMENTS_MAX_DAYS,
  PAST_COMMENTS_MIN_DAYS,
} from './automation-backfill.constants.js';

/**
 * `app.automation_backfills` — one past-comments read of a live comment or ad-comment automation
 * (feat-instagram-dm-sending routes-final § 4.C.3, AU31–AU33, D69): the days back (1–7), its status,
 * its counters, why it failed, who asked and when.
 *
 * @remarks
 * - **One open per automation:** the partial unique `idx_automation_backfills_open` over
 *   `(organization_id, automation_id) WHERE status IN ('queued', 'reading')` — route 38's
 *   `409 automation_backfill_in_progress`; a new press after a `failed` one makes a new row.
 * - **Keys:** the automation composite `ON DELETE CASCADE` (the deleted-automation purge takes it
 *   along); the account composite `RESTRICT` (a copy — one read at a time per account, AU32);
 *   `requested_by_user_id` → users `SET NULL` (K6). Every key has a usable index (index hygiene).
 * - **Indexes for the read job (ROUTE row R41):** the 10-minute watch across organizations
 *   (`idx_automation_backfills_watch`) and the account's next queued read
 *   (`idx_automation_backfills_account_queued`).
 * - **RLS:** the organization arm, plus the retention sweep arm in `USING` bound to the maintenance
 *   role (the watch reads across organizations); `WITH CHECK` the organization only.
 */
export const automation_backfills = appSchema
  .table(
    'automation_backfills',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      /** The automation's account, copied at the start (one read at a time per account, AU32). */
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      automation_id: bigint('automation_id', { mode: 'number' }).notNull(),
      /** How many days back the read covers, 1–7. */
      days: smallint('days').notNull(),
      status: varchar('status', { length: 10 }).notNull().default('queued'),
      posts_read: integer('posts_read').notNull().default(0),
      found: integer('found').notNull().default(0),
      matched: integer('matched').notNull().default(0),
      queued_count: integer('queued_count').notNull().default(0),
      /** `meta_error` · `plan_feature_off`; set exactly when `failed`. */
      fail_reason: varchar('fail_reason', { length: 30 }),
      /** Codes only, never Meta's text — never returned (support reads it in the logs). */
      last_error: varchar('last_error', { length: AUTOMATION_BACKFILL_LAST_ERROR_MAX_LENGTH }),
      requested_by_user_id: bigint('requested_by_user_id', { mode: 'number' }).references(
        () => users.id,
        { onDelete: 'set null' },
      ),
      started_at: timestamp('started_at', { withTimezone: true }),
      done_at: timestamp('done_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      uniqueIndex('idx_automation_backfills_public_id').on(table.public_id),
      // One queued or reading read per automation (AU31).
      uniqueIndex('idx_automation_backfills_open')
        .on(table.organization_id, table.automation_id)
        .where(sql`${table.status} IN ('queued', 'reading')`),
      // The automation key's index (and an automation's reads, newest first).
      index('idx_automation_backfills_automation_created_at').on(
        table.organization_id,
        table.automation_id,
        table.created_at,
      ),
      // The account key's index.
      index('idx_automation_backfills_organization_id_channel_account_id').on(
        table.organization_id,
        table.channel_account_id,
      ),
      // The read's 10-minute watch across organizations (AU32, R41).
      index('idx_automation_backfills_watch')
        .on(table.status, table.updated_at)
        .where(sql`${table.status} IN ('queued', 'reading')`),
      // The next queued read of an account (AU32, R41).
      index('idx_automation_backfills_account_queued')
        .on(table.organization_id, table.channel_account_id, table.created_at)
        .where(sql`${table.status} = 'queued'`),
      index('idx_automation_backfills_requested_by_user_id')
        .on(table.requested_by_user_id)
        .where(sql`${table.requested_by_user_id} IS NOT NULL`),
      foreignKey({
        name: 'automation_backfills_automation_fk',
        columns: [table.organization_id, table.automation_id],
        foreignColumns: [automations.organization_id, automations.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'automation_backfills_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('restrict'),
      check(
        'chk_automation_backfills_days',
        sql`${table.days} BETWEEN ${sqlLiteral(PAST_COMMENTS_MIN_DAYS)} AND ${sqlLiteral(PAST_COMMENTS_MAX_DAYS)}`,
      ),
      check(
        'chk_automation_backfills_status',
        sql`${table.status} IN (${sqlLiteralList(AUTOMATION_BACKFILL_STATUSES)})`,
      ),
      check(
        'chk_automation_backfills_fail_reason',
        sql`(${table.status} = 'failed') = (${table.fail_reason} IS NOT NULL) AND (${table.fail_reason} IS NULL OR ${table.fail_reason} IN (${sqlLiteralList(AUTOMATION_BACKFILL_FAIL_REASONS)}))`,
      ),
      check(
        'chk_automation_backfills_counters',
        sql`${table.posts_read} >= 0 AND ${table.found} >= 0 AND ${table.matched} >= 0 AND ${table.queued_count} >= 0`,
      ),
      check('chk_automation_backfills_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('automation_backfills_tenant_isolation', {
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
