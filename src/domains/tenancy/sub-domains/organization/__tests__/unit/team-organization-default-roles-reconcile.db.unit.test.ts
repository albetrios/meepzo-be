import { and, eq, inArray, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { role_permissions } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { MEMBERSHIP_STATUS } from '@/domains/tenancy/sub-domains/membership/membership.constants.js';
import {
  DEFAULT_TEAM_ROLES,
  OWNER_ROLE_NAME,
  provisionOrganizationWithOwner,
  provisionPersonalOrganization,
  reconcileDefaultTeamRoles,
} from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { database } from '@/infrastructure/database/connection.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

const APP_CODES: readonly string[] = Object.values(APP_PERMISSIONS);
const MEMBER_CODES = DEFAULT_TEAM_ROLES.find(
  (role) => role.name === MEMBER_ROLE_NAME,
)!.permissionCodes;

/** A TEAM organization as it was before launch IA2: no Member role, no app code on any role. */
async function provisionTeamFromBeforeTheChange(slug: string) {
  const owner = await createTestUser();
  const team = await provisionOrganizationWithOwner({
    name: `Team ${slug}`,
    slug,
    type: 'TEAM',
    ownerUserId: owner.id,
  });
  const organizationRoles = await database
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(eq(roles.organization_id, team.organization.id));
  await database.delete(role_permissions).where(
    and(
      inArray(
        role_permissions.role_id,
        organizationRoles.map((role) => role.id),
      ),
      inArray(role_permissions.permission_code, [...APP_CODES]),
    ),
  );
  await database
    .delete(roles)
    .where(and(eq(roles.organization_id, team.organization.id), eq(roles.name, MEMBER_ROLE_NAME)));
  return { owner, team };
}

/** The organization's live roles with their sorted codes, by name. */
async function liveRolesOf(organizationId: number) {
  const rows = await database
    .select({
      id: roles.id,
      public_id: roles.public_id,
      name: roles.name,
      tone: roles.tone,
      is_system: roles.is_system,
      is_locked: roles.is_locked,
    })
    .from(roles)
    .where(and(eq(roles.organization_id, organizationId), isNull(roles.deleted_at)));
  const result = new Map<string, (typeof rows)[number] & { codes: string[] }>();
  for (const row of rows) {
    const grants = await database
      .select({ code: role_permissions.permission_code })
      .from(role_permissions)
      .where(eq(role_permissions.role_id, row.id));
    result.set(row.name, { ...row, codes: grants.map((grant) => grant.code).sort() });
  }
  return result;
}

/**
 * Launch IA2 / IAC2, IQ5 (AC-1.5, AC-1.6): `reconcileDefaultTeamRoles` gives a team that existed
 * before the change exactly what provisioning gives a new one — the locked Member role and the
 * nine app codes on Owner and Admin — renames a clashing custom "Member", and changes nothing the
 * second time.
 */
describe('reconcileDefaultTeamRoles (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
  });

  it('adds the locked Member role and the nine codes to a team created before the change', async () => {
    const { team } = await provisionTeamFromBeforeTheChange('reconcile-before-change');
    const before = await liveRolesOf(team.organization.id);
    expect(before.has(MEMBER_ROLE_NAME)).toBe(false);
    expect(before.get(OWNER_ROLE_NAME)!.codes).not.toContain(APP_PERMISSIONS.CONTACT_READ);

    const result = await reconcileDefaultTeamRoles();

    expect(result).toMatchObject({ organizations: 1, changedOrganizations: 1, addedRoles: 1 });
    const after = await liveRolesOf(team.organization.id);
    const member = after.get(MEMBER_ROLE_NAME)!;
    expect(member).toMatchObject({ is_system: true, is_locked: true, tone: 'sage' });
    expect(member.public_id.startsWith('rol_')).toBe(true);
    expect(member.codes).toEqual([...MEMBER_CODES].sort());
    for (const name of [OWNER_ROLE_NAME, ADMIN_ROLE_NAME]) {
      for (const code of APP_CODES) {
        expect(after.get(name)!.codes).toContain(code);
      }
    }
  });

  it('ends with the same roles and codes as a team provisioned today', async () => {
    const { team: reconciled } = await provisionTeamFromBeforeTheChange('reconcile-old-team');
    const owner = await createTestUser();
    const fresh = await provisionOrganizationWithOwner({
      name: 'Fresh Team',
      slug: 'reconcile-fresh-team',
      type: 'TEAM',
      ownerUserId: owner.id,
    });

    await reconcileDefaultTeamRoles();

    const shape = async (organizationId: number) =>
      [...(await liveRolesOf(organizationId)).values()]
        .map((role) => [role.name, role.tone, role.is_system, role.is_locked, role.codes])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    expect(await shape(reconciled.organization.id)).toEqual(await shape(fresh.organization.id));
  });

  it('renames a custom role named "Member" to "Member (custom)", keeping its people and codes (IQ5)', async () => {
    const { team } = await provisionTeamFromBeforeTheChange('reconcile-clashing-member');
    const [customRole] = await database
      .insert(roles)
      .values({
        public_id: generatePublicId('memberRole'),
        organization_id: team.organization.id,
        name: MEMBER_ROLE_NAME,
        is_system: false,
      })
      .returning({ id: roles.id, public_id: roles.public_id });
    await database.insert(role_permissions).values([
      { role_id: customRole!.id, permission_code: 'membership:read' },
      { role_id: customRole!.id, permission_code: 'contact:delete' },
    ]);
    const person = await createTestUser();
    await database.insert(memberships).values({
      public_id: generatePublicId('membership'),
      user_id: person.id,
      organization_id: team.organization.id,
      role_id: customRole!.id,
      status: MEMBERSHIP_STATUS.ACTIVE,
      joined_at: new Date(),
    });

    const result = await reconcileDefaultTeamRoles();

    expect(result).toMatchObject({ renamedRoles: 1, addedRoles: 1 });
    const after = await liveRolesOf(team.organization.id);
    const renamed = after.get('Member (custom)')!;
    expect(renamed).toMatchObject({
      id: customRole!.id,
      public_id: customRole!.public_id,
      is_system: false,
      is_locked: false,
    });
    expect(renamed.codes).toEqual(['contact:delete', 'membership:read']);
    const [membership] = await database
      .select({ role_id: memberships.role_id })
      .from(memberships)
      .where(eq(memberships.user_id, person.id));
    expect(membership!.role_id).toBe(customRole!.id);
    const member = after.get(MEMBER_ROLE_NAME)!;
    expect(member.id).not.toBe(customRole!.id);
    expect(member).toMatchObject({ is_system: true, is_locked: true });
    expect(member.codes).toEqual([...MEMBER_CODES].sort());
  });

  it('changes nothing the second time (twice = once)', async () => {
    const { team } = await provisionTeamFromBeforeTheChange('reconcile-twice');
    await reconcileDefaultTeamRoles();
    const afterFirst = await liveRolesOf(team.organization.id);

    const second = await reconcileDefaultTeamRoles();

    expect(second).toEqual({
      organizations: 1,
      changedOrganizations: 0,
      addedRoles: 0,
      renamedRoles: 0,
      grantedCodes: 0,
    });
    expect(await liveRolesOf(team.organization.id)).toEqual(afterFirst);
  });

  it('leaves a personal organization alone: Owner only, none of the nine codes', async () => {
    const user = await createTestUser();
    const personal = await provisionPersonalOrganization({ ownerUserId: user.id });

    const result = await reconcileDefaultTeamRoles();

    expect(result.organizations).toBe(0);
    const after = await liveRolesOf(personal.organization.id);
    expect([...after.keys()]).toEqual([OWNER_ROLE_NAME]);
    for (const code of APP_CODES) {
      expect(after.get(OWNER_ROLE_NAME)!.codes).not.toContain(code);
    }
  });
});
