import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { sql as drizzleSql } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  grantMeepzoBeAppRoleForTests,
  executeAsMeepzoBeAppTenant,
  seedRlsMatrixFixtures,
  tableKey,
  type RlsTenantFixture,
} from '@/tests/helpers/rls-matrix.helper.js';
import { database } from '@/infrastructure/database/connection.js';

/** Rows of a `database.execute()` result. */
function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

/**
 * audit H1: every organization-scoped `_tenant_isolation` policy now declares an explicit
 * `WITH CHECK` pinned to the active-organization GUC (migration
 * `20260621020000_tenant_isolation_with_check_propagation`), while the `USING`
 * arm keeps the `app.global_retention_cleanup` bypass. Before this, the implicit
 * WITH CHECK reused the bypass-carrying USING, so a retention-context process
 * could INSERT/UPDATE a row under an arbitrary tenant. This proves, across a
 * representative set of the propagated tables, that:
 *   1. a retention-context write setting a foreign organization_id is rejected;
 *   2. a tenant-context cross-organization reassignment is rejected (write confinement);
 *   3. retention DELETE still works via the USING bypass (positive control).
 */
const ORG_SCOPED_TABLES = [
  { schemaName: 'notify', tableName: 'webhooks' },
  { schemaName: 'tenancy', tableName: 'memberships' },
  { schemaName: 'tenancy', tableName: 'roles' },
  { schemaName: 'tenancy', tableName: 'api_keys' },
  { schemaName: 'tenancy', tableName: 'organization_notification_policies' },
  // The Instagram account and its settings carry the sweep arm in USING only (launch R3). The
  // token table carries none, so a retention context does not even see a token (IA5) — covered by
  // instagram-account-resolvers.security.test.ts.
  { schemaName: 'app', tableName: 'instagram_accounts' },
  { schemaName: 'app', tableName: 'instagram_account_settings' },
  // The stored posts (launch R5) carry the same sweep arm in USING only.
  { schemaName: 'app', tableName: 'instagram_media' },
  // The Instagram webhook events: the sweep arm in USING only (the pick-up and the 30-day clean-up,
  // launch R12), WITH CHECK the organization arm only.
  { schemaName: 'app', tableName: 'instagram_webhook_events' },
  // Contacts carry the sweep arm in USING only too (launch R8, routes-final § 2.3).
  { schemaName: 'app', tableName: 'contacts' },
  // Automations: the sweep arm in USING only (the "next post" expiry scan and the purge read across
  // organizations; each change runs in its organization's own context — launch R9, § 3.3).
  { schemaName: 'app', tableName: 'automations' },
  // The run engine's runs, run events and comment logs: the sweep arm in USING only (the 7-day wait
  // scan and the retentions read across organizations — launch R10, § 3.B.3).
  { schemaName: 'app', tableName: 'automation_runs' },
  { schemaName: 'app', tableName: 'automation_run_events' },
  { schemaName: 'app', tableName: 'automation_comment_logs' },
  // Instagram's messages and send attempts (feat-instagram-dm-sending § 6.B.3, R19): the sweep arm
  // in USING only (the repair duties and the part upkeep read across organizations).
  { schemaName: 'app', tableName: 'instagram_messages' },
  { schemaName: 'app', tableName: 'instagram_send_attempts' },
  // Instagram's message files (§ 6.C.3, R20): the sweep arm in USING only (the purge, WC-47).
  { schemaName: 'app', tableName: 'instagram_attachments' },
] as const;

