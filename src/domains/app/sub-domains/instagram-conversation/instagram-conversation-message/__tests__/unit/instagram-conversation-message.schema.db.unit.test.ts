import { beforeEach, describe, expect, it } from 'vitest';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { getPostgresConstraintName } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { instagram_conversations } from '@/domains/app/sub-domains/instagram-conversation/instagram-conversation.schema.js';
import { instagram_conversation_messages } from '@/domains/app/sub-domains/instagram-conversation/instagram-conversation-message/instagram-conversation-message.schema.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase, operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

/** The constraint a refused statement named, or `null` when it was not refused. */
async function constraintRefusing(statement: () => Promise<unknown>): Promise<string | null> {
  try {
    await statement();
    return null;
  } catch (error) {
    return getPostgresConstraintName(error) ?? 'unknown';
  }
}

/**
 * `app.instagram_conversation_messages` (feat-instagram-inbox routes-final § 2.B.3, ROUTE row R3) against
 * the database: a message lands in its month part, once per Meta message id, the sender / kind lists, a
 * send status and a member exactly for team replies, the file cap, and the conversation cascade.
 */
describe('app.instagram_conversation_messages (database)', () => {
  let organizationId: number;
  let channelAccountId: number;
  let contactId: number;
  let conversationId: number;

  beforeEach(async () => {
    await cleanupDatabase();
    const organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    organizationId = organization.id;
    const account = await insertInstagramAccount({ organizationId });
    channelAccountId = account.channel_account_id;
    contactId = (await insertContact({ organizationId, instagramAccountId: account.id })).id;
    const [conversation] = await getOperatorDatabase()
      .insert(instagram_conversations)
      .values({
        public_id: generatePublicId('instagramConversation'),
        organization_id: organizationId,
        channel_account_id: channelAccountId,
        contact_id: contactId,
        last_message_at: new Date(),
        last_message_sender_type: 'contact',
      })
      .returning();
    conversationId = conversation!.id;
  });

  function insertMessage(
    values: Partial<typeof instagram_conversation_messages.$inferInsert> = {},
  ) {
    return getOperatorDatabase()
      .insert(instagram_conversation_messages)
      .values({
        public_id: generatePublicId('instagramConversationMessage'),
        organization_id: organizationId,
        instagram_conversation_id: conversationId,
        channel_account_id: channelAccountId,
        contact_id: contactId,
        sender_type: 'contact',
        kind: 'text',
        text: 'Hello',
        sent_at: new Date(),
        ...values,
      })
      .returning();
  }

  it('stores a message in its month part with an igcm_ id and no files', async () => {
    const [row] = await insertMessage();
    expect(row?.public_id).toMatch(/^igcm_[a-z0-9]{21}$/);
    expect(row?.attachments).toEqual([]);
    const [part] = await operatorQuery<Array<{ part: string }>>`
      SELECT tableoid::regclass::text AS part FROM app.instagram_conversation_messages
      WHERE public_id = ${row!.public_id}`;
    expect(part?.part).toMatch(/^app\.instagram_conversation_messages_p\d{6}$/);
  });

  it('keeps one row per Meta message id on an account', async () => {
    const sentAt = new Date();
    await insertMessage({ meta_message_id: 'aWdfZAG1faW', sent_at: sentAt });
    // The refusal names the month part's copy of `idx_instagram_conversation_messages_meta_message_id`.
    expect(
      await constraintRefusing(() =>
        insertMessage({ meta_message_id: 'aWdfZAG1faW', sent_at: sentAt }),
      ),
    ).not.toBeNull();
  });

  it('refuses a sender or kind outside its list, and more than 10 files', async () => {
    expect(await constraintRefusing(() => insertMessage({ sender_type: 'system' }))).toBe(
      'chk_instagram_conversation_messages_sender_type',
    );
    expect(await constraintRefusing(() => insertMessage({ kind: 'sticker' }))).toBe(
      'chk_instagram_conversation_messages_kind',
    );
    const tooMany = Array.from({ length: 11 }, () => ({
      type: 'image',
      upload_id: null,
      meta_url: null,
      meta_url_expires_at: null,
    }));
    expect(await constraintRefusing(() => insertMessage({ attachments: tooMany }))).toBe(
      'chk_instagram_conversation_messages_attachments',
    );
  });

  it('gives a send status and a member to team replies only (CV5)', async () => {
    expect(await constraintRefusing(() => insertMessage({ send_status: 'sent' }))).toBe(
      'chk_instagram_conversation_messages_send_status',
    );
    expect(
      await constraintRefusing(() =>
        insertMessage({ sender_type: 'team_member', send_status: 'sending' }),
      ),
    ).toBe('chk_instagram_conversation_messages_sent_by');
  });

  it('goes with its conversation (the key cascade)', async () => {
    await insertMessage();
    await operatorQuery`DELETE FROM app.instagram_conversations WHERE id = ${conversationId}`;
    const rows = await operatorQuery<Array<{ id: string }>>`
      SELECT id::text FROM app.instagram_conversation_messages WHERE organization_id = ${organizationId}`;
    expect(rows).toHaveLength(0);
  });
});
