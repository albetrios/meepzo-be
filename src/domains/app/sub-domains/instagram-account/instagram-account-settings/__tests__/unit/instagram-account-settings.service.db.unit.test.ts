import { insertChannelAccount } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { buildInstagramPickValues } from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { insertChannelConnection } from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
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
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';

/**
 * The settings service (routes-final § 1.B.3, IA12 step 4): the first connect creates the default
 * row; a reconnect keeps the row the team changed; another organization sees none of it. And the
 * repository's route 3 write (IA15): only the settings sent, who and when, the checks still hold.
 * Route 3 itself (team check, 404, 409, audit) is covered over HTTP in
 * `__tests__/integration/instagram-account-settings.integration.test.ts`.
 */
describe('InstagramAccountSettingsService (database)', () => {
  const accountRepository = new InstagramAccountRepository();
  const settingsRepository = new InstagramAccountSettingsRepository();
  // createDefaultSettings / findSettings never reach the organization service.
  const service = new InstagramAccountSettingsService(
    settingsRepository,
    accountRepository,
    {} as OrganizationService,
  );
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
    const channelConnection = await insertChannelConnection({ organizationId: organization.id });
    const channelAccount = await insertChannelAccount({
      organizationId: organization.id,
      providerAccountId: '17841400000000001',
      channelConnectionId: channelConnection.id,
    });
    const account = await withAppDatabaseContext({
      scope,
      callback: () =>
        accountRepository.upsertAtPick(
          buildInstagramPickValues({
            organizationId: organization.id,
            channelAccountId: channelAccount.id,
            instagramUserId: '17841400000000001',
            username: 'acme_shop',
          }),
        ),
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

  it('the update writes only the settings sent, who changed them and when (route 3)', async () => {
    const created = await service.createDefaultSettings({ scope, instagramAccount });
    const editor = await createTestUser();

    const updated = await withAppDatabaseContext({
      scope,
      callback: () =>
        settingsRepository.update({
          ...instagramAccount,
          changes: { is_automation_enabled: false, public_reply_gap_max_seconds: 90 },
          updatedByUserId: editor.id,
        }),
    });

    expect(updated).toMatchObject({
      id: created.id,
      is_automation_enabled: false,
      is_public_reply_safety_enabled: false,
      public_reply_chance_percent: 80,
      public_reply_hour_limit: 60,
      public_reply_gap_min_seconds: 20,
      public_reply_gap_max_seconds: 90,
      updated_by_user_id: editor.id,
    });
    expect(updated?.updated_at.getTime()).toBeGreaterThanOrEqual(created.updated_at.getTime());
  });

  it('the locked read finds the row inside a transaction, and the gap-order check still refuses max below min', async () => {
    await service.createDefaultSettings({ scope, instagramAccount });

    const locked = await withAppDatabaseContext({
      scope,
      callback: () => settingsRepository.findByInstagramAccountForUpdate(instagramAccount),
    });
    expect(locked?.public_reply_gap_min_seconds).toBe(20);

    await expect(
      withAppDatabaseContext({
        scope,
        callback: () =>
          settingsRepository.update({
            ...instagramAccount,
            changes: { public_reply_gap_min_seconds: 120 },
            updatedByUserId: null,
          }),
      }),
    ).rejects.toThrow();
  });

  it("the update never touches another organization's row", async () => {
    await service.createDefaultSettings({ scope, instagramAccount });

    const result = await withAppDatabaseContext({
      scope: otherScope,
      callback: () =>
        settingsRepository.update({
          organizationId: otherOrganizationId,
          instagramAccountId: instagramAccount.instagramAccountId,
          changes: { is_automation_enabled: false },
          updatedByUserId: null,
        }),
    });

    expect(result).toBeNull();
    await expect(service.findSettings({ scope, instagramAccount })).resolves.toMatchObject({
      is_automation_enabled: true,
    });
  });
});
