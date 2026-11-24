import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMembership,
  seedAllPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  VIEWER_ROLE_NAME,
} from '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { membership_invitations } from '@/domains/tenancy/sub-domains/membership/membership-invitation/membership-invitation.schema.js';
import { hashInvitationToken } from '@/domains/tenancy/sub-domains/membership/membership-invitation/membership-invitation.token.js';
import { OWNER_ROLE_NAME } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { provisionOrganizationWithOwner } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import {
  firstInviteLine,
  invitedMembershipPublicId,
  pendingInvitationPublicId,
} from '@/tests/helpers/membership-invite.helper.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';

type InviteLine = { email: string; result: string; membership_id: string | null };
type InviteAnswer = { data: { results: InviteLine[]; invited_count: number } };
type PreviewAnswer = {
  data: {
    state: string;
    organization: { name: string; logo_color: string };
    role_name: string;
    inviter_first_name: string | null;
    expires_at: string;
    signed_in: boolean;
    email_matches: boolean | null;
  };
};

/**
 * feat-instagram-dm-sending R29 (routes-final § 9.C, TN9–TN11; AC-12.5–AC-12.7, TNC3): the invite of
 * several emails with one role (route 117), the invitation page's preview (route 118, PUBLIC with an
 * optional bearer) and the members list's count per role (route 116), on a provisioned team with
 * custom roles off as built.
 */
