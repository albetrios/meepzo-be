import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  pgPolicy,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteral } from '@/infrastructure/database/utils/sql-literal.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { instagram_conversations } from '@/domains/app/sub-domains/instagram-conversation/instagram-conversation.schema.js';
import { INSTAGRAM_CONVERSATION_NOTE_TEXT_MAX_CHARACTERS } from './instagram-conversation-note.constants.js';

/**
 * `app.instagram_conversation_notes` — the team's internal notes on a conversation (feat-instagram-inbox
 * routes-final § 2.C.3, CV3): never sent, never shown to the contact.
 *
 * @remarks
 * - **Keys:** the conversation `(organization_id, instagram_conversation_id)` CASCADE (the erase removes the
 *   conversation, its notes go with it); the author `(organization_id, author_membership_id)` →
 *   `tenancy.memberships`, kept as history when the member leaves (a membership is ended, never deleted).
 * - **Soft delete:** `deleted_at`; the list reads live notes only.
 * - **RLS:** the organization policy only — nothing reads notes across organizations.
 */
export const instagram_conversation_notes = appSchema
  .table(
    'instagram_conversation_notes',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      /** `igcn_…` (CV1). */
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      instagram_conversation_id: bigint('instagram_conversation_id', { mode: 'number' }).notNull(),
      author_membership_id: bigint('author_membership_id', { mode: 'number' }).notNull(),
      /** 1 to {@link INSTAGRAM_CONVERSATION_NOTE_TEXT_MAX_CHARACTERS} characters. */
      text: varchar('text', { length: INSTAGRAM_CONVERSATION_NOTE_TEXT_MAX_CHARACTERS }).notNull(),
      deleted_at: timestamp('deleted_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'instagram_conversation_notes_conversation_fk',
        columns: [table.organization_id, table.instagram_conversation_id],
        foreignColumns: [instagram_conversations.organization_id, instagram_conversations.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'instagram_conversation_notes_author_membership_fk',
        columns: [table.organization_id, table.author_membership_id],
        foreignColumns: [memberships.organization_id, memberships.id],
      }),
      uniqueIndex('idx_instagram_conversation_notes_public_id').on(table.public_id),
      // The conversation's notes, newest first (2.C.3), and the conversation key's index.
      index('idx_instagram_conversation_notes_list')
        .on(table.instagram_conversation_id, table.created_at.desc(), table.id.desc())
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_instagram_conversation_notes_conversation').on(
        table.organization_id,
        table.instagram_conversation_id,
      ),
      // The author key's index.
      index('idx_instagram_conversation_notes_author_membership').on(
        table.organization_id,
        table.author_membership_id,
      ),
      check(
        'chk_instagram_conversation_notes_text',
        sql`char_length(${table.text}) BETWEEN 1 AND ${sqlLiteral(INSTAGRAM_CONVERSATION_NOTE_TEXT_MAX_CHARACTERS)}`,
      ),
      check(
        'chk_instagram_conversation_notes_updated',
        sql`${table.updated_at} >= ${table.created_at}`,
      ),
      pgPolicy('instagram_conversation_notes_tenant_isolation', {
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
