import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  connectionRepository,
  retentionConnectionRepository,
  tokenRepository,
  metaClient,
  enqueueChecksMock,
  reencryptMock,
} = vi.hoisted(() => ({
  connectionRepository: { findByPublicIdInOrganization: vi.fn(), recordTokenCheck: vi.fn() },
  retentionConnectionRepository: { listDueForTokenCheck: vi.fn() },
  tokenRepository: { findByConnection: vi.fn(), replaceEncryptedAccessToken: vi.fn() },
  metaClient: {
    listMetaAssignedInstagramAccounts: vi.fn(),
    readInstagramAccountProfile: vi.fn(),
  },
  enqueueChecksMock: vi.fn(),
  reencryptMock: vi.fn(),
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', () => ({
  PRINCIPAL_SCOPE: {
    JOB: (identity: Record<string, string>) => ({ ...identity, source: 'job' }),
  },
}));

// Each unit of work runs its callback with a stand-in handle; the repositories are stubs.
vi.mock('@/infrastructure/queue/worker-runtime/worker-processor.util.js', () => ({
  runOrganizationScopedWorkerJob: ({
    processor,
  }: {
    processor: (databaseHandle: unknown) => Promise<unknown>;
  }) => processor({}),
  runGlobalRetentionWorkerJob: (processor: (databaseHandle: unknown) => Promise<unknown>) =>
    processor({}),
}));

vi.mock(
  '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js',
  () => metaClient,
);

vi.mock('@/domains/app/sub-domains/channel-connection/channel-connection.repository.js', () => ({
  createWorkerChannelConnectionRepository: () => connectionRepository,
  createRetentionChannelConnectionRepository: () => retentionConnectionRepository,
}));

vi.mock(
  '@/domains/app/sub-domains/channel-connection/channel-connection-token.repository.js',
  () => ({ createWorkerChannelConnectionTokenRepository: () => tokenRepository }),
);

vi.mock(
  '@/domains/app/sub-domains/channel-connection/queues/channel-connection-token-check.queue.js',
  () => ({ enqueueChannelConnectionTokenChecks: enqueueChecksMock }),
);

