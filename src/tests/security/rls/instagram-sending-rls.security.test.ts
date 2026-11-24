import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import {
  type RequestScopedPostgresDatabase,
  setLocalDatabaseConfig,
  setLocalMaintenanceRole,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  executeAsMeepzoBeAppTenant,
  grantMeepzoBeAppRoleForTests,
} from '@/tests/helpers/rls-matrix.helper.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { insertChannelAccount } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';

/** The row count of `statement`'s answer. */
function rowCount(result: unknown): number {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])).length;
}

/** Flattens an error and its `.cause` chain so the postgres message is matchable. */
function flattenErrorChain(error: unknown): string {
  let text = '';
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current; depth += 1) {
    text += String(current);
    current = (current as { cause?: unknown }).cause;
  }
  return text;
}

/**
 * The sending tables the generic RLS matrix cannot cover (feat-instagram-dm-sending § 6.A.3, R18):
 * the three keyed counter tables (no `id`) are organization-isolated for `meepzo_be_app`, and the
 * tenantless `app.sending_states` (P16) is closed to the application role and open only to the
 * maintenance role with `app.sending_state_access` armed.
 */
describe('Security: Instagram sending tables RLS', () => {
  beforeAll(async () => {
    await grantMeepzoBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it.each([
    'app.instagram_send_minute_counts',
    'app.message_month_counts',
    'app.instagram_send_day_counts',
  ])('%s shows an organization only its own rows', async (table) => {
    const organizationA = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    const organizationB = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    for (const [organization, providerAccountId] of [
      [organizationA, '17841466000000001'],
      [organizationB, '17841466000000002'],
    ] as const) {
      const account = await insertChannelAccount({
        organizationId: organization.id,
        providerAccountId,
      });
      await operatorQuery`
        INSERT INTO app.instagram_send_minute_counts (organization_id, channel_account_id, count_group, minute_start, count)
        VALUES (${organization.id}, ${account.id}, 'fast', date_trunc('minute', now()), 1)`;
      await operatorQuery`
        INSERT INTO app.message_month_counts (organization_id, month_start, slot, count)
        VALUES (${organization.id}, date_trunc('month', now())::date, 0, 1)`;
      await operatorQuery`
        INSERT INTO app.instagram_send_day_counts (organization_id, channel_account_id, day_date, sent_count)
        VALUES (${organization.id}, ${account.id}, current_date, 1)`;
    }

    const visible = await executeAsMeepzoBeAppTenant(organizationA.public_id, (transaction) =>
      transaction.execute(drizzleSql.raw(`SELECT organization_id FROM ${table}`)),
    );
    const rows = (
      Array.isArray(visible) ? visible : ((visible as { rows?: unknown[] }).rows ?? [])
    ) as Array<{ organization_id: string | number }>;
    expect(rows.map((row) => Number(row.organization_id))).toEqual([organizationA.id]);

    const updated = await executeAsMeepzoBeAppTenant(organizationA.public_id, (transaction) =>
      transaction.execute(
        drizzleSql.raw(
          `UPDATE ${table} SET organization_id = organization_id WHERE organization_id = ${organizationB.id} RETURNING organization_id`,
        ),
      ),
    );
    expect(rowCount(updated)).toBe(0);
  });

  it('app.sending_states refuses the application role and opens only to the maintenance role with its arm (P16)', async () => {
    await operatorQuery`
      INSERT INTO app.sending_states (id, environment_id, settings_version, minimum_compatible_settings_version)
      VALUES (1, 'production', '1', '1')`;
    const organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });

    let caught: unknown;
    try {
      await executeAsMeepzoBeAppTenant(organization.public_id, (transaction) =>
        transaction.execute(drizzleSql`SELECT id FROM app.sending_states`),
      );
    } catch (error) {
      caught = error;
    }
    expect(flattenErrorChain(caught)).toMatch(/permission denied/i);

    const withoutArm = await database.transaction(async (transaction) => {
      const databaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      await setLocalMaintenanceRole(databaseHandle);
      return rowCount(await databaseHandle.execute(drizzleSql`SELECT id FROM app.sending_states`));
    });
    expect(withoutArm).toBe(0);

    const withArm = await database.transaction(async (transaction) => {
      const databaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      await setLocalMaintenanceRole(databaseHandle);
      await setLocalDatabaseConfig({
        databaseHandle,
        key: 'app.sending_state_access',
        value: 'true',
      });
      return rowCount(await databaseHandle.execute(drizzleSql`SELECT id FROM app.sending_states`));
    });
    expect(withArm).toBe(1);
  });
});
