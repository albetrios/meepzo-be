import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  executeAsMeepzoBeAppTenant,
  grantMeepzoBeAppRoleForTests,
} from '@/tests/helpers/rls-matrix.helper.js';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { InstagramWebhookEventRepository } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import {
  type TestInstagramAccount,
  insertTestInstagramAccount,
  insertTestInstagramWebhookEvent,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';

/**
 * K5 / WH3 / WHC13 (launch-2026-11-20-ujai, routes-final § 4.B.3): `app.instagram_webhook_events`
 * is an ordinary tenant table — ENABLE + FORCE RLS, the organization arm in `USING` and `WITH
 * CHECK`, the retention sweep arm (maintenance role only) in `USING` only.
 *
 * Run as `meepzo_be_app` (the production role, subject to FORCE RLS): an organization reads and
 * writes only its own events, nothing is visible without a context, and only the maintenance role's
 * retention context reads across organizations (the stuck-event pick-up and the 30-day clean-up).
 * The superuser the harness normally connects as would hide a broken policy.
 */

/** Rows of a `database.execute()` result. */
function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

function flattenErrorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current != null; depth += 1) {
    const message = (current as { message?: unknown }).message;
    parts.push(typeof message === 'string' ? message : String(current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

describe('Security: Instagram webhook events row-level security as meepzo_be_app', () => {
  let organizationA: { id: number; public_id: string };
  let organizationB: { id: number; public_id: string };
  let accountA: TestInstagramAccount;
  let accountB: TestInstagramAccount;

  beforeAll(async () => {
    await grantMeepzoBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    organizationA = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    organizationB = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    accountA = await insertTestInstagramAccount(organizationA.id);
    accountB = await insertTestInstagramAccount(organizationB.id);
    await insertTestInstagramWebhookEvent({ organizationId: organizationA.id, account: accountA });
    await insertTestInstagramWebhookEvent({ organizationId: organizationA.id, account: accountA });
    await insertTestInstagramWebhookEvent({ organizationId: organizationB.id, account: accountB });
  });

  function countAs(organizationPublicId: string | null): Promise<number> {
    return executeAsMeepzoBeAppTenant(organizationPublicId, async (transaction) => {
      const [row] = rowsOf<{ count: number }>(
        await transaction.execute(
          drizzleSql`SELECT count(*)::int AS count FROM app.instagram_webhook_events`,
        ),
      );
      return Number(row?.count ?? 0);
    });
  }

  it('lets each organization read only its own events, and nothing without a context', async () => {
    expect(await countAs(organizationA.public_id)).toBe(2);
    expect(await countAs(organizationB.public_id)).toBe(1);
    expect(await countAs(null)).toBe(0);
  });

  it("refuses storing an event under another organization's id (WITH CHECK)", async () => {
    let caught: unknown;
    try {
      await executeAsMeepzoBeAppTenant(organizationA.public_id, async (transaction) =>
        transaction.execute(drizzleSql`
          INSERT INTO app.instagram_webhook_events
            (public_id, organization_id, instagram_account_id, instagram_user_id, event_kind,
             event_key, payload)
          VALUES (${generatePublicId('instagramWebhookEvent')}, ${organizationB.id}, ${accountB.id},
                  ${accountB.instagramUserId}, 'comment', 'comment:cross-organization',
                  '{"field":"comments"}'::jsonb)
        `),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(flattenErrorChain(caught)).toMatch(/row-level security/i);
  });

  it("cannot update or delete another organization's events", async () => {
    const changed = await executeAsMeepzoBeAppTenant(
      organizationA.public_id,
      async (transaction) => {
        const updated = rowsOf<{ id: number }>(
          await transaction.execute(drizzleSql`
          UPDATE app.instagram_webhook_events SET status = 'queued'
          WHERE organization_id = ${organizationB.id} RETURNING id`),
        );
        const deleted = rowsOf<{ id: number }>(
          await transaction.execute(drizzleSql`
          DELETE FROM app.instagram_webhook_events
          WHERE organization_id = ${organizationB.id} RETURNING id`),
        );
        return updated.length + deleted.length;
      },
    );
    expect(changed).toBe(0);
    expect(await countAs(organizationB.public_id)).toBe(1);
  });

  it('does not open the sweep arm to the app role, even with the retention setting', async () => {
    const visible = await executeAsMeepzoBeAppTenant(null, async (transaction) => {
      await transaction.execute(
        drizzleSql`SELECT set_config('app.global_retention_cleanup', 'true', true)`,
      );
      const [row] = rowsOf<{ count: number }>(
        await transaction.execute(
          drizzleSql`SELECT count(*)::int AS count FROM app.instagram_webhook_events`,
        ),
      );
      return Number(row?.count ?? 0);
    });
    expect(visible).toBe(0);
  });

  it("lets the maintenance role's retention context read every organization's events", async () => {
    const [row] = await withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      callback: async (databaseHandle) =>
        rowsOf<{ count: number }>(
          await databaseHandle.execute(
            drizzleSql`SELECT count(*)::int AS count FROM app.instagram_webhook_events`,
          ),
        ),
      options: { useMaintenanceDatabaseRole: true },
    });
    expect(Number(row?.count)).toBe(3);
  });

  it("lets the stuck-event pick-up's read find every organization's waiting accounts under the maintenance role (WH15)", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    await insertTestInstagramWebhookEvent({
      organizationId: organizationA.id,
      account: accountA,
      receivedAt: tenMinutesAgo,
    });
    await insertTestInstagramWebhookEvent({
      organizationId: organizationB.id,
      account: accountB,
      status: 'queued',
      receivedAt: tenMinutesAgo,
    });

    const stuck = await withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      callback: (databaseHandle) =>
        new InstagramWebhookEventRepository(
          databaseHandle as unknown as RequestScopedPostgresDatabase,
        ).listAccountsWithStuckEvents({ stuckAfterMinutes: 5, limit: 100 }),
      options: { useMaintenanceDatabaseRole: true },
    });

    expect(stuck.map((account) => account.organizationPublicId).sort()).toEqual(
      [organizationA.public_id, organizationB.public_id].sort(),
    );
  });
});
