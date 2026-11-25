import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelConnectionRow,
  ChannelConnectionRepository,
} from '@/domains/app/sub-domains/channel-connection/channel-connection.repository.js';
import {
  type ChannelConnectionPlanAccessService,
  ChannelConnectionService,
} from '@/domains/app/sub-domains/channel-connection/channel-connection.service.js';
import type { ChannelConnectionTokenService } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.service.js';
import type { ChannelConnectionUsageService } from '@/domains/app/sub-domains/channel-connection/channel-connection-usage.service.js';
import type {
  ChannelConnectionAccount,
  ChannelConnectionAccountPort,
  ChannelConnectionLanePort,
} from '@/domains/app/sub-domains/channel-connection/channel-connection.types.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import { CONNECT_STATE_MINUTES } from '@/shared/constants/instagram.constants.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { NotFoundError, UnprocessableEntityError } from '@/shared/errors/index.js';

const { unitOfWork, readMetaAppSettings, mintChannelConnectState, buildMetaLoginUrl } = vi.hoisted(
  () => ({
    /** How many units of work are open, and the open count at each Meta call. */
    unitOfWork: { openCount: 0, openCountAtMetaCalls: [] as number[] },
    readMetaAppSettings: vi.fn(),
    mintChannelConnectState: vi.fn(async () => 'state-token'),
    buildMetaLoginUrl: vi.fn(
      ({ state }: { state: string }) => `https://login.test/?state=${state}`,
    ),
  }),
);

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The unit lane has no Postgres: the unit of work runs the callback directly, counted open.
    withAppDatabaseContext: vi.fn(
      async ({ callback }: { callback: (databaseHandle: unknown) => Promise<unknown> }) => {
        unitOfWork.openCount += 1;
        try {
          return await callback({});
        } finally {
          unitOfWork.openCount -= 1;
        }
      },
    ),
  };
});

vi.mock(
  '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, readMetaAppSettings };
  },
);

vi.mock(
  '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-login.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, buildMetaLoginUrl };
  },
);

vi.mock(
  '@/domains/app/sub-domains/channel-connection/channel-connection-state.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, mintChannelConnectState };
  },
);

// The connection object's shape has its own test (`channel-connection.serializer.unit.test.ts`).
vi.mock(
  '@/domains/app/sub-domains/channel-connection/channel-connection.serializer.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      serializeChannelConnection: vi.fn(
        ({
          connection,
          connected_by_user_public_id,
          accounts,
        }: {
          connection: ChannelConnectionRow;
          connected_by_user_public_id: string | null;
          accounts: ChannelConnectionAccount[];
        }) => ({
          id: connection.public_id,
          connected_by_user_id: connected_by_user_public_id,
          account_ids: accounts.map((account) => account.publicId),
        }),
      ),
    };
  },
);

/**
 * The channel connection service's own decisions (routes-final § 1 — routes 1, 4, 5, 40, 42 and the
 * MC11 break) with its repository, the token, account, organization and plan services, the Meta
 * client and the login state faked: the team checks, the login state's payload and end, which
 * connections read as `404`, how a list groups the accounts, that only the break's winner breaks the
 * accounts, and that route 5 calls Meta outside every unit of work and stops each revoked account's
 * lanes. The callback and the pick are in the integration test; the SQL in the repository tests.
 */

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const USER_PUBLIC_ID = 'usr_a1b2c3d4e5f6g7h8i9j0k';
const ORGANIZATION_ID = 7;
const NOW = new Date('2026-11-24T09:00:00.000Z');
const scope: OrganizationPrincipalDatabaseScope = PRINCIPAL_SCOPE.VERIFIED({
  organizationPublicId: ORGANIZATION_PUBLIC_ID,
});

function connectionRow(overrides: Partial<ChannelConnectionRow> = {}): ChannelConnectionRow {
  return {
    id: 9,
    public_id: 'chc_a1b2c3d4e5f6g7h8i9j0k',
    organization_id: ORGANIZATION_ID,
    provider: 'meta',
    status: 'connected',
    connected_by_user_id: 41,
    ...overrides,
  } as ChannelConnectionRow;
}

