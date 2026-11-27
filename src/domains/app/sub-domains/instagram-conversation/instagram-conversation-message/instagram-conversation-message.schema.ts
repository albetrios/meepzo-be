import { type BuildExtraConfigColumns, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteral, sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import { INSTAGRAM_OPAQUE_ID_MAX_LENGTH } from '@/shared/constants/instagram.constants.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { instagram_conversations } from '@/domains/app/sub-domains/instagram-conversation/instagram-conversation.schema.js';
import { INSTAGRAM_CONVERSATION_SENDER_TYPES } from '@/domains/app/sub-domains/instagram-conversation/instagram-conversation.constants.js';
import {
  INSTAGRAM_CONVERSATION_MESSAGE_ATTACHMENTS_MAX,
  INSTAGRAM_CONVERSATION_MESSAGE_FAILURE_REASON_MAX_LENGTH,
  INSTAGRAM_CONVERSATION_MESSAGE_KINDS,
  INSTAGRAM_CONVERSATION_MESSAGE_SEND_STATUSES,
  INSTAGRAM_CONVERSATION_MESSAGE_TEXT_MAX_CHARACTERS,
} from './instagram-conversation-message.constants.js';

/** One file of a conversation message (2.B.3): its type, our copy's upload id, Meta's URL and its end. */
export interface InstagramConversationMessageAttachment {
  type: string;
  upload_id: string | null;
  meta_url: string | null;
  meta_url_expires_at: string | null;
}

/** A reaction message's emoji and the Meta message it reacts to (2.B.3). */
export interface InstagramConversationMessageReaction {
  emoji: string;
  target_meta_message_id: string;
}

/** The columns of `app.instagram_conversation_messages` (routes-final § 2.B.3), as the table is built from them. */
const instagramConversationMessageColumns = {
  id: bigserial('id', { mode: 'number' }).notNull(),
  /** `igcm_…` (CV1). */
  public_id: varchar('public_id', { length: 28 }).notNull(),
  organization_id: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  instagram_conversation_id: bigint('instagram_conversation_id', { mode: 'number' }).notNull(),
  /** Copies of the conversation's account and contact (no reference). */
  channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
  contact_id: bigint('contact_id', { mode: 'number' }).notNull(),
  /** `contact` · `automation` · `broadcast` · `team_member` · `instagram_app` (I-D14). */
  sender_type: varchar('sender_type', { length: 20 }).notNull(),
  kind: varchar('kind', { length: 20 }).notNull(),
  /** At most {@link INSTAGRAM_CONVERSATION_MESSAGE_TEXT_MAX_CHARACTERS} characters; empty once unsent. */
  text: varchar('text', { length: INSTAGRAM_CONVERSATION_MESSAGE_TEXT_MAX_CHARACTERS }),
  /** At most {@link INSTAGRAM_CONVERSATION_MESSAGE_ATTACHMENTS_MAX} files. */
  attachments: jsonb('attachments')
    .$type<InstagramConversationMessageAttachment[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  reply_to_meta_message_id: varchar('reply_to_meta_message_id', {
    length: INSTAGRAM_OPAQUE_ID_MAX_LENGTH,
  }),
  reaction: jsonb('reaction').$type<InstagramConversationMessageReaction>(),
  /** Meta's message id — opaque, no format check (C-D16); empty until a team reply is sent. */
  meta_message_id: varchar('meta_message_id', { length: INSTAGRAM_OPAQUE_ID_MAX_LENGTH }),
  /** Copies (no reference — the ledger is split by week): the automation, its run, the broadcast, the ledger row. */
  automation_id: bigint('automation_id', { mode: 'number' }),
  automation_run_id: bigint('automation_run_id', { mode: 'number' }),
  broadcast_id: bigint('broadcast_id', { mode: 'number' }),
  instagram_outgoing_message_id: bigint('instagram_outgoing_message_id', { mode: 'number' }),
  /** The member who sent a `team_member` message. */
  sent_by_membership_id: bigint('sent_by_membership_id', { mode: 'number' }),
  /** `sending` · `sent` · `failed` — team replies only (CV5). */
  send_status: varchar('send_status', { length: 10 }),
  failure_reason: varchar('failure_reason', {
    length: INSTAGRAM_CONVERSATION_MESSAGE_FAILURE_REASON_MAX_LENGTH,
  }),
  is_edited: boolean('is_edited').notNull().default(false),
  edited_at: timestamp('edited_at', { withTimezone: true }),
  is_unsent: boolean('is_unsent').notNull().default(false),
  /** Meta's read receipt reached this outbound message (CV9). */
  seen_at: timestamp('seen_at', { withTimezone: true }),
  /** The month split key. */
  sent_at: timestamp('sent_at', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
};

/** The table's columns as its extra config (keys, indexes, checks, policy) reads them. */
type InstagramConversationMessageTableColumns = BuildExtraConfigColumns<
  'instagram_conversation_messages',
  typeof instagramConversationMessageColumns,
  'pg'
>;

/** The keys and indexes of 2.B.3 — each local to its month part. */
function instagramConversationMessageKeysAndIndexes(
  table: InstagramConversationMessageTableColumns,
) {
  return [
    primaryKey({
      name: 'instagram_conversation_messages_pkey',
      columns: [table.id, table.sent_at],
    }),
    foreignKey({
      name: 'instagram_conversation_messages_conversation_fk',
      columns: [table.organization_id, table.instagram_conversation_id],
      foreignColumns: [instagram_conversations.organization_id, instagram_conversations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'instagram_conversation_messages_sent_by_membership_fk',
      columns: [table.organization_id, table.sent_by_membership_id],
      foreignColumns: [memberships.organization_id, memberships.id],
    }),
    // A split table's unique index carries the split key.
    uniqueIndex('idx_instagram_conversation_messages_public_id').on(table.public_id, table.sent_at),
    // The thread's keyset: newest first, then id.
    index('idx_instagram_conversation_messages_thread').on(
      table.instagram_conversation_id,
      table.sent_at.desc(),
      table.id.desc(),
    ),
    // Once per Meta message id (the intake's and the echo's dedupe).
    uniqueIndex('idx_instagram_conversation_messages_meta_message_id')
      .on(table.channel_account_id, table.meta_message_id, table.sent_at)
      .where(sql`${table.meta_message_id} IS NOT NULL`),
    // The stuck-`sending` repair (CVC3).
    index('idx_instagram_conversation_messages_sending')
      .on(table.send_status, table.created_at)
      .where(sql`${table.send_status} = 'sending'`),
    // The conversation key and the erase step.
    index('idx_instagram_conversation_messages_conversation').on(
      table.organization_id,
      table.instagram_conversation_id,
    ),
    index('idx_instagram_conversation_messages_sent_by_membership')
      .on(table.organization_id, table.sent_by_membership_id)
      .where(sql`${table.sent_by_membership_id} IS NOT NULL`),
  ];
}

/** The checks of 2.B.3. */
function instagramConversationMessageChecks(table: InstagramConversationMessageTableColumns) {
  return [
    check(
      'chk_instagram_conversation_messages_sender_type',
      sql`${table.sender_type} IN (${sqlLiteralList(INSTAGRAM_CONVERSATION_SENDER_TYPES)})`,
    ),
    check(
      'chk_instagram_conversation_messages_kind',
      sql`${table.kind} IN (${sqlLiteralList(INSTAGRAM_CONVERSATION_MESSAGE_KINDS)})`,
    ),
    // A send status for team replies only, and always for them.
    check(
      'chk_instagram_conversation_messages_send_status',
      sql`(${table.send_status} IS NULL OR ${table.send_status} IN (${sqlLiteralList(INSTAGRAM_CONVERSATION_MESSAGE_SEND_STATUSES)}))
    AND ((${table.sender_type} = 'team_member') = (${table.send_status} IS NOT NULL))`,
    ),
    // The sending member exactly for team replies.
    check(
      'chk_instagram_conversation_messages_sent_by',
      sql`(${table.sender_type} = 'team_member') = (${table.sent_by_membership_id} IS NOT NULL)`,
    ),
    check(
      'chk_instagram_conversation_messages_attachments',
      sql`jsonb_typeof(${table.attachments}) = 'array' AND jsonb_array_length(${table.attachments}) <= ${sqlLiteral(INSTAGRAM_CONVERSATION_MESSAGE_ATTACHMENTS_MAX)}`,
    ),
    check(
      'chk_instagram_conversation_messages_edited',
      sql`${table.is_edited} = (${table.edited_at} IS NOT NULL)`,
    ),
  ];
}

/**
 * `app.instagram_conversation_messages` — every message of a conversation, both ways (feat-instagram-inbox
 * routes-final § 2.B.3, I-D14): the contact's, an automation's, a broadcast's, a team member's and the
 * Instagram app's, with its kind, text, files, reply / reaction links and a team reply's send status.
 *
 * @remarks
 * - **Split by month** of `sent_at` (primary key `(id, sent_at)`), kept 12 months
 *   (`INSTAGRAM_CONVERSATION_MESSAGE_KEEP_DAYS`, I-D5): the shared partition upkeep makes and drops the
 *   parts.
 * - **Keys:** the conversation `(organization_id, instagram_conversation_id)` CASCADE (the erase removes the
 *   conversation, its messages go with it); the sending member; the account, contact, automation, run,
 *   broadcast and ledger ids are copies.
 * - **Writers (K1):** the webhook intake (inbound and echoes), the sender's one result save (automation /
 *   broadcast), the team-reply route — never a second writer. Text never reaches a log (K2).
 * - **RLS:** the organization policy plus the retention sweep arm in `USING` only (K3).
 */
export const instagram_conversation_messages = appSchema
  .table('instagram_conversation_messages', instagramConversationMessageColumns, (table) => [
    ...instagramConversationMessageKeysAndIndexes(table),
    ...instagramConversationMessageChecks(table),
    pgPolicy('instagram_conversation_messages_tenant_isolation', {
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
  ])
  .enableRLS();
