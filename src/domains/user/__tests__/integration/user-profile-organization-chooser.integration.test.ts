import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signInWithEmailCode } from '@/tests/helpers/test-auth.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import {
  provisionOrganizationWithOwner,
  provisionPersonalOrganization,
} from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedAllPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { insertChannelAccount } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';

/**
 * feat-instagram-dm-sending § 11.A (ROUTE R34): onboarding's handle and goal on the profile
 * (routes 130, 148 — AC-14.1) and the organization chooser (route 132 — AC-14.3): the personal
 * organization hidden, each organization's main role and counts, a name search, and another user's
 * organization never counted.
 */
describe('§ 11.A — the person and the organization chooser', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
  });

  async function login(email: string): Promise<string> {
    const response = await signInWithEmailCode(app, { email });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { data: { access_token: string } }).data.access_token;
  }

  function call(options: {
    method: 'GET' | 'PATCH';
    path: string;
    token: string;
    body?: Record<string, unknown>;
  }) {
    return app.inject({
      method: options.method,
      url: testApiPath(options.path),
      headers: { authorization: `Bearer ${options.token}` },
      ...(options.body ? { payload: options.body } : {}),
    });
  }

  async function createTeamOrganization({
    ownerUserId,
    name,
  }: {
    ownerUserId: number;
    name: string;
  }) {
    return provisionOrganizationWithOwner({
      name,
      slug: `${name.toLowerCase().replaceAll(' ', '-')}-${generatePublicId('organization').slice(4, 12)}`,
      type: 'TEAM',
      ownerUserId,
    });
  }

  describe('routes 130 and 148 — Instagram handle and goal (UN3, AC-14.1)', () => {
    it('saves the handle without @ in lower case and the goal, answers both, and null clears them', async () => {
      const user = await createTestUser();
      const token = await login(user.email);

      const saved = await call({
        method: 'PATCH',
        path: '/users/me',
        token,
        body: { instagram_handle: '@Jane.Doe_42', goal: 'drive_sales' },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect((saved.json() as { data: unknown }).data).toMatchObject({
        instagram_handle: 'jane.doe_42',
        goal: 'drive_sales',
      });

      const read = await call({ method: 'GET', path: '/users/me', token });
      expect((read.json() as { data: unknown }).data).toMatchObject({
        instagram_handle: 'jane.doe_42',
        goal: 'drive_sales',
      });

      const cleared = await call({
        method: 'PATCH',
        path: '/users/me',
        token,
        body: { instagram_handle: null, goal: null },
      });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect((cleared.json() as { data: unknown }).data).toMatchObject({
        instagram_handle: null,
        goal: null,
      });
    });

    it('refuses a handle with other signs or over 30 characters, and another goal (400)', async () => {
      const user = await createTestUser();
      const token = await login(user.email);

      for (const body of [
        { instagram_handle: 'jane doe' },
        { instagram_handle: 'jane-doe!' },
        { instagram_handle: 'a'.repeat(31) },
        { instagram_handle: '@' },
        { goal: 'get_famous' },
      ]) {
        const response = await call({ method: 'PATCH', path: '/users/me', token, body });
        expect(response.statusCode, `${JSON.stringify(body)} → ${response.body}`).toBe(400);
        const field = Object.keys(body)[0];
        expect(
          (response.json() as { error: { errors: { field: string }[] } }).error.errors.map(
            (error) => error.field,
          ),
        ).toContain(`body.${field}`);
      }

      // Thirty characters after the `@` is still Instagram's length.
      const longest = await call({
        method: 'PATCH',
        path: '/users/me',
        token,
        body: { instagram_handle: `@${'b'.repeat(30)}` },
      });
      expect(longest.statusCode, longest.body).toBe(200);
    });
  });

  describe('route 132 — the organization chooser (UN5, AC-14.3)', () => {
    it("hides the personal organization and answers each one's role and counts", async () => {
      const user = await createTestUser();
      const teammate = await createTestUser();
      const stranger = await createTestUser();
      await provisionPersonalOrganization({ ownerUserId: user.id });

      // Owned: two members, two accounts (one revoked), one live automation (plus a draft, a deleted one).
      const owned = await createTeamOrganization({ ownerUserId: user.id, name: 'Acme Studio' });
      const editorRole = await createRoleWithPermissions({
        organizationId: owned.organization.id,
        name: 'Studio helper',
        permissionCodes: [],
      });
      await createMembership({
        userId: teammate.id,
        organizationId: owned.organization.id,
        roleId: editorRole.id,
      });
      const account = await insertChannelAccount({
        organizationId: owned.organization.id,
        providerAccountId: '17841400000000001',
      });
      await insertChannelAccount({
        organizationId: owned.organization.id,
        providerAccountId: '17841400000000002',
        connectionStatus: 'revoked',
      });
      await insertAutomation({
        organizationId: owned.organization.id,
        channelAccountId: account.id,
        status: 'live',
        name: 'Live one',
      });
      await insertAutomation({
        organizationId: owned.organization.id,
        channelAccountId: account.id,
        name: 'Draft one',
      });
      await insertAutomation({
        organizationId: owned.organization.id,
        channelAccountId: account.id,
        status: 'live',
        name: 'Deleted one',
        deleted_at: new Date(),
      });

      // Joined as a member of the stranger's organization, with a custom main role.
      const joined = await createTeamOrganization({ ownerUserId: stranger.id, name: 'Bloom Co' });
      const viewerRole = await createRoleWithPermissions({
        organizationId: joined.organization.id,
        name: 'Guest reader',
        permissionCodes: [],
      });
      await createMembership({
        userId: user.id,
        organizationId: joined.organization.id,
        roleId: viewerRole.id,
      });

      // Never listed nor counted: the stranger's other organization, where the user is not a member.
      const foreign = await createTeamOrganization({ ownerUserId: stranger.id, name: 'Foreign' });
      await insertChannelAccount({
        organizationId: foreign.organization.id,
        providerAccountId: '17841400000000003',
      });

      const token = await login(user.email);
      const response = await call({ method: 'GET', path: '/users/me/organizations', token });
      expect(response.statusCode, response.body).toBe(200);
      const items = (response.json() as { data: Record<string, unknown>[] }).data;
      expect(items.map((item) => item.id)).toEqual([
        owned.organization.public_id,
        joined.organization.public_id,
      ]);
      expect(items[0]).toMatchObject({
        name: 'Acme Studio',
        role: { name: 'Owner' },
        members_count: 2,
        channel_accounts_count: 1,
        live_automations_count: 1,
      });
      expect(items[1]).toMatchObject({
        name: 'Bloom Co',
        role: { id: viewerRole.public_id, name: 'Guest reader' },
        members_count: 2,
        channel_accounts_count: 0,
        live_automations_count: 0,
      });
      expect(items[0]).toHaveProperty('logo_color');
      expect(items[0]).toHaveProperty('slug');

      // The app's function never counts an organization the user is not an active member of.
      const foreignCounts = await operatorQuery.unsafe(
        'SELECT * FROM app.list_organization_counts_for_user($1, $2::text[])',
        [user.public_id, [foreign.organization.public_id, owned.organization.public_id]],
      );
      expect(
        (foreignCounts as unknown as { organization_public_id: string }[]).map(
          (row) => row.organization_public_id,
        ),
      ).toEqual([owned.organization.public_id]);
    });

    it('searches the name with q, any case, and refuses a q over 100 characters', async () => {
      const user = await createTestUser();
      await createTeamOrganization({ ownerUserId: user.id, name: 'Acme Studio' });
      const bloom = await createTeamOrganization({ ownerUserId: user.id, name: 'Bloom Co' });
      const token = await login(user.email);

      const found = await call({ method: 'GET', path: '/users/me/organizations?q=bLoO', token });
      expect(found.statusCode, found.body).toBe(200);
      expect((found.json() as { data: { id: string }[] }).data.map((item) => item.id)).toEqual([
        bloom.organization.public_id,
      ]);

      // A `%` is a letter, never a wildcard.
      const literal = await call({ method: 'GET', path: '/users/me/organizations?q=%25', token });
      expect((literal.json() as { data: unknown[] }).data).toEqual([]);

      const tooLong = await call({
        method: 'GET',
        path: `/users/me/organizations?q=${'a'.repeat(101)}`,
        token,
      });
      expect(tooLong.statusCode, tooLong.body).toBe(400);
    });
  });
});
