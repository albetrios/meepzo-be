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
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';

/**
 * `app.automations` under FORCE RLS as the RLS-subject `meepzo_be_app` role (routes-final § 3.3,
 * K5): an organization reads, changes and creates only its own automations — another
 * organization's are invisible, and `WITH CHECK` refuses a row planted into it. The local and CI
 * superuser is RLS-exempt, so only this role proves the policy.
 */

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

describe('Security: app.automations tenant isolation (meepzo_be_app)', () => {
  let organizationA: { id: number; public_id: string };
  let organizationB: { id: number; public_id: string };
  let automationA: { id: number; public_id: string };
  let automationB: { id: number; public_id: string };
  let accountB: { id: number };

  beforeAll(async () => {
    await grantMeepzoBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    const owner = await createTestUser();
    organizationA = await createTestOrganization({ ownerUserId: owner.id });
    organizationB = await createTestOrganization({ ownerUserId: owner.id });
    const accountA = await insertInstagramAccount({ organizationId: organizationA.id });
    accountB = await insertInstagramAccount({ organizationId: organizationB.id });
    automationA = await insertAutomation({
      organizationId: organizationA.id,
      instagramAccountId: accountA.id,
      name: 'Automation A',
    });
    automationB = await insertAutomation({
      organizationId: organizationB.id,
      instagramAccountId: accountB.id,
      name: 'Automation B',
    });
  });

  it("reads only the active organization's automations; none without an organization", async () => {
    const visibleToA = await executeAsMeepzoBeAppTenant(
      organizationA.public_id,
      async (transaction) =>
        rowsOf<{ public_id: string }>(
          await transaction.execute(drizzleSql`SELECT public_id FROM app.automations ORDER BY id`),
        ),
    );
    const visibleWithout = await executeAsMeepzoBeAppTenant(null, async (transaction) =>
      rowsOf<{ public_id: string }>(
        await transaction.execute(drizzleSql`SELECT public_id FROM app.automations`),
      ),
    );

    expect(visibleToA.map((row) => row.public_id)).toEqual([automationA.public_id]);
    expect(visibleWithout).toEqual([]);
  });

  it("cannot change or delete another organization's automation", async () => {
    const changed = await executeAsMeepzoBeAppTenant(organizationA.public_id, async (transaction) =>
      rowsOf<{ id: number }>(
        await transaction.execute(
          drizzleSql`UPDATE app.automations SET deleted_at = now(), delete_reason = 'mistake'
            WHERE id = ${automationB.id} RETURNING id`,
        ),
      ),
    );

    expect(changed).toEqual([]);
    const stillThere = await executeAsMeepzoBeAppTenant(
      organizationB.public_id,
      async (transaction) =>
        rowsOf<{ name: string; deleted_at: Date | null }>(
          await transaction.execute(
            drizzleSql`SELECT name, deleted_at FROM app.automations WHERE id = ${automationB.id}`,
          ),
        ),
    );
    expect(stillThere).toEqual([{ name: 'Automation B', deleted_at: null }]);
  });

  it('refuses an automation planted into another organization (WITH CHECK)', async () => {
    await expect(
      executeAsMeepzoBeAppTenant(organizationA.public_id, (transaction) =>
        transaction.execute(drizzleSql`
          INSERT INTO app.automations (public_id, organization_id, instagram_account_id, name,
            trigger_type, is_opening_message_enabled, final_message)
          VALUES (${generatePublicId('automation')}, ${organizationB.id}, ${accountB.id}, 'Planted',
            'story_reply', false, '{"text":"x","links":[]}'::jsonb)`),
      ),
    ).rejects.toThrow();
  });

  it('lets the active organization soft-delete its own automation', async () => {
    const deleted = await executeAsMeepzoBeAppTenant(organizationA.public_id, async (transaction) =>
      rowsOf<{ deleted_at: Date | null }>(
        await transaction.execute(drizzleSql`
          UPDATE app.automations
          SET deleted_at = now(), delete_reason = 'duplicate', updated_at = now()
          WHERE id = ${automationA.id}
          RETURNING deleted_at`),
      ),
    );

    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.deleted_at).not.toBeNull();
  });
});
