import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedAllPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { ORGANIZATION_LOGO_COLORS } from '@/domains/tenancy/sub-domains/organization/organization.constants.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/** The organization fields these tests read. */
interface OrganizationBody {
  data: { id: string; name: string; slug: string; logo_color: string };
}

/** The error envelope these tests read. */
interface ErrorBody {
  error: { reason?: string; errors?: { field: string }[] };
}

/**
 * feat-instagram-dm-sending R27 — routes 110, 141, 142 (routes-final § 9.A, TN7, TN8; AC-12.8,
 * AC-12.9): a team organization is created from its name alone (the slug made from it, unique with a
 * short suffix), the slug is read only afterwards, and the tile colour is one of five tones —
 * `lavender` among them — picked from the name unless chosen.
 */
describe('Organization slug and tile colour — Integration', () => {
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

  async function createOrganization(payload: Record<string, unknown>) {
    const user = await createTestUser();
    const token = await generateTestToken({ userId: user.public_id });
    return injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/tenancy/organizations'),
      token,
      headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
      payload,
    });
  }

  async function createUpdateContext() {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
        TENANCY_PERMISSIONS.ORGANIZATION_UPDATE,
      ],
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { organization, token };
  }

  describe('POST /api/v1/tenancy/organizations (route 141)', () => {
    it('makes the slug and the tile colour from the name alone', async () => {
      const response = await createOrganization({ name: 'Café Ölberg & Co.' });
      expect(response.statusCode, response.body).toBe(200);
      const { data } = response.json() as OrganizationBody;
      expect(data.slug).toBe('cafe-olberg-co');
      expect(ORGANIZATION_LOGO_COLORS).toContain(data.logo_color);
    });

    it('gives a taken made slug a short suffix, and one name one colour', async () => {
      const first = await createOrganization({ name: 'Acme Studio' });
      const second = await createOrganization({ name: 'Acme Studio' });
      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      const firstData = (first.json() as OrganizationBody).data;
      const secondData = (second.json() as OrganizationBody).data;
      expect(firstData.slug).toBe('acme-studio');
      expect(secondData.slug).toMatch(/^acme-studio-[a-z0-9]{6}$/);
      expect(secondData.logo_color).toBe(firstData.logo_color);
    });

    it('makes a slug for a name with no Latin letter or digit', async () => {
      const response = await createOrganization({ name: '🌸🌸' });
      expect(response.statusCode, response.body).toBe(200);
      expect((response.json() as OrganizationBody).data.slug).toMatch(
        /^organization(?:-[a-z0-9]{6})?$/,
      );
    });

    it('keeps a chosen slug and a chosen colour', async () => {
      const response = await createOrganization({
        name: 'Bloom Clinic',
        slug: 'bloom',
        logo_color: 'lavender',
      });
      expect(response.statusCode, response.body).toBe(200);
      const { data } = response.json() as OrganizationBody;
      expect(data.slug).toBe('bloom');
      expect(data.logo_color).toBe('lavender');
    });

    it('refuses a colour outside the five with 400 on body.logo_color (the old `lav` included)', async () => {
      const response = await createOrganization({ name: 'Bloom Clinic', logo_color: 'lav' });
      expect(response.statusCode).toBe(400);
      const fields = ((response.json() as ErrorBody).error.errors ?? []).map(
        (error) => error.field,
      );
      expect(fields).toContain('body.logo_color');
    });
  });

  describe('GET /api/v1/tenancy/organization (route 142)', () => {
    it('answers the tile colour', async () => {
      const { organization, token } = await createUpdateContext();
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization'),
        token,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect((response.json() as OrganizationBody).data.logo_color).toBe(organization.logo_color);
    });
  });

  describe('PATCH /api/v1/tenancy/organization (route 110)', () => {
    it('refuses a slug with 422 slug_read_only and leaves it unchanged', async () => {
      const { organization, token } = await createUpdateContext();
      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath('/tenancy/organization'),
        token,
        payload: { name: 'Renamed', slug: 'another-slug' },
      });
      expect(response.statusCode).toBe(422);
      expect((response.json() as ErrorBody).error.reason).toBe('slug_read_only');

      const read = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization'),
        token,
      });
      const { data } = read.json() as OrganizationBody;
      expect(data.slug).toBe(organization.slug);
      expect(data.name).toBe(organization.name);
    });

    it('sets each of the five colours, `lavender` among them', async () => {
      const { token } = await createUpdateContext();
      for (const color of ORGANIZATION_LOGO_COLORS) {
        const response = await injectAuthenticated(app, {
          method: 'PATCH',
          url: testApiPath('/tenancy/organization'),
          token,
          payload: { logo_color: color },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect((response.json() as OrganizationBody).data.logo_color).toBe(color);
      }
    });

    it('refuses a colour outside the five with 400 on body.logo_color', async () => {
      const { token } = await createUpdateContext();
      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath('/tenancy/organization'),
        token,
        payload: { logo_color: 'butter' },
      });
      expect(response.statusCode).toBe(400);
      const fields = ((response.json() as ErrorBody).error.errors ?? []).map(
        (error) => error.field,
      );
      expect(fields).toContain('body.logo_color');
    });
  });
});
