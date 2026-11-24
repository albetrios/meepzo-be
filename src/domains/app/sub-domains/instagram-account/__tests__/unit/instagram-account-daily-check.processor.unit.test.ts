import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  accountRepository,
  retentionAccountRepository,
  tokenRepository,
  instagramClient,
  enqueueDailyChecksMock,
} = vi.hoisted(() => ({
  accountRepository: {
    findByPublicIdInOrganization: vi.fn(),
    recordProfileRefresh: vi.fn(),
    recordWebhookSubscribed: vi.fn(),
  },
  retentionAccountRepository: { listConnectedForDailyCheck: vi.fn() },
  tokenRepository: { findByConnection: vi.fn() },
  instagramClient: {
    readInstagramAccountProfile: vi.fn(),
    subscribeInstagramWebhookFields: vi.fn(),
  },
  enqueueDailyChecksMock: vi.fn(),
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

vi.mock('@/infrastructure/queue/worker-runtime/provider-outage-pause.util.js', () => ({
  ProviderOutageError: class ProviderOutageError extends Error {
    readonly provider: string;
    readonly retryAfterMs: number | null;
    constructor(options: { provider: string; cause: unknown; retryAfterMs?: number | null }) {
      super(`provider_outage:${options.provider}`, { cause: options.cause });
      this.provider = options.provider;
      this.retryAfterMs = options.retryAfterMs ?? null;
    }
  },
}));

vi.mock(
  '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js',
  () => instagramClient,
);

vi.mock('@/domains/app/sub-domains/instagram-account/instagram-account.repository.js', () => ({
  createWorkerInstagramAccountRepository: () => accountRepository,
  createRetentionInstagramAccountRepository: () => retentionAccountRepository,
}));

vi.mock(
  '@/domains/app/sub-domains/channel-connection/channel-connection-token.repository.js',
  () => ({
    createWorkerChannelConnectionTokenRepository: () => tokenRepository,
  }),
);

vi.mock(
  '@/domains/app/sub-domains/instagram-account/queues/instagram-account-daily-check.queue.js',
  () => ({ enqueueInstagramAccountDailyChecks: enqueueDailyChecksMock }),
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  describeMetaGraphError,
  readMetaGraphErrorResponse,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { ProviderOutageError } from '@/infrastructure/queue/worker-runtime/provider-outage-pause.util.js';
import {
  classifyInstagramDailyCheckFailure,
  processInstagramAccountDailyCheckJob,
  runInstagramAccountDailyCheckSweep,
} from '@/domains/app/sub-domains/instagram-account/workers/instagram-account-daily-check.processor.js';
import { INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE } from '@/domains/app/sub-domains/instagram-account/workers/instagram-account-daily-check.constants.js';

/**
 * The daily account check (launch IA8, IAC8) with its database steps and Meta mocked, after
 * feat-instagram-dm-sending R3 took the renewal out (WC-35): the token is the account's connection's
 * and is read, never renewed; the profile and subscription steps and how each failed call is classed.
 * The same rules against Postgres: `__tests__/integration/instagram-account-daily-check.integration.test.ts`.
 */

const NOW = new Date('2026-11-21T04:00:00.000Z');
const ORGANIZATION_PUBLIC_ID = 'org_acmeshop00000000000001';
const ACCOUNT_PUBLIC_ID = 'iga_acmeshop00000000000001';
const STORED_CIPHERTEXT = 'v1:stored-token-ciphertext';

function instagramError(options: { httpStatus: number; body: unknown; retryAfter?: string }) {
  return readMetaGraphErrorResponse({
    httpStatus: options.httpStatus,
    body: JSON.stringify(options.body),
    retryAfterHeader: options.retryAfter ?? null,
  });
}

const dyingTokenError = () =>
  instagramError({
    httpStatus: 400,
    body: { error: { message: 'Invalid OAuth access token.', code: 190, error_subcode: 460 } },
  });
const endedTokenError = () =>
  instagramError({
    httpStatus: 400,
    body: { error: { message: 'Session has expired.', code: 190, error_subcode: 463 } },
  });
const outageError = () =>
  instagramError({ httpStatus: 503, body: { error: { message: 'Service unavailable', code: 2 } } });

function connectedAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 41,
    public_id: ACCOUNT_PUBLIC_ID,
    organization_id: 7,
    connection_status: 'connected',
    instagram_user_id: '17841400000000001',
    channel_connection_id: 5,
    webhook_subscribed_at: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

function profileOf(instagramUserId = '17841400000000001') {
  return {
    instagramUserId,
    username: 'acme.shop',
    name: 'Acme Shop',
    profilePictureUrl: 'https://scontent.cdninstagram.com/v/acme.jpg',
    followersCount: 1300,
    followsCount: 90,
    mediaCount: 60,
    biography: 'Handmade things.',
    website: 'https://example.com',
  };
}

const markConnectionBroken = vi.fn();

function runCheck() {
  return processInstagramAccountDailyCheckJob({
    jobData: {
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
    },
    accountService: { markConnectionBroken },
    requestId: 'instagram-account-daily-check-test',
  });
}

function storeToken() {
  tokenRepository.findByConnection.mockResolvedValue({
    encryptedAccessToken: STORED_CIPHERTEXT,
    encryptedRefreshToken: null,
    tokenType: 'system_user',
    expiresAt: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  accountRepository.findByPublicIdInOrganization.mockResolvedValue(connectedAccount());
  accountRepository.recordProfileRefresh.mockResolvedValue(true);
  accountRepository.recordWebhookSubscribed.mockResolvedValue(true);
  storeToken();
  instagramClient.readInstagramAccountProfile.mockResolvedValue(profileOf());
  instagramClient.subscribeInstagramWebhookFields.mockResolvedValue(undefined);
  markConnectionBroken.mockResolvedValue(null);
});

describe('classifyInstagramDailyCheckFailure', () => {
  it('breaks on a refused token — expired for subcode 463, error otherwise', () => {
    expect(classifyInstagramDailyCheckFailure(endedTokenError())).toEqual({
      action: 'break',
      connectionStatus: 'expired',
    });
    expect(classifyInstagramDailyCheckFailure(dyingTokenError())).toEqual({
      action: 'break',
      connectionStatus: 'error',
    });
    const permissionRemoved = instagramError({
      httpStatus: 403,
      body: { error: { message: 'Permission denied', code: 200 } },
    });
    expect(classifyInstagramDailyCheckFailure(permissionRemoved)).toEqual({
      action: 'break',
      connectionStatus: 'error',
    });
  });

  it('never breaks on a code-10 messaging-window refusal (D32) — it is one refused request', () => {
    const outsideWindow = instagramError({
      httpStatus: 400,
      body: {
        error: {
          message: 'This message is sent outside of allowed window.',
          code: 10,
          error_subcode: 2534022,
        },
      },
    });
    expect(classifyInstagramDailyCheckFailure(outsideWindow)).toEqual({ action: 'continue' });
  });

  it('waits on an outage, a throttle, and anything that is not an Instagram answer', () => {
    expect(classifyInstagramDailyCheckFailure(outageError())).toEqual({ action: 'wait' });
    const throttled = instagramError({
      httpStatus: 400,
      body: { error: { message: 'Application request limit reached', code: 4 } },
    });
    expect(classifyInstagramDailyCheckFailure(throttled)).toEqual({ action: 'wait' });
    expect(classifyInstagramDailyCheckFailure(new Error('database gone'))).toEqual({
      action: 'wait',
    });
  });
});

describe('describeMetaGraphError', () => {
  it("keeps Instagram's class, codes and status, never its text — which can quote the token", () => {
    expect(describeMetaGraphError(endedTokenError())).toBe(
      'auth (code 190, subcode 463, HTTP 400)',
    );
    expect(describeMetaGraphError(new TypeError('secret detail'))).toBe('failed: TypeError');
    const quotedToken = instagramError({
      httpStatus: 400,
      body: { error: { message: 'Malformed access token AQ_quoted_in_the_answer', code: 190 } },
    });
    expect(describeMetaGraphError(quotedToken)).not.toContain('AQ_quoted');
    expect(describeMetaGraphError(quotedToken)).not.toContain('Malformed');
  });
});

describe('processInstagramAccountDailyCheckJob', () => {
  it("reads the connection's token, refreshes the profile, never renews (WC-35)", async () => {
    await expect(runCheck()).resolves.toEqual({
      outcome: 'checked',
      profile: 'refreshed',
      subscription: 'already_subscribed',
    });

    expect(tokenRepository.findByConnection).toHaveBeenCalledWith({
      organizationId: 7,
      channelConnectionId: 5,
    });
    expect(instagramClient.readInstagramAccountProfile).toHaveBeenCalledWith({
      encryptedAccessToken: STORED_CIPHERTEXT,
      instagramUserId: '17841400000000001',
      requestId: 'instagram-account-daily-check-test',
    });
    expect(accountRepository.recordProfileRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 7, instagramAccountId: 41 }),
    );
    expect(markConnectionBroken).not.toHaveBeenCalled();
  });

  it('keeps the account connected when Meta is down: the job waits', async () => {
    const outage = outageError();
    instagramClient.readInstagramAccountProfile.mockRejectedValue(outage);

    await expect(runCheck()).rejects.toBe(outage);
    expect(markConnectionBroken).not.toHaveBeenCalled();
    expect(accountRepository.recordProfileRefresh).not.toHaveBeenCalled();
  });

  it('turns a throttled read into a provider pause for the time Meta asked', async () => {
    instagramClient.readInstagramAccountProfile.mockRejectedValue(
      instagramError({
        httpStatus: 429,
        body: { error: { message: 'Too many calls', code: 4 } },
        retryAfter: '120',
      }),
    );

    const failure = await runCheck().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderOutageError);
    expect(failure).toMatchObject({ provider: 'meta', retryAfterMs: 120_000 });
    expect(markConnectionBroken).not.toHaveBeenCalled();
  });

  it('skips an account that is no longer connected, calling nothing', async () => {
    accountRepository.findByPublicIdInOrganization.mockResolvedValue(
      connectedAccount({ connection_status: 'error' }),
    );

    await expect(runCheck()).resolves.toEqual({ outcome: 'skipped', reason: 'not_connected' });
    expect(tokenRepository.findByConnection).not.toHaveBeenCalled();
    expect(instagramClient.readInstagramAccountProfile).not.toHaveBeenCalled();
  });

  it('skips an account whose connection has no token', async () => {
    tokenRepository.findByConnection.mockResolvedValue(null);

    await expect(runCheck()).resolves.toEqual({ outcome: 'skipped', reason: 'token_missing' });
    expect(instagramClient.readInstagramAccountProfile).not.toHaveBeenCalled();
  });

  it('subscribes an account that is not subscribed, then stamps it', async () => {
    accountRepository.findByPublicIdInOrganization.mockResolvedValue(
      connectedAccount({ webhook_subscribed_at: null }),
    );

    await expect(runCheck()).resolves.toMatchObject({ subscription: 'subscribed' });
    expect(instagramClient.subscribeInstagramWebhookFields).toHaveBeenCalledWith({
      encryptedAccessToken: STORED_CIPHERTEXT,
      instagramUserId: '17841400000000001',
      requestId: 'instagram-account-daily-check-test',
    });
    expect(accountRepository.recordWebhookSubscribed).toHaveBeenCalledWith({
      organizationId: 7,
      instagramAccountId: 41,
    });
  });

  it('keeps going after a refused profile read; a messaging-window refusal never breaks (D32)', async () => {
    instagramClient.readInstagramAccountProfile.mockRejectedValue(
      instagramError({
        httpStatus: 400,
        body: { error: { message: 'outside of allowed window', code: 10, error_subcode: 2018278 } },
      }),
    );

    await expect(runCheck()).resolves.toMatchObject({ outcome: 'checked', profile: 'refused' });
    expect(markConnectionBroken).not.toHaveBeenCalled();
    expect(accountRepository.recordProfileRefresh).not.toHaveBeenCalled();
  });

  it('breaks the connection when the profile read finds the token refused', async () => {
    instagramClient.readInstagramAccountProfile.mockRejectedValue(dyingTokenError());

    await expect(runCheck()).resolves.toEqual({
      outcome: 'broken',
      connectionStatus: 'error',
      step: 'profile',
    });
    expect(markConnectionBroken).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'job' },
        instagramAccount: { organizationId: 7, instagramAccountId: 41 },
        connectionStatus: 'error',
      }),
    );
  });

  it('does not write a profile that belongs to another Instagram account', async () => {
    instagramClient.readInstagramAccountProfile.mockResolvedValue(profileOf('17841499999999999'));

    await expect(runCheck()).resolves.toMatchObject({ profile: 'mismatch' });
    expect(accountRepository.recordProfileRefresh).not.toHaveBeenCalled();
  });
});

