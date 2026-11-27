import { beforeEach, describe, expect, it } from 'vitest';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { getPostgresConstraintName } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { instagram_conversations } from '@/domains/app/sub-domains/instagram-conversation/instagram-conversation.schema.js';
import { instagram_conversation_notes } from '@/domains/app/sub-domains/instagram-conversation/instagram-conversation-note/instagram-conversation-note.schema.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
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
 * `app.instagram_conversation_notes` (feat-instagram-inbox routes-final § 2.C.3, ROUTE row R4) against the
 * database: a note by a member of the organization, its text length, and the conversation cascade.
 */
describe('app.instagram_conversation_notes (database)', () => {
  let organizationId: number;
  let membershipId: number;
  let conversationId: number;

  beforeEach(async () => {
    await cleanupDatabase();
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    organizationId = organization.id;
    const role = await createRoleWithPermissions({ organizationId, permissionCodes: [] });
    membershipId = (await createMembership({ userId: owner.id, organizationId, roleId: role.id }))
      .id;
    const account = await insertInstagramAccount({ organizationId });
    const contact = await insertContact({ organizationId, instagramAccountId: account.id });
    const [conversation] = await getOperatorDatabase()
      .insert(instagram_conversations)
      .values({
        public_id: generatePublicId('instagramConversation'),
        organization_id: organizationId,
        channel_account_id: account.channel_account_id,
        contact_id: contact.id,
        last_message_at: new Date(),
        last_message_sender_type: 'contact',
      })
      .returning();
    conversationId = conversation!.id;
  });

  function insertNote(values: Partial<typeof instagram_conversation_notes.$inferInsert> = {}) {
    return getOperatorDatabase()
      .insert(instagram_conversation_notes)
      .values({
        public_id: generatePublicId('instagramConversationNote'),
        organization_id: organizationId,
        instagram_conversation_id: conversationId,
        author_membership_id: membershipId,
        text: 'Called her back',
        ...values,
      })
      .returning();
  }

  it('stores a live note with an igcn_ id', async () => {
    const [row] = await insertNote();
    expect(row?.public_id).toMatch(/^igcn_[a-z0-9]{21}$/);
    expect(row?.deleted_at).toBeNull();
  });

  it('refuses an empty note', async () => {
    expect(await constraintRefusing(() => insertNote({ text: '' }))).toBe(
      'chk_instagram_conversation_notes_text',
    );
  });

  it('refuses an author who is not a member of the organization', async () => {
    expect(
      await constraintRefusing(() => insertNote({ author_membership_id: membershipId + 100_000 })),
    ).toBe('instagram_conversation_notes_author_membership_fk');
  });

  it('goes with its conversation (the key cascade)', async () => {
    await insertNote();
    await operatorQuery`DELETE FROM app.instagram_conversations WHERE id = ${conversationId}`;
    const rows = await operatorQuery<Array<{ id: string }>>`
      SELECT id::text FROM app.instagram_conversation_notes WHERE organization_id = ${organizationId}`;
    expect(rows).toHaveLength(0);
  });
});
