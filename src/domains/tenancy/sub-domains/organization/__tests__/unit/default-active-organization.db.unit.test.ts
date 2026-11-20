import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { env } from '@/shared/config/env.config.js';
import { MEMBERSHIP_STATUS } from '@/domains/tenancy/sub-domains/membership/membership.constants.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { users } from '@/domains/user/user.schema.js';
import { UserRepository } from '@/domains/user/user.repository.js';
import { UserService } from '@/domains/user/user.service.js';
import { UserSettingsRepository } from '@/domains/user/sub-domains/user-settings/user-settings.repository.js';
import { UserSettingsService } from '@/domains/user/sub-domains/user-settings/user-settings.service.js';
import { UnprocessableEntityError } from '@/shared/errors/index.js';
import {
  PRINCIPAL_SCOPE,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import type { ObjectStoragePort } from '@/infrastructure/storage/object-storage.port.js';
import {
  provisionOrganizationWithOwner,
  provisionPersonalOrganization,
} from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { resolveDefaultActiveOrganizationPublicId } from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * The login default (iteration `feat-default-organization-at-login`): the organization the user last switched
 * to, else the newest organization, else the personal workspace — and the personal workspace first when
 * team organizations are off. Runs the real query under the user's own verified context.
 */
describe('resolveDefaultActiveOrganizationPublicId — the remembered organization (database)', () => {
  // Remembering only needs the repository; object storage is never touched.
  const userService = new UserService(new UserRepository(), {} as ObjectStoragePort);
  const settingsService = new UserSettingsService(userService, new UserSettingsRepository());
  const pin = ({
    userPublicId,
    organizationPublicId,
  }: {
    userPublicId: string;
    organizationPublicId: string | null;
  }) =>
    settingsService.update({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId }) as UserPrincipalDatabaseScope,
      body: { default_organization_id: organizationPublicId },
    });
  const originalTeamEnabled = env.TEAM_ORGANIZATION_ENABLED;
  const originalPersonalEnabled = env.PERSONAL_ORGANIZATION_ENABLED;

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    env.TEAM_ORGANIZATION_ENABLED = true;
    env.PERSONAL_ORGANIZATION_ENABLED = true;
  });

  afterEach(() => {
    env.TEAM_ORGANIZATION_ENABLED = originalTeamEnabled;
    env.PERSONAL_ORGANIZATION_ENABLED = originalPersonalEnabled;
  });

  async function createTeamOrganization({
    ownerUserId,
    name,
  }: {
    ownerUserId: number;
    name: string;
  }) {
    const { organization } = await provisionOrganizationWithOwner({
      name,
      slug: `${name.toLowerCase()}-${generatePublicId('organization').slice(4, 14)}`,
      type: 'TEAM',
      ownerUserId,
    });
    return organization;
  }

  /** Pins `joined_at` so "most recently joined" never rests on two inserts' clock ticks. */
  async function joinedAt({
    userId,
    organizationId,
    at,
  }: {
    userId: number;
    organizationId: number;
    at: string;
  }) {
    await getOperatorDatabase()
      .update(memberships)
      .set({ joined_at: new Date(at) })
      .where(and(eq(memberships.user_id, userId), eq(memberships.organization_id, organizationId)));
  }

  async function rememberedId(userId: number) {
    const [row] = await getOperatorDatabase()
      .select({ id: users.last_active_organization_id })
      .from(users)
      .where(eq(users.id, userId));
    return row?.id ?? null;
  }

  it('opens the remembered organization over an organization joined later and over the personal workspace', async () => {
    const user = await createTestUser();
    await provisionPersonalOrganization({ ownerUserId: user.id });
    const older = await createTeamOrganization({ ownerUserId: user.id, name: 'Older' });
    const newer = await createTeamOrganization({ ownerUserId: user.id, name: 'Newer' });
    await joinedAt({ userId: user.id, organizationId: older.id, at: '2026-01-01T00:00:00Z' });
    await joinedAt({ userId: user.id, organizationId: newer.id, at: '2026-06-01T00:00:00Z' });

    await userService.rememberLastActiveOrganization({
      userPublicId: user.public_id,
      organizationId: older.id,
    });

    expect(await resolveDefaultActiveOrganizationPublicId(user.id)).toBe(older.public_id);
  });

  it('with nothing remembered, opens the most recently joined organization — not the personal workspace', async () => {
    const user = await createTestUser();
    await provisionPersonalOrganization({ ownerUserId: user.id });
    const older = await createTeamOrganization({ ownerUserId: user.id, name: 'Older' });
    const newer = await createTeamOrganization({ ownerUserId: user.id, name: 'Newer' });
    await joinedAt({ userId: user.id, organizationId: older.id, at: '2026-01-01T00:00:00Z' });
    await joinedAt({ userId: user.id, organizationId: newer.id, at: '2026-06-01T00:00:00Z' });

    expect(await rememberedId(user.id)).toBeNull();
    expect(await resolveDefaultActiveOrganizationPublicId(user.id)).toBe(newer.public_id);
  });

  it('skips a remembered organization whose membership is no longer active', async () => {
    const user = await createTestUser();
    const personal = await provisionPersonalOrganization({ ownerUserId: user.id });
    const remembered = await createTeamOrganization({ ownerUserId: user.id, name: 'Remembered' });
    const other = await createTeamOrganization({ ownerUserId: user.id, name: 'Other' });
    await userService.rememberLastActiveOrganization({
      userPublicId: user.public_id,
      organizationId: remembered.id,
    });

    await getOperatorDatabase()
      .update(memberships)
      .set({ status: MEMBERSHIP_STATUS.SUSPENDED })
      .where(and(eq(memberships.user_id, user.id), eq(memberships.organization_id, remembered.id)));
    expect(await resolveDefaultActiveOrganizationPublicId(user.id)).toBe(other.public_id);

    await getOperatorDatabase()
      .update(memberships)
      .set({ status: MEMBERSHIP_STATUS.SUSPENDED })
      .where(and(eq(memberships.user_id, user.id), eq(memberships.organization_id, other.id)));
    expect(await resolveDefaultActiveOrganizationPublicId(user.id)).toBe(
      personal.organization.public_id,
    );
  });

  it('keeps the personal workspace first when team organizations are disabled', async () => {
    env.TEAM_ORGANIZATION_ENABLED = false;
    const user = await createTestUser();
    const personal = await provisionPersonalOrganization({ ownerUserId: user.id });
    const leftover = await createTeamOrganization({ ownerUserId: user.id, name: 'Leftover' });
    await userService.rememberLastActiveOrganization({
      userPublicId: user.public_id,
      organizationId: leftover.id,
    });

    expect(await resolveDefaultActiveOrganizationPublicId(user.id)).toBe(
      personal.organization.public_id,
    );
  });

  it('remembers only on a change — a repeat switch to the same organization writes nothing', async () => {
    const user = await createTestUser();
    const first = await createTeamOrganization({ ownerUserId: user.id, name: 'First' });
    const second = await createTeamOrganization({ ownerUserId: user.id, name: 'Second' });

    const remember = (organizationId: number) =>
      userService.rememberLastActiveOrganization({ userPublicId: user.public_id, organizationId });

    expect(await remember(first.id)).toBe(true);
    expect(await remember(first.id)).toBe(false);
    expect(await rememberedId(user.id)).toBe(first.id);
    expect(await remember(second.id)).toBe(true);
    expect(await rememberedId(user.id)).toBe(second.id);
  });
  describe('a pinned organization (feat-choose-default-organization)', () => {
    it('opens the pinned organization over the remembered one, a newer one and the personal workspace', async () => {
      const user = await createTestUser();
      await provisionPersonalOrganization({ ownerUserId: user.id });
      const pinned = await createTeamOrganization({ ownerUserId: user.id, name: 'Pinned' });
      const remembered = await createTeamOrganization({ ownerUserId: user.id, name: 'Remembered' });
      const newest = await createTeamOrganization({ ownerUserId: user.id, name: 'Newest' });
      await joinedAt({ userId: user.id, organizationId: pinned.id, at: '2026-01-01T00:00:00Z' });
      await joinedAt({
        userId: user.id,
        organizationId: remembered.id,
        at: '2026-02-01T00:00:00Z',
      });
      await joinedAt({ userId: user.id, organizationId: newest.id, at: '2026-06-01T00:00:00Z' });
      await userService.rememberLastActiveOrganization({
        userPublicId: user.public_id,
        organizationId: remembered.id,
      });

      const saved = await pin({
        userPublicId: user.public_id,
        organizationPublicId: pinned.public_id,
      });

      expect(saved.default_organization_id).toBe(pinned.public_id);
      expect(await resolveDefaultActiveOrganizationPublicId(user.id)).toBe(pinned.public_id);

      const cleared = await pin({ userPublicId: user.public_id, organizationPublicId: null });
      expect(cleared.default_organization_id).toBeNull();
      expect(await resolveDefaultActiveOrganizationPublicId(user.id)).toBe(remembered.public_id);
    });

    it('skips a pinned organization once the membership is suspended, and reports the pin as null', async () => {
      const user = await createTestUser();
      const pinned = await createTeamOrganization({ ownerUserId: user.id, name: 'Pinned' });
      const other = await createTeamOrganization({ ownerUserId: user.id, name: 'Other' });
      await pin({ userPublicId: user.public_id, organizationPublicId: pinned.public_id });

      await getOperatorDatabase()
        .update(memberships)
        .set({ status: MEMBERSHIP_STATUS.SUSPENDED })
        .where(and(eq(memberships.user_id, user.id), eq(memberships.organization_id, pinned.id)));

      expect(await resolveDefaultActiveOrganizationPublicId(user.id)).toBe(other.public_id);
      const settings = await settingsService.get(
        PRINCIPAL_SCOPE.VERIFIED({ userPublicId: user.public_id }) as UserPrincipalDatabaseScope,
      );
      expect(settings.default_organization_id).toBeNull();
    });

    it("refuses another person's organization and the personal workspace, storing nothing", async () => {
      const user = await createTestUser();
      const stranger = await createTestUser();
      const personal = await provisionPersonalOrganization({ ownerUserId: user.id });
      const theirs = await createTeamOrganization({ ownerUserId: stranger.id, name: 'Theirs' });

      for (const organizationPublicId of [theirs.public_id, personal.organization.public_id]) {
        await expect(
          pin({ userPublicId: user.public_id, organizationPublicId }),
        ).rejects.toBeInstanceOf(UnprocessableEntityError);
      }
      const settings = await settingsService.get(
        PRINCIPAL_SCOPE.VERIFIED({ userPublicId: user.public_id }) as UserPrincipalDatabaseScope,
      );
      expect(settings.default_organization_id).toBeNull();
    });

    it('keeps the personal workspace first when team organizations are disabled', async () => {
      const user = await createTestUser();
      const personal = await provisionPersonalOrganization({ ownerUserId: user.id });
      const pinned = await createTeamOrganization({ ownerUserId: user.id, name: 'Pinned' });
      await pin({ userPublicId: user.public_id, organizationPublicId: pinned.public_id });

      env.TEAM_ORGANIZATION_ENABLED = false;

      expect(await resolveDefaultActiveOrganizationPublicId(user.id)).toBe(
        personal.organization.public_id,
      );
    });
  });
});
