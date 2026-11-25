import { sql } from 'drizzle-orm';
import { bigint, foreignKey, index, pgPolicy, primaryKey, timestamp } from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { automation_runs } from './automation-run.schema.js';

/**
 * `app.automation_run_open_keys` — the open run of each automation and person (feat-instagram-dm-sending
 * routes-final § 4.B.3, AU37, P100): the rule "one open run per automation and person" now that runs
 * are split by month (a unique index on a split table holds only inside one part).
 *
 * @remarks
 * - **Primary key** `(organization_id, automation_id, contact_id)`: the new run and its key are
 *   written in one commit — the key's insert is the guard (a second start meets the conflict and is
 *   `ignored` · `run_in_progress`, or replaces per P35); the key is deleted in the commit that ends
 *   the run. A repair duty (`repair-open-run-keys`, WC-67 — scheduled by ROUTE row R47) removes keys
 *   whose run has ended.
 * - **Keys:** the automation composite `ON DELETE CASCADE`, the contact composite `RESTRICT`
 *   (contacts are erased in place), the run `(organization_id, automation_run_id,
 *   automation_run_started_at)` → `app.automation_runs` `ON DELETE CASCADE` (the open run and its
 *   month). Plain, not split; no public id, no `updated_at`.
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only — the repair's
 *   cross-organization read.
 */
export const automation_run_open_keys = appSchema
  .table(
    'automation_run_open_keys',
    {
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      automation_id: bigint('automation_id', { mode: 'number' }).notNull(),
      contact_id: bigint('contact_id', { mode: 'number' }).notNull(),
      automation_run_id: bigint('automation_run_id', { mode: 'number' }).notNull(),
      /** The open run's start — its month part. */
      automation_run_started_at: timestamp('automation_run_started_at', {
        withTimezone: true,
      }).notNull(),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      primaryKey({
        name: 'automation_run_open_keys_pkey',
        columns: [table.organization_id, table.automation_id, table.contact_id],
      }),
      foreignKey({
        name: 'automation_run_open_keys_automation_fk',
        columns: [table.organization_id, table.automation_id],
        foreignColumns: [automations.organization_id, automations.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'automation_run_open_keys_contact_fk',
        columns: [table.organization_id, table.contact_id],
        foreignColumns: [contacts.organization_id, contacts.id],
      }).onDelete('restrict'),
      foreignKey({
        name: 'automation_run_open_keys_automation_run_fk',
        columns: [table.organization_id, table.automation_run_id, table.automation_run_started_at],
        foreignColumns: [
          automation_runs.organization_id,
          automation_runs.id,
          automation_runs.started_at,
        ],
      }).onDelete('cascade'),
      // The run reference and the end-of-run delete.
      index('idx_automation_run_open_keys_automation_run').on(
        table.organization_id,
        table.automation_run_id,
        table.automation_run_started_at,
      ),
      // The contact reference and her open runs (the lock order, the erase).
      index('idx_automation_run_open_keys_contact').on(table.organization_id, table.contact_id),
      pgPolicy('automation_run_open_keys_tenant_isolation', {
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
