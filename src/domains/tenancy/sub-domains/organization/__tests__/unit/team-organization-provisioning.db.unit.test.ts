import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeEach } from 'vitest';
import { BILLING_PERMISSIONS } from '@/domains/billing/billing.permissions.js';
import { NOTIFY_PERMISSIONS } from '@/domains/notify/notify.permissions.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { UPLOAD_PERMISSIONS } from '@/domains/upload/upload.permissions.js';
import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  VIEWER_ROLE_NAME,
} from '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js';
import {
  DEFAULT_TEAM_ROLES,
  ownerPermissionCodesForOrganizationType,
  provisionOrganizationWithOwner,
  provisionPersonalOrganization,
} from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { role_permissions } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.schema.js';
import { database } from '@/infrastructure/database/connection.js';

describe('team organization provisioning (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
    // Seed the whole catalog, not a per-domain subset: the owner grant spans tenancy, audit,
    // upload, billing and notify, and every code carries a role_permissions → permissions FK,
    // so an enumerated subset breaks provisioning the next time a permission is added.
    await seedAllPermissions();
  });

  it('grants billing permissions to TEAM organization owners', async () => {
    const user = await createTestUser();

    const result = await provisionOrganizationWithOwner({
      name: 'Acme',
      slug: 'acme-team-provision',
      type: 'TEAM',
      ownerUserId: user.id,
    });

    const codes = ownerPermissionCodesForOrganizationType('TEAM');
    expect(codes).toContain(BILLING_PERMISSIONS.SUBSCRIPTION_READ);
    expect(codes).toContain(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE);

    const rows = await database
      .select({ permission_code: role_permissions.permission_code })
      .from(role_permissions)
      .where(eq(role_permissions.role_id, result.roleId));

    const granted = rows.map((row) => row.permission_code);
    expect(granted).toContain(BILLING_PERMISSIONS.SUBSCRIPTION_READ);
    expect(granted).toContain(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE);
  });

  it('grants notify (webhook) permissions to TEAM organization owners', async () => {
    // Regression: webhook:read / webhook:manage were seeded into
    // tenancy.permissions and granted to NO role in ANY organization, ever. So
    // /notify/webhooks answered 403 to every caller including the owner, and the
    // frontend's integrations panel rendered an API-keys list under a heading
    // promising "API keys and webhooks". A permission nothing can hold is not a
    // boundary, it is a dead route.
    const user = await createTestUser();

    const result = await provisionOrganizationWithOwner({
      name: 'Acme Notify',
      slug: 'acme-team-notify-provision',
      type: 'TEAM',
      ownerUserId: user.id,
    });

    const codes = ownerPermissionCodesForOrganizationType('TEAM');
    expect(codes).toContain(NOTIFY_PERMISSIONS.WEBHOOK_READ);
    expect(codes).toContain(NOTIFY_PERMISSIONS.WEBHOOK_MANAGE);

    const rows = await database
      .select({ permission_code: role_permissions.permission_code })
      .from(role_permissions)
      .where(eq(role_permissions.role_id, result.roleId));

    const granted = rows.map((row) => row.permission_code);
    expect(granted).toContain(NOTIFY_PERMISSIONS.WEBHOOK_READ);
    expect(granted).toContain(NOTIFY_PERMISSIONS.WEBHOOK_MANAGE);
  });

  it('grants a PERSONAL owner the billing read code but not the write half', async () => {
    // This reads the table rather than the function on purpose. The pure
    // contract is pinned without a database in owner-permission-codes.unit.test.ts;
    // a pure assertion parked in a `.db.` file only runs where Postgres runs,
    // which is how the previous version of this expectation survived a local
    // run and failed in CI.
    //
    // Billing is account-level, so the read half follows an owner into a
    // personal workspace. `subscription:manage` stays a TEAM surface, and so do
    // webhooks.
    const user = await createTestUser();

    const result = await provisionPersonalOrganization({ ownerUserId: user.id });

    const rows = await database
      .select({ permission_code: role_permissions.permission_code })
      .from(role_permissions)
      .where(eq(role_permissions.role_id, result.roleId));

    const granted = rows.map((row) => row.permission_code);
    expect(granted).toContain(BILLING_PERMISSIONS.SUBSCRIPTION_READ);
    expect(granted).not.toContain(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE);
    expect(granted).not.toContain(NOTIFY_PERMISSIONS.WEBHOOK_READ);
    expect(granted).not.toContain(NOTIFY_PERMISSIONS.WEBHOOK_MANAGE);
    // Launch IA3: the app surface is team-only — a personal owner holds none of the nine.
    for (const code of Object.values(APP_PERMISSIONS)) {
      expect(granted).not.toContain(code);
    }
  });

  it('provisions the default team roles as system roles for a TEAM org (launch D5, D40)', async () => {
    const user = await createTestUser();

    const result = await provisionOrganizationWithOwner({
      name: 'Acme Defaults',
      slug: 'acme-team-default-roles',
      type: 'TEAM',
      ownerUserId: user.id,
    });

    const roleRows = await database
      .select({
        id: roles.id,
        name: roles.name,
        is_system: roles.is_system,
        public_id: roles.public_id,
      })
      .from(roles)
      .where(eq(roles.organization_id, result.organization.id));

    // Owner + every default role, all immutable and correctly prefixed.
    expect(roleRows.map((row) => row.name).sort()).toEqual(
      ['Owner', ...DEFAULT_TEAM_ROLES.map((role) => role.name)].sort(),
    );
    for (const row of roleRows) {
      expect(row.is_system).toBe(true);
      expect(row.public_id.startsWith('rol_')).toBe(true);
    }

    // Admin, Editor and Viewer carry organization:read so an assigned person can load the
    // organization (launch D31). Editor's and Viewer's codes are pinned exactly below.
    const adminRow = roleRows.find((candidate) => candidate.name === ADMIN_ROLE_NAME)!;
    const adminGrants = await database
      .select({ code: role_permissions.permission_code })
      .from(role_permissions)
      .where(eq(role_permissions.role_id, adminRow.id));
    expect(adminGrants.map((grant) => grant.code)).toContain(TENANCY_PERMISSIONS.ORGANIZATION_READ);
    for (const name of [EDITOR_ROLE_NAME, VIEWER_ROLE_NAME]) {
      const row = roleRows.find((candidate) => candidate.name === name)!;
      const grants = await database
        .select({ code: role_permissions.permission_code })
        .from(role_permissions)
        .where(eq(role_permissions.role_id, row.id));
      expect(grants.map((grant) => grant.code)).toContain(TENANCY_PERMISSIONS.ORGANIZATION_READ);
    }

    // Each default role's granted codes match its catalog entry exactly.
    for (const defaultRole of DEFAULT_TEAM_ROLES) {
      const row = roleRows.find((candidate) => candidate.name === defaultRole.name)!;
      const grants = await database
        .select({ code: role_permissions.permission_code })
        .from(role_permissions)
        .where(eq(role_permissions.role_id, row.id));
      expect(grants.map((grant) => grant.code).sort()).toEqual(
        [...defaultRole.permissionCodes].sort(),
      );
    }
  });

  it('gives a new team exactly the four roles and their codes: Owner and Admin every app code, Editor and Viewer theirs (launch IA2, TN1, AC-12.1)', async () => {
    const user = await createTestUser();

    const result = await provisionOrganizationWithOwner({
      name: 'Acme App Codes',
      slug: 'acme-team-app-codes',
      type: 'TEAM',
      ownerUserId: user.id,
    });

    const roleRows = await database
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(eq(roles.organization_id, result.organization.id));
    const appCodes = new Set<string>(Object.values(APP_PERMISSIONS));
    const grantsOf = async (name: string): Promise<string[]> => {
      const row = roleRows.find((candidate) => candidate.name === name)!;
      const grants = await database
        .select({ code: role_permissions.permission_code })
        .from(role_permissions)
        .where(eq(role_permissions.role_id, row.id));
      return grants.map((grant) => grant.code).sort();
    };
    const appGrantsOf = async (name: string): Promise<string[]> =>
      (await grantsOf(name)).filter((code) => appCodes.has(code));

    expect(roleRows.map((row) => row.name).sort()).toEqual(['Admin', 'Editor', 'Owner', 'Viewer']);

    expect(await appGrantsOf('Owner')).toEqual([...appCodes].sort());
    expect(await appGrantsOf(ADMIN_ROLE_NAME)).toEqual([...appCodes].sort());
    // The plan's table (plan:L7867–L7877): Editor makes, runs and deletes automations, tags and
    // notes contacts and uploads message files; Viewer only reads.
    expect(await grantsOf(EDITOR_ROLE_NAME)).toEqual(
      [
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
        UPLOAD_PERMISSIONS.UPLOAD_MANAGE,
        APP_PERMISSIONS.CHANNEL_ACCOUNT_READ,
        APP_PERMISSIONS.INSTAGRAM_ACCOUNT_READ,
        APP_PERMISSIONS.AUTOMATION_READ,
        APP_PERMISSIONS.AUTOMATION_CREATE,
        APP_PERMISSIONS.AUTOMATION_UPDATE,
        APP_PERMISSIONS.AUTOMATION_DELETE,
        APP_PERMISSIONS.CONTACT_READ,
        APP_PERMISSIONS.CONTACT_UPDATE,
      ].sort(),
    );
    expect(await grantsOf(VIEWER_ROLE_NAME)).toEqual(
      [
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
        APP_PERMISSIONS.CHANNEL_ACCOUNT_READ,
        APP_PERMISSIONS.INSTAGRAM_ACCOUNT_READ,
        APP_PERMISSIONS.AUTOMATION_READ,
        APP_PERMISSIONS.CONTACT_READ,
      ].sort(),
    );
    expect(await appGrantsOf(ADMIN_ROLE_NAME)).toContain(APP_PERMISSIONS.CONTACT_UPDATE);
  });

  it("locks the Owner role and gives every role the design's tone (D81 (4))", async () => {
    const user = await createTestUser();

    const result = await provisionOrganizationWithOwner({
      name: 'Acme Tones',
      slug: 'acme-team-role-tones',
      type: 'TEAM',
      ownerUserId: user.id,
    });

    const roleRows = await database
      .select({ name: roles.name, tone: roles.tone, is_locked: roles.is_locked })
      .from(roles)
      .where(eq(roles.organization_id, result.organization.id));

    expect(Object.fromEntries(roleRows.map((row) => [row.name, row.tone]))).toEqual({
      Owner: 'slate',
      ...Object.fromEntries(DEFAULT_TEAM_ROLES.map((role) => [role.name, role.tone])),
    });
    expect(
      roleRows
        .filter((row) => row.is_locked)
        .map((row) => row.name)
        .sort(),
    ).toEqual(['Admin', 'Editor', 'Owner', 'Viewer']);
  });

  it('provisions only the Owner role for a PERSONAL organization (no default team roles)', async () => {
    const user = await createTestUser();

    const result = await provisionOrganizationWithOwner({
      name: 'Personal Space',
      slug: null,
      type: 'PERSONAL',
      ownerUserId: user.id,
    });

    const roleRows = await database
      .select({ name: roles.name })
      .from(roles)
      .where(eq(roles.organization_id, result.organization.id));

    expect(roleRows.map((row) => row.name)).toEqual(['Owner']);
  });
});