async function resolveOrganizationInternalId(organizationPublicId: string): Promise<number> {
  const rows = rowsOf<{ id: number }>(
    await database.execute(drizzleSql`
    SELECT id FROM tenancy.organizations WHERE public_id = ${organizationPublicId}
  `),
  );
  return Number(rows[0]!.id);
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

describe('Security: tenant-isolation WITH CHECK propagation confines cross-organization writes', () => {
  let fixture: RlsTenantFixture;
  let organizationAInternalId: number;
  let organizationBInternalId: number;

  beforeAll(async () => {
    await grantMeepzoBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    fixture = await seedRlsMatrixFixtures();
    organizationAInternalId = await resolveOrganizationInternalId(fixture.organizationAPublicId);
    organizationBInternalId = await resolveOrganizationInternalId(fixture.organizationBPublicId);
  });

  it.each(ORG_SCOPED_TABLES)(
    'rejects a retention-context write that sets a foreign organization_id on $tableName (explicit WITH CHECK)',
    async ({ schemaName, tableName }) => {
      const rowIds = fixture.rowIdsByTable.get(
        tableKey({ schemaName: schemaName, tableName: tableName }),
      );
      expect(rowIds, `fixture seeds a ${tableName} row for both orgs`).toBeDefined();

      let caught: unknown;
      try {
        await withMaintenanceDatabaseContext({
          scope: MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
          callback: async (databaseHandle) =>
            databaseHandle.execute(
              drizzleSql.raw(
                `UPDATE "${schemaName}"."${tableName}" SET organization_id = ${organizationAInternalId} WHERE id = ${rowIds!.organizationB} RETURNING id`,
              ),
            ),
          options: { useMaintenanceDatabaseRole: true },
        });
      } catch (error) {
        caught = error;
      }

      expect(
        caught,
        `expected explicit WITH CHECK to reject a retention-context cross-organization write on ${tableName}`,
      ).toBeDefined();
      expect(flattenErrorChain(caught)).toMatch(/row-level security/i);
    },
  );

  it.each(ORG_SCOPED_TABLES)(
    'rejects reassigning an organization-B $tableName row to organization A under the organization-B tenant context',
    async ({ schemaName, tableName }) => {
      const rowIds = fixture.rowIdsByTable.get(
        tableKey({ schemaName: schemaName, tableName: tableName }),
      )!;

      let caught: unknown;
      try {
        await executeAsMeepzoBeAppTenant(fixture.organizationBPublicId, async (transaction) => {
          await transaction.execute(
            drizzleSql.raw(
              `UPDATE "${schemaName}"."${tableName}" SET organization_id = ${organizationAInternalId} WHERE id = ${rowIds.organizationB} RETURNING id`,
            ),
          );
        });
      } catch (error) {
        caught = error;
      }

      expect(
        caught,
        `expected RLS to reject reassigning ${tableName} to a foreign org`,
      ).toBeDefined();
      expect(flattenErrorChain(caught)).toMatch(/row-level security/i);
    },
  );

  it('still allows a retention-context DELETE via the USING bypass (positive control)', async () => {
    const rowIds = fixture.rowIdsByTable.get(
      tableKey({ schemaName: 'tenancy', tableName: 'api_keys' }),
    )!;

    const deletedCount = await withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      callback: async (databaseHandle) => {
        const result = await databaseHandle.execute(
          drizzleSql.raw(
            `DELETE FROM "tenancy"."api_keys" WHERE id = ${rowIds.organizationB} RETURNING id`,
          ),
        );
        const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
        return rows.length;
      },
      options: { useMaintenanceDatabaseRole: true },
    });

    expect(deletedCount).toBe(1);
  });

  it('allows a same-organization reassignment under the matching tenant context (positive control)', async () => {
    const rowIds = fixture.rowIdsByTable.get(
      tableKey({ schemaName: 'tenancy', tableName: 'memberships' }),
    )!;

    const affected = await executeAsMeepzoBeAppTenant(
      fixture.organizationBPublicId,
      async (transaction) => {
        const result = await transaction.execute(
          drizzleSql.raw(
            `UPDATE "tenancy"."memberships" SET organization_id = ${organizationBInternalId} WHERE id = ${rowIds.organizationB} RETURNING id`,
          ),
        );
        const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
        return rows.length;
      },
    );

    expect(affected).toBe(1);
  });
});
