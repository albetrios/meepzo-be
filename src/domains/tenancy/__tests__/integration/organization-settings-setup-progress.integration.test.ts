import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { organization_settings } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { getPostgresConstraintName } from '@/shared/utils/infrastructure/postgres-error.util.js';

/** A clinic with its owner's membership (operator connection). */
async function createClinic(options: { name: string }) {
  const owner = await createTestUser();
  const organization = await createTestOrganization({
    ownerUserId: owner.id,
    name: options.name,
    type: 'TEAM',
  });
  const role = await createRoleWithPermissions({
    organizationId: organization.id,
    permissionCodes: [],
  });
  const membership = await createMembership({
    userId: owner.id,
    organizationId: organization.id,
    roleId: role.id,
  });
  return { organization, membership };
}

/** The clinic's settings row, or null when it has none. */
async function settingsOf(organizationId: number) {
  const [row] = await getOperatorDatabase()
    .select()
    .from(organization_settings)
    .where(eq(organization_settings.organization_id, organizationId));
  return row ?? null;
}

/** The settings write, for the constraint cases (operator connection). */
function writeSettings(values: typeof organization_settings.$inferInsert) {
  return getOperatorDatabase().insert(organization_settings).values(values);
}

/**
 * feat-clinic-setup-2026-10-13-sltd ROUTE #1 — the seven `setup_*` fields of
 * `tenancy.organization_settings` (routes-final §2.A.3).
 */
describe('Integration: organization settings — setup progress', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  describe('the fields', () => {
    it('defaults to no answers, no skips and no times', async () => {
      const clinic = await createClinic({ name: 'New clinic' });
      await writeSettings({ organization_id: clinic.organization.id });

      const row = await settingsOf(clinic.organization.id);
      expect(row).toMatchObject({
        setup_answered_steps: [],
        setup_skipped_items: [],
        setup_deferred_at: null,
        setup_completed_at: null,
        setup_completed_by_membership_id: null,
        setup_guide_hidden_at: null,
        setup_guide_done_at: null,
      });
    });

    it('takes only the answered steps and skippable items there are', async () => {
      const clinic = await createClinic({ name: 'New clinic' });

      await expect(
        writeSettings({
          organization_id: clinic.organization.id,
          setup_answered_steps: ['location'],
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          getPostgresConstraintName(error) === 'chk_organization_settings_setup_answered_steps',
      );
      await expect(
        writeSettings({
          organization_id: clinic.organization.id,
          setup_answered_steps: ['clinic_type', 'you', 'you'],
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          getPostgresConstraintName(error) === 'chk_organization_settings_setup_answered_steps',
      );
      await expect(
        writeSettings({
          organization_id: clinic.organization.id,
          setup_skipped_items: ['first_appointment'],
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          getPostgresConstraintName(error) === 'chk_organization_settings_setup_skipped_items',
      );

      await writeSettings({
        organization_id: clinic.organization.id,
        setup_answered_steps: ['clinic_type', 'you'],
        setup_skipped_items: ['treatments', 'invite_team'],
      });
      expect((await settingsOf(clinic.organization.id))?.setup_answered_steps).toEqual([
        'clinic_type',
        'you',
      ]);
    });

    it('names who went live only with the time it went live', async () => {
      const clinic = await createClinic({ name: 'New clinic' });

      await expect(
        writeSettings({
          organization_id: clinic.organization.id,
          setup_completed_by_membership_id: clinic.membership.id,
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          getPostgresConstraintName(error) === 'chk_organization_settings_setup_completed_by',
      );
    });

    it('takes a member of this clinic only, and keeps that member (K8, K2)', async () => {
      const clinic = await createClinic({ name: 'This clinic' });
      const otherClinic = await createClinic({ name: 'Another clinic' });

      await expect(
        writeSettings({
          organization_id: clinic.organization.id,
          setup_completed_at: new Date(),
          setup_completed_by_membership_id: otherClinic.membership.id,
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          getPostgresConstraintName(error) ===
          'organization_settings_setup_completed_by_membership_fk',
      );

      await writeSettings({
        organization_id: clinic.organization.id,
        setup_completed_at: new Date(),
        setup_completed_by_membership_id: clinic.membership.id,
      });
      await expect(
        getOperatorDatabase().delete(memberships).where(eq(memberships.id, clinic.membership.id)),
      ).rejects.toSatisfy(
        (error: unknown) =>
          getPostgresConstraintName(error) ===
          'organization_settings_setup_completed_by_membership_fk',
      );
    });

    it('still lets a deleted clinic be purged with its members', async () => {
      const clinic = await createClinic({ name: 'Leaving clinic' });
      await writeSettings({
        organization_id: clinic.organization.id,
        setup_completed_at: new Date(),
        setup_completed_by_membership_id: clinic.membership.id,
      });

      await getOperatorDatabase()
        .delete(organizations)
        .where(eq(organizations.id, clinic.organization.id));

      expect(await settingsOf(clinic.organization.id)).toBeNull();
    });
  });
});
