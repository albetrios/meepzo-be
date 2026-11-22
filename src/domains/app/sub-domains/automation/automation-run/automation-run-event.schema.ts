import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  pgPolicy,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { AUTOMATION_RUN_EVENT_TYPES, AUTOMATION_RUN_STATUSES } from './automation-run.constants.js';
import { automation_runs } from './automation-run.schema.js';

/**
 * `app.automation_run_events` — a run's history (routes-final § 3.B.3, AU23): one row per status
 * change and per email or phone collected, written in the same short transaction as the run
 * change.
 *
 * @remarks
 * - **Append-only:** no public id, no `updated_at`; the repository only inserts. The time column is
 *   `created_at` (the drop's `occurred_at`).
 * - **Keys:** composite `(organization_id, automation_run_id)` → `app.automation_runs`,
 *   `ON DELETE CASCADE` — the events go with their run (run retention, D8).
 * - **Personal data:** none — an `email_received` / `phone_received` row records that a value came,
 *   never the value (it lives on the contact).
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only (a run's cascade
 *   under the retention context deletes its events).
 */
export const automation_run_events = appSchema
  .table(
    'automation_run_events',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      automation_run_id: bigint('automation_run_id', { mode: 'number' }).notNull(),
      event_type: varchar('event_type', { length: 20 }).notNull(),
      /** The run's new status; set exactly for `status_changed`. */
      status: varchar('status', { length: 10 }),
      /** When it happened (AU23). */
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'automation_run_events_automation_run_fk',
        columns: [table.organization_id, table.automation_run_id],
        foreignColumns: [automation_runs.organization_id, automation_runs.id],
      }).onDelete('cascade'),
      // The run reference and a run's history, oldest first.
      index('idx_automation_run_events_automation_run').on(
        table.organization_id,
        table.automation_run_id,
        table.created_at,
      ),
      check(
        'chk_automation_run_events_event_type',
        sql`${table.event_type} IN (${sqlLiteralList(AUTOMATION_RUN_EVENT_TYPES)})`,
      ),
      check(
        'chk_automation_run_events_status',
        sql`${table.status} IN (${sqlLiteralList(AUTOMATION_RUN_STATUSES)})
          AND (${table.event_type} = 'status_changed') = (${table.status} IS NOT NULL)`,
      ),
      pgPolicy('automation_run_events_tenant_isolation', {
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
