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
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteral, sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { CONTACT_TAG_MAX_LENGTH } from '@/domains/app/sub-domains/contact/contact.constants.js';
import {
  CONTACT_TAG_EVENT_KINDS,
  CONTACT_TAG_EVENT_SOURCES,
  type ContactTagEventKind,
  type ContactTagEventSource,
} from './contact-tag-event.constants.js';

/**
 * `app.contact_tag_events` — one tag added to or removed from one contact (routes-final § 3.B.3,
 * CT16, D45): written in the same commit as the tag change, so a tag start is never lost.
 *
 * @remarks
 * - **Writers:** the contact service's tag commits only, through {@link ContactTagEventRecorder}
 *   (routes 20 and 21 — `source` `owner`; the tag step — `source` `automation`); intake (sub-domain
 *   5) sets `done_at`, the hand-over `queued_at`. Append-only otherwise.
 * - **Keys:** `(organization_id, contact_id)` → contacts `CASCADE` (an erased contact's events are
 *   deleted by the erase step — the row is erased in place, never deleted); the account is a copy
 *   of the contact's (`RESTRICT`). `source_automation_id`'s key into `app.automations`
 *   (`ON DELETE SET NULL (source_automation_id)`) is added by the automations migration, as
 *   `contacts.first_automation_id`'s is (sub-domain 4 builds after contacts — § 3.3).
 * - **No public id:** never returned; its `id` is part of a tag start's once key
 *   (`tag:<tag>:<event id>`).
 * - **Lifecycle:** kept 8 days, then deleted in batches by the small-table clean-up (P33 — a
 *   plain table, not split).
 * - **RLS:** the organization arm, plus the maintenance arm for the pick-up scan and the clean-up
 *   across organizations; `WITH CHECK` the organization only.
 *
 * {@link ContactTagEventRecorder}: `@/domains/app/sub-domains/contact/contact.types.js`.
 */
export const contact_tag_events = appSchema
  .table(
    'contact_tag_events',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      /** A copy of the contact's channel account. */
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      contact_id: bigint('contact_id', { mode: 'number' }).notNull(),
      tag: varchar('tag', { length: CONTACT_TAG_MAX_LENGTH }).notNull(),
      kind: varchar('kind', { length: 10 }).$type<ContactTagEventKind>().notNull(),
      source: varchar('source', { length: 12 }).$type<ContactTagEventSource>().notNull(),
      /** The automation whose tag step changed the tag; `null` for the owner (or once it is purged). */
      source_automation_id: bigint('source_automation_id', { mode: 'number' }),
      /** How many tag starts led to this change; intake starts nothing at 3 or more (the loop guard). */
      chain_number: smallint('chain_number').notNull().default(0),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      /** When the event was handed to intake (WC-4); the pick-up (WC-27) hands it over again. */
      queued_at: timestamp('queued_at', { withTimezone: true }),
      /** When intake finished it. */
      done_at: timestamp('done_at', { withTimezone: true }),
    },
    (table) => [
      foreignKey({
        name: 'contact_tag_events_contact_fk',
        columns: [table.organization_id, table.contact_id],
        foreignColumns: [contacts.organization_id, contacts.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'contact_tag_events_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('restrict'),
      // The erase step and the contact key; intake's pass over one contact's undone events.
      index('idx_contact_tag_events_contact').on(table.organization_id, table.contact_id),
      // The account key's index (index hygiene: every key's delete action has one to use).
      index('idx_contact_tag_events_channel_account').on(
        table.organization_id,
        table.channel_account_id,
      ),
      // The pick-up scan (WC-27): undone events by age, across organizations.
      index('idx_contact_tag_events_pickup')
        .on(table.created_at)
        .where(sql`${table.done_at} IS NULL`),
      // The 8-day clean-up (WC-54).
      index('idx_contact_tag_events_created').on(table.created_at),
      // The automation key (added by the automations migration).
      index('idx_contact_tag_events_source_automation')
        .on(table.organization_id, table.source_automation_id)
        .where(sql`${table.source_automation_id} IS NOT NULL`),
      check(
        'chk_contact_tag_events_kind',
        sql`${table.kind} IN (${sqlLiteralList(CONTACT_TAG_EVENT_KINDS)})`,
      ),
      check(
        'chk_contact_tag_events_source',
        sql`${table.source} IN (${sqlLiteralList(CONTACT_TAG_EVENT_SOURCES)})`,
      ),
      check(
        'chk_contact_tag_events_source_automation',
        sql`${table.source_automation_id} IS NULL OR ${table.source} = 'automation'`,
      ),
      check('chk_contact_tag_events_chain_number', sql`${table.chain_number} >= 0`),
      check(
        'chk_contact_tag_events_tag',
        sql`char_length(${table.tag}) BETWEEN 1 AND ${sqlLiteral(CONTACT_TAG_MAX_LENGTH)} AND ${table.tag} = btrim(${table.tag}) AND strpos(${table.tag}, ',') = 0`,
      ),
      pgPolicy('contact_tag_events_tenant_isolation', {
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
