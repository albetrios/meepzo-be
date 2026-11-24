import { sql } from 'drizzle-orm';
import { check, pgPolicy, smallint, timestamp, varchar } from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';

/**
 * `app.sending_states` — one row for the whole system (feat-instagram-dm-sending routes-final
 * § 6.A.3, SN7, D20, D21, P43 — shared by every channel): the environment id the running servers
 * must match (a restored or copied database never sends, D20), the newest settings version that
 * started and the minimum compatible one (P95), the all-accounts stop and its test, and Meta's
 * app-level usage (S13, P97 — the one reading every customer shares).
 *
 * @remarks
 * - `id` is always 1. `prepareDatabase` creates the row with the server's `SENDING_ENVIRONMENT_ID`
 *   only when it is missing — never overwritten — and each release writes its settings version.
 * - **No organization** (P16): a documented RLS exemption — enabled and forced with one policy whose
 *   `USING` and `WITH CHECK` are the `app.sending_state_access` maintenance arm, so it is readable and
 *   writable only under `MAINTENANCE_SCOPE.SENDING_STATE` on the maintenance login (the
 *   `audit.outbox` pattern). No grant to `meepzo_be_app`.
 */
export const sending_states = appSchema
  .table(
    'sending_states',
    {
      id: smallint('id').primaryKey(),
      /** Must equal the servers' `SENDING_ENVIRONMENT_ID` (D20). */
      environment_id: varchar('environment_id', { length: 64 }).notNull(),
      /** The newest settings version that started (D21) — a whole number as text. */
      settings_version: varchar('settings_version', { length: 32 }).notNull(),
      settings_version_since: timestamp('settings_version_since', { withTimezone: true })
        .notNull()
        .defaultNow(),
      /** A server older than this takes no tickets (P95); raised only by an incompatible release. */
      minimum_compatible_settings_version: varchar('minimum_compatible_settings_version', {
        length: 32,
      }).notNull(),
      /** The all-accounts stop (`app_limit` · `instagram_down`, WC-22). */
      all_stop_until: timestamp('all_stop_until', { withTimezone: true }),
      all_stop_reason: varchar('all_stop_reason', { length: 14 }),
      all_stop_count: smallint('all_stop_count').notNull().default(0),
      /** The one test for all accounts after an all-accounts stop. */
      testing_lane: varchar('testing_lane', { length: 9 }),
      testing_until: timestamp('testing_until', { withTimezone: true }),
      /** Meta's app-level usage (`X-App-Usage`, S13): the newer reading wins. */
      app_usage_percent: smallint('app_usage_percent'),
      app_usage_read_at: timestamp('app_usage_read_at', { withTimezone: true }),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      check('chk_sending_states_single_row', sql`${table.id} = 1`),
      check('chk_sending_states_environment_id', sql`length(${table.environment_id}) > 0`),
      check(
        'chk_sending_states_settings_versions',
        sql`${table.settings_version} ~ '^[0-9]{1,32}$' AND ${table.minimum_compatible_settings_version} ~ '^[0-9]{1,32}$'`,
      ),
      check(
        'chk_sending_states_all_stop',
        sql`(${table.all_stop_reason} IS NULL OR ${table.all_stop_reason} IN ('app_limit', 'instagram_down'))
    AND (${table.all_stop_reason} IS NOT NULL OR ${table.all_stop_until} IS NULL)
    AND ${table.all_stop_count} >= 0`,
      ),
      check(
        'chk_sending_states_testing',
        sql`(${table.testing_lane} IS NULL) = (${table.testing_until} IS NULL)
    AND (${table.testing_lane} IS NULL OR ${table.testing_lane} IN ('slow', 'reply', 'fast', 'broadcast'))`,
      ),
      check(
        'chk_sending_states_app_usage',
        sql`(${table.app_usage_percent} IS NULL) = (${table.app_usage_read_at} IS NULL)
    AND (${table.app_usage_percent} IS NULL OR ${table.app_usage_percent} BETWEEN 0 AND 100)`,
      ),
      pgPolicy('sending_states_maintenance_access', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${maintenanceBypassArm('app.sending_state_access')}`,
        withCheck: sql`${maintenanceBypassArm('app.sending_state_access')}`,
      }),
    ],
  )
  .enableRLS();
