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
} from 'drizzle-orm/pg-core';
import { appSchema } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { automations } from './automation.schema.js';

/**
 * `app.automation_reply_states` — an automation's "Reply like a person" pacing (feat-instagram-dm-sending
 * routes-final § 4.A.3, AU19, D32): the hour box it counts in, the last reply line used and how
 * many public replies wait.
 *
 * @remarks
 * - **One per automation,** made at its first public reply; written by the channel's reply lane and
 *   result save (sub-domain 6, later rows) through `AutomationReplyStateService`; a reply-step change
 *   empties the box (route 30, AU12).
 * - **Keys:** unique `(organization_id, automation_id)` (the upsert target); the automation composite
 *   `ON DELETE CASCADE`; the account composite `RESTRICT` (a copy — the reply pick reads one
 *   account's rows, `idx_automation_reply_states_account`). The `id` exists for the RLS matrix.
 * - **RLS:** the organization arm only.
 */
export const automation_reply_states = appSchema
  .table(
    'automation_reply_states',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      automation_id: bigint('automation_id', { mode: 'number' }).notNull(),
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      box_start: timestamp('box_start', { withTimezone: true }),
      /** The plan's `last_text_no` (P6). */
      last_text_number: smallint('last_text_number'),
      waiting_count: integer('waiting_count').notNull().default(0),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      uniqueIndex('idx_automation_reply_states_automation').on(
        table.organization_id,
        table.automation_id,
      ),
      index('idx_automation_reply_states_account').on(
        table.organization_id,
        table.channel_account_id,
      ),
      foreignKey({
        name: 'automation_reply_states_automation_fk',
        columns: [table.organization_id, table.automation_id],
        foreignColumns: [automations.organization_id, automations.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'automation_reply_states_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('restrict'),
      check('chk_automation_reply_states_waiting_count', sql`${table.waiting_count} >= 0`),
      check('chk_automation_reply_states_last_text_number', sql`${table.last_text_number} >= 1`),
      pgPolicy('automation_reply_states_tenant_isolation', {
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
