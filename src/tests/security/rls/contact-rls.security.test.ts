import { sql as drizzleSql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  executeAsMeepzoBeAppTenant,
  grantMeepzoBeAppRoleForTests,
} from '@/tests/helpers/rls-matrix.helper.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';

/**
 * `app.contacts` under FORCE RLS as the RLS-subject `meepzo_be_app` role (routes-final § 2.3,
 * K5): an organization reads, changes and creates only its own contacts — another organization's
 * are invisible, and `WITH CHECK` refuses a row planted into it. The local and CI superuser is
 * RLS-exempt, so only this role proves the policy.
 */

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

describe('Security: app.contacts tenant isolation (meepzo_be_app)', () => {
  let organizationA: { id: number; public_id: string };
  let organizationB: { id: number; public_id: string };
  let contactA: { id: number; public_id: string };
  let contactB: { id: number; public_id: string };
  let accountA: { id: number; channel_account_id: number };
  let accountB: { id: number; channel_account_id: number };

  beforeAll(async () => {
    await grantMeepzoBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    const owner = await createTestUser();
    organizationA = await createTestOrganization({ ownerUserId: owner.id });
    organizationB = await createTestOrganization({ ownerUserId: owner.id });
    accountA = await insertInstagramAccount({ organizationId: organizationA.id });
    accountB = await insertInstagramAccount({ organizationId: organizationB.id });
    contactA = await insertContact({
      organizationId: organizationA.id,
      instagramAccountId: accountA.id,
      username: 'contact.a',
    });
    contactB = await insertContact({
      organizationId: organizationB.id,
      instagramAccountId: accountB.id,
      username: 'contact.b',
    });
  });

  it("reads only the active organization's contacts; none without an organization", async () => {
    const visibleToA = await executeAsMeepzoBeAppTenant(
      organizationA.public_id,
      async (transaction) =>
        rowsOf<{ public_id: string }>(
          await transaction.execute(drizzleSql`SELECT public_id FROM app.contacts ORDER BY id`),
        ),
    );
    const visibleWithout = await executeAsMeepzoBeAppTenant(null, async (transaction) =>
      rowsOf<{ public_id: string }>(
        await transaction.execute(drizzleSql`SELECT public_id FROM app.contacts`),
      ),
    );

    expect(visibleToA.map((row) => row.public_id)).toEqual([contactA.public_id]);
    expect(visibleWithout).toEqual([]);
  });

  it("cannot change or erase another organization's contact", async () => {
    const changed = await executeAsMeepzoBeAppTenant(organizationA.public_id, async (transaction) =>
      rowsOf<{ id: number }>(
        await transaction.execute(
          drizzleSql`UPDATE app.contacts SET username = NULL WHERE id = ${contactB.id} RETURNING id`,
        ),
      ),
    );

    expect(changed).toEqual([]);
    const stillThere = await executeAsMeepzoBeAppTenant(
      organizationB.public_id,
      async (transaction) =>
        rowsOf<{ username: string | null }>(
          await transaction.execute(
            drizzleSql`SELECT username FROM app.contacts WHERE id = ${contactB.id}`,
          ),
        ),
    );
    expect(stillThere).toEqual([{ username: 'contact.b' }]);
  });

  it('refuses a contact planted into another organization (WITH CHECK)', async () => {
    await expect(
      executeAsMeepzoBeAppTenant(organizationA.public_id, (transaction) =>
        transaction.execute(drizzleSql`
          INSERT INTO app.contacts (public_id, organization_id, channel_account_id, instagram_user_id,
            first_seen_at)
          VALUES (${generatePublicId('contact')}, ${organizationB.id}, ${accountB.channel_account_id},
            '17841400000000999', now())`),
      ),
    ).rejects.toThrow();
  });

  it('lets the active organization erase its own contact', async () => {
    const erased = await executeAsMeepzoBeAppTenant(organizationA.public_id, async (transaction) =>
      rowsOf<{ deleted_at: Date | null }>(
        await transaction.execute(drizzleSql`
          UPDATE app.contacts
          SET instagram_user_id = NULL, username = NULL, tags = '{}', deleted_at = now(), updated_at = now()
          WHERE id = ${contactA.id}
          RETURNING deleted_at`),
      ),
    );

    expect(erased).toHaveLength(1);
    expect(erased[0]?.deleted_at).not.toBeNull();
  });
});