function portAccount(overrides: Partial<ChannelConnectionAccount> = {}): ChannelConnectionAccount {
  return {
    internalId: 5,
    publicId: 'cha_k7x9m2pqr4w8n1v3a1b2c',
    channel: 'instagram',
    providerAccountId: '17841400000000001',
    displayName: '@acme.shop',
    profilePictureUrl: null,
    connectionStatus: 'connected',
    channelConnectionId: 9,
    isWebhookSubscribed: true,
    ...overrides,
  };
}

function setup({
  organizationType = 'TEAM',
  connection = connectionRow() as ChannelConnectionRow | null,
  accounts = [portAccount()],
  hasToken = true,
  wasLive = true,
}: {
  organizationType?: 'TEAM' | 'PERSONAL';
  connection?: ChannelConnectionRow | null;
  accounts?: ChannelConnectionAccount[];
  hasToken?: boolean;
  wasLive?: boolean;
} = {}) {
  const connectionRepository = {
    findByPublicId: vi.fn(async () => connection),
    listByOrganizationId: vi.fn(async () => (connection === null ? [] : [connection])),
    markBroken: vi.fn(async (): Promise<ChannelConnectionRow | null> => connection),
  };
  const tokenService = {
    findAccessToken: vi.fn(async () => (hasToken ? { encryptedAccessToken: 'v1:cipher' } : null)),
    revokeConnection: vi.fn(async () => wasLive),
  };
  const accountPort = {
    listAccountsOfConnections: vi.fn(async () => accounts),
    unsubscribeAccountsBestEffort: vi.fn(async () => {
      unitOfWork.openCountAtMetaCalls.push(unitOfWork.openCount);
    }),
    revokeAccountsOfConnection: vi.fn(async () => accounts),
    markAccountsOfConnectionBroken: vi.fn(async () => undefined),
  };
  const organizationService = {
    requireOrganizationByPublicId: vi.fn(async () => ({
      id: ORGANIZATION_ID,
      public_id: ORGANIZATION_PUBLIC_ID,
      type: organizationType,
    })),
    resolveUserPublicIdsByInternalIds: vi.fn(async () => new Map([[41, USER_PUBLIC_ID]])),
  };
  const lanePort = { stopLanes: vi.fn(async (_options: Record<string, unknown>) => undefined) };
  const service = new ChannelConnectionService(
    connectionRepository as unknown as ChannelConnectionRepository,
    tokenService as unknown as ChannelConnectionTokenService,
    {} as ChannelConnectionUsageService,
    accountPort as unknown as ChannelConnectionAccountPort,
    organizationService as unknown as OrganizationService,
    {} as ChannelConnectionPlanAccessService,
    {} as Redis,
    lanePort as unknown as ChannelConnectionLanePort,
  );
  return { service, connectionRepository, tokenService, accountPort, lanePort };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  unitOfWork.openCount = 0;
  unitOfWork.openCountAtMetaCalls = [];
  readMetaAppSettings.mockReset();
  readMetaAppSettings.mockReturnValue({ configId: 'config-at-start' });
  mintChannelConnectState.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ChannelConnectionService.startLogin (route 1)', () => {
  it('mints a one-use state for this organization, user and login configuration (P356) and answers the login address', async () => {
    const { service } = setup();

    const output = await service.startLogin({
      scope,
      userPublicId: USER_PUBLIC_ID,
      provider: 'meta',
    });

    expect(mintChannelConnectState).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          provider: 'meta',
          organization_public_id: ORGANIZATION_PUBLIC_ID,
          user_public_id: USER_PUBLIC_ID,
          channel_connection_public_id: null,
          config_id: 'config-at-start',
        },
      }),
    );
    expect(output).toEqual({
      login_url: 'https://login.test/?state=state-token',
      state_expires_at: new Date(
        NOW.getTime() + CONNECT_STATE_MINUTES * MILLISECONDS_PER_MINUTE,
      ).toISOString(),
    });
  });

  it('answers 422 to a personal organization before any state is stored', async () => {
    const { service } = setup({ organizationType: 'PERSONAL' });

    await expect(
      service.startLogin({ scope, userPublicId: USER_PUBLIC_ID, provider: 'meta' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
    expect(mintChannelConnectState).not.toHaveBeenCalled();
  });

  it('stores no state when the Meta settings are unset', async () => {
    const { service } = setup();
    const unset = new Error('instagram_not_configured');
    readMetaAppSettings.mockImplementationOnce(() => {
      throw unset;
    });

    await expect(
      service.startLogin({ scope, userPublicId: USER_PUBLIC_ID, provider: 'meta' }),
    ).rejects.toBe(unset);
    expect(mintChannelConnectState).not.toHaveBeenCalled();
  });
});

describe('ChannelConnectionService.startReconnect (route 40)', () => {
  it("binds the state to the connection's public id and provider", async () => {
    const { service } = setup({ connection: connectionRow({ status: 'error' }) });

    await service.startReconnect({
      scope,
      userPublicId: USER_PUBLIC_ID,
      channelConnectionPublicId: 'chc_a1b2c3d4e5f6g7h8i9j0k',
    });

    expect(mintChannelConnectState).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          provider: 'meta',
          channel_connection_public_id: 'chc_a1b2c3d4e5f6g7h8i9j0k',
        }),
      }),
    );
  });

  it.each([
    ['missing', null],
    ['revoked', connectionRow({ status: 'revoked' })],
  ])('answers 404 channel_connection_not_found for a %s connection', async (_label, connection) => {
    const { service } = setup({ connection });

    const failure = service.startReconnect({
      scope,
      userPublicId: USER_PUBLIC_ID,
      channelConnectionPublicId: 'chc_a1b2c3d4e5f6g7h8i9j0k',
    });

    await expect(failure).rejects.toBeInstanceOf(NotFoundError);
    await expect(failure).rejects.toMatchObject({ reason: 'channel_connection_not_found' });
    expect(mintChannelConnectState).not.toHaveBeenCalled();
  });
});

