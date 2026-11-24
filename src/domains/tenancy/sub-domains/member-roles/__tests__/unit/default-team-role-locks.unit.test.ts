import { beforeEach, describe, expect, it, vi } from 'vitest';
// The platform's custom roles are switched off in this product (feat-instagram-dm-sending TN3); this
// suite tests the role and membership rules underneath with the switch on
// (`custom-roles-off.unit.test.ts` covers it off).
vi.mock(
  '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    TENANCY_CUSTOM_ROLES_ENABLED: true,
  }),
);

import { ForbiddenError } from '@/shared/errors/index.js';

vi.mock('@/domains/tenancy/sub-domains/permission/permission-cache.service.js', () => ({
  invalidateOrganizationPermissions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/domains/tenancy/sub-domains/permission/assert-grantable-permissions.util.js', () => ({
  assertCallerCanGrantPermissionCodes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The unit lane has no Postgres: run every unit of work's callback directly.
    withMaintenanceDatabaseContext: vi.fn(
      async ({ callback }: { callback: () => Promise<unknown> }) => callback(),
    ),
    withAppDatabaseContext: vi.fn(async ({ callback }: { callback: () => Promise<unknown> }) =>
      callback(),
    ),
  };
});

import { MemberRoleService } from '@/domains/tenancy/sub-domains/member-roles/member-role.service.js';
import { MemberRolePermissionService } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.service.js';
import { DEFAULT_TEAM_ROLES } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { OrganizationRepository } from '@/domains/tenancy/sub-domains/organization/organization.repository.js';
import type { MemberRoleRepository } from '@/domains/tenancy/sub-domains/member-roles/member-role.repository.js';
import type { MemberRolePermissionRepository } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.repository.js';
import type { MembershipRepository } from '@/domains/tenancy/sub-domains/membership/membership.repository.js';
import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * Launch D3 / AC-1.4: every default team role — Admin, Editor and Viewer — is refused an edit of its
 * codes (403 `role_locked`), a rename and a delete (403 `system_role_fixed`), exactly as Admin
 * always was. The guards read the row's `is_locked` / `is_system` flags, never its name, so the
 * role is built here the way provisioning and the reconcile write it.
 */
const scope = PRINCIPAL_SCOPE.REQUEST({
  organizationPublicId: 'org_public',
}) as OrganizationPrincipalDatabaseScope;

const organization = { id: 1, public_id: 'org_public', owner_user_id: 99 };

/** A default team role's row as provisioning and the reconcile insert it. */
function provisionedRow(defaultRole: (typeof DEFAULT_TEAM_ROLES)[number]) {
  return {
    id: 20,
    public_id: `rol_${defaultRole.name.toLowerCase()}`,
    organization_id: organization.id,
    name: defaultRole.name,
    description: defaultRole.description,
    tone: defaultRole.tone,
    is_system: true,
    is_locked: defaultRole.isLocked,
    deleted_at: null,
    created_at: new Date('2026-11-21T00:00:00Z'),
    updated_at: new Date('2026-11-21T00:00:00Z'),
    updated_by_user_id: null,
  };
}

describe('default team roles are locked (launch D3)', () => {
  const memberRoleRepository = {
    findByPublicId: vi.fn(),
    update: vi.fn(),
    softDeleteIfNoActiveMembers: vi.fn(),
  } as unknown as MemberRoleRepository;
  const memberRolePermissionRepository = {
    replace: vi.fn(),
    findByRoleId: vi.fn().mockResolvedValue([]),
  } as unknown as MemberRolePermissionRepository;
  const organizationService = {
    requireOrganizationRecordByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserInternalIdByPublicId: vi.fn().mockResolvedValue(undefined),
    resolveUserPublicIdByInternalId: vi.fn().mockResolvedValue(null),
  } as unknown as OrganizationService;
  const organizationRepository = {
    findByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserIdByPublicId: vi.fn().mockResolvedValue(99),
  } as unknown as OrganizationRepository;
  const membershipRepository = {
    findByUserAndOrganization: vi.fn().mockResolvedValue({ id: 42, role_id: 1 }),
  } as unknown as MembershipRepository;

  const roleService = new MemberRoleService(
    organizationService,
    memberRoleRepository,
    memberRolePermissionRepository,
    {} as never,
    {} as never,
  );
  const rolePermissionService = new MemberRolePermissionService(
    organizationRepository,
    memberRoleRepository,
    memberRolePermissionRepository,
    { resolveUserOrganizationPermissions: vi.fn().mockResolvedValue([]) } as never,
    { findAll: vi.fn().mockResolvedValue([]) } as never,
    membershipRepository,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockResolvedValue(
      organization as never,
    );
    vi.mocked(organizationRepository.findByPublicId).mockResolvedValue(organization as never);
  });

  it('lists Admin, Editor and Viewer as the default roles, all locked (TN1)', () => {
    expect(DEFAULT_TEAM_ROLES.map((role) => [role.name, role.isLocked])).toEqual([
      ['Admin', true],
      ['Editor', true],
      ['Viewer', true],
    ]);
  });

  for (const defaultRole of DEFAULT_TEAM_ROLES) {
    it(`refuses to change ${defaultRole.name}'s codes (403 role_locked)`, async () => {
      vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(
        provisionedRow(defaultRole) as never,
      );
      const refusal = rolePermissionService.put({
        scope,
        role_public_id: provisionedRow(defaultRole).public_id,
        body: { permission_codes: [] },
        created_by_user_public_id: 'usr_requester',
      });
      await expect(refusal).rejects.toBeInstanceOf(ForbiddenError);
      await expect(refusal).rejects.toMatchObject({ reason: 'role_locked' });
      expect(memberRolePermissionRepository.replace).not.toHaveBeenCalled();
    });

    it(`refuses to rename ${defaultRole.name} (403 system_role_fixed)`, async () => {
      vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(
        provisionedRow(defaultRole) as never,
      );
      const refusal = roleService.update({
        scope,
        role_public_id: provisionedRow(defaultRole).public_id,
        body: { name: 'Renamed' },
        updated_by_user_public_id: 'usr_requester',
      });
      await expect(refusal).rejects.toBeInstanceOf(ForbiddenError);
      await expect(refusal).rejects.toMatchObject({ reason: 'system_role_fixed' });
      expect(memberRoleRepository.update).not.toHaveBeenCalled();
    });

    it(`refuses to delete ${defaultRole.name} (403 system_role_fixed)`, async () => {
      vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(
        provisionedRow(defaultRole) as never,
      );
      const refusal = roleService.delete({
        scope,
        role_public_id: provisionedRow(defaultRole).public_id,
        query: { reason: 'not_needed' },
        deleted_by_user_public_id: 'usr_requester',
      });
      await expect(refusal).rejects.toBeInstanceOf(ForbiddenError);
      await expect(refusal).rejects.toMatchObject({ reason: 'system_role_fixed' });
      expect(memberRoleRepository.softDeleteIfNoActiveMembers).not.toHaveBeenCalled();
    });
  }
});