describe('Members and invitations — invite several, preview, counts per role (integration)', () => {
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

  /** A provisioned TEAM organization (Owner, Admin, Editor, Viewer) and its owner's token. */
  async function team() {
    const owner = await createTestUser({ firstName: 'Olivia' });
    const { organization } = await provisionOrganizationWithOwner({
      name: 'Invite Team',
      slug: `invite-team-${generatePublicId('organization').slice(4, 14)}`,
      type: 'TEAM',
      ownerUserId: owner.id,
    });
    const liveRoles = await getOperatorDatabase()
      .select({ id: roles.id, public_id: roles.public_id, name: roles.name })
      .from(roles)
      .where(and(eq(roles.organization_id, organization.id), isNull(roles.deleted_at)));
    const roleNamed = (name: string) => liveRoles.find((role) => role.name === name)!;
    const ownerToken = await generateTestToken({
      userId: owner.public_id,
      organizationPublicId: organization.public_id,
    });
    return { owner, organization, roleNamed, ownerToken };
  }

  function invite(options: { token: string; emails: string[]; roleIds: string[] }) {
    return injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/tenancy/organization/memberships'),
      token: options.token,
      headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
      payload: { emails: options.emails, role_ids: options.roleIds },
    });
  }

  describe('route 117 — invite 1–20 emails with one role (AC-12.5, TNC6)', () => {
    it('answers one line per email: 2 invited and 1 already a member', async () => {
      const { organization, roleNamed, ownerToken } = await team();
      const member = await createTestUser({ email: `member-${randomUUID()}@example.com` });
      const existing = await createMembership({
        userId: member.id,
        organizationId: organization.id,
        roleId: roleNamed(EDITOR_ROLE_NAME).id,
      });
      const first = `first-${randomUUID()}@example.com`;
      const second = `second-${randomUUID()}@example.com`;

      const response = await invite({
        token: ownerToken,
        emails: [first, member.email.toUpperCase(), second],
        roleIds: [roleNamed(VIEWER_ROLE_NAME).public_id],
      });
      expect(response.statusCode, response.body).toBe(200);
      const { data } = response.json() as InviteAnswer;
      expect(data.invited_count).toBe(2);
      expect(data.results.map((line) => [line.email, line.result])).toEqual([
        [first, 'invited'],
        [member.email, 'already_member'],
        [second, 'invited'],
      ]);
      expect(data.results[1]!.membership_id).toBe(existing.public_id);
      expect(data.results[0]!.membership_id).toMatch(/^mem_/);
    });

    it('answers already_invited and invalid_email in their own lines, folding a repeat', async () => {
      const { roleNamed, ownerToken } = await team();
      const pending = `pending-${randomUUID()}@example.com`;
      const roleIds = [roleNamed(VIEWER_ROLE_NAME).public_id];
      expect((await invite({ token: ownerToken, emails: [pending], roleIds })).statusCode).toBe(
        200,
      );

      const response = await invite({
        token: ownerToken,
        emails: [pending, 'not-an-email', ` ${pending.toUpperCase()} `],
        roleIds,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect((response.json() as InviteAnswer).data).toEqual({
        results: [
          { email: pending, result: 'already_invited', membership_id: null },
          { email: 'not-an-email', result: 'invalid_email', membership_id: null },
        ],
        invited_count: 0,
      });
    });

    it('replays the whole answer for a repeated X-Idempotency-Key', async () => {
      const { roleNamed, ownerToken } = await team();
      const headers = { 'x-idempotency-key': `idem-${randomUUID()}` };
      const payload = {
        emails: [`replay-${randomUUID()}@example.com`],
        role_ids: [roleNamed(EDITOR_ROLE_NAME).public_id],
      };
      const send = () =>
        injectAuthenticated(app, {
          method: 'POST',
          url: testApiPath('/tenancy/organization/memberships'),
          token: ownerToken,
          headers,
          payload,
        });
      const first = await send();
      const again = await send();
      expect(first.statusCode).toBe(200);
      expect(again.statusCode).toBe(200);
      expect(firstInviteLine(again)).toEqual(firstInviteLine(first));
      expect(firstInviteLine(again).result).toBe('invited');
    });

    it('refuses no email, 21 emails, no role (400), two roles (403 custom_roles_off) and the Owner role (400)', async () => {
      const { roleNamed, ownerToken } = await team();
      const viewer = roleNamed(VIEWER_ROLE_NAME).public_id;
      const twentyOne = Array.from({ length: 21 }, (_, index) => `many-${index}@example.com`);

      expect((await invite({ token: ownerToken, emails: [], roleIds: [viewer] })).statusCode).toBe(
        400,
      );
      expect(
        (await invite({ token: ownerToken, emails: twentyOne, roleIds: [viewer] })).statusCode,
      ).toBe(400);
      expect(
        (await invite({ token: ownerToken, emails: ['a@example.com'], roleIds: [] })).statusCode,
      ).toBe(400);
      const two = await invite({
        token: ownerToken,
        emails: ['a@example.com'],
        roleIds: [viewer, roleNamed(EDITOR_ROLE_NAME).public_id],
      });
      expect(two.statusCode).toBe(403);
      expect((two.json() as { error: { reason?: string } }).error.reason).toBe('custom_roles_off');
      const ownerRole = await invite({
        token: ownerToken,
        emails: ['a@example.com'],
        roleIds: [roleNamed(OWNER_ROLE_NAME).public_id],
      });
      expect(ownerRole.statusCode, ownerRole.body).toBe(400);
      expect(
        (ownerRole.json() as { error: { errors: { field: string }[] } }).error.errors[0]!.field,
      ).toBe('role_ids');
    });

    it('invites a 31st member into an organization of 30 — members are unlimited (TN4, TNC3)', async () => {
      const { organization, roleNamed, ownerToken } = await team();
      for (let index = 0; index < 29; index += 1) {
        const user = await createTestUser();
        await createMembership({
          userId: user.id,
          organizationId: organization.id,
          roleId: roleNamed(VIEWER_ROLE_NAME).id,
        });
      }
      const response = await invite({
        token: ownerToken,
        emails: [`thirty-first-${randomUUID()}@example.com`],
        roleIds: [roleNamed(VIEWER_ROLE_NAME).public_id],
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(firstInviteLine(response).result).toBe('invited');
    });
  });

  describe('route 116 — the count per role (AC-12.7, TNC5)', () => {
    it('answers counts_by_role for live members by main role, Owner first, whatever the filters', async () => {
      const { organization, roleNamed, ownerToken } = await team();
      for (const name of [EDITOR_ROLE_NAME, EDITOR_ROLE_NAME, VIEWER_ROLE_NAME]) {
        const user = await createTestUser();
        await createMembership({
          userId: user.id,
          organizationId: organization.id,
          roleId: roleNamed(name).id,
        });
      }
      await invite({
        token: ownerToken,
        emails: [`counted-${randomUUID()}@example.com`],
        roleIds: [roleNamed(VIEWER_ROLE_NAME).public_id],
      });
      const expected = [
        { role_id: roleNamed(OWNER_ROLE_NAME).public_id, name: OWNER_ROLE_NAME, count: 1 },
        { role_id: roleNamed(EDITOR_ROLE_NAME).public_id, name: EDITOR_ROLE_NAME, count: 2 },
        { role_id: roleNamed(VIEWER_ROLE_NAME).public_id, name: VIEWER_ROLE_NAME, count: 2 },
      ];

      for (const query of ['', '?status=invited']) {
        const response = await injectAuthenticated(app, {
          url: testApiPath(`/tenancy/organization/memberships${query}`),
          token: ownerToken,
        });
        expect(response.statusCode, response.body).toBe(200);
        const counts = (response.json() as { meta: { counts_by_role: typeof expected } }).meta
          .counts_by_role;
        expect(counts[0]!.name).toBe(OWNER_ROLE_NAME);
        expect([...counts].sort((left, right) => left.name.localeCompare(right.name))).toEqual(
          [...expected].sort((left, right) => left.name.localeCompare(right.name)),
        );
        expect(counts.find((line) => line.name === ADMIN_ROLE_NAME)).toBeUndefined();
      }
    });
  });

  describe('route 118 — the invitation preview (AC-12.6, TNC7)', () => {
    /** Invites `email` as a Viewer and pins its token to a known one (`token`, unique per invite). */
    async function invited(options: { email: string }) {
      const context = await team();
      const response = await invite({
        token: context.ownerToken,
        emails: [options.email],
        roleIds: [context.roleNamed(VIEWER_ROLE_NAME).public_id],
      });
      const membershipPublicId = invitedMembershipPublicId(response);
      const invitationPublicId = await pendingInvitationPublicId(membershipPublicId);
      const token = randomUUID().replaceAll('-', '');
      await getOperatorDatabase()
        .update(membership_invitations)
        .set({ token_hash: hashInvitationToken(token) })
        .where(eq(membership_invitations.public_id, invitationPublicId));
      return { ...context, membershipPublicId, invitationPublicId, token };
    }

    function preview(options: { invitationPublicId: string; token: string; bearer?: string }) {
      const request = {
        method: 'POST' as const,
        url: testApiPath(`/tenancy/membership-invitations/${options.invitationPublicId}/preview`),
        payload: { token: options.token },
      };
      return options.bearer === undefined
        ? injectUnauthenticated(app, request)
        : injectAuthenticated(app, { ...request, token: options.bearer });
    }

    it('valid, signed in with the invited verified email: email_matches true', async () => {
      const email = `invitee-${randomUUID()}@example.com`;
      const invitee = await createTestUser({ email, isEmailVerified: true });
      const { invitationPublicId, token } = await invited({ email });
      const response = await preview({
        invitationPublicId,
        token,
        bearer: await generateTestToken({ userId: invitee.public_id }),
      });
      expect(response.statusCode, response.body).toBe(200);
      const { data } = response.json() as PreviewAnswer;
      expect(data).toMatchObject({
        state: 'valid',
        organization: { name: 'Invite Team' },
        role_name: VIEWER_ROLE_NAME,
        inviter_first_name: 'Olivia',
        signed_in: true,
        email_matches: true,
      });
      expect(['sky', 'lavender', 'sage', 'peach', 'slate']).toContain(data.organization.logo_color);
    });

    it('valid, signed in with another account: email_matches false', async () => {
      const { invitationPublicId, token } = await invited({
        email: `invitee-${randomUUID()}@example.com`,
      });
      const other = await createTestUser({ isEmailVerified: true });
      const response = await preview({
        invitationPublicId,
        token,
        bearer: await generateTestToken({ userId: other.public_id }),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect((response.json() as PreviewAnswer).data).toMatchObject({
        state: 'valid',
        signed_in: true,
        email_matches: false,
      });
    });

    it('signed out: signed_in false, email_matches null, and the invitee email never returned', async () => {
      const email = `invitee-${randomUUID()}@example.com`;
      const { invitationPublicId, token } = await invited({ email });
      const response = await preview({ invitationPublicId, token });
      expect(response.statusCode, response.body).toBe(200);
      expect((response.json() as PreviewAnswer).data).toMatchObject({
        state: 'valid',
        signed_in: false,
        email_matches: null,
      });
      expect(response.body).not.toContain(email);
      // A bearer that does not verify reads signed out — the route never refuses.
      const badBearer = await preview({ invitationPublicId, token, bearer: 'not-a-jwt' });
      expect(badBearer.statusCode, badBearer.body).toBe(200);
      expect((badBearer.json() as PreviewAnswer).data.signed_in).toBe(false);
    });

    it('accepted, expired, revoked and declined (revoked) states', async () => {
      const accepted = await invited({ email: `accepted-${randomUUID()}@example.com` });
      await getOperatorDatabase()
        .update(membership_invitations)
        .set({ accepted_at: new Date() })
        .where(eq(membership_invitations.public_id, accepted.invitationPublicId));
      const expired = await invited({ email: `expired-${randomUUID()}@example.com` });
      await getOperatorDatabase()
        .update(membership_invitations)
        .set({
          created_at: new Date(Date.now() - 10 * 86_400_000),
          expires_at: new Date(Date.now() - 86_400_000),
        })
        .where(eq(membership_invitations.public_id, expired.invitationPublicId));
      const revoked = await invited({ email: `revoked-${randomUUID()}@example.com` });
      const revokeResponse = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(
          `/tenancy/organization/memberships/${revoked.membershipPublicId}/invitation`,
        ),
        token: revoked.ownerToken,
      });
      expect(revokeResponse.statusCode, revokeResponse.body).toBe(204);
      const declinerEmail = `declined-${randomUUID()}@example.com`;
      const decliner = await createTestUser({ email: declinerEmail, isEmailVerified: true });
      const declined = await invited({ email: declinerEmail });
      const declineResponse = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/membership-invitations/${declined.invitationPublicId}/decline`),
        token: await generateTestToken({ userId: decliner.public_id }),
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
      });
      expect(declineResponse.statusCode, declineResponse.body).toBe(200);

      const stateOf = async (context: { invitationPublicId: string; token: string }) =>
        (
          (
            await preview({ invitationPublicId: context.invitationPublicId, token: context.token })
          ).json() as PreviewAnswer
        ).data.state;
      expect(await stateOf(accepted)).toBe('accepted');
      expect(await stateOf(expired)).toBe('expired');
      expect(await stateOf(revoked)).toBe('revoked');
      expect(await stateOf(declined)).toBe('revoked');
    });

    it('answers 404 for a wrong token or an unknown id, and 400 for a missing token or a malformed id', async () => {
      const { invitationPublicId, token } = await invited({
        email: `wrong-${randomUUID()}@example.com`,
      });
      const wrongToken = await preview({ invitationPublicId, token: 'b'.repeat(64) });
      expect(wrongToken.statusCode, wrongToken.body).toBe(404);
      const unknown = await preview({
        invitationPublicId: generatePublicId('membershipInvitation'),
        token,
      });
      expect(unknown.statusCode, unknown.body).toBe(404);
      // One answer for both: nothing says whether the id exists.
      const errorOf = (response: { json(): unknown }) =>
        (response.json() as { error: unknown }).error;
      expect(errorOf(unknown)).toEqual(errorOf(wrongToken));

      const missingToken = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/membership-invitations/${invitationPublicId}/preview`),
        payload: {},
      });
      expect(missingToken.statusCode).toBe(400);
      const malformed = await preview({ invitationPublicId: 'x'.repeat(40), token });
      expect(malformed.statusCode).toBe(400);
    });
  });
});