describe('ChannelConnectionService reads (routes 4, 42)', () => {
  it("lists each connection with only its own accounts and the connecting user's public id", async () => {
    const other = connectionRow({
      id: 10,
      public_id: 'chc_z9y8x7w6v5u4t3s2r1q0p',
      connected_by_user_id: null,
    });
    const { service, connectionRepository } = setup({
      accounts: [
        portAccount(),
        portAccount({
          internalId: 6,
          publicId: 'cha_other0000000000000000',
          channelConnectionId: 10,
        }),
      ],
    });
    connectionRepository.listByOrganizationId.mockResolvedValueOnce([connectionRow(), other]);

    const outputs = await service.listConnections({ scope, includeRevoked: true });

    expect(connectionRepository.listByOrganizationId).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      includeRevoked: true,
    });
    expect(outputs).toEqual([
      {
        id: 'chc_a1b2c3d4e5f6g7h8i9j0k',
        connected_by_user_id: USER_PUBLIC_ID,
        account_ids: ['cha_k7x9m2pqr4w8n1v3a1b2c'],
      },
      {
        id: 'chc_z9y8x7w6v5u4t3s2r1q0p',
        connected_by_user_id: null,
        account_ids: ['cha_other0000000000000000'],
      },
    ]);
  });

  it('answers 404 team_organization_required to a personal organization', async () => {
    const { service } = setup({ organizationType: 'PERSONAL' });

    await expect(service.listConnections({ scope, includeRevoked: false })).rejects.toMatchObject({
      reason: 'team_organization_required',
    });
  });

  it('reads a revoked connection but answers 404 for a missing one', async () => {
    const revoked = setup({ connection: connectionRow({ status: 'revoked' }) });
    await expect(
      revoked.service.getConnection({
        scope,
        channelConnectionPublicId: 'chc_a1b2c3d4e5f6g7h8i9j0k',
      }),
    ).resolves.toMatchObject({ id: 'chc_a1b2c3d4e5f6g7h8i9j0k' });

    const missing = setup({ connection: null });
    await expect(
      missing.service.getConnection({
        scope,
        channelConnectionPublicId: 'chc_a1b2c3d4e5f6g7h8i9j0k',
      }),
    ).rejects.toMatchObject({ reason: 'channel_connection_not_found' });
  });
});

