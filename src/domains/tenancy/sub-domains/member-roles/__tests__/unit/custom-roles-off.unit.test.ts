import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@/shared/errors/index.js';
import { TENANCY_CUSTOM_ROLES_ENABLED } from '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js';
import {
  assertCustomRolesEnabled,
  assertMembershipRolesAllowed,
  CUSTOM_ROLES_OFF_REASON,
} from '@/domains/tenancy/sub-domains/member-roles/member-role-capability.js';
import { MemberRoleService } from '@/domains/tenancy/sub-domains/member-roles/member-role.service.js';
import { MemberRolePermissionService } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.service.js';
import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

const scope = PRINCIPAL_SCOPE.REQUEST({
  organizationPublicId: 'org_public',
}) as OrganizationPrincipalDatabaseScope;

/** A collaborator every method of which fails the test if called: the refusal comes first. */
function untouchable(): never {
  return new Proxy(
    {},
    {
      get: (_target, property) =>
        vi.fn(() => {
          throw new Error(`reached ${String(property)} past the custom-roles check`);
        }),
    },
  ) as never;
}

const roleService = new MemberRoleService(
  untouchable(),
  untouchable(),
  untouchable(),
  untouchable(),
  untouchable(),
);
const rolePermissionService = new MemberRolePermissionService(
  untouchable(),
  untouchable(),
  untouchable(),
  untouchable(),
  untouchable(),
  untouchable(),
);

/** Expects a `403 custom_roles_off`. */
async function expectCustomRolesOff(attempt: Promise<unknown>): Promise<void> {
  await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
  await expect(attempt).rejects.toMatchObject({
    statusCode: 403,
    reason: CUSTOM_ROLES_OFF_REASON,
    message: 'errors:customRolesOff',
  });
}

/**
 * feat-instagram-dm-sending TN3 (routes-final § 9.B.9, § 9.11 TNC2; AC-12.4): with the product's
 * switch as built — off — the five role writes refuse with `403 custom_roles_off` before any body
 * check, organization read or role lookup, and a membership's `role_ids` must be one system role.
 */
describe('custom roles off (TN3)', () => {
  it('ships switched off', () => {
    expect(TENANCY_CUSTOM_ROLES_ENABLED).toBe(false);
  });

  it('refuses create, edit, delete and restore of a role, and replacing its codes, before anything else', async () => {
    await expectCustomRolesOff(
      roleService.create({ scope, body: { name: 'Support' }, created_by_user_public_id: 'usr_a' }),
    );
    await expectCustomRolesOff(
      roleService.update({
        scope,
        role_public_id: 'rol_any',
        body: { name: 'Renamed' },
        updated_by_user_public_id: 'usr_a',
      }),
    );
    await expectCustomRolesOff(
      roleService.delete({
        scope,
        role_public_id: 'rol_any',
        query: {},
        deleted_by_user_public_id: 'usr_a',
      }),
    );
    await expectCustomRolesOff(
      roleService.restore({
        scope,
        role_public_id: 'rol_any',
        restored_by_user_public_id: 'usr_a',
      }),
    );
    await expectCustomRolesOff(
      rolePermissionService.put({
        scope,
        role_public_id: 'rol_any',
        body: { permission_codes: [] },
        created_by_user_public_id: 'usr_a',
      }),
    );
  });

  it('answers custom_roles_off before the service checks a body that would fail them', async () => {
    expect(() => assertCustomRolesEnabled()).toThrow(ForbiddenError);
    await expectCustomRolesOff(
      roleService.create({ scope, body: { name: '' }, created_by_user_public_id: 'usr_a' }),
    );
  });

  it('lets a membership hold exactly one system role', () => {
    expect(() => assertMembershipRolesAllowed({ roles: [{ is_system: true }] })).not.toThrow();
  });

  it('refuses a membership two roles, even two system ones, and any custom role', () => {
    for (const roles of [
      [{ is_system: true }, { is_system: true }],
      [{ is_system: false }],
      [{ is_system: true }, { is_system: false }],
    ]) {
      expect(() => assertMembershipRolesAllowed({ roles })).toThrow(
        expect.objectContaining({ statusCode: 403, reason: CUSTOM_ROLES_OFF_REASON }),
      );
    }
  });
});
