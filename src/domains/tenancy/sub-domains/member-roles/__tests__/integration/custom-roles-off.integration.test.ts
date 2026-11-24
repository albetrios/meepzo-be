import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMembership,
  createRoleWithPermissions,
  seedAllPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  VIEWER_ROLE_NAME,
} from '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { provisionOrganizationWithOwner } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';

/** The `error` of a refused answer. */
function errorOf(body: string): { reason?: string; detail: string } {
  return (JSON.parse(body) as { error: { reason?: string; detail: string } }).error;
}

/**
 * feat-instagram-dm-sending R28 (routes-final § 9.B, TN1–TN3; AC-12.2–AC-12.4) with the product's
 * switch as built — custom roles off: the five role writes (routes 111–115) answer `403
 * custom_roles_off` after the permission gate and change nothing, the role list still answers the
 * four system roles, a membership takes exactly one system role, and the Editor and Viewer roles
 * reach what the plan's table gives them.
 */
describe('Custom roles off and the four system roles (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
  });

  /** A provisioned TEAM organization: its owner's token and a token per system role. */
  async function team() {
    const owner = await createTestUser();
    const { organization } = await provisionOrganizationWithOwner({
      name: 'Roles Team',
      slug: `roles-team-${generatePublicId('organization').slice(4, 14)}`,
      type: 'TEAM',
      ownerUserId: owner.id,
    });
    const liveRoles = await getOperatorDatabase()
      .select({ id: roles.id, public_id: roles.public_id, name: roles.name })
      .from(roles)
      .where(and(eq(roles.organization_id, organization.id), isNull(roles.deleted_at)));
    const roleNamed = (name: string) => liveRoles.find((role) => role.name === name)!;
    const tokenOf = async (userPublicId: string) =>
      generateTestToken({ userId: userPublicId, organizationPublicId: organization.public_id });
    const holderOf = async (name: string) => {
      const user = await createTestUser();
      const membership = await createMembership({
        userId: user.id,
        organizationId: organization.id,
        roleId: roleNamed(name).id,
      });
      return { user, membership, token: await tokenOf(user.public_id) };
    };
    return {
      organization,
      roleNamed,
      ownerToken: await tokenOf(owner.public_id),
      editor: await holderOf(EDITOR_ROLE_NAME),
      viewer: await holderOf(VIEWER_ROLE_NAME),
    };
  }

  /** The live role names of the organization. */
  async function liveRoleNames(organizationId: number): Promise<string[]> {
    const rows = await getOperatorDatabase()
      .select({ name: roles.name })
      .from(roles)
      .where(and(eq(roles.organization_id, organizationId), isNull(roles.deleted_at)));
    return rows.map((row) => row.name).sort();
  }

  describe('routes 111–115 (AC-12.4)', () => {
    it('refuses create, edit, delete, restore and replacing codes with 403 custom_roles_off, changing nothing; the list still answers', async () => {
      const { organization, roleNamed, ownerToken } = await team();
      const custom = await createRoleWithPermissions({
        organizationId: organization.id,
        name: 'Old Custom',
        permissionCodes: ['organization:read'],
      });
      const before = await liveRoleNames(organization.id);
      const idempotent = () => ({ 'x-idempotency-key': `idem-${randomUUID()}` });

      const attempts = [
        {
          method: 'POST' as const,
          url: '/tenancy/organization/roles',
          payload: { name: 'Support' },
          headers: idempotent(),
        },
        {
          method: 'PATCH' as const,
          url: `/tenancy/organization/roles/${custom.public_id}`,
          payload: { name: 'Renamed' },
        },
        {
          method: 'DELETE' as const,
          url: `/tenancy/organization/roles/${custom.public_id}?reason=mistake`,
        },
        {
          method: 'PUT' as const,
          url: `/tenancy/organization/roles/${roleNamed(VIEWER_ROLE_NAME).public_id}/permissions`,
          payload: { permission_codes: ['organization:read'] },
        },
        {
          method: 'POST' as const,
          url: `/tenancy/organization/roles/${custom.public_id}/restore`,
          headers: idempotent(),
        },
      ];
      for (const attempt of attempts) {
        const response = await injectAuthenticated(app, {
          ...attempt,
          url: testApiPath(attempt.url),
          token: ownerToken,
        });
        expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
        expect(errorOf(response.body).reason).toBe('custom_roles_off');
      }
      expect(await liveRoleNames(organization.id)).toEqual(before);

      const list = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization/roles'),
        token: ownerToken,
      });
      expect(list.statusCode).toBe(200);
      expect(
        (JSON.parse(list.body) as { data: { name: string }[] }).data
          .map((role) => role.name)
          .sort(),
      ).toEqual(['Admin', 'Editor', 'Old Custom', 'Owner', 'Viewer']);
    });

    it('answers a caller without the code missing_permission first (the gate runs before the switch)', async () => {
      const { editor } = await team();
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/roles'),
        token: editor.token,
        payload: { name: 'Support' },
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
      });
      expect(response.statusCode).toBe(403);
      expect(errorOf(response.body).reason).toBe('missing_permission');
    });
  });

  describe('a membership takes one system role (TN3, P82)', () => {
    it('invites with one system role, and refuses two roles or a custom role with 403 custom_roles_off', async () => {
      const { organization, roleNamed, ownerToken } = await team();
      const custom = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: ['organization:read'],
      });
      const invite = (email: string, roleIds: string[]) =>
        injectAuthenticated(app, {
          method: 'POST',
          url: testApiPath('/tenancy/organization/memberships'),
          token: ownerToken,
          payload: { email, role_ids: roleIds },
          headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        });

      const two = await invite('two-roles@example.com', [
        roleNamed(EDITOR_ROLE_NAME).public_id,
        roleNamed(VIEWER_ROLE_NAME).public_id,
      ]);
      expect(two.statusCode).toBe(403);
      expect(errorOf(two.body).reason).toBe('custom_roles_off');
      const customAnswer = await invite('custom-role@example.com', [custom.public_id]);
      expect(customAnswer.statusCode).toBe(403);
      expect(errorOf(customAnswer.body).reason).toBe('custom_roles_off');

      const one = await invite('one-role@example.com', [roleNamed(VIEWER_ROLE_NAME).public_id]);
      expect(one.statusCode, one.body).toBe(200);
    });

    it('changes a member to one system role, and refuses two roles with 403 custom_roles_off', async () => {
      const { roleNamed, ownerToken, viewer } = await team();
      const change = (roleIds: string[]) =>
        injectAuthenticated(app, {
          method: 'PATCH',
          url: testApiPath(`/tenancy/organization/memberships/${viewer.membership.public_id}`),
          token: ownerToken,
          payload: { role_ids: roleIds },
        });

      const two = await change([
        roleNamed(EDITOR_ROLE_NAME).public_id,
        roleNamed(ADMIN_ROLE_NAME).public_id,
      ]);
      expect(two.statusCode).toBe(403);
      expect(errorOf(two.body).reason).toBe('custom_roles_off');

      const one = await change([roleNamed(EDITOR_ROLE_NAME).public_id]);
      expect(one.statusCode, one.body).toBe(200);
      expect((JSON.parse(one.body) as { data: { role_ids: string[] } }).data.role_ids).toEqual([
        roleNamed(EDITOR_ROLE_NAME).public_id,
      ]);
    });
  });

  describe('what Editor and Viewer reach (AC-12.2, AC-12.3)', () => {
    it('lets an Editor upload a message file and refuses a Viewer with missing_permission', async () => {
      const { organization, editor, viewer } = await team();
      const requestFile = (token: string) =>
        injectAuthenticated(app, {
          method: 'POST',
          url: testApiPath('/uploads'),
          token,
          payload: {
            purpose: 'message-media',
            for: 'organization',
            organization_id: organization.public_id,
            content_type: 'image/png',
            file_name: 'picture.png',
            file_size: 1024,
          },
        });

      expect((await requestFile(editor.token)).statusCode).toBe(200);
      const refused = await requestFile(viewer.token);
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused.body).reason).toBe('missing_permission');
    });

    it('refuses Editor and Viewer billing and member management, and lets both read the organization', async () => {
      const { editor, viewer } = await team();
      for (const holder of [editor, viewer]) {
        const billing = await injectAuthenticated(app, {
          method: 'POST',
          url: testApiPath(`/billing/subscriptions/${generatePublicId('subscription')}/resume`),
          token: holder.token,
          headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        });
        expect(billing.statusCode).toBe(403);
        expect(errorOf(billing.body).reason).toBe('missing_permission');
        const members = await injectAuthenticated(app, {
          method: 'GET',
          url: testApiPath('/tenancy/organization/memberships'),
          token: holder.token,
        });
        expect(members.statusCode).toBe(403);
        expect(errorOf(members.body).reason).toBe('missing_permission');
        const organizationRead = await injectAuthenticated(app, {
          method: 'GET',
          url: testApiPath('/tenancy/organization'),
          token: holder.token,
        });
        expect(organizationRead.statusCode).toBe(200);
      }
    });
  });
});