describe('ChannelConnectionService.markConnectionBroken (MC11)', () => {
  const channelConnection = { organizationId: ORGANIZATION_ID, channelConnectionId: 9 };

  it('breaks the accounts when this caller won the guarded change', async () => {
    const { service, connectionRepository, accountPort } = setup();

    await expect(
      service.markConnectionBroken({
        scope,
        channelConnection,
        lastCheckError: 'auth:190',
        requestId: 'req_1',
      }),
    ).resolves.toBe(true);
    expect(connectionRepository.markBroken).toHaveBeenCalledWith({
      ...channelConnection,
      lastCheckError: 'auth:190',
    });
    expect(accountPort.markAccountsOfConnectionBroken).toHaveBeenCalledWith({
      scope,
      organizationId: ORGANIZATION_ID,
      channelConnectionId: 9,
      requestId: 'req_1',
    });
  });

  it('leaves the accounts to the winner when the connection was not connected any more', async () => {
    const { service, connectionRepository, accountPort } = setup();
    connectionRepository.markBroken.mockResolvedValueOnce(null);

    await expect(
      service.markConnectionBroken({
        scope,
        channelConnection,
        lastCheckError: 'auth:190',
        requestId: 'req_1',
      }),
    ).resolves.toBe(false);
    expect(accountPort.markAccountsOfConnectionBroken).not.toHaveBeenCalled();
  });
});

describe('ChannelConnectionService.disconnectConnection (route 5)', () => {
  const caller = {
    scope,
    requestId: 'req_1',
    channelConnectionPublicId: 'chc_a1b2c3d4e5f6g7h8i9j0k',
  };

  it("unsubscribes outside every unit of work, then revokes, stopping each account's lanes", async () => {
    const accounts = [
      portAccount(),
      portAccount({ internalId: 6, publicId: 'cha_other0000000000000000' }),
    ];
    const { service, accountPort, lanePort, tokenService } = setup({ accounts });

    const result = await service.disconnectConnection(caller);

    expect(accountPort.unsubscribeAccountsBestEffort).toHaveBeenCalledWith({
      scope,
      accounts,
      encryptedAccessToken: 'v1:cipher',
      requestId: 'req_1',
    });
    expect(unitOfWork.openCountAtMetaCalls).toEqual([0]);
    expect(lanePort.stopLanes.mock.calls.map(([options]) => options)).toEqual([
      { scope, organizationId: ORGANIZATION_ID, channelAccountId: 5 },
      { scope, organizationId: ORGANIZATION_ID, channelAccountId: 6 },
    ]);
    expect(tokenService.revokeConnection).toHaveBeenCalledWith({
      scope,
      channelConnection: { organizationId: ORGANIZATION_ID, channelConnectionId: 9 },
    });
    expect(result).toEqual({
      channelConnectionPublicId: 'chc_a1b2c3d4e5f6g7h8i9j0k',
      disconnectedAccountCount: 2,
    });
  });

  it('skips the Meta call when the connection has no token', async () => {
    const { service, accountPort } = setup({ hasToken: false });

    await service.disconnectConnection(caller);

    expect(accountPort.unsubscribeAccountsBestEffort).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['revoked', connectionRow({ status: 'revoked' })],
  ])('answers 404 for a %s connection before any Meta call', async (_label, connection) => {
    const { service, accountPort } = setup({ connection });

    await expect(service.disconnectConnection(caller)).rejects.toMatchObject({
      reason: 'channel_connection_not_found',
    });
    expect(accountPort.unsubscribeAccountsBestEffort).not.toHaveBeenCalled();
    expect(accountPort.revokeAccountsOfConnection).not.toHaveBeenCalled();
  });

  it('answers 404 when a concurrent disconnect revoked the connection first', async () => {
    const { service } = setup({ wasLive: false });

    await expect(service.disconnectConnection(caller)).rejects.toMatchObject({
      reason: 'channel_connection_not_found',
    });
  });

  it('answers 422 to a personal organization', async () => {
    const { service, connectionRepository } = setup({ organizationType: 'PERSONAL' });

    await expect(service.disconnectConnection(caller)).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
    expect(connectionRepository.findByPublicId).not.toHaveBeenCalled();
  });
});
