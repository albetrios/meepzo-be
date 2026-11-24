import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
// The platform's custom roles are switched off in this product (feat-instagram-dm-sending TN3); this
// suite tests the role and membership rules underneath with the switch on
// (`custom-roles-off.integration.test.ts` covers it off).
vi.mock(
  '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    TENANCY_CUSTOM_ROLES_ENABLED: true,
  }),
);

import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { firstInviteLine } from '@/tests/helpers/membership-invite.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
  MEMBERSHIP_WRITE_PERMISSION_CODES,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';

/**
 * Unique-violation conflict handling for organization-scoped writes.
 *
 * Several resources carry a composite unique constraint — webhooks
 * `(organization_id, url)`, memberships `(user_id, organization_id)`. A write
 * that collides with an existing row, whether issued sequentially or under a
 * concurrent race, must resolve to a clean 409 conflict rather than leaking the
 * raw Postgres unique_violation as a 500 (with a false Sentry capture).
 *
 * The webhook delivery DNS pin is mocked so the update path reaches the database
 * write (rather than failing the SSRF resolve on a non-resolvable test host).
 */
vi.mock('@/shared/utils/security/webhook-outbound-fetch.util.js', () => ({
  resolveAndPinWebhookUrl: vi.fn(async (url: string) => ({ pinnedAddress: '93.184.216.34', url })),
  createPinnedWebhookFetch: vi.fn(async () => async () => new Response('{}', { status: 200 })),
}));

function tally(statuses: number[]) {
  return {
    created: statuses.filter((s) => s === 200).length,
    conflict: statuses.filter((s) => s === 409).length,
    serverError: statuses.filter((s) => s >= 500).length,
  };
}

describe('Security: unique-violation conflict handling', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('webhook url collision (PATCH)', () => {
    beforeEach(async () => {
      await cleanupDatabase();
      // The factory's webhooks receive `subscription.updated`: changing one needs `subscription:read`.
      await seedPermissions(['webhook:read', 'webhook:manage', 'subscription:read']);
    });

    async function webhookAdminContext() {
      const user = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: user.id });
      const role = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: ['webhook:read', 'webhook:manage', 'subscription:read'],
      });
      await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
      // Flat webhook routes resolve the organization from the JWT `org` claim.
      const token = await generateTestToken({
        userId: user.public_id,
        organizationPublicId: organization.public_id,
      });
      return { organization, token };
    }

    function patchWebhookUrl(token: string, webhookPublicId: string, url: string) {
      return injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/notify/webhooks/${webhookPublicId}`),
        token,
        payload: { url },
      });
    }

    it('changing a webhook url to another existing webhook url is a clean 409 (not 500)', async () => {
      const { organization, token } = await webhookAdminContext();
      const first = await createTestWebhook({
        organizationId: organization.id,
        url: 'https://alpha.example.com/hook',
      });
      await createTestWebhook({
        organizationId: organization.id,
        url: 'https://beta.example.com/hook',
      });

      const response = await patchWebhookUrl(
        token,
        first.public_id,
        'https://beta.example.com/hook',
      );
      expect(response.statusCode).toBe(409);
    });

    it('changing a webhook url to a genuinely new url still succeeds (200)', async () => {
      const { organization, token } = await webhookAdminContext();
      const first = await createTestWebhook({
        organizationId: organization.id,
        url: 'https://alpha.example.com/hook',
      });

      const response = await patchWebhookUrl(
        token,
        first.public_id,
        'https://unique-target.example.com/hook',
      );
      expect(response.statusCode).toBe(200);
    });
  });

  describe('membership duplicate (POST)', () => {
    beforeEach(async () => {
      await cleanupDatabase();
      await seedPermissions([...MEMBERSHIP_WRITE_PERMISSION_CODES, 'membership:read', 'role:read']);
    });

    async function membershipAdminContext() {
      const owner = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: owner.id });
      const adminRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [...MEMBERSHIP_WRITE_PERMISSION_CODES, 'membership:read', 'role:read'],
      });
      await createMembership({
        userId: owner.id,
        organizationId: organization.id,
        roleId: adminRole.id,
      });
      const memberRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: ['membership:read'],
      });
      // Flat membership routes resolve the organization from the JWT `org` claim.
      const token = await generateTestToken({
        userId: owner.public_id,
        organizationPublicId: organization.public_id,
      });
      // Pre-provision the invitee so add-member-by-email takes findOrCreateInvitedByEmail's
      // "return existing user" path. This isolates the test to the membership-level conflict
      // (the subject here) instead of the separate, documented user-creation race in
      // findOrCreateInvitedByEmail. The invitee has no membership yet, so the first add succeeds.
      const invitee = await createTestUser();
      return {
        organization,
        token,
        memberRolePublicId: memberRole.public_id,
        inviteeEmail: invitee.email,
      };
    }

    // Route 117 (feat-instagram-dm-sending TN10): "Invite" takes emails and answers one line each.
    // Re-inviting the same email answers its line `already_invited`; concurrent invites collide on
    // the (user_id, organization_id) unique index, which the service maps (membership_already_exists)
    // and reads again — a line, never a raw 500.
    function addMember(token: string, email: string, rolePublicId: string) {
      return injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/memberships'),
        token,
        extraHeaders: { 'x-idempotency-key': randomUUID() },
        payload: { emails: [email], role_ids: [rolePublicId] },
      });
    }

    it('inviting the same email twice answers already_invited (not a 409 or 500)', async () => {
      const { token, memberRolePublicId, inviteeEmail } = await membershipAdminContext();

      const first = await addMember(token, inviteeEmail, memberRolePublicId);
      expect(first.statusCode).toBe(200);
      expect(firstInviteLine(first).result).toBe('invited');

      const second = await addMember(token, inviteeEmail, memberRolePublicId);
      expect(second.statusCode).toBe(200);
      expect(firstInviteLine(second)).toMatchObject({
        result: 'already_invited',
        membership_id: null,
      });
    });

    it('concurrent invites of the same email: exactly one invited, the rest already_invited, no 5xx', async () => {
      const { token, memberRolePublicId, inviteeEmail } = await membershipAdminContext();

      const responses = await Promise.all(
        Array.from({ length: 4 }, () => addMember(token, inviteeEmail, memberRolePublicId)),
      );
      const result = tally(responses.map((response) => response.statusCode));
      expect(result.serverError).toBe(0);
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      const lines = responses.map((response) => firstInviteLine(response).result).sort();
      expect(lines).toEqual(['already_invited', 'already_invited', 'already_invited', 'invited']);
    });
  });
});
