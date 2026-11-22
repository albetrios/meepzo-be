import { beforeEach, describe, expect, it } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { InstagramAccountRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import { InstagramAccountTokenRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account-token.repository.js';
import { InstagramAccountTokenService } from '@/domains/app/sub-domains/instagram-account/instagram-account-token.service.js';
import { instagram_account_tokens } from '@/domains/app/sub-domains/instagram-account/instagram-account-token.schema.js';
import { InstagramAccountSettingsRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import { instagram_account_settings } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.schema.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';

/**
 * `InstagramAccountService.findWebhookProcessingAccount` against the database (routes-final § 4.A
 * WH12, WH13): the account event processing works for — any status, revoked included, so its
 * waiting events can still be marked; the automation switch; the encrypted token only while
 * `connected`. Every read runs in the job's own organization scope, so the suite also holds under
 * `pnpm test:rls-role`.
 */

type TestOrganization = { id: number; public_id: string };

describe('InstagramAccountService.findWebhookProcessingAccount (database)', () => {
  let organization: TestOrganization;
  let otherOrganization: TestOrganization;
  let service: InstagramAccountService;

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    otherOrganization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    const known = new Map([organization, otherOrganization].map((row) => [row.public_id, row]));
    const organizationService = {
      findOrganizationByPublicId: async (publicId: string) => known.get(publicId) ?? null,
    } as unknown as OrganizationService;
    const accountRepository = new InstagramAccountRepository();
    service = new InstagramAccountService(
      accountRepository,
      new InstagramAccountTokenService(new InstagramAccountTokenRepository()),
      new InstagramAccountSettingsService(
        new InstagramAccountSettingsRepository(),
        accountRepository,
        organizationService,
      ),
      organizationService,
    );
  });

  async function insertToken(account: { id: number }, ciphertext = 'v1:fake-ciphertext') {
    await getOperatorDatabase().insert(instagram_account_tokens).values({
      organization_id: organization.id,
      instagram_account_id: account.id,
      encrypted_access_token: ciphertext,
    });
  }

  async function insertSettings(account: { id: number }, isAutomationEnabled: boolean) {
    await getOperatorDatabase().insert(instagram_account_settings).values({
      organization_id: organization.id,
      instagram_account_id: account.id,
      is_automation_enabled: isAutomationEnabled,
    });
  }

  function find(instagramAccountPublicId: string, scopeOrganization = organization) {
    return service.findWebhookProcessingAccount({
      scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId: scopeOrganization.public_id }),
      instagramAccountPublicId,
    });
  }

  it('returns a connected account with its key, switch and encrypted token', async () => {
    const account = await insertInstagramAccount({ organizationId: organization.id });
    await insertToken(account);
    await insertSettings(account, false);

    await expect(find(account.public_id)).resolves.toEqual({
      instagramAccount: { organizationId: organization.id, instagramAccountId: account.id },
      instagramAccountPublicId: account.public_id,
      connectionStatus: 'connected',
      isAutomationEnabled: false,
      encryptedAccessToken: 'v1:fake-ciphertext',
    });
  });

  it('reads the switch as on when the account has no settings row', async () => {
    const account = await insertInstagramAccount({ organizationId: organization.id });

    await expect(find(account.public_id)).resolves.toMatchObject({
      isAutomationEnabled: true,
      encryptedAccessToken: null,
    });
  });

  it('returns a revoked account too — its waiting events still need their key — without a token', async () => {
    const account = await insertInstagramAccount({
      organizationId: organization.id,
      connectionStatus: 'revoked',
    });
    await insertToken(account);

    await expect(find(account.public_id)).resolves.toMatchObject({
      instagramAccount: { organizationId: organization.id, instagramAccountId: account.id },
      connectionStatus: 'revoked',
      encryptedAccessToken: null,
    });
  });

  it("answers null for an unknown public id and for another organization's account", async () => {
    const account = await insertInstagramAccount({ organizationId: organization.id });

    await expect(find('iga_unknown00000000000001')).resolves.toBeNull();
    await expect(find(account.public_id, otherOrganization)).resolves.toBeNull();
  });
});