vi.mock('@/shared/utils/security/field-secret-encryption.util.js', () => ({
  reencryptFieldSecretToCurrentVersion: reencryptMock,
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { readMetaGraphErrorResponse } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import {
  classifyChannelConnectionTokenCheckFailure,
  processChannelConnectionTokenCheckJob,
  runChannelConnectionTokenCheckSweep,
} from '@/domains/app/sub-domains/channel-connection/workers/channel-connection-token-check.processor.js';
import {
  CHANNEL_CONNECTION_TOKEN_CHECK_INTERVAL_MS,
  CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_PAGE_SIZE,
} from '@/domains/app/sub-domains/channel-connection/workers/channel-connection-token-check.constants.js';

/**
 * The channel connection's daily token check (routes-final § 1 MC10, MC11; WC-34; P17; S26) with
 * its database steps and Meta mocked: which service step each answer leads to. Against Postgres:
 * `__tests__/integration/channel-connection-token-check.integration.test.ts`.
 */

const NOW = new Date('2026-11-25T10:00:00.000Z');
const ORGANIZATION_PUBLIC_ID = 'org_acmeshop00000000000001';
const CONNECTION_PUBLIC_ID = 'chc_acmeshop00000000000001';
const STORED_CIPHERTEXT = 'v1:stored-token-ciphertext';
const SCOPE = { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'job' };

function metaError(options: { httpStatus: number; body: unknown }) {
  return readMetaGraphErrorResponse({
    httpStatus: options.httpStatus,
    body: JSON.stringify(options.body),
    retryAfterHeader: null,
  });
}

const tokenRefused = () =>
  metaError({ httpStatus: 400, body: { error: { message: 'Invalid token', code: 190 } } });
const outage = () =>
  metaError({ httpStatus: 503, body: { error: { message: 'Service unavailable', code: 2 } } });
const refused = () =>
  metaError({ httpStatus: 400, body: { error: { message: 'Unsupported request', code: 100 } } });

function account(overrides: Record<string, unknown> = {}) {
  return {
    internalId: 31,
    publicId: 'cha_acmeshop00000000000001',
    channel: 'instagram',
    providerAccountId: '17841400000000001',
    displayName: '@acme.shop',
    profilePictureUrl: null,
    connectionStatus: 'connected',
    channelConnectionId: 5,
    isWebhookSubscribed: true,
    ...overrides,
  };
}

function profileOf(instagramUserId = '17841400000000001') {
  return {
    instagramUserId,
    username: 'acme.shop',
    name: 'Acme Shop',
    profilePictureUrl: null,
    followersCount: 1300,
    followsCount: 90,
    mediaCount: 60,
    biography: 'Handmade things.',
    website: null,
  };
}

const connectionService = { markConnectionBroken: vi.fn() };
const accountPort = {
  listAccountsOfConnections: vi.fn(),
  markAccountBroken: vi.fn(),
  refreshAccountProfile: vi.fn(),
};

function runCheck() {
  return processChannelConnectionTokenCheckJob({
    jobData: {
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelConnectionPublicId: CONNECTION_PUBLIC_ID,
    },
    services: { connectionService, accountPort },
    requestId: 'token-check-test',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  connectionRepository.findByPublicIdInOrganization.mockResolvedValue({
    id: 5,
    public_id: CONNECTION_PUBLIC_ID,
    organization_id: 7,
    status: 'connected',
  });
  connectionRepository.recordTokenCheck.mockResolvedValue(true);
  tokenRepository.findByConnection.mockResolvedValue({
    encryptedAccessToken: STORED_CIPHERTEXT,
    encryptedRefreshToken: null,
    tokenType: 'system_user',
    expiresAt: null,
  });
  tokenRepository.replaceEncryptedAccessToken.mockResolvedValue(true);
  reencryptMock.mockReturnValue(null);
  accountPort.listAccountsOfConnections.mockResolvedValue([account()]);
  accountPort.markAccountBroken.mockResolvedValue(true);
  accountPort.refreshAccountProfile.mockResolvedValue(true);
  connectionService.markConnectionBroken.mockResolvedValue(true);
  metaClient.listMetaAssignedInstagramAccounts.mockResolvedValue([
    { instagramUserId: '17841400000000001', username: 'acme.shop' },
  ]);
  metaClient.readInstagramAccountProfile.mockResolvedValue(profileOf());
});

describe('classifyChannelConnectionTokenCheckFailure', () => {
  it('breaks on any token refusal, keeps a refused request, defers everything else', () => {
    expect(classifyChannelConnectionTokenCheckFailure(tokenRefused())).toBe('break');
    expect(classifyChannelConnectionTokenCheckFailure(refused())).toBe('refused');
    expect(classifyChannelConnectionTokenCheckFailure(outage())).toBe('defer');
    expect(
      classifyChannelConnectionTokenCheckFailure(
        metaError({ httpStatus: 429, body: { error: { message: 'Too many calls', code: 4 } } }),
      ),
    ).toBe('defer');
    expect(classifyChannelConnectionTokenCheckFailure(new Error('not Meta'))).toBe('defer');
  });
});

describe('processChannelConnectionTokenCheckJob', () => {
  it('reads the list, refreshes each connected profile and clears the error (MC10, P17)', async () => {
    await expect(runCheck()).resolves.toEqual({
      outcome: 'checked',
      refreshedCount: 1,
      missingCount: 0,
      reencrypted: false,
    });

    expect(metaClient.listMetaAssignedInstagramAccounts).toHaveBeenCalledWith({
      encryptedAccessToken: STORED_CIPHERTEXT,
      requestId: 'token-check-test',
      recordUsage: undefined,
    });
    expect(accountPort.refreshAccountProfile).toHaveBeenCalledWith({
      scope: SCOPE,
      organizationId: 7,
      channelAccountId: 31,
      profile: profileOf(),
    });
    expect(connectionRepository.recordTokenCheck).toHaveBeenCalledWith({
      organizationId: 7,
      channelConnectionId: 5,
      lastCheckError: null,
    });
    expect(connectionService.markConnectionBroken).not.toHaveBeenCalled();
  });

  it('breaks an account missing from the list alone (`account_not_shared`), never calling its profile', async () => {
    metaClient.listMetaAssignedInstagramAccounts.mockResolvedValue([]);

    await expect(runCheck()).resolves.toMatchObject({ outcome: 'checked', missingCount: 1 });
    expect(accountPort.markAccountBroken).toHaveBeenCalledWith({
      scope: SCOPE,
      organizationId: 7,
      channelAccountId: 31,
      requestId: 'token-check-test',
      stopReason: 'account_not_shared',
    });
    expect(metaClient.readInstagramAccountProfile).not.toHaveBeenCalled();
  });

  it('leaves accounts that are not connected alone', async () => {
    accountPort.listAccountsOfConnections.mockResolvedValue([
      account({ connectionStatus: 'error' }),
    ]);
    metaClient.listMetaAssignedInstagramAccounts.mockResolvedValue([]);

    await expect(runCheck()).resolves.toMatchObject({ refreshedCount: 0, missingCount: 0 });
    expect(accountPort.markAccountBroken).not.toHaveBeenCalled();
  });

  it('breaks the connection when Meta refuses the token (MC11), and stamps nothing else', async () => {
    const error = tokenRefused();
    metaClient.listMetaAssignedInstagramAccounts.mockRejectedValue(error);

    await expect(runCheck()).resolves.toEqual({
      outcome: 'broken',
      step: 'assigned_accounts',
      isWinner: true,
      reencrypted: false,
    });
    expect(connectionService.markConnectionBroken).toHaveBeenCalledWith({
      scope: SCOPE,
      channelConnection: { organizationId: 7, channelConnectionId: 5 },
      lastCheckError: 'auth (code 190, HTTP 400)',
      requestId: 'token-check-test',
    });
    expect(connectionRepository.recordTokenCheck).not.toHaveBeenCalled();
  });

  it('breaks the connection when a profile read finds the token refused', async () => {
    metaClient.readInstagramAccountProfile.mockRejectedValue(tokenRefused());

    await expect(runCheck()).resolves.toMatchObject({ outcome: 'broken', step: 'profile' });
    expect(connectionService.markConnectionBroken).toHaveBeenCalledTimes(1);
    expect(accountPort.refreshAccountProfile).not.toHaveBeenCalled();
  });

  it('changes nothing when Meta is down — the next sweep tries again', async () => {
    metaClient.listMetaAssignedInstagramAccounts.mockRejectedValue(outage());

    await expect(runCheck()).resolves.toEqual({
      outcome: 'deferred',
      step: 'assigned_accounts',
      reencrypted: false,
    });
    expect(connectionService.markConnectionBroken).not.toHaveBeenCalled();
    expect(connectionRepository.recordTokenCheck).not.toHaveBeenCalled();
  });

  it("keeps a refused list read's codes as the check's error", async () => {
    metaClient.listMetaAssignedInstagramAccounts.mockRejectedValue(refused());

    await expect(runCheck()).resolves.toEqual({ outcome: 'refused', reencrypted: false });
    expect(connectionRepository.recordTokenCheck).toHaveBeenCalledWith({
      organizationId: 7,
      channelConnectionId: 5,
      lastCheckError: 'refused (code 100, HTTP 400)',
    });
  });

  it('skips a refused profile read and carries on', async () => {
    metaClient.readInstagramAccountProfile.mockRejectedValue(refused());

    await expect(runCheck()).resolves.toMatchObject({ outcome: 'checked', refreshedCount: 0 });
    expect(connectionService.markConnectionBroken).not.toHaveBeenCalled();
  });

  it('skips a connection that is not connected, calling nothing', async () => {
    connectionRepository.findByPublicIdInOrganization.mockResolvedValue({
      id: 5,
      public_id: CONNECTION_PUBLIC_ID,
      organization_id: 7,
      status: 'error',
    });

    await expect(runCheck()).resolves.toEqual({ outcome: 'skipped', reason: 'not_connected' });
    expect(tokenRepository.findByConnection).not.toHaveBeenCalled();
    expect(metaClient.listMetaAssignedInstagramAccounts).not.toHaveBeenCalled();
  });

  it('skips a connection with no token', async () => {
    tokenRepository.findByConnection.mockResolvedValue(null);

    await expect(runCheck()).resolves.toEqual({ outcome: 'skipped', reason: 'token_missing' });
    expect(metaClient.listMetaAssignedInstagramAccounts).not.toHaveBeenCalled();
  });

  it('moves a token on an old key version and calls Meta with the new ciphertext (S26)', async () => {
    reencryptMock.mockReturnValue('v2:moved-ciphertext');

    await expect(runCheck()).resolves.toMatchObject({ outcome: 'checked', reencrypted: true });
    expect(tokenRepository.replaceEncryptedAccessToken).toHaveBeenCalledWith({
      organizationId: 7,
      channelConnectionId: 5,
      previousEncryptedAccessToken: STORED_CIPHERTEXT,
      encryptedAccessToken: 'v2:moved-ciphertext',
    });
    expect(metaClient.listMetaAssignedInstagramAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ encryptedAccessToken: 'v2:moved-ciphertext' }),
    );
  });

  it('keeps the stored ciphertext when a reconnect replaced the token meanwhile', async () => {
    reencryptMock.mockReturnValue('v2:moved-ciphertext');
    tokenRepository.replaceEncryptedAccessToken.mockResolvedValue(false);

    await expect(runCheck()).resolves.toMatchObject({ reencrypted: false });
    expect(metaClient.listMetaAssignedInstagramAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ encryptedAccessToken: STORED_CIPHERTEXT }),
    );
  });
});

