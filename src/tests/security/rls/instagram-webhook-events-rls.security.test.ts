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
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { InstagramWebhookEventRepository } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import {
  type TestInstagramAccount,
  insertTestInstagramAccount,
  insertTestInstagramWebhookEvent,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';

/**
 * K5 / WH3 / WHC13 (launch-2026-11-20-ujai, routes-final § 4.B.3) and WHC11 / WHC12
 * (feat-instagram-dm-sending R16, § 5.B.3): `app.instagram_webhook_events` and
 * `app.instagram_webhook_event_keys` are tenant tables split by day — ENABLE + FORCE RLS on the
 * parent, the organization arm in `USING` and `WITH CHECK`, the retention sweep arm (maintenance
 * role only) in `USING` only; the parts carry no grant for the application roles.
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
            (public_id, organization_id, channel_account_id, instagram_user_id, event_kind,
             event_key, payload)
          VALUES (${generatePublicId('instagramWebhookEvent')}, ${organizationB.id},
                  ${accountB.channelAccountId},
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

  describe('the event keys (WHC12)', () => {
    const today = new Date().toISOString().slice(0, 10);

    beforeEach(async () => {
      for (const [organization, account] of [
        [organizationA, accountA],
        [organizationB, accountB],
      ] as const) {
        await operatorQuery`
          INSERT INTO app.instagram_webhook_event_keys
            (organization_id, channel_account_id, event_key, event_day)
          VALUES (${organization.id}, ${account.channelAccountId}, 'comment:same-key', ${today})`;
      }
    });

    function countKeysAs(organizationPublicId: string | null): Promise<number> {
      return executeAsMeepzoBeAppTenant(organizationPublicId, async (transaction) => {
        const [row] = rowsOf<{ count: number }>(
          await transaction.execute(
            drizzleSql`SELECT count(*)::int AS count FROM app.instagram_webhook_event_keys`,
          ),
        );
        return Number(row?.count ?? 0);
      });
    }

    it("never shows another organization's keys, and none without a context", async () => {
      expect(await countKeysAs(organizationA.public_id)).toBe(1);
      expect(await countKeysAs(organizationB.public_id)).toBe(1);
      expect(await countKeysAs(null)).toBe(0);
    });

    it("is never blocked by another organization's key: the same key and day on its own account is new", async () => {
      await operatorQuery`
        DELETE FROM app.instagram_webhook_event_keys WHERE organization_id = ${organizationA.id}`;
      const inserted = await executeAsMeepzoBeAppTenant(
        organizationA.public_id,
        async (transaction) =>
          rowsOf<{ event_key: string }>(
            await transaction.execute(drizzleSql`
              INSERT INTO app.instagram_webhook_event_keys
                (organization_id, channel_account_id, event_key, event_day)
              VALUES (${organizationA.id}, ${accountA.channelAccountId}, 'comment:same-key', ${today})
              ON CONFLICT DO NOTHING RETURNING event_key`),
          ),
      );
      expect(inserted).toHaveLength(1);
    });

    it("refuses a key under another organization's id (WITH CHECK)", async () => {
      let caught: unknown;
      try {
        await executeAsMeepzoBeAppTenant(organizationA.public_id, async (transaction) =>
          transaction.execute(drizzleSql`
            INSERT INTO app.instagram_webhook_event_keys
              (organization_id, channel_account_id, event_key, event_day)
            VALUES (${organizationB.id}, ${accountB.channelAccountId}, 'comment:cross', ${today})`),
        );
      } catch (error) {
        caught = error;
      }
      expect(flattenErrorChain(caught)).toMatch(/row-level security/i);
    });

    it("lets the maintenance role's retention context read every organization's keys", async () => {
      const [row] = await withMaintenanceDatabaseContext({
        scope: MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
        callback: async (databaseHandle) =>
          rowsOf<{ count: number }>(
            await databaseHandle.execute(
              drizzleSql`SELECT count(*)::int AS count FROM app.instagram_webhook_event_keys`,
            ),
          ),
        options: { useMaintenanceDatabaseRole: true },
      });
      expect(Number(row?.count)).toBe(2);
    });
  });

  it('gives the app role no grant on a day part or the default part — only the parent, whose policy applies', async () => {
    const [part] = await operatorQuery<Array<{ part_name: string }>>`
      SELECT child.relname AS part_name
        FROM pg_inherits
        JOIN pg_class child ON child.oid = pg_inherits.inhrelid
       WHERE pg_inherits.inhparent = 'app.instagram_webhook_events'::regclass
         AND child.relname <> 'instagram_webhook_events_default'
       LIMIT 1`;
    expect(part?.part_name).toMatch(/^instagram_webhook_events_p\d{8}$/);
    for (const qualified of [
      `app.${part?.part_name}`,
      'app.instagram_webhook_events_default',
      'app.instagram_webhook_event_keys_default',
    ]) {
      let caught: unknown;
      try {
        await executeAsMeepzoBeAppTenant(organizationA.public_id, async (transaction) =>
          transaction.execute(drizzleSql.raw(`SELECT count(*) FROM ${qualified}`)),
        );
      } catch (error) {
        caught = error;
      }
      expect(flattenErrorChain(caught), qualified).toMatch(/permission denied/i);
    }
  });
});
