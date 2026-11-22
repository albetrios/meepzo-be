import { sql as drizzleSql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
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
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationCommentLog,
  insertAutomationRun,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';

/**
 * The run engine's three tables under FORCE RLS as the RLS-subject `meepzo_be_app` role
 * (routes-final § 3.B.3, K5): an organization reads, changes and creates only its own runs, run
 * events and comment logs — another organization's are invisible and `WITH CHECK` refuses a row
 * planted into it; the retention sweep (the 7-day wait scan, run and comment-log retention) reads
 * across organizations but cannot update one. The local and CI superuser is RLS-exempt, so only
 * this role proves the policy.
 */

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

type Side = {
  organization: { id: number; public_id: string };
  automationId: number;
  contactId: number;
  runId: number;
  commentLogId: number;
};

describe('Security: app.automation_runs / _run_events / _comment_logs tenant isolation (meepzo_be_app)', () => {
  let sideA: Side;
  let sideB: Side;

  beforeAll(async () => {
    await grantMeepzoBeAppRoleForTests();
  });

  async function seedSide(): Promise<Side> {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const account = await insertInstagramAccount({ organizationId: organization.id });
    const automation = await insertAutomation({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    const contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    const run = await insertAutomationRun({
      organizationId: organization.id,
      automationId: automation.id,
      contactId: contact.id,
    });
    const commentLog = await insertAutomationCommentLog({
      organizationId: organization.id,
      automationId: automation.id,
      contactId: contact.id,
      automation_run_id: run.id,
    });
    await executeAsMeepzoBeAppTenant(organization.public_id, (transaction) =>
      transaction.execute(drizzleSql`
        INSERT INTO app.automation_run_events (organization_id, automation_run_id, event_type, status)
        VALUES (${organization.id}, ${run.id}, 'status_changed', 'waiting')`),
    );
    return {
      organization,
      automationId: automation.id,
      contactId: contact.id,
      runId: run.id,
      commentLogId: commentLog.id,
    };
  }

  beforeEach(async () => {
    await cleanupDatabase();
    sideA = await seedSide();
    sideB = await seedSide();
  });

  it.each([
    ['app.automation_runs', 'id', (side: Side) => side.runId],
    ['app.automation_comment_logs', 'id', (side: Side) => side.commentLogId],
    ['app.automation_run_events', 'automation_run_id', (side: Side) => side.runId],
  ] as const)(
    "%s: reads only the active organization's rows; none without an organization",
    async (table, column, keyOf) => {
      const visibleToA = await executeAsMeepzoBeAppTenant(
        sideA.organization.public_id,
        async (transaction) =>
          rowsOf<{ key: number }>(
            await transaction.execute(
              drizzleSql.raw(`SELECT ${column}::int AS key FROM ${table} ORDER BY id`),
            ),
          ),
      );
      const visibleWithout = await executeAsMeepzoBeAppTenant(null, async (transaction) =>
        rowsOf<{ key: number }>(
          await transaction.execute(drizzleSql.raw(`SELECT ${column} AS key FROM ${table}`)),
        ),
      );

      expect(visibleToA.map((row) => Number(row.key))).toEqual([keyOf(sideA)]);
      expect(visibleWithout).toEqual([]);
    },
  );

  it("cannot change another organization's run or comment log", async () => {
    const changed = await executeAsMeepzoBeAppTenant(
      sideA.organization.public_id,
      async (transaction) => [
        ...rowsOf(
          await transaction.execute(drizzleSql`
            UPDATE app.automation_runs SET trigger_text = NULL WHERE id = ${sideB.runId} RETURNING id`),
        ),
        ...rowsOf(
          await transaction.execute(drizzleSql`
            UPDATE app.automation_comment_logs SET comment_text = NULL
            WHERE id = ${sideB.commentLogId} RETURNING id`),
        ),
      ],
    );

    expect(changed).toEqual([]);
  });

  it('refuses a run, a run event and a comment log planted into another organization (WITH CHECK)', async () => {
    await expect(
      executeAsMeepzoBeAppTenant(sideA.organization.public_id, (transaction) =>
        transaction.execute(drizzleSql`
          INSERT INTO app.automation_runs (public_id, organization_id, automation_id, contact_id,
            trigger_type, last_instagram_event_key)
          VALUES ('run_plantedplantedplanted', ${sideB.organization.id}, ${sideB.automationId},
            ${sideB.contactId}, 'dm', 'message:planted')`),
      ),
    ).rejects.toThrow();
    await expect(
      executeAsMeepzoBeAppTenant(sideA.organization.public_id, (transaction) =>
        transaction.execute(drizzleSql`
          INSERT INTO app.automation_run_events (organization_id, automation_run_id, event_type, status)
          VALUES (${sideB.organization.id}, ${sideB.runId}, 'status_changed', 'failed')`),
      ),
    ).rejects.toThrow();
    await expect(
      executeAsMeepzoBeAppTenant(sideA.organization.public_id, (transaction) =>
        transaction.execute(drizzleSql`
          INSERT INTO app.automation_comment_logs (public_id, organization_id, automation_id,
            automation_name, contact_id, instagram_media_id, instagram_comment_id)
          VALUES ('acl_plantedplantedplanted', ${sideB.organization.id}, ${sideB.automationId},
            'Planted', ${sideB.contactId}, '1', '2')`),
      ),
    ).rejects.toThrow();
  });

  it('the retention sweep reads every organization’s runs, and cannot update one', async () => {
    const seen = await withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      callback: async (databaseHandle) =>
        rowsOf<{ id: number }>(
          await databaseHandle.execute(drizzleSql`SELECT id FROM app.automation_runs ORDER BY id`),
        ).map((row) => Number(row.id)),
      options: { useMaintenanceDatabaseRole: true },
    });
    expect(seen).toEqual([sideA.runId, sideB.runId]);

    // USING lets the sweep see the row; WITH CHECK (the organization arm only) refuses the change.
    await expect(
      withMaintenanceDatabaseContext({
        scope: MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
        callback: (databaseHandle) =>
          databaseHandle.execute(drizzleSql`
            UPDATE app.automation_runs SET trigger_text = NULL WHERE id = ${sideB.runId}`),
        options: { useMaintenanceDatabaseRole: true },
      }),
    ).rejects.toThrow();
  });
});
