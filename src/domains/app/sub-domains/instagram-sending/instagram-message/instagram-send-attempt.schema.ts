import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  pgPolicy,
  primaryKey,
  smallint,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { INSTAGRAM_SEND_LANES } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import {
  INSTAGRAM_SEND_ATTEMPT_COUNT_GROUPS,
  INSTAGRAM_SEND_ATTEMPT_RESULT_GROUP_MAX_LENGTH,
} from './instagram-message.constants.js';

/**
 * `app.instagram_send_attempts` — one call to Meta for a message (feat-instagram-dm-sending
 * routes-final § 6.B.3, SN19; plan §19.2): written in the claim's commit (`started_at`, lane, count
 * group), finished by the result save (`result_group`, HTTP status, codes, duration). The source of
 * "in a row", "30 % bad" and the outage check (SN5).
 *
 * @remarks
 * - **Split by the UTC day of `started_at`**, kept 8 days (P33, D16): parts made by
 *   `app.fn_create_daily_partitions`, dropped by the shared upkeep (ROUTE row R49). Primary key
 *   `(id, started_at)`.
 * - **Copies without a reference:** the account, our message (`instagram_message_id` is
 *   `app.instagram_messages.id`, not Meta's id), the automation and the contact.
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only.
 */
export const instagram_send_attempts = appSchema
  .table(
    'instagram_send_attempts',
    {
      id: bigserial('id', { mode: 'number' }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /** Our message's internal id (a copy, no reference) — the plan's `message_id`. */
      instagram_message_id: bigint('instagram_message_id', { mode: 'number' }).notNull(),
      /** A copy; empty for a broadcast. */
      automation_id: bigint('automation_id', { mode: 'number' }),
      contact_id: bigint('contact_id', { mode: 'number' }).notNull(),
      lane: varchar('lane', { length: 9 }).notNull(),
      count_group: varchar('count_group', { length: 9 }).notNull(),
      /** The day split key. */
      started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
      /** `sent` or a group of 6.A.10; empty while the call runs. */
      result_group: varchar('result_group', {
        length: INSTAGRAM_SEND_ATTEMPT_RESULT_GROUP_MAX_LENGTH,
      }),
      http_status: smallint('http_status'),
      error_code: integer('error_code'),
      error_subcode: integer('error_subcode'),
      duration_milliseconds: integer('duration_milliseconds'),
    },
    (table) => [
      primaryKey({ name: 'instagram_send_attempts_pkey', columns: [table.id, table.started_at] }),
      index('idx_instagram_send_attempts_account').on(
        table.channel_account_id,
        table.started_at.desc(),
      ),
      index('idx_instagram_send_attempts_automation').on(
        table.organization_id,
        table.automation_id,
        table.started_at.desc(),
      ),
      index('idx_instagram_send_attempts_started').on(table.started_at),
      check(
        'chk_instagram_send_attempts_lane',
        sql`${table.lane} IN (${sqlLiteralList(INSTAGRAM_SEND_LANES)})`,
      ),
      check(
        'chk_instagram_send_attempts_count_group',
        sql`${table.count_group} IN (${sqlLiteralList(INSTAGRAM_SEND_ATTEMPT_COUNT_GROUPS)})`,
      ),
      check(
        'chk_instagram_send_attempts_result_group',
        sql`${table.result_group} ~ '^[a-z_]{1,20}$'`,
      ),
      check(
        'chk_instagram_send_attempts_http_status',
        sql`${table.http_status} BETWEEN 100 AND 599`,
      ),
      check('chk_instagram_send_attempts_duration', sql`${table.duration_milliseconds} >= 0`),
      check(
        'chk_instagram_send_attempts_finished',
        sql`${table.duration_milliseconds} IS NULL OR ${table.result_group} IS NOT NULL`,
      ),
      check(
        'chk_instagram_send_attempts_error',
        sql`${table.error_subcode} IS NULL OR ${table.error_code} IS NOT NULL`,
      ),
      pgPolicy('instagram_send_attempts_tenant_isolation', {
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
