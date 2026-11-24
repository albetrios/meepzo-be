import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import { ServiceUnavailableError } from '@/shared/errors/index.js';

const appSettings = vi.hoisted(() => ({
  appSecret: 'meta-callback-unit-test-app-secret' as string | null,
}));
const contextSpy = vi.hoisted(() => ({ scopes: [] as OrganizationPrincipalDatabaseScope[] }));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/infrastructure/database/contexts/database-context.js')>();
  return {
    ...actual,
    // No database: run the unit of work inline and record the scope it was opened with.
    withAppDatabaseContext: async ({
      scope,
      callback,
    }: {
      scope: OrganizationPrincipalDatabaseScope;
      callback: () => Promise<unknown>;
    }) => {
      contextSpy.scopes.push(scope);
      return callback();
    },
  };
});

vi.mock(
  '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js',
  () => ({
    readMetaAppSecret: () => {
      if (appSettings.appSecret === null) {
        throw new ServiceUnavailableError('errors:instagramNotConfigured').withReason(
          'instagram_not_configured',
        );
      }
      return appSettings.appSecret;
    },
  }),
);

import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import { InstagramAccountErasureService } from '@/domains/app/sub-domains/instagram-account/instagram-account-erasure.service.js';
import type { InstagramAccountDisconnectChange } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import type { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import { InstagramAccountMetaCallbackService } from '@/domains/app/sub-domains/instagram-account/instagram-account-meta-callback/instagram-account-meta-callback.service.js';
import { deriveMetaDataDeletionConfirmationCode } from '@/domains/app/sub-domains/instagram-account/instagram-account-meta-callback/instagram-account-meta-callback-confirmation-code.util.js';

const APP_SECRET = 'meta-callback-unit-test-app-secret';
const signedRequest = { userId: '17841400000000001', issuedAt: 1_763_740_000 };

/** One account's outcome in `disconnectForMeta`. */
function accountChange(overrides: Partial<InstagramAccountDisconnectChange> = {}) {
  return {
    instagramAccount: { organizationId: 1, instagramAccountId: 10 },
    instagramAccountPublicId: 'cha_aaaaaaaaaaaaaaaaaaaaa',
    wasRevoked: false,
    wasTokenErased: false,
    wasProfileErased: false,
    ...overrides,
  } satisfies InstagramAccountDisconnectChange;
}

/**
 * {@link InstagramAccountMetaCallbackService} without a database (the context runs inline, the
 * account and media services are stubs): the resolver drives which organizations change, each in
 * its own verified scope; only organizations with something left to do are reported; data
 * deletion erases the posts and answers the derived code (IA19, IA20).
 */
describe('InstagramAccountMetaCallbackService (no database)', () => {
  const resolveOrganizationPublicIdsForInstagramAppUser = vi.fn();
  const disconnectForMeta = vi.fn();
  const deleteForAccount = vi.fn();
  const accountService = {
    resolveOrganizationPublicIdsForInstagramAppUser,
    disconnectForMeta,
  } as unknown as InstagramAccountService;
  const service = new InstagramAccountMetaCallbackService(
    accountService,
    new InstagramAccountErasureService(accountService, {
      deleteForAccount,
    } as unknown as InstagramMediaService),
  );

  beforeEach(() => {
    vi.clearAllMocks();
    contextSpy.scopes.length = 0;
    appSettings.appSecret = APP_SECRET;
  });

  it('deauthorize: disconnects in every organization the resolver names, each in its own verified scope', async () => {
    resolveOrganizationPublicIdsForInstagramAppUser.mockResolvedValue(['org_a', 'org_b']);
    disconnectForMeta
      .mockResolvedValueOnce([accountChange({ wasRevoked: true, wasTokenErased: true })])
      .mockResolvedValueOnce([
        accountChange({ instagramAccountPublicId: 'iga_bbbbbbbbbbbbbbbbbbbbb' }),
      ]);

    const result = await service.deauthorize({ signedRequest });

    expect(resolveOrganizationPublicIdsForInstagramAppUser).toHaveBeenCalledWith(
      signedRequest.userId,
    );
    expect(contextSpy.scopes.map((scope) => [scope.organizationPublicId, scope.source])).toEqual([
      ['org_a', 'verified'],
      ['org_b', 'verified'],
    ]);
    // The account service compares when Meta signed with when the account was connected (D53).
    expect(disconnectForMeta).toHaveBeenNthCalledWith(1, {
      scope: contextSpy.scopes[0],
      instagramAppUserId: signedRequest.userId,
      issuedAt: signedRequest.issuedAt,
      shouldEraseProfile: false,
    });
    // org_b's row was already revoked and tokenless: nothing left to do, so it is not reported.
    expect(result.changes).toEqual([
      {
        organizationPublicId: 'org_a',
        instagramAccountPublicIds: ['cha_aaaaaaaaaaaaaaaaaaaaa'],
        erasedPostCount: 0,
      },
    ]);
    expect(deleteForAccount).not.toHaveBeenCalled();
  });

  it('deauthorize of a person never stored changes nothing and reports nothing', async () => {
    resolveOrganizationPublicIdsForInstagramAppUser.mockResolvedValue([]);

    await expect(service.deauthorize({ signedRequest })).resolves.toEqual({ changes: [] });
    expect(disconnectForMeta).not.toHaveBeenCalled();
  });

  it('data deletion: erases the profile and each account’s posts, and answers the derived code', async () => {
    resolveOrganizationPublicIdsForInstagramAppUser.mockResolvedValue(['org_a']);
    const live = accountChange({ wasRevoked: true, wasTokenErased: true, wasProfileErased: true });
    const revokedEarlier = accountChange({
      instagramAccount: { organizationId: 1, instagramAccountId: 11 },
      instagramAccountPublicId: 'iga_ccccccccccccccccccccc',
    });
    disconnectForMeta.mockResolvedValue([live, revokedEarlier]);
    deleteForAccount.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

    const result = await service.deleteData({ signedRequest });

    expect(disconnectForMeta).toHaveBeenCalledWith(
      expect.objectContaining({ shouldEraseProfile: true, issuedAt: signedRequest.issuedAt }),
    );
    expect(deleteForAccount).toHaveBeenNthCalledWith(1, {
      scope: contextSpy.scopes[0],
      instagramAccount: live.instagramAccount,
    });
    expect(deleteForAccount).toHaveBeenNthCalledWith(2, {
      scope: contextSpy.scopes[0],
      instagramAccount: revokedEarlier.instagramAccount,
    });
    // The earlier-revoked row changed too: its stored posts were erased.
    expect(result.changes).toEqual([
      {
        organizationPublicId: 'org_a',
        instagramAccountPublicIds: ['cha_aaaaaaaaaaaaaaaaaaaaa', 'iga_ccccccccccccccccccccc'],
        erasedPostCount: 5,
      },
    ]);
    const code = deriveMetaDataDeletionConfirmationCode({ signedRequest, appSecret: APP_SECRET });
    expect(result.answer.confirmation_code).toBe(code);
    expect(result.answer.url).toMatch(new RegExp(`/instagram/data-deletion\\?code=${code}$`));
  });

  it('data deletion repeated: nothing left to do, nothing reported, the same answer', async () => {
    resolveOrganizationPublicIdsForInstagramAppUser.mockResolvedValue(['org_a']);
    disconnectForMeta.mockResolvedValue([accountChange()]);
    deleteForAccount.mockResolvedValue(0);

    const first = await service.deleteData({ signedRequest });
    const repeat = await service.deleteData({ signedRequest });

    expect(first.changes).toEqual([]);
    expect(repeat).toEqual(first);
  });

  it('data deletion without an app secret answers 503 before any lookup or write', async () => {
    appSettings.appSecret = null;

    await expect(service.deleteData({ signedRequest })).rejects.toMatchObject({
      statusCode: 503,
      reason: 'instagram_not_configured',
    });
    expect(resolveOrganizationPublicIdsForInstagramAppUser).not.toHaveBeenCalled();
    expect(disconnectForMeta).not.toHaveBeenCalled();
  });
});
