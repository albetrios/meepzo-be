import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { UPLOAD_PERMISSIONS } from '@/domains/upload/upload.permissions.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  FORMER_EDITOR_ROLE_NAME,
  VIEWER_ROLE_NAME,
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
import { getOperatorPool } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

const APP_CODES: readonly string[] = Object.values(APP_PERMISSIONS);
const codesOf = (name: string): string[] =>
  [...DEFAULT_TEAM_ROLES.find((role) => role.name === name)!.permissionCodes].sort();

/** The launch's Member role's six codes (launch D2, K4, D31). */
const LAUNCH_MEMBER_CODES = [
  'organization:read',
  APP_PERMISSIONS.INSTAGRAM_ACCOUNT_READ,
  APP_PERMISSIONS.AUTOMATION_READ,
  APP_PERMISSIONS.AUTOMATION_CREATE,
  APP_PERMISSIONS.AUTOMATION_UPDATE,
  APP_PERMISSIONS.CONTACT_READ,
];

/** A person holding `roleId` in `organizationId`. */
async function addPerson({ organizationId, roleId }: { organizationId: number; roleId: number }) {
  const person = await createTestUser();
  await database.insert(memberships).values({
    public_id: generatePublicId('membership'),
    user_id: person.id,
    organization_id: organizationId,
    role_id: roleId,
    status: MEMBERSHIP_STATUS.ACTIVE,
    joined_at: new Date(),
  });
  return person;
}

/**
 * A TEAM organization as the launch left it (launch IA2): Owner, Admin and the locked Member role
 * with its six codes, no Viewer, no `contact:update` anywhere — and one person holding Member.
 */
async function provisionLaunchTeam(slug: string) {
  const owner = await createTestUser();
  const team = await provisionOrganizationWithOwner({
    name: `Team ${slug}`,
    slug,
    type: 'TEAM',
    ownerUserId: owner.id,
  });
  const organizationId = team.organization.id;
  await database
    .delete(roles)
    .where(and(eq(roles.organization_id, organizationId), eq(roles.name, VIEWER_ROLE_NAME)));
  const [member] = await database
    .update(roles)
    .set({
      name: FORMER_EDITOR_ROLE_NAME,
      description: 'Does the daily work: Instagram content, automations and contacts.',
    })
    .where(and(eq(roles.organization_id, organizationId), eq(roles.name, EDITOR_ROLE_NAME)))
    .returning({ id: roles.id, public_id: roles.public_id });
  await database
    .delete(role_permissions)
    .where(
      and(
        eq(role_permissions.role_id, member!.id),
        inArray(role_permissions.permission_code, [
          APP_PERMISSIONS.AUTOMATION_DELETE,
          UPLOAD_PERMISSIONS.UPLOAD_MANAGE,
        ]),
      ),
    );
  const organizationRoleIds = (
    await database
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.organization_id, organizationId))
  ).map((role) => role.id);
  await database
    .delete(role_permissions)
    .where(
      and(
        inArray(role_permissions.role_id, organizationRoleIds),
        eq(role_permissions.permission_code, APP_PERMISSIONS.CONTACT_UPDATE),
      ),
    );
  const person = await addPerson({ organizationId, roleId: member!.id });
  return { owner, team, member: member!, person };
}