describe('runInstagramAccountDailyCheckSweep', () => {
  it('pages through every connected account and hands one check each to the queue', async () => {
    const fullPage = Array.from(
      { length: INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE },
      (_, i) => ({
        id: i + 1,
        instagramAccountPublicId: `iga_page${String(i).padStart(17, '0')}`,
        organizationPublicId: `org_page${String(i).padStart(17, '0')}`,
      }),
    );
    const lastPage = [
      {
        id: INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE + 1,
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
      },
    ];
    retentionAccountRepository.listConnectedForDailyCheck
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce(lastPage);
    enqueueDailyChecksMock.mockImplementation(
      async ({ targets }: { targets: unknown[] }) => targets.length,
    );

    await expect(runInstagramAccountDailyCheckSweep({ now: NOW })).resolves.toEqual({
      listedCount: INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE + 1,
      addedCount: INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE + 1,
      capped: false,
    });

    expect(retentionAccountRepository.listConnectedForDailyCheck).toHaveBeenNthCalledWith(2, {
      afterId: INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE,
      limit: INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE,
    });
    expect(enqueueDailyChecksMock).toHaveBeenLastCalledWith({
      targets: [
        {
          organizationPublicId: ORGANIZATION_PUBLIC_ID,
          instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        },
      ],
      checkedOn: NOW,
    });
    // The sweep never reads a token.
    expect(tokenRepository.findByConnection).not.toHaveBeenCalled();
  });

  it('logs a failed add and carries on — tomorrow lists the accounts again', async () => {
    retentionAccountRepository.listConnectedForDailyCheck.mockResolvedValueOnce([
      {
        id: 1,
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
      },
    ]);
    enqueueDailyChecksMock.mockRejectedValue(new Error('Redis refused the write'));

    await expect(runInstagramAccountDailyCheckSweep({ now: NOW })).resolves.toEqual({
      listedCount: 1,
      addedCount: 0,
      capped: false,
    });
  });
});
