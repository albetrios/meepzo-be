import { beforeEach, describe, expect, it } from 'vitest';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { getPostgresConstraintName } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { saved_replies } from '@/domains/app/sub-domains/saved-reply/saved-reply.schema.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
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
 * `app.saved_replies` (feat-instagram-inbox routes-final § 3.3, ROUTE row R5) against the database: a title
 * unique in any case per organization (SR3), the text's byte cap, a use count that never goes below zero.
 */
describe('app.saved_replies (database)', () => {
  let organizationId: number;

  beforeEach(async () => {
    await cleanupDatabase();
    organizationId = (await createTestOrganization({ ownerUserId: (await createTestUser()).id }))
      .id;
  });

  function insertSavedReply(values: Partial<typeof saved_replies.$inferInsert> = {}) {
    return getOperatorDatabase()
      .insert(saved_replies)
      .values({
        public_id: generatePublicId('savedReply'),
        organization_id: organizationId,
        title: 'Shipping times',
        text: 'Hi {first_name}, we ship in 2 days.',
        ...values,
      })
      .returning();
  }

  it('stores a reply with an svr_ id, never used', async () => {
    const [row] = await insertSavedReply();
    expect(row?.public_id).toMatch(/^svr_[a-z0-9]{21}$/);
    expect(row).toMatchObject({ use_count: 0, last_used_at: null });
  });

  it('keeps one title per organization in any case (SR3)', async () => {
    await insertSavedReply();
    expect(await constraintRefusing(() => insertSavedReply({ title: 'SHIPPING TIMES' }))).toBe(
      'idx_saved_replies_organization_title',
    );
  });

  it('refuses an empty title, a text over 1,000 bytes and a negative use count', async () => {
    expect(await constraintRefusing(() => insertSavedReply({ title: '' }))).toBe(
      'chk_saved_replies_title',
    );
    // 334 three-byte characters are 1,002 bytes, though only 334 characters.
    expect(await constraintRefusing(() => insertSavedReply({ text: '€'.repeat(334) }))).toBe(
      'chk_saved_replies_text',
    );
    expect(await constraintRefusing(() => insertSavedReply({ use_count: -1 }))).toBe(
      'chk_saved_replies_use_count',
    );
  });
});
