import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  jsonb,
  pgPolicy,
  smallint,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { appSchema } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteral } from '@/infrastructure/database/utils/sql-literal.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { AUTOMATION_COUNT_SLOTS } from './automation.constants.js';
import { automations } from './automation.schema.js';

/** A flat object of counts per step version (`{ "hello.1": 650 }`, AU19). */
export type AutomationCountsByVersion = Record<string, number>;

/**
 * `app.automation_counts` — an automation's all-time counters in 16 slot rows (feat-instagram-dm-sending
 * routes-final § 4.A.3, AU19, D36, D61): runs started, hello taps and typed answers, in total and per
 * step version.
 *
 * @remarks
 * - **Slots:** slot = the run's id mod `AUTOMATION_COUNT_SLOTS` (16), so a busy automation spreads
 *   its `+1`s over 16 rows; the list and the read sum them (at most 400 small rows for a page of 25).
 * - **Written in the event's commit** with `INSERT … ON CONFLICT DO UPDATE` on the unique
 *   `(organization_id, automation_id, slot)`, last in the lock order (the run engine — ROUTE row R14 —
 *   writes through `AutomationCountService`). They survive the 90-day run delete.
 * - **Keys:** the automation composite `ON DELETE CASCADE` (the purge takes them along). The `id`
 *   exists for the RLS matrix and is never returned (the plan's key is the unique index).
 * - **RLS:** the organization arm only.
 */
export const automation_counts = appSchema
  .table(
    'automation_counts',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      automation_id: bigint('automation_id', { mode: 'number' }).notNull(),
      slot: smallint('slot').notNull(),
      runs_started: bigint('runs_started', { mode: 'number' }).notNull().default(0),
      taps: bigint('taps', { mode: 'number' }).notNull().default(0),
      typed_answers: bigint('typed_answers', { mode: 'number' }).notNull().default(0),
      runs_by_version: jsonb('runs_by_version')
        .$type<AutomationCountsByVersion>()
        .notNull()
        .default({}),
      taps_by_version: jsonb('taps_by_version')
        .$type<AutomationCountsByVersion>()
        .notNull()
        .default({}),
      typed_by_version: jsonb('typed_by_version')
        .$type<AutomationCountsByVersion>()
        .notNull()
        .default({}),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      // One row per automation and slot: the upsert target and the automation key's index.
      uniqueIndex('idx_automation_counts_automation_slot').on(
        table.organization_id,
        table.automation_id,
        table.slot,
      ),
      foreignKey({
        name: 'automation_counts_automation_fk',
        columns: [table.organization_id, table.automation_id],
        foreignColumns: [automations.organization_id, automations.id],
      }).onDelete('cascade'),
      check(
        'chk_automation_counts_slot',
        sql`${table.slot} BETWEEN 0 AND ${sqlLiteral(AUTOMATION_COUNT_SLOTS - 1)}`,
      ),
      check(
        'chk_automation_counts_values',
        sql`${table.runs_started} >= 0 AND ${table.taps} >= 0 AND ${table.typed_answers} >= 0`,
      ),
      check(
        'chk_automation_counts_by_version',
        sql`jsonb_typeof(${table.runs_by_version}) = 'object' AND jsonb_typeof(${table.taps_by_version}) = 'object' AND jsonb_typeof(${table.typed_by_version}) = 'object'`,
      ),
      pgPolicy('automation_counts_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )`,
        withCheck: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )`,
      }),
    ],
  )
  .enableRLS();
