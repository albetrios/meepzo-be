import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';

/**
 * B2-5: a clinic record cannot point at another clinic's record.
 *
 * Each foreign key below was a single column (`<child>.<column>` -> `<parent>.id`), so a row of one
 * clinic could name the row of another. It is now the composite key
 * `(organization_id, <column>) -> <parent> (organization_id, id)` — see
 * `20261101101100_tenant_composite_foreign_keys.sql`. The catalog test pins each constraint; the
 * behaviour test points a row of one clinic at the matching record of a second clinic and expects that
 * exact constraint to refuse it, for every converted link. Under the old single-column keys the same
 * update succeeds, since the record it names exists.
 */
type DeleteAction = 'cascade' | 'restrict' | 'set null';

type Conversion = {
  /** Schema-qualified child table. */
  table: string;
  column: string;
  /** Schema-qualified parent table. */
  parent: string;
  constraint: string;
  onDelete: DeleteAction;
};

function link(
  table: string,
  column: string,
  parent: string,
  onDelete: DeleteAction,
  constraint: string,
): Conversion {
  return { table, column, parent, constraint, onDelete };
}

const CONVERSIONS: readonly Conversion[] = [
  link('tenancy.memberships', 'role_id', 'tenancy.roles', 'restrict', 'memberships_role_fk'),
  link(
    'tenancy.membership_additional_roles',
    'membership_id',
    'tenancy.memberships',
    'cascade',
    'membership_additional_roles_membership_fk',
  ),
  link(
    'tenancy.membership_additional_roles',
    'role_id',
    'tenancy.roles',
    'cascade',
    'membership_additional_roles_role_fk',
  ),
];

/** `pg_constraint.confdeltype` → the `ON DELETE` clause the migration writes. */
const DELETE_ACTION_BY_CODE: Readonly<Record<string, DeleteAction | 'no action'>> = {
  a: 'no action',
  c: 'cascade',
  n: 'set null',
  r: 'restrict',
};

/** Rows of a `database.execute()` / operator query result. */
function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

/**
 * An organization with every converted link set: a member with a role and an additional role (the
 * parent rows the other organization's children are re-pointed at).
 */
async function seedOrganizationWithLinks(): Promise<{ id: number }> {
  const owner = await createTestUser();
  const organization = await createTestOrganization({ ownerUserId: owner.id });
  const role = await createRoleWithPermissions({
    organizationId: organization.id,
    permissionCodes: [],
  });
  const additionalRole = await createRoleWithPermissions({
    organizationId: organization.id,
    permissionCodes: [],
  });
  const member = await createTestUser();
  const membership = await createMembership({
    userId: member.id,
    organizationId: organization.id,
    roleId: role.id,
  });
  await operatorQuery.unsafe(
    `INSERT INTO tenancy.membership_additional_roles (membership_id, role_id, organization_id, position)
     VALUES ($1, $2, $3, 1)`,
    [membership.id, additionalRole.id, organization.id],
  );
  return { id: organization.id };
}

describe('Integration: tenant composite foreign keys (B2-5)', () => {
  let victim: { id: number };
  let other: { id: number };

  beforeAll(async () => {
    await cleanupDatabase();
    // Two organizations: the victim's rows are re-pointed at the other organization's records.
    victim = await seedOrganizationWithLinks();
    other = await seedOrganizationWithLinks();
  });

  it('keeps every converted constraint composite, on the organization column and the same delete action', async () => {
    const rows = rowsOf<{
      constraint_name: string;
      child_table: string;
      child_columns: string;
      parent_columns: string;
      parent_table: string;
      delete_action: string;
      delete_set_columns: string | null;
      is_validated: boolean;
    }>(
      await operatorQuery.unsafe(
        `
        SELECT c.conname AS constraint_name,
               c.conrelid::regclass::text AS child_table,
               (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                  FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_columns,
               (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                  FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_columns,
               (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                  FROM unnest(c.confdelsetcols) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS delete_set_columns,
               c.confrelid::regclass::text AS parent_table,
               c.confdeltype::text AS delete_action,
               c.convalidated AS is_validated
          FROM pg_constraint c
         WHERE c.contype = 'f' AND c.conname = ANY($1)
        `,
        [CONVERSIONS.map((conversion) => conversion.constraint)],
      ),
    );
    const byName = new Map(rows.map((row) => [row.constraint_name, row]));
    for (const conversion of CONVERSIONS) {
      const row = byName.get(conversion.constraint);
      expect(row, `${conversion.constraint} does not exist`).toBeDefined();
      expect(row?.child_table).toBe(conversion.table);
      expect(row?.child_columns).toBe(`organization_id,${conversion.column}`);
      expect(row?.parent_table).toBe(conversion.parent);
      expect(row?.parent_columns).toBe('organization_id,id');
      expect(row?.is_validated, `${conversion.constraint} was left NOT VALID`).toBe(true);
      expect(DELETE_ACTION_BY_CODE[row?.delete_action ?? '']).toBe(conversion.onDelete);
      // SET NULL names the link column alone: clearing organization_id would break its NOT NULL.
      expect(row?.delete_set_columns ?? null).toBe(
        conversion.onDelete === 'set null' ? conversion.column : null,
      );
    }

    // The single-column keys they replaced are gone: no converted column refers to its parent alone.
    const singleColumn = rowsOf<{ constraint_name: string }>(
      await operatorQuery.unsafe(
        `
        SELECT c.conname AS constraint_name
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.contype = 'f' AND cardinality(c.conkey) = 1
           AND c.conrelid::regclass::text || '.' || a.attname || '>' || c.confrelid::regclass::text = ANY($1)
        `,
        [
          CONVERSIONS.map(
            (conversion) => `${conversion.table}.${conversion.column}>${conversion.parent}`,
          ),
        ],
      ),
    );
    expect(singleColumn.map((row) => row.constraint_name)).toEqual([]);
  });

  it.each(
    CONVERSIONS.map((conversion) => [`${conversion.table}.${conversion.column}`, conversion]),
  )("refuses a %s that names another clinic's record", async (_label, conversion) => {
    const { table, column, parent } = conversion;
    // A victim row, preferring one whose link is set.
    const [child] = rowsOf<{ location: string }>(
      await operatorQuery.unsafe(
        `SELECT ctid::text AS location FROM ${table}
            WHERE organization_id = $1
            ORDER BY (${column} IS NULL), ctid LIMIT 1`,
        [victim.id],
      ),
    );
    expect(child, `the seed creates no ${table} row`).toBeDefined();
    // A record of the other organization, preferring one no row links to yet (a link can be unique).
    const [foreignRecord] = rowsOf<{ id: number }>(
      await operatorQuery.unsafe(
        `SELECT p.id FROM ${parent} p
            WHERE p.organization_id = $1
            ORDER BY EXISTS (SELECT 1 FROM ${table} c WHERE c.${column} = p.id), p.id LIMIT 1`,
        [other.id],
      ),
    );
    expect(foreignRecord, `the seed creates no ${parent} row in the other clinic`).toBeDefined();

    const failure = await operatorQuery
      .unsafe(`UPDATE ${table} SET ${column} = $1 WHERE ctid = $2::tid`, [
        foreignRecord?.id,
        child?.location,
      ])
      .then(
        () => null,
        (error: unknown) => error as { code?: string; constraint?: string; message?: string },
      );
    expect(failure, `${table}.${column} accepted another clinic's ${parent} row`).not.toBeNull();
    expect(failure?.code, failure?.message).toBe('23503');
    expect(failure?.constraint).toBe(conversion.constraint);
  });
});
