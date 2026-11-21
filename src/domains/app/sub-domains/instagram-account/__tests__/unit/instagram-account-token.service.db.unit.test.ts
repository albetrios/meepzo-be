import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
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
import { InstagramAccountTokenRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account-token.repository.js';
import { InstagramAccountTokenService } from '@/domains/app/sub-domains/instagram-account/instagram-account-token.service.js';

/**
 * The token service (IA5): stores, hands out and erases the account's token as ciphertext, inside
 * the caller's organization scope — and inside the caller's open unit of work, so a connect that
 * fails after writing the token leaves no token behind.
 */

const FIRST_CIPHERTEXT = 'v1:token-service-test-first';
const SECOND_CIPHERTEXT = 'v1:token-service-test-second';

describe('InstagramAccountTokenService (database)', () => {
  const accountRepository = new InstagramAccountRepository();
  const service = new InstagramAccountTokenService(new InstagramAccountTokenRepository());
  let scope: OrganizationPrincipalDatabaseScope;
  let otherScope: OrganizationPrincipalDatabaseScope;
  let organizationId: number;
  let otherOrganizationId: number;

  async function connectAccount(): Promise<InstagramAccountKey> {
    const { account } = await withAppDatabaseContext({
      scope,
      callback: () =>
        accountRepository.upsertConnected({
          organizationId,
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
    return { organizationId, instagramAccountId: account.id };
  }

  beforeEach(async () => {
    await cleanupDatabase();
    const organization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    const otherOrganization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    organizationId = organization.id;
    otherOrganizationId = otherOrganization.id;
    scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id });
    otherScope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: otherOrganization.public_id });
  });

  it('stores, replaces, hands out and erases the ciphertext', async () => {
    const instagramAccount = await connectAccount();
    const firstExpiry = new Date('2027-01-01T00:00:00.000Z');
    const secondExpiry = new Date('2027-02-01T00:00:00.000Z');

    await expect(service.findAccessToken({ scope, instagramAccount })).resolves.toBeNull();
    await service.storeAccessToken({
      scope,
      instagramAccount,
      encryptedAccessToken: FIRST_CIPHERTEXT,
      expiresAt: firstExpiry,
    });
    await expect(service.findAccessToken({ scope, instagramAccount })).resolves.toEqual({
      encryptedAccessToken: FIRST_CIPHERTEXT,
      expiresAt: firstExpiry,
    });

    await service.storeAccessToken({
      scope,
      instagramAccount,
      encryptedAccessToken: SECOND_CIPHERTEXT,
      expiresAt: secondExpiry,
    });
    await expect(service.findAccessToken({ scope, instagramAccount })).resolves.toEqual({
      encryptedAccessToken: SECOND_CIPHERTEXT,
      expiresAt: secondExpiry,
    });

    await expect(service.eraseAccessToken({ scope, instagramAccount })).resolves.toBe(true);
    await expect(service.findAccessToken({ scope, instagramAccount })).resolves.toBeNull();
    await expect(service.eraseAccessToken({ scope, instagramAccount })).resolves.toBe(false);
  });

  it('names the organization in every statement: another organization’s key finds no token', async () => {
    // The repository's own organization filter, independent of RLS (which this lane's role
    // bypasses; under meepzo_be_app the policy hides the row too —
    // instagram-account-resolvers.security.test.ts and the RLS matrix).
    const instagramAccount = await connectAccount();
    await service.storeAccessToken({
      scope,
      instagramAccount,
      encryptedAccessToken: FIRST_CIPHERTEXT,
      expiresAt: new Date(),
    });
    const mismatchedAccount = {
      organizationId: otherOrganizationId,
      instagramAccountId: instagramAccount.instagramAccountId,
    };

    await expect(
      service.findAccessToken({ scope: otherScope, instagramAccount: mismatchedAccount }),
    ).resolves.toBeNull();
    await expect(
      service.eraseAccessToken({ scope: otherScope, instagramAccount: mismatchedAccount }),
    ).resolves.toBe(false);
    await expect(service.findAccessToken({ scope, instagramAccount })).resolves.toMatchObject({
      encryptedAccessToken: FIRST_CIPHERTEXT,
    });
  });

  it('joins the caller’s unit of work: a failure after the write leaves no token', async () => {
    const instagramAccount = await connectAccount();

    await expect(
      withAppDatabaseContext({
        scope,
        callback: async () => {
          await service.storeAccessToken({
            scope,
            instagramAccount,
            encryptedAccessToken: FIRST_CIPHERTEXT,
            expiresAt: new Date(),
          });
          throw new Error('the connect failed after the token write');
        },
      }),
    ).rejects.toThrow('the connect failed after the token write');

    await expect(service.findAccessToken({ scope, instagramAccount })).resolves.toBeNull();
  });
});
