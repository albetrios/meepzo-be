import { sql as drizzleSql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { database } from '@/infrastructure/database/connection.js';

/**
 * Role-taxonomy locks (migration 20260827050000): five named roles with one
 * semantic each, `meepzo_be_owner` owning every app table, and SECURITY DEFINER
 * functions deliberately NOT owned by it (a non-exempt definer owner is bound by
 * FORCE RLS and every resolver would silently return zero rows) and executable by
 * the two runtime roles only (migration 20261010135529).
 */
async function queryRows<T extends Record<string, unknown>>(
  statement: ReturnType<typeof drizzleSql>,
): Promise<T[]> {
  const result = await database.execute<T>(statement);
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

/**
 * The SECURITY DEFINER functions only the maintenance role may run — they change the schema, so the
 * application role must never reach them: the shared partition upkeep (feat-instagram-dm-sending
 * WC-55, P410) makes and drops the time-split tables' parts as its owner.
 */
const MAINTENANCE_ONLY_DEFINER_FUNCTIONS: readonly string[] = [
  'app.fn_manage_time_partitions(regclass,integer,integer,boolean)',
];

describe('role taxonomy (owner / operator / migrator / app / maintenance)', () => {
  it('all five roles exist; none of the runtime/DDL roles is superuser or BYPASSRLS', async () => {
    const rows = await queryRows<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      drizzleSql`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'meepzo_be%' ORDER BY rolname`,
    );
    const names = rows.map((row) => row.rolname);
    expect(names).toEqual([
      'meepzo_be_app',
      'meepzo_be_maintenance',
      'meepzo_be_migrator',
      'meepzo_be_operator',
      'meepzo_be_owner',
    ]);
    for (const row of rows) {
      expect(row.rolsuper, `${row.rolname} must never be superuser`).toBe(false);
      if (row.rolname !== 'meepzo_be_operator') {
        // Operator MAY carry BYPASSRLS locally (fixture power); every other role is
        // strictly RLS-subject — the boot guards additionally enforce this for the
        // two runtime URLs.
        expect(row.rolbypassrls, `${row.rolname} must never be BYPASSRLS`).toBe(false);
      }
    }
  });

  it('meepzo_be_owner owns every table in the seven application schemas (drift lock)', async () => {
    const rows = await queryRows<{ schemaname: string; tablename: string; tableowner: string }>(
      drizzleSql`SELECT schemaname, tablename, tableowner FROM pg_tables
                 WHERE schemaname IN ('auth','tenancy','billing','notify','audit','upload','app')
                   AND tableowner <> 'meepzo_be_owner'`,
    );
    expect(
      rows.map((row) => `${row.schemaname}.${row.tablename} (${row.tableowner})`),
      'New tables must end with ALTER TABLE ... OWNER TO meepzo_be_owner in their migration.',
    ).toEqual([]);
  });

  it('migrator and operator are owner members; app and maintenance are NOT', async () => {
    const rows = await queryRows<{ role: string; is_member: boolean }>(
      drizzleSql`SELECT r.rolname AS role, pg_has_role(r.rolname, 'meepzo_be_owner', 'member') AS is_member
                 FROM pg_roles r WHERE r.rolname IN ('meepzo_be_migrator','meepzo_be_operator','meepzo_be_app','meepzo_be_maintenance')`,
    );
    const byRole = new Map(rows.map((row) => [row.role, row.is_member]));
    expect(byRole.get('meepzo_be_migrator')).toBe(true);
    expect(byRole.get('meepzo_be_operator')).toBe(true);
    expect(byRole.get('meepzo_be_app')).toBe(false);
    expect(byRole.get('meepzo_be_maintenance')).toBe(false);
  });

  it('SECURITY DEFINER resolver functions are NOT owned by meepzo_be_owner (non-exempt definer would zero them out)', async () => {
    const rows = await queryRows<{ proname: string; owner: string }>(
      drizzleSql`SELECT p.proname, pg_get_userbyid(p.proowner) AS owner
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE p.prosecdef AND n.nspname IN ('auth','tenancy','billing','notify','audit','upload','app')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.owner, `${row.proname} definer owner`).not.toBe('meepzo_be_owner');
    }
  });

  it('SECURITY DEFINER functions are executable by the two runtime roles only, never PUBLIC', async () => {
    // They run as their RLS-exempt owner (one returns a password hash): PUBLIC would hand that to
    // every role that can log in. The maintenance-only definers (MAINTENANCE_ONLY_DEFINER_FUNCTIONS)
    // are narrower still: the maintenance role alone, never the app role.
    const rows = await queryRows<{
      signature: string;
      public_can_execute: boolean;
      app_can_execute: boolean;
      maintenance_can_execute: boolean;
    }>(
      drizzleSql`SELECT p.oid::regprocedure::text AS signature,
                        EXISTS (
                          SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
                          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
                        ) AS public_can_execute,
                        has_function_privilege('meepzo_be_app', p.oid, 'EXECUTE') AS app_can_execute,
                        has_function_privilege('meepzo_be_maintenance', p.oid, 'EXECUTE') AS maintenance_can_execute
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE p.prosecdef AND n.nspname IN ('auth','tenancy','billing','notify','audit','upload','app')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const signature of MAINTENANCE_ONLY_DEFINER_FUNCTIONS) {
      expect(
        rows.map((row) => row.signature),
        `${signature} is a SECURITY DEFINER function`,
      ).toContain(signature);
    }
    for (const row of rows) {
      expect(row.public_can_execute, `${row.signature}: REVOKE EXECUTE … FROM PUBLIC`).toBe(false);
      if (MAINTENANCE_ONLY_DEFINER_FUNCTIONS.includes(row.signature)) {
        expect(row.app_can_execute, `${row.signature}: never EXECUTE for meepzo_be_app`).toBe(
          false,
        );
        expect(row.maintenance_can_execute, `${row.signature}: maintenance only`).toBe(true);
        continue;
      }
      expect(row.app_can_execute, `${row.signature}: GRANT EXECUTE … TO meepzo_be_app`).toBe(true);
      expect(
        row.maintenance_can_execute,
        `${row.signature}: GRANT EXECUTE … TO meepzo_be_maintenance`,
      ).toBe(true);
    }
  });
});
