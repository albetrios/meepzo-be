import { sql } from 'drizzle-orm';
import { describe, it, expect, beforeEach } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { provisionOrganizationWithOwner } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { ORGANIZATION_LOGO_COLORS } from '@/domains/tenancy/sub-domains/organization/organization.constants.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { database } from '@/infrastructure/database/connection.js';

/** Rows of a `database.execute()` result. */
function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

/** The colour `tenancy.fn_organization_logo_color` gives a name. */
async function colorOfName(name: string): Promise<string> {
  const [row] = rowsOf<{ color: string }>(
    await database.execute(sql`SELECT tenancy.fn_organization_logo_color(${name}) AS color`),
  );
  return row!.color;
}

/**
 * feat-instagram-dm-sending R27 (routes-final § 9.A, TN8, TNQ1 / P81; AC-12.9, AC-12.11): the tile
 * colour and the `lavender` tone arrive as tenancy migrations — the name's colour is one SQL rule
 * every writer shares, and a `lav` the previous release still writes is stored as `lavender`.
 */
describe('organization tile colour and the lavender tone (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
  });

  it('gives one name one colour, whatever its case, always among the five', async () => {
    const names = ['Acme Studio', 'Bloom Clinic', 'Zen Yoga', 'Northwind', 'Café Ölberg', '🌸'];
    for (const name of names) {
      const color = await colorOfName(name);
      expect(ORGANIZATION_LOGO_COLORS).toContain(color);
      expect(await colorOfName(name.toUpperCase())).toBe(color);
    }
    const spread = new Set(await Promise.all(names.map(colorOfName)));
    expect(spread.size).toBeGreaterThan(1);
  });

  it('provisioning stores the name colour unless one is chosen', async () => {
    const user = await createTestUser();
    const picked = await provisionOrganizationWithOwner({
      name: 'Acme Studio',
      slug: 'acme-studio-colour',
      type: 'TEAM',
      ownerUserId: user.id,
    });
    expect(picked.organization.logo_color).toBe(await colorOfName('Acme Studio'));

    const chosen = await provisionOrganizationWithOwner({
      name: 'Acme Studio',
      slug: 'acme-studio-chosen',
      type: 'TEAM',
      ownerUserId: user.id,
      logoColor: 'peach',
    });
    expect(chosen.organization.logo_color).toBe('peach');
  });

  it('fills the colour of a row written without one (the previous release, raw SQL)', async () => {
    const user = await createTestUser();
    const publicId = generatePublicId('organization');
    await database.execute(sql`
      INSERT INTO tenancy.organizations (public_id, name, slug, owner_user_id, type)
      VALUES (${publicId}, 'Legacy Writer', 'legacy-writer-colour', ${user.id}, 'TEAM')
    `);
    const [row] = rowsOf<{ logo_color: string }>(
      await database.execute(
        sql`SELECT logo_color FROM tenancy.organizations WHERE public_id = ${publicId}`,
      ),
    );
    expect(row!.logo_color).toBe(await colorOfName('Legacy Writer'));
  });

  it('refuses a colour outside the five (chk_organizations_logo_color)', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    await expect(
      database.execute(
        sql`UPDATE tenancy.organizations SET logo_color = 'butter' WHERE id = ${organization.id}`,
      ),
    ).rejects.toThrow();
  });

  it('stores a `lav` tone the previous release writes as `lavender`, and refuses any other old value', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const publicId = generatePublicId('memberRole');
    await database.execute(sql`
      INSERT INTO tenancy.roles (public_id, organization_id, name, tone, created_by_user_id)
      VALUES (${publicId}, ${organization.id}, 'Legacy Admin', 'lav', ${user.id})
    `);
    const [row] = rowsOf<{ tone: string }>(
      await database.execute(sql`SELECT tone FROM tenancy.roles WHERE public_id = ${publicId}`),
    );
    expect(row!.tone).toBe('lavender');

    await database.execute(
      sql`UPDATE tenancy.roles SET tone = 'lav' WHERE public_id = ${publicId}`,
    );
    const [updated] = rowsOf<{ tone: string }>(
      await database.execute(sql`SELECT tone FROM tenancy.roles WHERE public_id = ${publicId}`),
    );
    expect(updated!.tone).toBe('lavender');

    await expect(
      database.execute(sql`UPDATE tenancy.roles SET tone = 'lilac' WHERE public_id = ${publicId}`),
    ).rejects.toThrow();
  });
});