describe('runChannelConnectionTokenCheckSweep', () => {
  it('pages through the due connections and hands one check each to the queue', async () => {
    const fullPage = Array.from(
      { length: CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_PAGE_SIZE },
      (_, index) => ({
        id: index + 1,
        channelConnectionPublicId: `chc_${index}`,
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
      }),
    );
    retentionConnectionRepository.listDueForTokenCheck
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([
        {
          id: 900,
          channelConnectionPublicId: 'chc_last',
          organizationPublicId: ORGANIZATION_PUBLIC_ID,
        },
      ]);
    enqueueChecksMock.mockImplementation(({ targets }: { targets: unknown[] }) =>
      Promise.resolve(targets.length),
    );

    await expect(runChannelConnectionTokenCheckSweep({ now: NOW })).resolves.toEqual({
      listedCount: CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_PAGE_SIZE + 1,
      addedCount: CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_PAGE_SIZE + 1,
      capped: false,
    });
    expect(retentionConnectionRepository.listDueForTokenCheck).toHaveBeenNthCalledWith(1, {
      dueBefore: new Date(NOW.getTime() - CHANNEL_CONNECTION_TOKEN_CHECK_INTERVAL_MS),
      afterId: 0,
      limit: CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_PAGE_SIZE,
    });
    expect(retentionConnectionRepository.listDueForTokenCheck).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ afterId: CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_PAGE_SIZE }),
    );
    expect(enqueueChecksMock).toHaveBeenLastCalledWith({
      targets: [
        { organizationPublicId: ORGANIZATION_PUBLIC_ID, channelConnectionPublicId: 'chc_last' },
      ],
      sweptAt: NOW,
    });
  });

  it('logs a failed add and carries on — the connections stay due', async () => {
    retentionConnectionRepository.listDueForTokenCheck.mockResolvedValueOnce([
      { id: 1, channelConnectionPublicId: 'chc_one', organizationPublicId: ORGANIZATION_PUBLIC_ID },
    ]);
    enqueueChecksMock.mockRejectedValue(new Error('redis down'));

    await expect(runChannelConnectionTokenCheckSweep({ now: NOW })).resolves.toEqual({
      listedCount: 1,
      addedCount: 0,
      capped: false,
    });
  });
});
