import { beforeEach, describe, expect, it } from 'vitest';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { getPostgresConstraintName } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { instagram_conversations } from '@/domains/app/sub-domains/instagram-conversation/instagram-conversation.schema.js';
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
 * `app.instagram_conversations` (feat-instagram-inbox routes-final § 2.A.3, ROUTE row R2) against the
 * database: one conversation per contact, the state / holder / sender lists, the holder rules, the
 * preview cap, and the contact's erase removing its conversation.
 */
describe('app.instagram_conversations (database)', () => {
  let organizationId: number;
  let channelAccountId: number;
  let contactId: number;

  beforeEach(async () => {
    await cleanupDatabase();
    const organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    organizationId = organization.id;
    const account = await insertInstagramAccount({ organizationId });
    channelAccountId = account.channel_account_id;
    contactId = (await insertContact({ organizationId, instagramAccountId: account.id })).id;
  });

  function insertConversation(values: Partial<typeof instagram_conversations.$inferInsert> = {}) {
    return getOperatorDatabase()
      .insert(instagram_conversations)
      .values({
        public_id: generatePublicId('instagramConversation'),
        organization_id: organizationId,
        channel_account_id: channelAccountId,
        contact_id: contactId,
        last_message_at: new Date(),
        last_message_sender_type: 'contact',
        ...values,
      })
      .returning();
  }

  it('starts open, unread 0, held by nobody, with an igcv_ public id', async () => {
    const [row] = await insertConversation();
    expect(row).toMatchObject({
      state: 'open',
      unread_count: 0,
      taken_by: null,
      taken_by_membership_id: null,
    });
    expect(row?.public_id).toMatch(/^igcv_[a-z0-9]{21}$/);
  });

  it('keeps one conversation per contact (the lazy upsert target, CV2)', async () => {
    await insertConversation();
    expect(await constraintRefusing(() => insertConversation())).toBe(
      'idx_instagram_conversations_organization_contact',
    );
  });

  it('refuses a state, holder or sender outside its list, and a negative unread count', async () => {
    expect(await constraintRefusing(() => insertConversation({ state: 'archived' }))).toBe(
      'chk_instagram_conversations_state',
    );
    expect(await constraintRefusing(() => insertConversation({ taken_by: 'bot' }))).toBe(
      'chk_instagram_conversations_taken_by',
    );
    expect(
      await constraintRefusing(() => insertConversation({ last_message_sender_type: 'system' })),
    ).toBe('chk_instagram_conversations_sender_type');
    expect(await constraintRefusing(() => insertConversation({ unread_count: -1 }))).toBe(
      'chk_instagram_conversations_unread_count',
    );
  });

  it('keeps the holder in step: no take time without a holder, no member for the Instagram app (CV4)', async () => {
    expect(await constraintRefusing(() => insertConversation({ taken_at: new Date() }))).toBe(
      'chk_instagram_conversations_taken',
    );
    const [held] = await insertConversation({ taken_by: 'instagram_app', taken_at: new Date() });
    expect(held?.taken_by).toBe('instagram_app');
  });

  it('removes the conversation with its contact row (the key cascade; the erase step itself lands at R13)', async () => {
    await insertConversation();
    await operatorQuery`DELETE FROM app.contact_activities WHERE contact_id = ${contactId}`;
    await operatorQuery`DELETE FROM app.contacts WHERE id = ${contactId}`;
    const rows = await operatorQuery<Array<{ id: string }>>`
      SELECT id::text FROM app.instagram_conversations WHERE organization_id = ${organizationId}`;
    expect(rows).toHaveLength(0);
  });
});
