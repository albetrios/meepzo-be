import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';

const contextSpy = vi.hoisted(() => ({ openCount: 0, scopes: [] as unknown[] }));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/infrastructure/database/contexts/database-context.js')>();
  return {
    ...actual,
    // No database: run the unit of work inline, counted open, and record its scope.
    withAppDatabaseContext: async ({
      scope,
      callback,
    }: {
      scope: unknown;
      callback: () => Promise<unknown>;
    }) => {
      contextSpy.scopes.push(scope);
      contextSpy.openCount += 1;
      try {
        return await callback();
      } finally {
        contextSpy.openCount -= 1;
      }
    },
  };
});

import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import { InstagramAccountErasureService } from '@/domains/app/sub-domains/instagram-account/instagram-account-erasure.service.js';
import type { InstagramAccountDisconnectChange } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import type { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';

const scope: OrganizationPrincipalDatabaseScope = PRINCIPAL_SCOPE.VERIFIED({
  organizationPublicId: 'org_a1b2c3d4e5f6g7h8i9j0k',
});

/** One account's outcome of the disconnect. */
function accountChange(
  overrides: Partial<InstagramAccountDisconnectChange> = {},
): InstagramAccountDisconnectChange {
  return {
    instagramAccount: { organizationId: 1, instagramAccountId: 10 },
    channelAccount: { organizationId: 1, channelAccountId: 20 },
    instagramAccountPublicId: 'cha_aaaaaaaaaaaaaaaaaaaaa',
    wasRevoked: false,
    wasTokenErased: false,
    wasProfileErased: false,
    ...overrides,
  };
}

/**
 * {@link InstagramAccountErasureService} without a database (the context runs inline, the account and
 * media services are stubs): the one erase Meta's callbacks (IA19, IA20) and an organization's delete
 * (D54) share — one transaction, the unsubscribe outside it, and only accounts something changed on
 * named.
 */
describe('InstagramAccountErasureService (no database)', () => {
  const disconnectForMeta = vi.fn();
  const disconnectForOrganizationOffboarding = vi.fn();
  const unsubscribeForOrganizationOffboarding = vi.fn();
  const deleteForAccount = vi.fn();
  const service = new InstagramAccountErasureService(
    {
      disconnectForMeta,
      disconnectForOrganizationOffboarding,
      unsubscribeForOrganizationOffboarding,
    } as unknown as InstagramAccountService,
    { deleteForAccount } as unknown as InstagramMediaService,
  );

  beforeEach(() => {
    vi.resetAllMocks();
    contextSpy.openCount = 0;
    contextSpy.scopes.length = 0;
  });

  describe('eraseForOrganizationOffboarding (D54)', () => {
    it('unsubscribes outside the transaction, then disconnects and erases the posts inside one, in the organization’s scope', async () => {
      const openCounts: Record<string, number> = {};
      unsubscribeForOrganizationOffboarding.mockImplementation(async () => {
        openCounts.unsubscribe = contextSpy.openCount;
      });
      disconnectForOrganizationOffboarding.mockImplementation(async () => {
        openCounts.disconnect = contextSpy.openCount;
        return [
          accountChange({ wasRevoked: true, wasTokenErased: true, wasProfileErased: true }),
          accountChange({
            instagramAccount: { organizationId: 1, instagramAccountId: 11 },
            channelAccount: { organizationId: 1, channelAccountId: 21 },
            instagramAccountPublicId: 'iga_bbbbbbbbbbbbbbbbbbbbb',
          }),
        ];
      });
      deleteForAccount.mockImplementation(async () => {
        openCounts.posts = contextSpy.openCount;
        return 2;
      });

      const erasure = await service.eraseForOrganizationOffboarding(scope);

      expect(openCounts).toEqual({ unsubscribe: 0, disconnect: 1, posts: 1 });
      expect(contextSpy.scopes).toEqual([scope]);
      expect(unsubscribeForOrganizationOffboarding).toHaveBeenCalledWith({ scope });
      expect(disconnectForOrganizationOffboarding).toHaveBeenCalledWith({ scope });
      // The second account held only stored posts: it changed too.
      expect(erasure).toEqual({
        instagramAccountPublicIds: ['cha_aaaaaaaaaaaaaaaaaaaaa', 'iga_bbbbbbbbbbbbbbbbbbbbb'],
        erasedPostCount: 4,
        // Only the first was revoked now: the channel account whose lanes a Meta callback stops.
        revokedChannelAccounts: [{ organizationId: 1, channelAccountId: 20 }],
      });
    });

    it('answers null when nothing was left to erase — a repeat, or an organization without Instagram', async () => {
      disconnectForOrganizationOffboarding.mockResolvedValueOnce([accountChange()]);
      deleteForAccount.mockResolvedValueOnce(0);
      await expect(service.eraseForOrganizationOffboarding(scope)).resolves.toBeNull();

      disconnectForOrganizationOffboarding.mockResolvedValueOnce([]);
      await expect(service.eraseForOrganizationOffboarding(scope)).resolves.toBeNull();
    });

    it('lets a database failure reach the delete', async () => {
      disconnectForOrganizationOffboarding.mockRejectedValue(new Error('the erase failed'));

      await expect(service.eraseForOrganizationOffboarding(scope)).rejects.toThrow(
        'the erase failed',
      );
    });
  });

  describe('eraseForMeta (MC15, MC16)', () => {
    it('a deauthorize keeps the profile and the posts', async () => {
      disconnectForMeta.mockResolvedValue([
        accountChange({ wasRevoked: true, wasTokenErased: true }),
      ]);

      const erasure = await service.eraseForMeta({
        scope,
        match: { kind: 'provider_account', providerAccountId: '8724000000000001' },
        issuedAt: 1_763_740_000,
        shouldEraseData: false,
      });

      expect(disconnectForMeta).toHaveBeenCalledWith({
        scope,
        match: { kind: 'provider_account', providerAccountId: '8724000000000001' },
        issuedAt: 1_763_740_000,
        shouldEraseProfile: false,
      });
      expect(deleteForAccount).not.toHaveBeenCalled();
      expect(erasure).toEqual({
        instagramAccountPublicIds: ['cha_aaaaaaaaaaaaaaaaaaaaa'],
        erasedPostCount: 0,
        revokedChannelAccounts: [{ organizationId: 1, channelAccountId: 20 }],
      });
    });

    it('a data deletion erases the profile and the posts of the accounts it disconnected only', async () => {
      const account = accountChange({ wasProfileErased: true });
      disconnectForMeta.mockResolvedValue([account]);
      deleteForAccount.mockResolvedValue(3);

      const erasure = await service.eraseForMeta({
        scope,
        match: { kind: 'provider_account', providerAccountId: '8724000000000001' },
        issuedAt: null,
        shouldEraseData: true,
      });

      expect(disconnectForMeta).toHaveBeenCalledWith(
        expect.objectContaining({ shouldEraseProfile: true, issuedAt: null }),
      );
      expect(deleteForAccount.mock.calls).toEqual([
        [{ scope, channelAccount: account.channelAccount }],
      ]);
      expect(erasure).toEqual({
        instagramAccountPublicIds: ['cha_aaaaaaaaaaaaaaaaaaaaa'],
        erasedPostCount: 3,
        // Revoked earlier (only its profile was left): no lane to stop now.
        revokedChannelAccounts: [],
      });
    });

    it('answers null when every account was connected after the request', async () => {
      disconnectForMeta.mockResolvedValue([]);

      await expect(
        service.eraseForMeta({
          scope,
          match: { kind: 'provider_account', providerAccountId: '8724000000000001' },
          issuedAt: 1_763_740_000,
          shouldEraseData: true,
        }),
      ).resolves.toBeNull();
      expect(deleteForAccount).not.toHaveBeenCalled();
    });
  });
});
