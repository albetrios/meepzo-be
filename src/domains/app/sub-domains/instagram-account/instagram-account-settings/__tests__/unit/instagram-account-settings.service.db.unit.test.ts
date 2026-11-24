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
import { InstagramAccountRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import type { InstagramAccountSettingsChannelAccountPort } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';
import { instagram_account_settings } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.schema.js';
import { InstagramAccountSettingsRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';

/**
 * The settings service (feat-instagram-dm-sending routes-final § 2.B.3, MC7): the first pick creates
 * the empty row; a reconnect keeps the row the team changed; another organization sees none of it.
 * And the repository's route 12 write (IA12): only the settings sent, who and when, the checks
 * still hold. Route 12 itself (team check, feature check, 404, 409, audit) is covered over HTTP in
 * `__tests__/integration/instagram-account-settings.integration.test.ts`.
 */
describe('InstagramAccountSettingsService (database)', () => {
  const accountRepository = new InstagramAccountRepository();
  const settingsRepository = new InstagramAccountSettingsRepository();
  // createDefaultSettings / findSettings never reach the organization service.
  const service = new InstagramAccountSettingsService(
    settingsRepository,
    {} as InstagramAccountSettingsChannelAccountPort,
    {} as OrganizationService,
  );
  let scope: OrganizationPrincipalDatabaseScope;
  let otherScope: OrganizationPrincipalDatabaseScope;
  let channelAccount: ChannelAccountKey;
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
    const insertedAccount = await insertChannelAccount({
      organizationId: organization.id,
      providerAccountId: '17841400000000001',
      channelConnectionId: channelConnection.id,
    });
    await withAppDatabaseContext({
      scope,
      callback: () =>
        accountRepository.upsertAtPick(
          buildInstagramPickValues({
            organizationId: organization.id,
            channelAccountId: insertedAccount.id,
            instagramUserId: '17841400000000001',
            username: 'acme_shop',
          }),
        ),
    });
    channelAccount = { organizationId: organization.id, channelAccountId: insertedAccount.id };
  });

  it('creates the empty row once (AC-3.1)', async () => {
    await expect(service.findSettings({ scope, channelAccount })).resolves.toBeNull();

    const created = await service.createDefaultSettings({ scope, channelAccount });
    expect(created).toMatchObject({
      organization_id: channelAccount.organizationId,
      channel_account_id: channelAccount.channelAccountId,
      opening_hour_limit: null,
      opening_day_limit: null,
      fast_hour_limit: null,
      person_hour_limit: null,
      broadcast_hour_limit: null,
      is_automatic_notice_enabled: false,
      extra_stop_words: [],
      is_comment_reply_trigger_enabled: true,
      is_once_per_person_per_post_enabled: true,
      is_mark_seen_after_reply_enabled: false,
      extra_delay_seconds_min: null,
      extra_delay_seconds_max: null,
      updated_by_user_id: null,
    });

    const again = await service.createDefaultSettings({ scope, channelAccount });
    expect(again.id).toBe(created.id);
    await expect(service.findSettings({ scope, channelAccount })).resolves.toMatchObject({
      id: created.id,
    });
  });

  it('keeps the settings the team changed when the account connects again', async () => {
    const created = await service.createDefaultSettings({ scope, channelAccount });
    await getOperatorDatabase()
      .update(instagram_account_settings)
      .set({ is_comment_reply_trigger_enabled: false, person_hour_limit: 25 })
      .where(
        and(
          eq(instagram_account_settings.organization_id, channelAccount.organizationId),
          eq(instagram_account_settings.id, created.id),
        ),
      );

    const kept = await service.createDefaultSettings({ scope, channelAccount });
    expect(kept).toMatchObject({
      id: created.id,
      is_comment_reply_trigger_enabled: false,
      person_hour_limit: 25,
    });
  });

  it('names the organization in every statement, and the composite key refuses a foreign account', async () => {
    // The repository's own organization filter and the composite key, independent of RLS (which
    // this lane's role bypasses; the app-role isolation is the RLS matrix).
    await service.createDefaultSettings({ scope, channelAccount });
    const mismatchedAccount = {
      organizationId: otherOrganizationId,
      channelAccountId: channelAccount.channelAccountId,
    };

    await expect(
      service.findSettings({ scope: otherScope, channelAccount: mismatchedAccount }),
    ).resolves.toBeNull();
    await expect(
      service.createDefaultSettings({ scope: otherScope, channelAccount: mismatchedAccount }),
    ).rejects.toThrow();
  });

  it('the update writes only the settings sent, who changed them and when (route 12)', async () => {
    const created = await service.createDefaultSettings({ scope, channelAccount });
    const editor = await createTestUser();

    const updated = await withAppDatabaseContext({
      scope,
      callback: () =>
        settingsRepository.update({
          ...channelAccount,
          changes: { opening_hour_limit: 300, extra_stop_words: ['band karo'] },
          updatedByUserId: editor.id,
        }),
    });

    expect(updated).toMatchObject({
      id: created.id,
      opening_hour_limit: 300,
      extra_stop_words: ['band karo'],
      fast_hour_limit: null,
      is_comment_reply_trigger_enabled: true,
      updated_by_user_id: editor.id,
    });
    expect(updated?.updated_at.getTime()).toBeGreaterThanOrEqual(created.updated_at.getTime());
  });

  it('the locked read finds the row inside a transaction, and the extra-delay check still refuses one end alone', async () => {
    await service.createDefaultSettings({ scope, channelAccount });

    const locked = await withAppDatabaseContext({
      scope,
      callback: () => settingsRepository.findByChannelAccountForUpdate(channelAccount),
    });
    expect(locked?.extra_delay_seconds_min).toBeNull();

    await expect(
      withAppDatabaseContext({
        scope,
        callback: () =>
          settingsRepository.update({
            ...channelAccount,
            changes: { extra_delay_seconds_min: 5 },
            updatedByUserId: null,
          }),
      }),
    ).rejects.toThrow();
  });

  it("the update never touches another organization's row", async () => {
    await service.createDefaultSettings({ scope, channelAccount });

    const result = await withAppDatabaseContext({
      scope: otherScope,
      callback: () =>
        settingsRepository.update({
          organizationId: otherOrganizationId,
          channelAccountId: channelAccount.channelAccountId,
          changes: { is_automatic_notice_enabled: true },
          updatedByUserId: null,
        }),
    });

    expect(result).toBeNull();
    await expect(service.findSettings({ scope, channelAccount })).resolves.toMatchObject({
      is_automatic_notice_enabled: false,
    });
  });
});
