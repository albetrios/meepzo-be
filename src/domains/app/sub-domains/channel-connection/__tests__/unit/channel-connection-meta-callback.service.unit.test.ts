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
import { ChannelConnectionMetaCallbackService } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta-callback.service.js';
import { deriveMetaDataDeletionConfirmationCode } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta-callback-confirmation-code.util.js';
import type { ChannelConnectionRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection.repository.js';
import type { ChannelConnectionTokenService } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.service.js';

const APP_SECRET = 'meta-callback-unit-test-app-secret';
const signedRequest = { userId: '17841400000000001', issuedAt: 1_763_740_000 };
/** A moment before Meta signed (D53): an older connection is reached. */
const BEFORE_REQUEST = new Date((signedRequest.issuedAt - 60) * 1000);

/** One account's outcome in `disconnectForMeta`. */
function accountChange(overrides: Partial<InstagramAccountDisconnectChange> = {}) {
  return {
    instagramAccount: { organizationId: 1, instagramAccountId: 10 },
    channelAccount: { organizationId: 1, channelAccountId: 20 },
    instagramAccountPublicId: 'cha_aaaaaaaaaaaaaaaaaaaaa',
    wasRevoked: false,
    wasTokenErased: false,
    wasProfileErased: false,
    ...overrides,
  } satisfies InstagramAccountDisconnectChange;
}

/** A business connection row as `listByBusiness` reads it. */
function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 30,
    organization_id: 1,
    public_id: 'chc_aaaaaaaaaaaaaaaaaaaaa',
    status: 'connected',
    connected_at: BEFORE_REQUEST,
    ...overrides,
  };
}

/**
 * {@link ChannelConnectionMetaCallbackService} without a database (the context runs inline, the
 * account, media, connection and token pieces are stubs): the account resolver first, else the
 * business resolver (P56), each organization in its own verified scope; only organizations with
 * something left to do are reported; data deletion erases the posts and answers the derived code;
 * an unmatched id answers and alerts the team (MC15, MC16).
 */
