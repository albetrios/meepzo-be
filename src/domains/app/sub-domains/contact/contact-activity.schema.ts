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
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { appSchema } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { contacts } from './contact.schema.js';

/**
 * `app.contact_activities` — a live contact's fast-changing times and counts, 1:1 with
 * `app.contacts` (scale review S5, P97; routes-final § 3 CT3).
 *
 * @remarks
 * - **Why:** every inbound event moves her message times; on `app.contacts` that rewrote a row with
 *   ~13 indexes, two of them GIN. Here the row is narrow, `fillfactor` 70, with three indexes — the
 *   list's "last message" sort, a broadcast's "chat open" and a segment's "commented in the last N
 *   days" — so most updates are HOT-eligible or cheap.
 * - **Keys:** unique on `(organization_id, contact_id)` (the upsert target, backing the contact key); `(organization_id, contact_id)` → contacts `CASCADE`;
 *   `channel_account_id` is a copy of the contact's (`RESTRICT`), so the sort index reads one account.
 * - **Lifecycle:** inserted with the contact (the first event), deleted by the erase (CT11) — so an
 *   inner join with it reads live contacts only. No public id and no timestamps of its own: never
 *   returned alone, never edited by a person.
 * - **Writers:** the contact service only (3.A.10).
 * - **RLS:** the organization arm only.
 */
export const contact_activities = appSchema
  .table(
    'contact_activities',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      contact_id: bigint('contact_id', { mode: 'number' }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      /** A copy of the contact's channel account. */
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /** Her newest event of any kind ("last active"); never null — a contact is born from one. */
      last_message_received_at: timestamp('last_message_received_at', {
        withTimezone: true,
      }).notNull(),
      /** Her newest DM, story reply or tap — the 24-hour chat window; a comment never sets it. */
      last_direct_message_received_at: timestamp('last_direct_message_received_at', {
        withTimezone: true,
      }),
      /** Our newest DM to her. */
      last_message_sent_at: timestamp('last_message_sent_at', { withTimezone: true }),
      /** Our newest opening DM `sent` or `unknown` — the private-reply rule (D8). */
      last_opening_message_at: timestamp('last_opening_message_at', { withTimezone: true }),
      /** Her first DM in the chat; set once. */
      first_message_at: timestamp('first_message_at', { withTimezone: true }),
      last_comment_at: timestamp('last_comment_at', { withTimezone: true }),
      comment_count: integer('comment_count').notNull().default(0),
      /** Her newest story reply or mention. */
      last_story_activity_at: timestamp('last_story_activity_at', { withTimezone: true }),
      /** Our newest broadcast message `sent` to her (D68). */
      last_broadcast_at: timestamp('last_broadcast_at', { withTimezone: true }),
    },
    (table) => [
      foreignKey({
        name: 'contact_activities_contact_fk',
        columns: [table.organization_id, table.contact_id],
        foreignColumns: [contacts.organization_id, contacts.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'contact_activities_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('restrict'),
      // One activity row per contact: the upsert target.
      uniqueIndex('idx_contact_activities_organization_contact').on(
        table.organization_id,
        table.contact_id,
      ),
      index('idx_contact_activities_account_last_message_received_at').on(
        table.organization_id,
        table.channel_account_id,
        table.last_message_received_at,
        table.contact_id,
      ),
      index('idx_contact_activities_chat_open')
        .on(table.organization_id, table.channel_account_id, table.last_direct_message_received_at)
        .where(sql`${table.last_direct_message_received_at} IS NOT NULL`),
      index('idx_contact_activities_last_comment')
        .on(table.organization_id, table.channel_account_id, table.last_comment_at)
        .where(sql`${table.last_comment_at} IS NOT NULL`),
      check('chk_contact_activities_comment_count', sql`${table.comment_count} >= 0`),
      pgPolicy('contact_activities_tenant_isolation', {
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
