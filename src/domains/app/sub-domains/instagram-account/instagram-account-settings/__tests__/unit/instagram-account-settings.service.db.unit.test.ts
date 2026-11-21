import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  InstagramAccountRepository,
  type InstagramAccountKey,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { instagram_account_settings } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.schema.js';
import { InstagramAccountSettingsRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';

/**
 * The settings service (routes-final § 1.B.3, IA12 step 4): the first connect creates the default
 * row; a reconnect keeps the row the team changed; another organization sees none of it.
 */
describe('InstagramAccountSettingsService (database)', () => {
  const accountRepository = new InstagramAccountRepository();
  const service = new InstagramAccountSettingsService(new InstagramAccountSettingsRepository());
  let scope: OrganizationPrincipalDatabaseScope;
  let otherScope: OrganizationPrincipalDatabaseScope;
  let instagramAccount: InstagramAccountKey;
  let otherOrganizationId: number;

  beforeEach(async () => {
    await cleanupDatabase();
    const organization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    const otherOrganization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    otherOrganizationId = otherOrganization.id;
    scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id });
    otherScope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: otherOrganization.public_id });
    const { account } = await withAppDatabaseContext({
      scope,
      callback: () =>
        accountRepository.upsertConnected({
          organizationId: organization.id,
          instagramUserId: '17841400000000001',
          instagramAppUserId: '917841400000000001',
          username: 'meepzo_shop',
          name: null,
          biography: null,
          website: null,
          profilePictureUrl: null,
          followersCount: 0,
          followsCount: 0,
          mediaCount: 0,
          scopes: [],
          tokenExpiresAt: new Date(),
          connectedByUserId: null,
        }),
    });
    instagramAccount = { organizationId: organization.id, instagramAccountId: account.id };
  });

  it('creates the defaults once', async () => {
    await expect(service.findSettings({ scope, instagramAccount })).resolves.toBeNull();

    const created = await service.createDefaultSettings({ scope, instagramAccount });
    expect(created).toMatchObject({
      organization_id: instagramAccount.organizationId,
      instagram_account_id: instagramAccount.instagramAccountId,
      is_automation_enabled: true,
      is_public_reply_safety_enabled: false,
      public_reply_chance_percent: 80,
      public_reply_hour_limit: 60,
      public_reply_gap_min_seconds: 20,
      public_reply_gap_max_seconds: 60,
      updated_by_user_id: null,
    });

    const again = await service.createDefaultSettings({ scope, instagramAccount });
    expect(again.id).toBe(created.id);
    await expect(service.findSettings({ scope, instagramAccount })).resolves.toMatchObject({
      id: created.id,
    });
  });

  it('keeps the settings the team changed when the account connects again', async () => {
    const created = await service.createDefaultSettings({ scope, instagramAccount });
    await getOperatorDatabase()
      .update(instagram_account_settings)
      .set({ is_automation_enabled: false, public_reply_chance_percent: 25 })
      .where(
        and(
          eq(instagram_account_settings.organization_id, instagramAccount.organizationId),
          eq(instagram_account_settings.id, created.id),
        ),
      );

    const kept = await service.createDefaultSettings({ scope, instagramAccount });
    expect(kept).toMatchObject({
      id: created.id,
      is_automation_enabled: false,
      public_reply_chance_percent: 25,
    });
  });

  it('names the organization in every statement, and the composite key refuses a foreign account', async () => {
    // The repository's own organization filter and the composite key, independent of RLS (which
    // this lane's role bypasses; the app-role isolation is the RLS matrix).
    await service.createDefaultSettings({ scope, instagramAccount });
    const mismatchedAccount = {
      organizationId: otherOrganizationId,
      instagramAccountId: instagramAccount.instagramAccountId,
    };

    await expect(
      service.findSettings({ scope: otherScope, instagramAccount: mismatchedAccount }),
    ).resolves.toBeNull();
    await expect(
      service.createDefaultSettings({ scope: otherScope, instagramAccount: mismatchedAccount }),
    ).rejects.toThrow();
  });
});