/** The organization's live roles with their sorted codes, by name. */
async function liveRolesOf(organizationId: number) {
  const rows = await database
    .select({
      id: roles.id,
      public_id: roles.public_id,
      name: roles.name,
      description: roles.description,
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

/** The roles' shape without ids — what two organizations can share. */
async function shapeOf(organizationId: number) {
  return [...(await liveRolesOf(organizationId)).values()]
    .map((role) => [
      role.name,
      role.description,
      role.tone,
      role.is_system,
      role.is_locked,
      role.codes,
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
}

/** The role a person holds as their main one. */
async function mainRoleOf(userId: number): Promise<number> {
  const [membership] = await database
    .select({ role_id: memberships.role_id })
    .from(memberships)
    .where(eq(memberships.user_id, userId));
  return membership!.role_id;
}

/**
 * Applies the two R28 tenancy migrations' data steps again, in order, on the operator connection
 * (it bypasses row-level security; the files' NO FORCE / FORCE brackets are the table owner's and
 * are left out).
 */
async function applyRolesMigrations(): Promise<void> {
  for (const file of [
    '20261124072815_tenancy_permission_contact_update.sql',
    '20261124072816_tenancy_roles_editor_viewer.sql',
  ]) {
    const statements = readFileSync(resolve(process.cwd(), 'migrations', file), 'utf8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.replace(/^(--[^\n]*\n|\s*\n)*/, '').trim())
      .filter((statement) => statement.length > 0 && !/^ALTER TABLE/i.test(statement));
    for (const statement of statements) await getOperatorPool().query(statement);
  }
}

/**
 * feat-instagram-dm-sending R28 (routes-final § 9.1 TN1, TN2, § 9.11 TNC1; AC-12.1): a team the
 * launch made — Owner, Admin, the locked Member — ends with exactly what a team provisioned today
 * holds, whether the migrations or `reconcileDefaultTeamRoles` get there first: Member renamed
 * Editor (the same row and people) with its three new codes, a locked Viewer, `contact:update` on
 * Owner, Admin and Editor. A clashing custom role moves aside (launch IQ5); a second run changes
 * nothing.
 */
describe('default team roles: Member → Editor, Viewer added (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
  });

  describe('reconcileDefaultTeamRoles', () => {
    it('renames Member to Editor in place, adds its codes and a locked Viewer, and contact:update on Owner and Admin', async () => {
      const { team, member, person } = await provisionLaunchTeam('reconcile-launch-team');
      const before = await liveRolesOf(team.organization.id);
      expect(before.get(FORMER_EDITOR_ROLE_NAME)!.codes).toEqual([...LAUNCH_MEMBER_CODES].sort());
      expect(before.has(VIEWER_ROLE_NAME)).toBe(false);

      const result = await reconcileDefaultTeamRoles();

      expect(result).toMatchObject({
        organizations: 1,
        changedOrganizations: 1,
        addedRoles: 1,
        renamedSystemRoles: 1,
        renamedRoles: 0,
      });
      const after = await liveRolesOf(team.organization.id);
      expect([...after.keys()].sort()).toEqual(['Admin', 'Editor', 'Owner', 'Viewer']);
      expect(after.get(EDITOR_ROLE_NAME)).toMatchObject({
        id: member.id,
        public_id: member.public_id,
        description: 'Makes and runs automations and keeps contacts tidy.',
        is_system: true,
        is_locked: true,
        tone: 'sage',
        codes: codesOf(EDITOR_ROLE_NAME),
      });
      expect(await mainRoleOf(person.id)).toBe(member.id);
      const viewer = after.get(VIEWER_ROLE_NAME)!;
      expect(viewer).toMatchObject({ is_system: true, is_locked: true, tone: 'sky' });
      expect(viewer.public_id).toMatch(/^rol_[a-z0-9]{21}$/);
      expect(viewer.codes).toEqual(codesOf(VIEWER_ROLE_NAME));
      for (const name of [OWNER_ROLE_NAME, ADMIN_ROLE_NAME]) {
        for (const code of APP_CODES) expect(after.get(name)!.codes).toContain(code);
      }
    });

    it('ends with the same roles and codes as a team provisioned today', async () => {
      const { team: reconciled } = await provisionLaunchTeam('reconcile-old-team');
      const owner = await createTestUser();
      const fresh = await provisionOrganizationWithOwner({
        name: 'Fresh Team',
        slug: 'reconcile-fresh-team',
        type: 'TEAM',
        ownerUserId: owner.id,
      });

      await reconcileDefaultTeamRoles();

      expect(await shapeOf(reconciled.organization.id)).toEqual(
        await shapeOf(fresh.organization.id),
      );
    });

    it('moves a custom role named "Editor" to "Editor (custom)", keeping its people and codes (IQ5)', async () => {
      const { team, member } = await provisionLaunchTeam('reconcile-clashing-editor');
      const [customRole] = await database
        .insert(roles)
        .values({
          public_id: generatePublicId('memberRole'),
          organization_id: team.organization.id,
          name: EDITOR_ROLE_NAME,
          is_system: false,
        })
        .returning({ id: roles.id, public_id: roles.public_id });
      await database.insert(role_permissions).values([
        { role_id: customRole!.id, permission_code: 'membership:read' },
        { role_id: customRole!.id, permission_code: 'contact:delete' },
      ]);
      const person = await addPerson({
        organizationId: team.organization.id,
        roleId: customRole!.id,
      });

      const result = await reconcileDefaultTeamRoles();

      expect(result).toMatchObject({ renamedRoles: 1, renamedSystemRoles: 1, addedRoles: 1 });
      const after = await liveRolesOf(team.organization.id);
      expect(after.get('Editor (custom)')).toMatchObject({
        id: customRole!.id,
        public_id: customRole!.public_id,
        is_system: false,
        is_locked: false,
        codes: ['contact:delete', 'membership:read'],
      });
      expect(await mainRoleOf(person.id)).toBe(customRole!.id);
      expect(after.get(EDITOR_ROLE_NAME)).toMatchObject({ id: member.id, is_system: true });
    });

    it('changes nothing the second time (twice = once)', async () => {
      const { team } = await provisionLaunchTeam('reconcile-twice');
      await reconcileDefaultTeamRoles();
      const afterFirst = await liveRolesOf(team.organization.id);

      const second = await reconcileDefaultTeamRoles();

      expect(second).toEqual({
        organizations: 1,
        changedOrganizations: 0,
        addedRoles: 0,
        renamedRoles: 0,
        renamedSystemRoles: 0,
        grantedCodes: 0,
      });
      expect(await liveRolesOf(team.organization.id)).toEqual(afterFirst);
    });

    it('leaves a personal organization alone: Owner only, no app code', async () => {
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

  describe('the migrations tenancy_permission_contact_update and tenancy_roles_editor_viewer', () => {
    it('bring a launch team to the shape of a team provisioned today; the reconcile then finds nothing to do', async () => {
      const { team, member, person } = await provisionLaunchTeam('migration-launch-team');
      const owner = await createTestUser();
      const fresh = await provisionOrganizationWithOwner({
        name: 'Fresh Migration Team',
        slug: 'migration-fresh-team',
        type: 'TEAM',
        ownerUserId: owner.id,
      });

      await applyRolesMigrations();

      expect(await shapeOf(team.organization.id)).toEqual(await shapeOf(fresh.organization.id));
      const after = await liveRolesOf(team.organization.id);
      expect(after.get(EDITOR_ROLE_NAME)).toMatchObject({
        id: member.id,
        public_id: member.public_id,
      });
      expect(after.get(VIEWER_ROLE_NAME)!.public_id).toMatch(/^rol_[a-z0-9]{21}$/);
      expect(await mainRoleOf(person.id)).toBe(member.id);
      expect((await reconcileDefaultTeamRoles()).changedOrganizations).toBe(0);
    });

    it('move a clashing custom "Viewer" aside and change nothing when run again', async () => {
      const { team } = await provisionLaunchTeam('migration-clashing-viewer');
      for (const name of [VIEWER_ROLE_NAME, 'Viewer (custom)']) {
        await database.insert(roles).values({
          public_id: generatePublicId('memberRole'),
          organization_id: team.organization.id,
          name,
          is_system: false,
        });
      }

      await applyRolesMigrations();
      const afterFirst = await liveRolesOf(team.organization.id);
      await applyRolesMigrations();

      expect(afterFirst.get(VIEWER_ROLE_NAME)).toMatchObject({ is_system: true, is_locked: true });
      expect(afterFirst.get('Viewer (custom 2)')).toMatchObject({ is_system: false });
      expect(afterFirst.get('Viewer (custom)')).toMatchObject({ is_system: false });
      expect(await liveRolesOf(team.organization.id)).toEqual(afterFirst);
    });
  });
});
