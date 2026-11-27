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
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteral, sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import { INSTAGRAM_OPAQUE_ID_MAX_LENGTH } from '@/shared/constants/instagram.constants.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import {
  INSTAGRAM_CONVERSATION_PREVIEW_MAX_CHARACTERS,
  INSTAGRAM_CONVERSATION_SENDER_TYPES,
  INSTAGRAM_CONVERSATION_STATES,
  INSTAGRAM_CONVERSATION_TAKEN_BY,
} from './instagram-conversation.constants.js';

/**
 * `app.instagram_conversations` — one conversation per contact (feat-instagram-inbox routes-final § 2.A.3,
 * CV1–CV4): its state, who holds it, the unread count, the newest message and the response times the
 * team inbox lists.
 *
 * @remarks
 * - **Keys:** one row per organization and contact — the lazy upsert's target (CV2); the contact link is
 *   the composite `(organization_id, contact_id)` → `app.contacts`, `ON DELETE CASCADE` (the erase,
 *   CV11); the account a copy for the list's filter, `ON DELETE RESTRICT` (an account is revoked, never
 *   deleted); the holder `(organization_id, taken_by_membership_id)` → `tenancy.memberships` (a
 *   membership is ended, never deleted — the service clears the holder when the member leaves). The unique `(organization_id, id)` index is the parent
 *   key of the conversation's messages and notes (2.B, 2.C).
 * - **Hand-off (CV4):** `taken_by` names who holds it — a member or the Instagram app — and the checks
 *   keep it in step with `taken_by_membership_id` and `taken_at`.
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only (K3).
 */
export const instagram_conversations = appSchema
  .table(
    'instagram_conversations',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      /** `igcv_…` (CV1). */
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      /** A copy of the contact's channel account — the list's account filter. */
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      contact_id: bigint('contact_id', { mode: 'number' }).notNull(),
      /** `open` · `waiting_on_us` · `waiting_on_contact` · `closed`. */
      state: varchar('state', { length: 20 }).notNull().default('open'),
      /** Who holds it (CV4): `team_member` · `instagram_app`; empty while nobody does. */
      taken_by: varchar('taken_by', { length: 20 }),
      taken_by_membership_id: bigint('taken_by_membership_id', { mode: 'number' }),
      taken_at: timestamp('taken_at', { withTimezone: true }),
      /** The newest `team_member` message — the 24-hour idle release reads it (CV4). */
      last_team_message_at: timestamp('last_team_message_at', { withTimezone: true }),
      snoozed_until: timestamp('snoozed_until', { withTimezone: true }),
      unread_count: integer('unread_count').notNull().default(0),
      last_read_at: timestamp('last_read_at', { withTimezone: true }),
      last_message_at: timestamp('last_message_at', { withTimezone: true }).notNull(),
      /** One of the conversation message sender types (I-D14). */
      last_message_sender_type: varchar('last_message_sender_type', { length: 20 }).notNull(),
      /** At most {@link INSTAGRAM_CONVERSATION_PREVIEW_MAX_CHARACTERS} characters; empty for a file. */
      last_message_preview: varchar('last_message_preview', {
        length: INSTAGRAM_CONVERSATION_PREVIEW_MAX_CHARACTERS,
      }),
      first_response_at: timestamp('first_response_at', { withTimezone: true }),
      last_response_at: timestamp('last_response_at', { withTimezone: true }),
      /** Meta's own conversation id once read — opaque, bounded (C-D16). */
      meta_conversation_id: varchar('meta_conversation_id', {
        length: INSTAGRAM_OPAQUE_ID_MAX_LENGTH,
      }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'instagram_conversations_contact_fk',
        columns: [table.organization_id, table.contact_id],
        foreignColumns: [contacts.organization_id, contacts.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'instagram_conversations_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('restrict'),
      foreignKey({
        name: 'instagram_conversations_taken_by_membership_fk',
        columns: [table.organization_id, table.taken_by_membership_id],
        foreignColumns: [memberships.organization_id, memberships.id],
      }),
      uniqueIndex('idx_instagram_conversations_public_id').on(table.public_id),
      // The parent key of the conversation's messages and notes.
      uniqueIndex('idx_instagram_conversations_organization_id_id').on(
        table.organization_id,
        table.id,
      ),
      // One conversation per contact: the lazy upsert's target (CV2).
      uniqueIndex('idx_instagram_conversations_organization_contact').on(
        table.organization_id,
        table.contact_id,
      ),
      // The inbox list's keyset: newest message first, then id.
      index('idx_instagram_conversations_list').on(
        table.organization_id,
        table.last_message_at.desc(),
        table.id.desc(),
      ),
      // The account key's index.
      index('idx_instagram_conversations_channel_account').on(
        table.organization_id,
        table.channel_account_id,
      ),
      index('idx_instagram_conversations_taken_by_membership')
        .on(table.organization_id, table.taken_by_membership_id)
        .where(sql`${table.taken_by_membership_id} IS NOT NULL`),
      index('idx_instagram_conversations_unread')
        .on(table.organization_id, table.last_message_at)
        .where(sql`${table.unread_count} > 0`),
      // The 24-hour idle release's sweep (CV4).
      index('idx_instagram_conversations_idle_release')
        .on(table.last_team_message_at)
        .where(sql`${table.taken_by} IS NOT NULL`),
      check(
        'chk_instagram_conversations_state',
        sql`${table.state} IN (${sqlLiteralList(INSTAGRAM_CONVERSATION_STATES)})`,
      ),
      check(
        'chk_instagram_conversations_taken_by',
        sql`${table.taken_by} IS NULL OR ${table.taken_by} IN (${sqlLiteralList(INSTAGRAM_CONVERSATION_TAKEN_BY)})`,
      ),
      // Nobody holds it → no member and no take time; the Instagram app never names a member.
      check(
        'chk_instagram_conversations_taken',
        sql`(${table.taken_by} IS NOT NULL OR (${table.taken_by_membership_id} IS NULL AND ${table.taken_at} IS NULL))
    AND (${table.taken_by} IS DISTINCT FROM 'instagram_app' OR ${table.taken_by_membership_id} IS NULL)`,
      ),
      check(
        'chk_instagram_conversations_sender_type',
        sql`${table.last_message_sender_type} IN (${sqlLiteralList(INSTAGRAM_CONVERSATION_SENDER_TYPES)})`,
      ),
      check('chk_instagram_conversations_unread_count', sql`${table.unread_count} >= 0`),
      check(
        'chk_instagram_conversations_preview',
        sql`${table.last_message_preview} IS NULL OR char_length(${table.last_message_preview}) <= ${sqlLiteral(INSTAGRAM_CONVERSATION_PREVIEW_MAX_CHARACTERS)}`,
      ),
      check('chk_instagram_conversations_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('instagram_conversations_tenant_isolation', {
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