describe('ChannelConnectionMetaCallbackService (no database)', () => {
  const resolveOrganizationPublicIdsForProviderAccount = vi.fn();
  const resolveOrganizationPublicIdsForProviderBusiness = vi.fn();
  const listByBusiness = vi.fn();
  const disconnectForMeta = vi.fn();
  const deleteForAccount = vi.fn();
  const revokeConnection = vi.fn();
  const countLiveAccountsOfConnection = vi.fn();
  const alertUnmatchedMetaCallback = vi.fn();
  const accountService = { disconnectForMeta } as unknown as InstagramAccountService;
  const service = new ChannelConnectionMetaCallbackService(
    {
      resolveOrganizationPublicIdsForProviderAccount,
      resolveOrganizationPublicIdsForProviderBusiness,
      listByBusiness,
    } as unknown as ChannelConnectionRepository,
    { revokeConnection } as unknown as ChannelConnectionTokenService,
    { countLiveAccountsOfConnection },
    new InstagramAccountErasureService(accountService, {
      deleteForAccount,
    } as unknown as InstagramMediaService),
    { alertUnmatchedMetaCallback },
  );

  beforeEach(() => {
    vi.clearAllMocks();
    contextSpy.scopes.length = 0;
    appSettings.appSecret = APP_SECRET;
    resolveOrganizationPublicIdsForProviderAccount.mockResolvedValue([]);
    resolveOrganizationPublicIdsForProviderBusiness.mockResolvedValue([]);
    countLiveAccountsOfConnection.mockResolvedValue(0);
  });

  it('deauthorize: an account match disconnects in every organization the resolver names, each in its own verified scope', async () => {
    resolveOrganizationPublicIdsForProviderAccount.mockResolvedValue(['org_a', 'org_b']);
    disconnectForMeta
      .mockResolvedValueOnce([accountChange({ wasRevoked: true, wasTokenErased: true })])
      .mockResolvedValueOnce([
        accountChange({ instagramAccountPublicId: 'cha_bbbbbbbbbbbbbbbbbbbbb' }),
      ]);

    const result = await service.deauthorize({ provider: 'meta', signedRequest });

    expect(resolveOrganizationPublicIdsForProviderAccount).toHaveBeenCalledWith({
      provider: 'meta',
      providerAccountId: signedRequest.userId,
    });
    expect(resolveOrganizationPublicIdsForProviderBusiness).not.toHaveBeenCalled();
    expect(contextSpy.scopes.map((scope) => [scope.organizationPublicId, scope.source])).toEqual([
      ['org_a', 'verified'],
      ['org_b', 'verified'],
    ]);
    // The account service compares when Meta signed with when the account was connected (D53).
    expect(disconnectForMeta).toHaveBeenNthCalledWith(1, {
      scope: contextSpy.scopes[0],
      match: { kind: 'provider_account', providerAccountId: signedRequest.userId },
      issuedAt: signedRequest.issuedAt,
      shouldEraseProfile: false,
    });
    // org_b's row was already revoked and tokenless: nothing left to do, so it is not reported.
    expect(result).toEqual({
      matchKind: 'provider_account',
      changes: [
        {
          organizationPublicId: 'org_a',
          channelAccountPublicIds: ['cha_aaaaaaaaaaaaaaaaaaaaa'],
          revokedChannelConnectionPublicIds: [],
          erasedPostCount: 0,
        },
      ],
    });
    expect(deleteForAccount).not.toHaveBeenCalled();
    expect(alertUnmatchedMetaCallback).not.toHaveBeenCalled();
  });

  it('deauthorize: with no account match, a business match reaches every not-revoked account of that business’s connections and revokes an emptied one (P56)', async () => {
    resolveOrganizationPublicIdsForProviderBusiness.mockResolvedValue(['org_a']);
    listByBusiness.mockResolvedValue([
      connectionRow(),
      // A connection with no account left (a login never picked) is revoked with its token.
      connectionRow({ id: 31, public_id: 'chc_bbbbbbbbbbbbbbbbbbbbb' }),
      // An already revoked one, and one connected after Meta signed (D53), are left alone.
      connectionRow({ id: 32, public_id: 'chc_ccccccccccccccccccccc', status: 'revoked' }),
      connectionRow({
        id: 33,
        public_id: 'chc_ddddddddddddddddddddd',
        connected_at: new Date((signedRequest.issuedAt + 60) * 1000),
      }),
    ]);
    disconnectForMeta.mockResolvedValue([
      accountChange({ wasRevoked: true, wasTokenErased: true }),
    ]);

    const result = await service.deauthorize({ provider: 'meta', signedRequest });

    expect(resolveOrganizationPublicIdsForProviderBusiness).toHaveBeenCalledWith({
      provider: 'meta',
      clientBusinessId: signedRequest.userId,
    });
    expect(listByBusiness).toHaveBeenCalledWith({
      organizationPublicId: 'org_a',
      provider: 'meta',
      clientBusinessId: signedRequest.userId,
    });
    expect(disconnectForMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        match: { kind: 'provider_business', channelConnectionIds: [30, 31, 32, 33] },
        shouldEraseProfile: false,
      }),
    );
    expect(revokeConnection.mock.calls.map(([input]) => input.channelConnection)).toEqual([
      { organizationId: 1, channelConnectionId: 30 },
      { organizationId: 1, channelConnectionId: 31 },
    ]);
    expect(result).toEqual({
      matchKind: 'provider_business',
      changes: [
        {
          organizationPublicId: 'org_a',
          channelAccountPublicIds: ['cha_aaaaaaaaaaaaaaaaaaaaa'],
          revokedChannelConnectionPublicIds: [
            'chc_aaaaaaaaaaaaaaaaaaaaa',
            'chc_bbbbbbbbbbbbbbbbbbbbb',
          ],
          erasedPostCount: 0,
        },
      ],
    });
  });

  it('a business match keeps a connection another (newer) account still uses', async () => {
    resolveOrganizationPublicIdsForProviderBusiness.mockResolvedValue(['org_a']);
    listByBusiness.mockResolvedValue([connectionRow()]);
    disconnectForMeta.mockResolvedValue([]);
    countLiveAccountsOfConnection.mockResolvedValue(1);

    const result = await service.deauthorize({ provider: 'meta', signedRequest });

    expect(revokeConnection).not.toHaveBeenCalled();
    expect(result.changes).toEqual([]);
  });

  it('deauthorize of an id that matches neither changes nothing, reports nothing and alerts the team (MC16)', async () => {
    const result = await service.deauthorize({
      provider: 'meta',
      signedRequest,
      requestId: 'req-1',
    });

    expect(result).toEqual({ matchKind: 'none', changes: [] });
    expect(disconnectForMeta).not.toHaveBeenCalled();
    expect(alertUnmatchedMetaCallback).toHaveBeenCalledWith({
      callback: 'deauthorize',
      provider: 'meta',
      providerId: signedRequest.userId,
      requestId: 'req-1',
    });
  });

  it('a failing team alert never fails Meta’s request', async () => {
    alertUnmatchedMetaCallback.mockRejectedValueOnce(new Error('mail down'));

    await expect(service.deleteData({ provider: 'meta', signedRequest })).resolves.toMatchObject({
      matchKind: 'none',
      changes: [],
    });
  });

  it('data deletion: erases the profile and each account’s posts, and answers the derived code', async () => {
    resolveOrganizationPublicIdsForProviderAccount.mockResolvedValue(['org_a']);
    const live = accountChange({ wasRevoked: true, wasTokenErased: true, wasProfileErased: true });
    const revokedEarlier = accountChange({
      instagramAccount: { organizationId: 1, instagramAccountId: 11 },
      channelAccount: { organizationId: 1, channelAccountId: 21 },
      instagramAccountPublicId: 'cha_ccccccccccccccccccccc',
    });
    disconnectForMeta.mockResolvedValue([live, revokedEarlier]);
    deleteForAccount.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

    const result = await service.deleteData({ provider: 'meta', signedRequest });

    expect(disconnectForMeta).toHaveBeenCalledWith(
      expect.objectContaining({ shouldEraseProfile: true, issuedAt: signedRequest.issuedAt }),
    );
    expect(deleteForAccount).toHaveBeenNthCalledWith(1, {
      scope: contextSpy.scopes[0],
      channelAccount: live.channelAccount,
    });
    expect(deleteForAccount).toHaveBeenNthCalledWith(2, {
      scope: contextSpy.scopes[0],
      channelAccount: revokedEarlier.channelAccount,
    });
    // The earlier-revoked row changed too: its stored posts were erased.
    expect(result.changes).toEqual([
      {
        organizationPublicId: 'org_a',
        channelAccountPublicIds: ['cha_aaaaaaaaaaaaaaaaaaaaa', 'cha_ccccccccccccccccccccc'],
        revokedChannelConnectionPublicIds: [],
        erasedPostCount: 5,
      },
    ]);
    const code = deriveMetaDataDeletionConfirmationCode({ signedRequest, appSecret: APP_SECRET });
    expect(result.answer.confirmation_code).toBe(code);
    expect(result.answer.url).toMatch(new RegExp(`/instagram/data-deletion\\?code=${code}$`));
  });

  it('data deletion of an unmatched id still answers its code and alerts the team with it (MC16)', async () => {
    const result = await service.deleteData({ provider: 'meta', signedRequest });

    const code = deriveMetaDataDeletionConfirmationCode({ signedRequest, appSecret: APP_SECRET });
    expect(result.answer.confirmation_code).toBe(code);
    expect(alertUnmatchedMetaCallback).toHaveBeenCalledWith(
      expect.objectContaining({ callback: 'data_deletion', confirmationCode: code }),
    );
  });

  it('data deletion repeated: nothing left to do, nothing reported, the same answer', async () => {
    resolveOrganizationPublicIdsForProviderAccount.mockResolvedValue(['org_a']);
    disconnectForMeta.mockResolvedValue([accountChange()]);
    deleteForAccount.mockResolvedValue(0);

    const first = await service.deleteData({ provider: 'meta', signedRequest });
    const repeat = await service.deleteData({ provider: 'meta', signedRequest });

    expect(first.changes).toEqual([]);
    expect(repeat).toEqual(first);
  });

  it('data deletion without an app secret answers 503 before any lookup or write', async () => {
    appSettings.appSecret = null;

    await expect(service.deleteData({ provider: 'meta', signedRequest })).rejects.toMatchObject({
      statusCode: 503,
      reason: 'instagram_not_configured',
    });
    expect(resolveOrganizationPublicIdsForProviderAccount).not.toHaveBeenCalled();
    expect(disconnectForMeta).not.toHaveBeenCalled();
  });
});
