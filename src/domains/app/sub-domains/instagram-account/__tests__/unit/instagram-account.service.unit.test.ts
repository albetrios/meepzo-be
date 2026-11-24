import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import { CircuitBreakerOpenError } from '@/infrastructure/resilience/circuit-breaker.js';
import type { InstagramAccountProfile } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableEntityError,
} from '@/shared/errors/index.js';
import { INSTAGRAM_ACCOUNT_UNIQUE_INDEXES } from '@/domains/app/sub-domains/instagram-account/instagram-account.constants.js';
import type {
  InstagramAccountRepository,
  InstagramAccountRow,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramAccountTokenService } from '@/domains/app/sub-domains/instagram-account/instagram-account-token.service.js';
import type { InstagramAccountSettingsRow } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import type { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';

const { unitOfWork, instagramClient, enqueueReconnectNotice, runEnqueueAfterCommit, loggerWarn } =
  vi.hoisted(() => ({
    /** How many units of work are open, and whether one was open at any Instagram call. */
    unitOfWork: { openCount: 0, openCountAtInstagramCalls: [] as number[] },
    instagramClient: {
      exchangeInstagramAuthorizationCode: vi.fn(),
      exchangeInstagramLongLivedAccessToken: vi.fn(),
      readInstagramAccountProfile: vi.fn(),
      subscribeInstagramWebhookFields: vi.fn(),
      unsubscribeInstagramWebhookFields: vi.fn(),
    },
    enqueueReconnectNotice: vi.fn(),
    runEnqueueAfterCommit: vi.fn(),
    loggerWarn: vi.fn(),
  }));

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
    return { ...actual, ...instagramClient };
  },
);

vi.mock('@/core/events/event-bus.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runEnqueueAfterCommit };
});

vi.mock(
  '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.queue.js',
  () => ({ enqueueInstagramReconnectNoticeBestEffort: enqueueReconnectNotice }),
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { warn: loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * The account service's own decisions (routes-final § 1.A — IA3, IA6, IA9, IA12–IA14, IA19, IA20,
 * WH3, WH10, AU27) with its repository, the token, settings and organization services and the
 * Instagram client faked: the order of the connect's three steps and each refusal's reason, what
 * stays best-effort, who a disconnect touches, and what each lookup answers — `null` or a 404. No
 * Instagram call is ever made inside a unit of work. The SQL is in
 * `instagram-account.repository.db.unit.test.ts`.
 */

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const OTHER_ORGANIZATION_PUBLIC_ID = 'org_z9y8x7w6v5u4t3s2r1q0p';
const CONNECTING_USER_PUBLIC_ID = 'usr_a1b2c3d4e5f6g7h8i9j0k';
const SETTINGS_EDITOR_PUBLIC_ID = 'usr_z9y8x7w6v5u4t3s2r1q0p';
const CONNECTING_USER_ID = 5;
const SETTINGS_EDITOR_ID = 6;
const INSTAGRAM_USER_ID = '17841400000000001';
const INSTAGRAM_APP_USER_ID = '8724000000000001';
const SHORT_LIVED_CIPHERTEXT = 'v1:short-lived-ciphertext';
const LONG_LIVED_CIPHERTEXT = 'v1:long-lived-ciphertext';
const STORED_CIPHERTEXT = 'v1:stored-ciphertext';
const TOKEN_EXPIRES_AT = new Date('2027-01-20T09:00:00.000Z');
const NOW = new Date('2026-11-21T09:00:00.000Z');
/** {@link NOW} as Meta signs a time: Unix seconds. */
const NOW_SECONDS = NOW.getTime() / 1000;
const REQUEST_ID = 'request-connect';
const GRANTED_PERMISSIONS = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
];
const scope: OrganizationPrincipalDatabaseScope = PRINCIPAL_SCOPE.VERIFIED({
  organizationPublicId: ORGANIZATION_PUBLIC_ID,
});
const TEAM = { id: 7, public_id: ORGANIZATION_PUBLIC_ID, type: 'TEAM' };
const ACCOUNT_PUBLIC_ID = 'iga_k7x9m2pqr4w8n1v3a1b2c';
const instagramAccount = { organizationId: TEAM.id, instagramAccountId: 3 };

function accountRow(overrides: Partial<InstagramAccountRow> = {}): InstagramAccountRow {
  return {
    id: instagramAccount.instagramAccountId,
    public_id: ACCOUNT_PUBLIC_ID,
    organization_id: TEAM.id,
    instagram_user_id: INSTAGRAM_USER_ID,
    instagram_app_user_id: INSTAGRAM_APP_USER_ID,
    username: 'acme.shop',
    name: 'Acme Shop',
    biography: 'Handmade things.',
    website: 'https://example.com',
    profile_picture_url: 'https://cdn.example.com/picture.jpg',
    followers_count: 1204,
    follows_count: 87,
    media_count: 54,
    scopes: GRANTED_PERMISSIONS,
    connection_status: 'connected',
    connection_status_changed_at: NOW,
    token_expires_at: TOKEN_EXPIRES_AT,
    webhook_subscribed_at: null,
    connected_by_user_id: CONNECTING_USER_ID,
    connected_at: NOW,
    disconnected_at: null,
    profile_synced_at: NOW,
    profile_erased_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function settingsRow(
  overrides: Partial<InstagramAccountSettingsRow> = {},
): InstagramAccountSettingsRow {
  return {
    id: 91,
    organization_id: TEAM.id,
    instagram_account_id: instagramAccount.instagramAccountId,
    is_automation_enabled: true,
    is_public_reply_safety_enabled: false,
    public_reply_chance_percent: 80,
    public_reply_hour_limit: 60,
    public_reply_gap_min_seconds: 20,
    public_reply_gap_max_seconds: 60,
    updated_by_user_id: SETTINGS_EDITOR_ID,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function profile(overrides: Partial<InstagramAccountProfile> = {}): InstagramAccountProfile {
  return {
    instagramUserId: INSTAGRAM_USER_ID,
    instagramAppUserId: INSTAGRAM_APP_USER_ID,
    username: 'acme.shop',
    name: 'Acme Shop',
    accountType: 'BUSINESS',
    profilePictureUrl: 'https://cdn.example.com/picture.jpg',
    followersCount: 1204,
    followsCount: 87,
    mediaCount: 54,
    biography: 'Handmade things.',
    website: 'https://example.com',
    ...overrides,
  };
}

/** An Instagram error of one class, as the client throws it. */
function instagramError({
  errorClass,
  retryAfterMs,
}: {
  errorClass: MetaGraphApiError['errorClass'];
  retryAfterMs?: number;
}): MetaGraphApiError {
  return new MetaGraphApiError({
    errorClass,
    category: errorClass === 'outage' ? 'http_5xx' : 'http_4xx',
    httpStatus: errorClass === 'outage' ? 500 : 400,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    details: {
      code: 100,
      subcode: 33,
      type: 'OAuthException',
      fbtraceId: 'trace-acme',
    },
    fallbackMessage: 'Instagram failed',
  });
}

/** A Postgres unique violation as Drizzle throws it: the driver's error is the cause. */
function uniqueViolation(constraint: string): Error {
  return new Error('Failed query', {
    cause: Object.assign(new Error('duplicate key value'), { code: '23505', constraint }),
  });
}

function setup({
  organizationType = 'TEAM',
  isOrganizationKnown = true,
  liveAccount = accountRow() as InstagramAccountRow | null,
  settings = settingsRow() as InstagramAccountSettingsRow | null,
  storedToken = STORED_CIPHERTEXT as string | null,
}: {
  organizationType?: 'TEAM' | 'PERSONAL';
  isOrganizationKnown?: boolean;
  liveAccount?: InstagramAccountRow | null;
  settings?: InstagramAccountSettingsRow | null;
  storedToken?: string | null;
} = {}) {
  const organization = { ...TEAM, type: organizationType };
  const accountRepository = {
    findLiveByOrganizationId: vi.fn(async () => liveAccount),
    findById: vi.fn(async (): Promise<InstagramAccountRow | null> => null),
    findByPublicIdInOrganization: vi.fn(async () => liveAccount),
    resolveOrganizationPublicIdForInstagramUser: vi.fn(
      async (_instagramUserId: string): Promise<string | null> => null,
    ),
    resolveOrganizationPublicIdsForInstagramAppUser: vi.fn(
      async (_instagramAppUserId: string): Promise<string[]> => [],
    ),
    lockByInstagramAppUserInOrganization: vi.fn(async (): Promise<InstagramAccountRow[]> => []),
    lockByOrganizationId: vi.fn(async (): Promise<InstagramAccountRow[]> => []),
    upsertConnected: vi.fn(async (_values: Record<string, unknown>) => ({
      account: accountRow(),
      isNewConnection: true,
    })),
    recordWebhookSubscribed: vi.fn(async () => true),
    markConnectionBroken: vi.fn(async (): Promise<InstagramAccountRow | null> => null),
    revoke: vi.fn(
      async (): Promise<InstagramAccountRow | null> => accountRow({ connection_status: 'revoked' }),
    ),
    eraseProfile: vi.fn(
      async (): Promise<InstagramAccountRow | null> => accountRow({ username: null }),
    ),
  };
  const tokenService = {
    findAccessToken: vi.fn(async () =>
      storedToken === null
        ? null
        : { encryptedAccessToken: storedToken, expiresAt: TOKEN_EXPIRES_AT },
    ),
    storeAccessToken: vi.fn(async () => {}),
    eraseAccessToken: vi.fn(async () => true),
  };
  const settingsService = {
    findSettings: vi.fn(async () => settings),
    createDefaultSettings: vi.fn(async () => settings ?? settingsRow()),
  };
  const organizationService = {
    requireOrganizationByPublicId: vi.fn(async () => organization),
    findOrganizationByPublicId: vi.fn(async () => (isOrganizationKnown ? organization : null)),
    resolveUserInternalIdByPublicId: vi.fn(
      async (userPublicId: string | undefined): Promise<number | null> =>
        userPublicId === undefined ? null : CONNECTING_USER_ID,
    ),
    resolveUserPublicIdsByInternalIds: vi.fn(
      async (userInternalIds: readonly number[]) =>
        new Map(
          [
            [CONNECTING_USER_ID, CONNECTING_USER_PUBLIC_ID] as const,
            [SETTINGS_EDITOR_ID, SETTINGS_EDITOR_PUBLIC_ID] as const,
          ].filter(([userId]) => userInternalIds.includes(userId)),
        ),
    ),
  };
  const service = new InstagramAccountService(
    accountRepository as unknown as InstagramAccountRepository,
    tokenService as unknown as InstagramAccountTokenService,
    settingsService as unknown as InstagramAccountSettingsService,
    organizationService as unknown as OrganizationService,
  );
  return { service, accountRepository, tokenService, settingsService, organizationService };
}

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

/** A fake Instagram call that notes how many units of work were open when it was made. */
function answering<T>(answer: T): () => Promise<T> {
  return async () => {
    unitOfWork.openCountAtInstagramCalls.push(unitOfWork.openCount);
    return answer;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  unitOfWork.openCount = 0;
  unitOfWork.openCountAtInstagramCalls = [];
  instagramClient.exchangeInstagramAuthorizationCode.mockReset().mockImplementation(
    answering({
      encryptedAccessToken: SHORT_LIVED_CIPHERTEXT,
      instagramUserId: INSTAGRAM_USER_ID,
      grantedPermissions: GRANTED_PERMISSIONS,
    }),
  );
  instagramClient.exchangeInstagramLongLivedAccessToken
    .mockReset()
    .mockImplementation(
      answering({ encryptedAccessToken: LONG_LIVED_CIPHERTEXT, expiresAt: TOKEN_EXPIRES_AT }),
    );
  instagramClient.readInstagramAccountProfile.mockReset().mockImplementation(answering(profile()));
  instagramClient.subscribeInstagramWebhookFields
    .mockReset()
    .mockImplementation(answering(undefined));
  instagramClient.unsubscribeInstagramWebhookFields
    .mockReset()
    .mockImplementation(answering(undefined));
  runEnqueueAfterCommit
    .mockReset()
    .mockImplementation(async (callback: () => Promise<void>) => callback());
  enqueueReconnectNotice.mockReset().mockResolvedValue(undefined);
});

describe('InstagramAccountService.connect (route 1, IA12)', () => {
  const connectInput = {
    scope,
    code: 'AQB-test-authorization-code#_',
    connectedByUserPublicId: CONNECTING_USER_PUBLIC_ID,
    requestId: REQUEST_ID,
  };

  it('swaps the code for the long-lived token, reads the profile with it and writes the account, its settings and its token', async () => {
    const { service, accountRepository, tokenService, settingsService } = setup({
      liveAccount: null,
    });
    const subscribed = accountRow({ webhook_subscribed_at: NOW });
    accountRepository.findById.mockResolvedValueOnce(subscribed);

    const result = await service.connect(connectInput);

    expect(instagramClient.exchangeInstagramAuthorizationCode).toHaveBeenCalledWith({
      code: connectInput.code,
      requestId: REQUEST_ID,
    });
    expect(instagramClient.exchangeInstagramLongLivedAccessToken).toHaveBeenCalledWith({
      encryptedShortLivedAccessToken: SHORT_LIVED_CIPHERTEXT,
      requestId: REQUEST_ID,
    });
    expect(instagramClient.readInstagramAccountProfile).toHaveBeenCalledWith({
      encryptedAccessToken: LONG_LIVED_CIPHERTEXT,
      requestId: REQUEST_ID,
    });
    expect(accountRepository.upsertConnected).toHaveBeenCalledWith({
      organizationId: TEAM.id,
      instagramUserId: INSTAGRAM_USER_ID,
      instagramAppUserId: INSTAGRAM_APP_USER_ID,
      username: 'acme.shop',
      name: 'Acme Shop',
      biography: 'Handmade things.',
      website: 'https://example.com',
      profilePictureUrl: 'https://cdn.example.com/picture.jpg',
      followersCount: 1204,
      followsCount: 87,
      mediaCount: 54,
      scopes: GRANTED_PERMISSIONS,
      tokenExpiresAt: TOKEN_EXPIRES_AT,
      connectedByUserId: CONNECTING_USER_ID,
    });
    expect(settingsService.createDefaultSettings).toHaveBeenCalledWith({ scope, instagramAccount });
    expect(tokenService.storeAccessToken).toHaveBeenCalledWith({
      scope,
      instagramAccount,
      encryptedAccessToken: LONG_LIVED_CIPHERTEXT,
      expiresAt: TOKEN_EXPIRES_AT,
    });
    expect(result).toEqual({
      is_new_connection: true,
      instagram_account: expect.objectContaining({
        id: ACCOUNT_PUBLIC_ID,
        connection_status: 'connected',
        is_webhook_subscribed: true,
        connected_by_user_id: CONNECTING_USER_PUBLIC_ID,
        settings: expect.objectContaining({ updated_by_user_id: SETTINGS_EDITOR_PUBLIC_ID }),
      }),
    });
    expect(JSON.stringify(result)).not.toContain('ciphertext');
  });

  it('makes every Instagram call outside the units of work', async () => {
    const { service } = setup({ liveAccount: null });

    await service.connect(connectInput);

    expect(unitOfWork.openCountAtInstagramCalls).toEqual([0, 0, 0, 0]);
  });

  it('writes 0 for a count Instagram left out, and each permission once', async () => {
    instagramClient.exchangeInstagramAuthorizationCode.mockResolvedValue({
      encryptedAccessToken: SHORT_LIVED_CIPHERTEXT,
      grantedPermissions: [...GRANTED_PERMISSIONS, 'instagram_business_basic'],
    });
    instagramClient.readInstagramAccountProfile.mockResolvedValue(
      profile({ followersCount: null, followsCount: null, mediaCount: null }),
    );
    const { service, accountRepository } = setup({ liveAccount: null });

    await service.connect(connectInput);

    expect(accountRepository.upsertConnected).toHaveBeenCalledWith(
      expect.objectContaining({
        followersCount: 0,
        followsCount: 0,
        mediaCount: 0,
        scopes: GRANTED_PERMISSIONS,
      }),
    );
  });

  it('connects for no user when an API key calls it', async () => {
    const { service, accountRepository } = setup({ liveAccount: null });

    await service.connect({ ...connectInput, connectedByUserPublicId: undefined });

    expect(accountRepository.upsertConnected).toHaveBeenCalledWith(
      expect.objectContaining({ connectedByUserId: null }),
    );
  });

  it('reconnects the organization’s own account: not new, and no second subscription once subscribed', async () => {
    const subscribed = accountRow({ webhook_subscribed_at: NOW });
    const { service, accountRepository } = setup({ liveAccount: subscribed });
    accountRepository.resolveOrganizationPublicIdForInstagramUser.mockResolvedValueOnce(
      ORGANIZATION_PUBLIC_ID,
    );
    accountRepository.upsertConnected.mockResolvedValueOnce({
      account: subscribed,
      isNewConnection: false,
    });

    const result = await service.connect(connectInput);

    expect(result.is_new_connection).toBe(false);
    expect(result.instagram_account.is_webhook_subscribed).toBe(true);
    expect(instagramClient.subscribeInstagramWebhookFields).not.toHaveBeenCalled();
  });

  it('refuses a personal organization with 422 before any Instagram call (IA3)', async () => {
    const { service } = setup({ organizationType: 'PERSONAL' });

    const error = await rejection(service.connect(connectInput));

    expect(error).toBeInstanceOf(UnprocessableEntityError);
    expect((error as UnprocessableEntityError).messageKey).toBe(
      'errors:personalOrganizationNoInstagram',
    );
    expect(instagramClient.exchangeInstagramAuthorizationCode).not.toHaveBeenCalled();
  });

  it.each([
    ['refused', 'exchangeInstagramAuthorizationCode'],
    ['auth', 'exchangeInstagramAuthorizationCode'],
    ['refused', 'exchangeInstagramLongLivedAccessToken'],
    ['auth', 'readInstagramAccountProfile'],
  ] as const)(
    'answers 422 instagram_code_invalid when Instagram answers %s to %s, storing nothing',
    async (errorClass, call) => {
      const { service, accountRepository, tokenService } = setup({ liveAccount: null });
      instagramClient[call].mockRejectedValue(instagramError({ errorClass }));

      const error = await rejection(service.connect(connectInput));

      expect(error).toBeInstanceOf(UnprocessableEntityError);
      expect((error as UnprocessableEntityError).reason).toBe('instagram_code_invalid');
      expect(accountRepository.upsertConnected).not.toHaveBeenCalled();
      expect(tokenService.storeAccessToken).not.toHaveBeenCalled();
    },
  );

  it('answers 503 instagram_unavailable with Instagram’s own wait when it throttles', async () => {
    const { service, accountRepository } = setup({ liveAccount: null });
    instagramClient.exchangeInstagramAuthorizationCode.mockRejectedValue(
      instagramError({ errorClass: 'throttled', retryAfterMs: 120_000 }),
    );

    const error = await rejection(service.connect(connectInput));

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toMatchObject({ reason: 'instagram_unavailable', retryAfterSeconds: 120 });
    expect(accountRepository.upsertConnected).not.toHaveBeenCalled();
  });

  it('answers 503 instagram_unavailable with a wait of its own when Instagram fails', async () => {
    const { service } = setup({ liveAccount: null });
    instagramClient.exchangeInstagramAuthorizationCode.mockRejectedValue(
      instagramError({ errorClass: 'outage' }),
    );

    const error = await rejection(service.connect(connectInput));

    expect(error).toMatchObject({ statusCode: 503, reason: 'instagram_unavailable' });
    expect((error as ServiceUnavailableError).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('answers 503 instagram_unavailable with the circuit’s wait, rounded up to a second', async () => {
    const { service } = setup({ liveAccount: null });
    instagramClient.exchangeInstagramAuthorizationCode.mockRejectedValue(
      new CircuitBreakerOpenError('meta', 1_200, 'instagram circuit is open'),
    );

    const error = await rejection(service.connect(connectInput));

    expect(error).toMatchObject({ reason: 'instagram_unavailable', retryAfterSeconds: 2 });
  });

  describe('once the one-time code is spent (D56)', () => {
    const circuitOpen = new CircuitBreakerOpenError(
      'instagram',
      1_200,
      'instagram circuit is open',
    );

    it.each([
      [
        'an outage',
        'exchangeInstagramLongLivedAccessToken',
        instagramError({ errorClass: 'outage' }),
      ],
      [
        'a throttle',
        'exchangeInstagramLongLivedAccessToken',
        instagramError({ errorClass: 'throttled', retryAfterMs: 120_000 }),
      ],
      ['the open circuit', 'exchangeInstagramLongLivedAccessToken', circuitOpen],
      ['an outage', 'readInstagramAccountProfile', instagramError({ errorClass: 'outage' })],
      [
        'a throttle',
        'readInstagramAccountProfile',
        instagramError({ errorClass: 'throttled', retryAfterMs: 120_000 }),
      ],
      ['the open circuit', 'readInstagramAccountProfile', circuitOpen],
    ] as const)(
      'answers 409 instagram_connect_restart_required for %s in %s, with no Retry-After, storing nothing',
      async (_failure, call, failure) => {
        const { service, accountRepository, tokenService } = setup({ liveAccount: null });
        instagramClient[call].mockRejectedValue(failure);

        const error = await rejection(service.connect(connectInput));

        expect(error).toBeInstanceOf(ConflictError);
        expect(error).toMatchObject({
          statusCode: 409,
          reason: 'instagram_connect_restart_required',
          messageKey: 'errors:instagramConnectRestartRequired',
        });
        expect((error as ConflictError).retryAfterSeconds).toBeUndefined();
        expect(accountRepository.upsertConnected).not.toHaveBeenCalled();
        expect(tokenService.storeAccessToken).not.toHaveBeenCalled();
      },
    );

    it('answers it when the profile has no username', async () => {
      const { service, accountRepository } = setup({ liveAccount: null });
      instagramClient.readInstagramAccountProfile.mockResolvedValue(profile({ username: null }));

      const error = await rejection(service.connect(connectInput));

      expect(error).toMatchObject({
        statusCode: 409,
        reason: 'instagram_connect_restart_required',
      });
      expect(accountRepository.upsertConnected).not.toHaveBeenCalled();
    });

    it('passes a failure of our own through unchanged', async () => {
      const { service } = setup({ liveAccount: null });
      const ownFailure = new TypeError('a failure of ours');
      instagramClient.readInstagramAccountProfile.mockRejectedValue(ownFailure);

      await expect(service.connect(connectInput)).rejects.toBe(ownFailure);
    });
  });

  it('reads what the answer needs in the connect transaction, so a failed read connects nothing (D56)', async () => {
    const { service, organizationService } = setup({ liveAccount: null });
    const readFailure = new Error('the read failed');
    let openCountAtRead = -1;
    organizationService.resolveUserPublicIdsByInternalIds.mockImplementationOnce(async () => {
      openCountAtRead = unitOfWork.openCount;
      throw readFailure;
    });

    await expect(service.connect(connectInput)).rejects.toBe(readFailure);

    expect(openCountAtRead).toBe(1);
    expect(instagramClient.subscribeInstagramWebhookFields).not.toHaveBeenCalled();
  });

  it('reads nothing after the commit but the subscription stamp', async () => {
    const { service, organizationService } = setup({ liveAccount: null });
    const openCountsAtRead: number[] = [];
    organizationService.resolveUserPublicIdsByInternalIds.mockImplementation(async () => {
      openCountsAtRead.push(unitOfWork.openCount);
      return new Map([[CONNECTING_USER_ID, CONNECTING_USER_PUBLIC_ID]]);
    });

    const result = await service.connect(connectInput);

    expect(openCountsAtRead).toEqual([1]);
    expect(result.instagram_account.connected_by_user_id).toBe(CONNECTING_USER_PUBLIC_ID);
  });

  it('passes a failure of our own through unchanged', async () => {
    const { service } = setup({ liveAccount: null });
    const notConfigured = new ServiceUnavailableError('errors:instagramNotConfigured').withReason(
      'instagram_not_configured',
    );
    instagramClient.exchangeInstagramAuthorizationCode.mockRejectedValue(notConfigured);

    await expect(service.connect(connectInput)).rejects.toBe(notConfigured);
  });

  it.each([['PERSONAL'], [null]])(
    'answers 422 instagram_account_not_professional for an account type of %s',
    async (accountType) => {
      const { service, accountRepository } = setup({ liveAccount: null });
      instagramClient.readInstagramAccountProfile.mockResolvedValue(profile({ accountType }));

      const error = await rejection(service.connect(connectInput));

      expect(error).toBeInstanceOf(UnprocessableEntityError);
      expect((error as UnprocessableEntityError).reason).toBe('instagram_account_not_professional');
      expect(accountRepository.resolveOrganizationPublicIdForInstagramUser).not.toHaveBeenCalled();
    },
  );

  it.each(['BUSINESS', 'MEDIA_CREATOR'])('takes a %s account', async (accountType) => {
    const { service } = setup({ liveAccount: null });
    instagramClient.readInstagramAccountProfile.mockResolvedValue(profile({ accountType }));

    await expect(service.connect(connectInput)).resolves.toMatchObject({ is_new_connection: true });
  });

  it.each(GRANTED_PERMISSIONS)(
    'answers 422 instagram_scopes_missing without %s, storing nothing',
    async (missingPermission) => {
      const { service, accountRepository } = setup({ liveAccount: null });
      instagramClient.exchangeInstagramAuthorizationCode.mockResolvedValue({
        encryptedAccessToken: SHORT_LIVED_CIPHERTEXT,
        grantedPermissions: GRANTED_PERMISSIONS.filter(
          (permission) => permission !== missingPermission,
        ),
      });

      const error = await rejection(service.connect(connectInput));

      expect((error as UnprocessableEntityError).reason).toBe('instagram_scopes_missing');
      expect(accountRepository.upsertConnected).not.toHaveBeenCalled();
    },
  );

  it('names the account type before a missing permission', async () => {
    const { service } = setup({ liveAccount: null });
    instagramClient.exchangeInstagramAuthorizationCode.mockResolvedValue({
      encryptedAccessToken: SHORT_LIVED_CIPHERTEXT,
      grantedPermissions: [],
    });
    instagramClient.readInstagramAccountProfile.mockResolvedValue(
      profile({ accountType: 'PERSONAL' }),
    );

    const error = await rejection(service.connect(connectInput));

    expect((error as UnprocessableEntityError).reason).toBe('instagram_account_not_professional');
  });

  it('answers 409 instagram_account_connected_elsewhere while another organization holds it, opening no transaction', async () => {
    const { service, accountRepository } = setup({ liveAccount: null });
    accountRepository.resolveOrganizationPublicIdForInstagramUser.mockResolvedValueOnce(
      OTHER_ORGANIZATION_PUBLIC_ID,
    );

    const error = await rejection(service.connect(connectInput));

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).reason).toBe('instagram_account_connected_elsewhere');
    expect(accountRepository.resolveOrganizationPublicIdForInstagramUser).toHaveBeenCalledWith(
      INSTAGRAM_USER_ID,
    );
    expect(accountRepository.findLiveByOrganizationId).not.toHaveBeenCalled();
  });

  it('answers 409 organization_already_has_instagram_account while another account is live here (D5)', async () => {
    const { service, accountRepository } = setup({
      liveAccount: accountRow({ instagram_user_id: '17841400000000002' }),
    });

    const error = await rejection(service.connect(connectInput));

    expect((error as ConflictError).reason).toBe('organization_already_has_instagram_account');
    expect(accountRepository.upsertConnected).not.toHaveBeenCalled();
  });

  it.each([
    [
      INSTAGRAM_ACCOUNT_UNIQUE_INDEXES.organizationLive,
      'organization_already_has_instagram_account',
    ],
    [INSTAGRAM_ACCOUNT_UNIQUE_INDEXES.instagramUserLive, 'instagram_account_connected_elsewhere'],
  ])('maps a lost race on %s to 409 %s', async (constraint, reason) => {
    const { service, accountRepository, tokenService } = setup({ liveAccount: null });
    accountRepository.upsertConnected.mockRejectedValueOnce(uniqueViolation(constraint));

    const error = await rejection(service.connect(connectInput));

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).reason).toBe(reason);
    expect(tokenService.storeAccessToken).not.toHaveBeenCalled();
    expect(instagramClient.subscribeInstagramWebhookFields).not.toHaveBeenCalled();
  });

  it('passes any other database failure through, and subscribes nothing', async () => {
    const { service, accountRepository, tokenService } = setup({ liveAccount: null });
    const otherIndex = uniqueViolation('idx_instagram_accounts_public_id');
    accountRepository.upsertConnected.mockRejectedValueOnce(otherIndex);
    await expect(service.connect(connectInput)).rejects.toBe(otherIndex);

    const tokenFailure = new Error('token write failed');
    tokenService.storeAccessToken.mockRejectedValueOnce(tokenFailure);
    await expect(service.connect(connectInput)).rejects.toBe(tokenFailure);

    expect(instagramClient.subscribeInstagramWebhookFields).not.toHaveBeenCalled();
  });

  it('subscribes the account after the commit and stamps it', async () => {
    const { service, accountRepository } = setup({ liveAccount: null });
    accountRepository.findById.mockResolvedValueOnce(accountRow({ webhook_subscribed_at: NOW }));

    await service.connect(connectInput);

    expect(instagramClient.subscribeInstagramWebhookFields).toHaveBeenCalledWith({
      encryptedAccessToken: LONG_LIVED_CIPHERTEXT,
      instagramAppUserId: INSTAGRAM_APP_USER_ID,
      requestId: REQUEST_ID,
    });
    expect(accountRepository.recordWebhookSubscribed).toHaveBeenCalledWith(instagramAccount);
  });

  it('answers the account not subscribed when it was disconnected before the stamp', async () => {
    const { service, accountRepository } = setup({ liveAccount: null });
    accountRepository.recordWebhookSubscribed.mockResolvedValueOnce(false);

    const result = await service.connect(connectInput);

    expect(result.instagram_account.is_webhook_subscribed).toBe(false);
    expect(accountRepository.findById).not.toHaveBeenCalled();
  });

  it('connects all the same when the subscription fails, logging the codes and never Instagram’s text', async () => {
    const { service, accountRepository } = setup({ liveAccount: null });
    instagramClient.subscribeInstagramWebhookFields.mockRejectedValue(
      instagramError({ errorClass: 'refused' }),
    );

    const result = await service.connect(connectInput);

    expect(result.instagram_account.is_webhook_subscribed).toBe(false);
    expect(accountRepository.recordWebhookSubscribed).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        requestId: REQUEST_ID,
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        errorClass: 'refused',
        instagramErrorCode: 100,
        instagramErrorSubcode: 33,
        fbtraceId: 'trace-acme',
      },
      'app.instagram_account.webhook_subscription_failed',
    );
  });

  it('logs only the name of a failure that is not Instagram’s', async () => {
    const { service } = setup({ liveAccount: null });
    instagramClient.subscribeInstagramWebhookFields.mockRejectedValue(
      new TypeError('a detail that stays out of the log'),
    );

    await service.connect(connectInput);

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ errorName: 'TypeError' }),
      'app.instagram_account.webhook_subscription_failed',
    );
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain('stays out of the log');
  });
});

describe('InstagramAccountService.getAccount (route 2, IA13)', () => {
  it.each(['connected', 'expired', 'error'])(
    'answers the %s account with its settings and both users',
    async (connectionStatus) => {
      const { service, settingsService, organizationService } = setup({
        liveAccount: accountRow({ connection_status: connectionStatus }),
      });

      const account = await service.getAccount({ scope });

      expect(account).toMatchObject({
        id: ACCOUNT_PUBLIC_ID,
        connection_status: connectionStatus,
        access_expires_at: TOKEN_EXPIRES_AT.toISOString(),
        connected_by_user_id: CONNECTING_USER_PUBLIC_ID,
        settings: { is_automation_enabled: true, updated_by_user_id: SETTINGS_EDITOR_PUBLIC_ID },
      });
      expect(settingsService.findSettings).toHaveBeenCalledWith({ scope, instagramAccount });
      expect(organizationService.resolveUserPublicIdsByInternalIds).toHaveBeenCalledTimes(1);
    },
  );

  it('answers no user for one the account never had, or one deleted since', async () => {
    const never = setup({
      liveAccount: accountRow({ connected_by_user_id: null }),
      settings: settingsRow({ updated_by_user_id: null }),
    });
    const withoutUsers = await never.service.getAccount({ scope });
    expect(withoutUsers.connected_by_user_id).toBeNull();
    expect(withoutUsers.settings.updated_by_user_id).toBeNull();
    expect(never.organizationService.resolveUserPublicIdsByInternalIds).toHaveBeenCalledWith([]);

    const deleted = setup();
    deleted.organizationService.resolveUserPublicIdsByInternalIds.mockResolvedValueOnce(new Map());
    const withDeletedUsers = await deleted.service.getAccount({ scope });
    expect(withDeletedUsers.connected_by_user_id).toBeNull();
    expect(withDeletedUsers.settings.updated_by_user_id).toBeNull();
  });

  it('never reads the token and never calls Instagram', async () => {
    const { service, tokenService } = setup();

    await service.getAccount({ scope });

    expect(tokenService.findAccessToken).not.toHaveBeenCalled();
    expect(unitOfWork.openCountAtInstagramCalls).toEqual([]);
  });

  it('answers 404 instagram_not_connected without a live account', async () => {
    const { service, settingsService } = setup({ liveAccount: null });

    const error = await rejection(service.getAccount({ scope }));

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).reason).toBe('instagram_not_connected');
    expect(settingsService.findSettings).not.toHaveBeenCalled();
  });

  it('answers 404 team_organization_required on a personal organization — a read is never a 422 (IA3)', async () => {
    const { service, accountRepository } = setup({ organizationType: 'PERSONAL' });

    const error = await rejection(service.getAccount({ scope }));

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).reason).toBe('team_organization_required');
    expect(accountRepository.findLiveByOrganizationId).not.toHaveBeenCalled();
  });

  it('fails when the account has no settings row', async () => {
    const { service } = setup({ settings: null });

    await expect(service.getAccount({ scope })).rejects.toThrow('no settings row');
  });
});

describe('InstagramAccountService lookups', () => {
  it('findLiveAccount answers the live account, or null — no team check, no 404 (AU27)', async () => {
    const live = setup();
    await expect(
      live.service.findLiveAccount({ scope, organizationId: TEAM.id }),
    ).resolves.toMatchObject({ public_id: ACCOUNT_PUBLIC_ID });
    expect(live.accountRepository.findLiveByOrganizationId).toHaveBeenCalledWith(TEAM.id);
    expect(live.organizationService.requireOrganizationByPublicId).not.toHaveBeenCalled();

    const none = setup({ liveAccount: null });
    await expect(
      none.service.findLiveAccount({ scope, organizationId: TEAM.id }),
    ).resolves.toBeNull();
  });

  describe('findLiveAccountAccess (routes 5–6, IA16)', () => {
    it('answers the account, its key and its ciphertext', async () => {
      const { service, tokenService } = setup();

      await expect(service.findLiveAccountAccess({ scope })).resolves.toEqual({
        account: accountRow(),
        instagramAccount,
        encryptedAccessToken: STORED_CIPHERTEXT,
      });
      expect(tokenService.findAccessToken).toHaveBeenCalledWith({ scope, instagramAccount });
    });

    it('answers no token, and a broken account as it is — the caller decides', async () => {
      const { service } = setup({
        liveAccount: accountRow({ connection_status: 'expired' }),
        storedToken: null,
      });

      await expect(service.findLiveAccountAccess({ scope })).resolves.toMatchObject({
        account: { connection_status: 'expired' },
        encryptedAccessToken: null,
      });
    });

    it('answers 404 instagram_not_connected, and 404 team_organization_required on a personal organization', async () => {
      const none = setup({ liveAccount: null });
      const notConnected = await rejection(none.service.findLiveAccountAccess({ scope }));
      expect((notConnected as NotFoundError).reason).toBe('instagram_not_connected');
      expect(none.tokenService.findAccessToken).not.toHaveBeenCalled();

      const personal = setup({ organizationType: 'PERSONAL' });
      const teamOnly = await rejection(personal.service.findLiveAccountAccess({ scope }));
      expect((teamOnly as NotFoundError).reason).toBe('team_organization_required');
    });
  });

  it('resolves a webhook user id outside any unit of work (WH3)', async () => {
    const { service, accountRepository } = setup();
    accountRepository.resolveOrganizationPublicIdForInstagramUser.mockImplementationOnce(
      async () => {
        expect(unitOfWork.openCount).toBe(0);
        return OTHER_ORGANIZATION_PUBLIC_ID;
      },
    );

    await expect(
      service.resolveOrganizationPublicIdForInstagramUser(INSTAGRAM_USER_ID),
    ).resolves.toBe(OTHER_ORGANIZATION_PUBLIC_ID);
    await expect(
      service.resolveOrganizationPublicIdForInstagramUser('17841400000000009'),
    ).resolves.toBeNull();
  });

  describe('findWebhookAccountState (WH3, WH10)', () => {
    it('answers the account’s ids, status and switch — never the token', async () => {
      const { service, tokenService } = setup({
        liveAccount: accountRow({ connection_status: 'error' }),
        settings: settingsRow({ is_automation_enabled: false }),
      });

      await expect(
        service.findWebhookAccountState({ scope, instagramUserId: INSTAGRAM_USER_ID }),
      ).resolves.toEqual({
        instagramAccount,
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        instagramUserId: INSTAGRAM_USER_ID,
        instagramAppUserId: INSTAGRAM_APP_USER_ID,
        connectionStatus: 'error',
        isAutomationEnabled: false,
      });
      expect(tokenService.findAccessToken).not.toHaveBeenCalled();
    });

    it('reads the switch as on without a settings row', async () => {
      const { service } = setup({ settings: null });

      await expect(
        service.findWebhookAccountState({ scope, instagramUserId: INSTAGRAM_USER_ID }),
      ).resolves.toMatchObject({ isAutomationEnabled: true });
    });

    it.each([
      ['the organization is gone', { isOrganizationKnown: false }],
      ['no account is live', { liveAccount: null }],
      [
        'another account is connected now',
        { liveAccount: accountRow({ instagram_user_id: '17841400000000002' }) },
      ],
    ])('answers null when %s', async (_case, options) => {
      const { service, settingsService } = setup(options);

      await expect(
        service.findWebhookAccountState({ scope, instagramUserId: INSTAGRAM_USER_ID }),
      ).resolves.toBeNull();
      expect(settingsService.findSettings).not.toHaveBeenCalled();
    });
  });

  describe('findAutomationAccountAccess (AU5, AU27)', () => {
    it('answers what a run sends with: the ids, the username, the ciphertext and the settings', async () => {
      const { service } = setup();

      await expect(
        service.findAutomationAccountAccess({ scope, instagramAccountPublicId: ACCOUNT_PUBLIC_ID }),
      ).resolves.toEqual({
        instagramAccount,
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        instagramAppUserId: INSTAGRAM_APP_USER_ID,
        username: 'acme.shop',
        connectionStatus: 'connected',
        encryptedAccessToken: STORED_CIPHERTEXT,
        settings: settingsRow(),
      });
    });

    it('answers a broken account with its status, and no token or settings when it has none', async () => {
      const { service } = setup({
        liveAccount: accountRow({ connection_status: 'expired' }),
        storedToken: null,
        settings: null,
      });

      await expect(
        service.findAutomationAccountAccess({ scope, instagramAccountPublicId: ACCOUNT_PUBLIC_ID }),
      ).resolves.toMatchObject({
        connectionStatus: 'expired',
        encryptedAccessToken: null,
        settings: null,
      });
    });

    it.each([
      ['the organization is gone', { isOrganizationKnown: false }],
      ['no account is live', { liveAccount: null }],
      [
        'another account is connected now',
        { liveAccount: accountRow({ public_id: 'iga_z9y8x7w6v5u4t3s2r1q0p' }) },
      ],
    ])('answers null when %s, reading no token', async (_case, options) => {
      const { service, tokenService } = setup(options);

      await expect(
        service.findAutomationAccountAccess({ scope, instagramAccountPublicId: ACCOUNT_PUBLIC_ID }),
      ).resolves.toBeNull();
      expect(tokenService.findAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('findWebhookProcessingAccount (WH12, WH13)', () => {
    it.each(['expired', 'error', 'revoked'])(
      'never reads the token of an account that is %s',
      async (connectionStatus) => {
        const { service, tokenService } = setup({
          liveAccount: accountRow({ connection_status: connectionStatus }),
        });

        await expect(
          service.findWebhookProcessingAccount({
            scope,
            instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
          }),
        ).resolves.toMatchObject({ connectionStatus, encryptedAccessToken: null });
        expect(tokenService.findAccessToken).not.toHaveBeenCalled();
      },
    );

    it('answers null when the organization is gone, before it looks for the account', async () => {
      const { service, accountRepository } = setup({ isOrganizationKnown: false });

      await expect(
        service.findWebhookProcessingAccount({
          scope,
          instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        }),
      ).resolves.toBeNull();
      expect(accountRepository.findByPublicIdInOrganization).not.toHaveBeenCalled();
    });
  });
});

describe('InstagramAccountService.disconnect (route 4, IA14)', () => {
  const disconnectInput = { scope, requestId: 'request-disconnect' };

  it('unsubscribes outside the units of work, then revokes the account and erases its token', async () => {
    const { service, accountRepository, tokenService } = setup();

    await expect(service.disconnect(disconnectInput)).resolves.toEqual({
      instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
    });

    expect(instagramClient.unsubscribeInstagramWebhookFields).toHaveBeenCalledWith({
      encryptedAccessToken: STORED_CIPHERTEXT,
      instagramAppUserId: INSTAGRAM_APP_USER_ID,
      requestId: 'request-disconnect',
    });
    expect(unitOfWork.openCountAtInstagramCalls).toEqual([0]);
    expect(accountRepository.revoke).toHaveBeenCalledWith(instagramAccount);
    expect(tokenService.eraseAccessToken).toHaveBeenCalledWith({ scope, instagramAccount });
    expect(accountRepository.eraseProfile).not.toHaveBeenCalled();
  });

  it('calls no Instagram for an account without a token', async () => {
    const { service, accountRepository } = setup({ storedToken: null });

    await service.disconnect(disconnectInput);

    expect(instagramClient.unsubscribeInstagramWebhookFields).not.toHaveBeenCalled();
    expect(accountRepository.revoke).toHaveBeenCalledTimes(1);
  });

  it('disconnects all the same when the unsubscribe fails, and logs it', async () => {
    const { service, accountRepository, tokenService } = setup();
    instagramClient.unsubscribeInstagramWebhookFields.mockRejectedValue(
      instagramError({ errorClass: 'outage' }),
    );

    await expect(service.disconnect(disconnectInput)).resolves.toEqual({
      instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
    });

    expect(accountRepository.revoke).toHaveBeenCalledTimes(1);
    expect(tokenService.eraseAccessToken).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-disconnect',
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        errorClass: 'outage',
      }),
      'app.instagram_account.webhook_unsubscription_failed',
    );
  });

  it('answers 404 instagram_not_connected without a live account, calling no Instagram', async () => {
    const { service } = setup({ liveAccount: null });

    const error = await rejection(service.disconnect(disconnectInput));

    expect((error as NotFoundError).reason).toBe('instagram_not_connected');
    expect(instagramClient.unsubscribeInstagramWebhookFields).not.toHaveBeenCalled();
  });

  it('answers 404 instagram_not_connected when another disconnect won, erasing nothing', async () => {
    const { service, accountRepository, tokenService } = setup();
    accountRepository.revoke.mockResolvedValueOnce(null);

    const error = await rejection(service.disconnect(disconnectInput));

    expect((error as NotFoundError).reason).toBe('instagram_not_connected');
    expect(tokenService.eraseAccessToken).not.toHaveBeenCalled();
  });

  it('refuses a personal organization with 422 (IA3)', async () => {
    const { service, accountRepository } = setup({ organizationType: 'PERSONAL' });

    expect(await rejection(service.disconnect(disconnectInput))).toBeInstanceOf(
      UnprocessableEntityError,
    );
    expect(accountRepository.findLiveByOrganizationId).not.toHaveBeenCalled();
  });
});

describe('InstagramAccountService and Meta’s callbacks (IA19, IA20)', () => {
  it('lists the organizations of an app-scoped id outside any unit of work (IA6)', async () => {
    const { service, accountRepository } = setup();
    accountRepository.resolveOrganizationPublicIdsForInstagramAppUser.mockImplementationOnce(
      async () => {
        expect(unitOfWork.openCount).toBe(0);
        return [ORGANIZATION_PUBLIC_ID, OTHER_ORGANIZATION_PUBLIC_ID];
      },
    );

    await expect(
      service.resolveOrganizationPublicIdsForInstagramAppUser(INSTAGRAM_APP_USER_ID),
    ).resolves.toEqual([ORGANIZATION_PUBLIC_ID, OTHER_ORGANIZATION_PUBLIC_ID]);
    expect(accountRepository.resolveOrganizationPublicIdsForInstagramAppUser).toHaveBeenCalledWith(
      INSTAGRAM_APP_USER_ID,
    );
  });

  const revokedKey = { organizationId: TEAM.id, instagramAccountId: 4 };
  const accountsOfThePerson = () => [
    accountRow(),
    accountRow({
      id: revokedKey.instagramAccountId,
      public_id: 'iga_z9y8x7w6v5u4t3s2r1q0p',
      connection_status: 'revoked',
    }),
  ];

  it('a deauthorize revokes each account and erases its token, keeping the profile and calling no Instagram', async () => {
    const { service, accountRepository, tokenService } = setup();
    accountRepository.lockByInstagramAppUserInOrganization.mockResolvedValueOnce(
      accountsOfThePerson(),
    );
    // The second account was already revoked and holds no token.
    accountRepository.revoke
      .mockResolvedValueOnce(accountRow({ connection_status: 'revoked' }))
      .mockResolvedValueOnce(null);
    tokenService.eraseAccessToken.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const changes = await service.disconnectForMeta({
      scope,
      instagramAppUserId: INSTAGRAM_APP_USER_ID,
      issuedAt: NOW_SECONDS,
      shouldEraseProfile: false,
    });

    expect(accountRepository.lockByInstagramAppUserInOrganization).toHaveBeenCalledWith({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      instagramAppUserId: INSTAGRAM_APP_USER_ID,
    });
    expect(changes).toEqual([
      {
        instagramAccount,
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        wasRevoked: true,
        wasTokenErased: true,
        wasProfileErased: false,
      },
      {
        instagramAccount: revokedKey,
        instagramAccountPublicId: 'iga_z9y8x7w6v5u4t3s2r1q0p',
        wasRevoked: false,
        wasTokenErased: false,
        wasProfileErased: false,
      },
    ]);
    expect(accountRepository.eraseProfile).not.toHaveBeenCalled();
    expect(unitOfWork.openCountAtInstagramCalls).toEqual([]);
  });

  it('a data deletion also erases each profile — a revoked account’s too, and only once', async () => {
    const { service, accountRepository } = setup();
    accountRepository.lockByInstagramAppUserInOrganization.mockResolvedValueOnce(
      accountsOfThePerson(),
    );
    // The second profile was erased by an earlier request.
    accountRepository.eraseProfile
      .mockResolvedValueOnce(accountRow({ username: null }))
      .mockResolvedValueOnce(null);

    const changes = await service.disconnectForMeta({
      scope,
      instagramAppUserId: INSTAGRAM_APP_USER_ID,
      issuedAt: NOW_SECONDS,
      shouldEraseProfile: true,
    });

    expect(accountRepository.eraseProfile.mock.calls).toEqual([[instagramAccount], [revokedKey]]);
    expect(changes.map((change) => change.wasProfileErased)).toEqual([true, false]);
    // The profile is erased once the account is revoked — only a revoked one may lose its username.
    expect(accountRepository.revoke.mock.invocationCallOrder[0]).toBeLessThan(
      accountRepository.eraseProfile.mock.invocationCallOrder[0] as number,
    );
  });

  it('answers an empty list for an organization without such an account', async () => {
    const { service, accountRepository, tokenService } = setup();

    await expect(
      service.disconnectForMeta({
        scope,
        instagramAppUserId: INSTAGRAM_APP_USER_ID,
        issuedAt: NOW_SECONDS,
        shouldEraseProfile: true,
      }),
    ).resolves.toEqual([]);
    expect(accountRepository.revoke).not.toHaveBeenCalled();
    expect(tokenService.eraseAccessToken).not.toHaveBeenCalled();
  });

  it('leaves an account connected after Meta signed the request alone, and changes an older one (D53)', async () => {
    const { service, accountRepository, tokenService } = setup();
    const [reconnected, older] = accountsOfThePerson() as [
      InstagramAccountRow,
      InstagramAccountRow,
    ];
    accountRepository.lockByInstagramAppUserInOrganization.mockResolvedValueOnce([
      { ...reconnected, connected_at: new Date(NOW.getTime() + 1000) },
      older,
    ]);

    const changes = await service.disconnectForMeta({
      scope,
      instagramAppUserId: INSTAGRAM_APP_USER_ID,
      issuedAt: NOW_SECONDS,
      shouldEraseProfile: true,
    });

    // The reconnected account is left out, so its stored posts stay too.
    expect(changes.map((change) => change.instagramAccount)).toEqual([revokedKey]);
    expect(accountRepository.revoke.mock.calls).toEqual([[revokedKey]]);
    expect(tokenService.eraseAccessToken.mock.calls).toEqual([
      [{ scope, instagramAccount: revokedKey }],
    ]);
    expect(accountRepository.eraseProfile.mock.calls).toEqual([[revokedKey]]);
  });

  it('changes an account connected in the second Meta signed the request in', async () => {
    const { service, accountRepository } = setup();
    // Meta signs whole seconds: 09:00:00.900 is not after 09:00:00.
    accountRepository.lockByInstagramAppUserInOrganization.mockResolvedValueOnce([
      accountRow({ connected_at: new Date(NOW.getTime() + 900) }),
    ]);

    const changes = await service.disconnectForMeta({
      scope,
      instagramAppUserId: INSTAGRAM_APP_USER_ID,
      issuedAt: NOW_SECONDS,
      shouldEraseProfile: false,
    });

    expect(changes.map((change) => change.wasRevoked)).toEqual([true]);
  });

  it('changes every account for a request without issued_at', async () => {
    const { service, accountRepository } = setup();
    accountRepository.lockByInstagramAppUserInOrganization.mockResolvedValueOnce([
      accountRow({ connected_at: new Date(NOW.getTime() + 60_000) }),
    ]);

    const changes = await service.disconnectForMeta({
      scope,
      instagramAppUserId: INSTAGRAM_APP_USER_ID,
      issuedAt: null,
      shouldEraseProfile: false,
    });

    expect(changes.map((change) => change.wasRevoked)).toEqual([true]);
  });
});

describe('InstagramAccountService and an organization delete (D54)', () => {
  it('unsubscribes the live account outside the unit of work that read it', async () => {
    const { service, accountRepository } = setup();

    await service.unsubscribeForOrganizationOffboarding({ scope });

    expect(instagramClient.unsubscribeInstagramWebhookFields).toHaveBeenCalledWith({
      encryptedAccessToken: STORED_CIPHERTEXT,
      instagramAppUserId: INSTAGRAM_APP_USER_ID,
      requestId: undefined,
    });
    expect(unitOfWork.openCountAtInstagramCalls).toEqual([0]);
    expect(accountRepository.revoke).not.toHaveBeenCalled();
  });

  it('never blocks the delete: a failed unsubscribe is logged', async () => {
    const { service } = setup();
    instagramClient.unsubscribeInstagramWebhookFields.mockRejectedValue(
      instagramError({ errorClass: 'outage' }),
    );

    await expect(service.unsubscribeForOrganizationOffboarding({ scope })).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        errorClass: 'outage',
      }),
      'app.instagram_account.webhook_unsubscription_failed',
    );
  });

  it.each([
    ['the organization is gone', { isOrganizationKnown: false }],
    ['it has no live account', { liveAccount: null }],
    ['the account has no token', { storedToken: null }],
  ])('calls no Instagram when %s', async (_reason, options) => {
    const { service } = setup(options);

    await service.unsubscribeForOrganizationOffboarding({ scope });

    expect(instagramClient.unsubscribeInstagramWebhookFields).not.toHaveBeenCalled();
  });

  it('revokes every account of the organization and erases its token and profile, calling no Instagram', async () => {
    const { service, accountRepository, tokenService } = setup();
    const formerKey = { organizationId: TEAM.id, instagramAccountId: 4 };
    accountRepository.lockByOrganizationId.mockResolvedValueOnce([
      accountRow(),
      accountRow({
        id: formerKey.instagramAccountId,
        public_id: 'iga_z9y8x7w6v5u4t3s2r1q0p',
        connection_status: 'revoked',
      }),
    ]);
    accountRepository.revoke
      .mockResolvedValueOnce(accountRow({ connection_status: 'revoked' }))
      .mockResolvedValueOnce(null);
    tokenService.eraseAccessToken.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const changes = await service.disconnectForOrganizationOffboarding({ scope });

    expect(accountRepository.lockByOrganizationId).toHaveBeenCalledWith(TEAM.id);
    expect(changes).toEqual([
      {
        instagramAccount,
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        wasRevoked: true,
        wasTokenErased: true,
        wasProfileErased: true,
      },
      {
        instagramAccount: formerKey,
        instagramAccountPublicId: 'iga_z9y8x7w6v5u4t3s2r1q0p',
        wasRevoked: false,
        wasTokenErased: false,
        wasProfileErased: true,
      },
    ]);
    expect(accountRepository.eraseProfile.mock.calls).toEqual([[instagramAccount], [formerKey]]);
    expect(unitOfWork.openCountAtInstagramCalls).toEqual([]);
  });

  it('changes nothing when the organization is gone', async () => {
    const { service, accountRepository } = setup({ isOrganizationKnown: false });

    await expect(service.disconnectForOrganizationOffboarding({ scope })).resolves.toEqual([]);
    expect(accountRepository.lockByOrganizationId).not.toHaveBeenCalled();
  });
});

describe('InstagramAccountService.markConnectionBroken (IA9)', () => {
  it.each(['expired', 'error'] as const)(
    'moves the account to %s and enqueues the break’s notice after the commit',
    async (connectionStatus) => {
      const { service, accountRepository } = setup();
      const brokenAt = new Date('2026-11-21T09:30:00.000Z');
      const broken = accountRow({
        connection_status: connectionStatus,
        connection_status_changed_at: brokenAt,
      });
      accountRepository.markConnectionBroken.mockResolvedValueOnce(broken);

      await expect(
        service.markConnectionBroken({
          scope,
          instagramAccount,
          connectionStatus,
          requestId: 'job-request',
        }),
      ).resolves.toBe(broken);

      expect(accountRepository.markConnectionBroken).toHaveBeenCalledWith({
        ...instagramAccount,
        connectionStatus,
      });
      expect(enqueueReconnectNotice).toHaveBeenCalledWith({
        connectionBreak: {
          organizationPublicId: ORGANIZATION_PUBLIC_ID,
          instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
          connectionStatus,
          connectionStatusChangedAt: brokenAt,
        },
        requestId: 'job-request',
      });
    },
  );

  it('hands the notice to the commit, never enqueues it by itself', async () => {
    const { service, accountRepository } = setup();
    accountRepository.markConnectionBroken.mockResolvedValueOnce(accountRow());
    // The unit never commits: what was deferred does not run.
    runEnqueueAfterCommit.mockImplementationOnce(async () => {});

    await service.markConnectionBroken({ scope, instagramAccount, connectionStatus: 'error' });

    expect(runEnqueueAfterCommit).toHaveBeenCalledTimes(1);
    expect(enqueueReconnectNotice).not.toHaveBeenCalled();
  });

  it('answers null and enqueues nothing when the account had already left connected', async () => {
    const { service } = setup();

    await expect(
      service.markConnectionBroken({ scope, instagramAccount, connectionStatus: 'expired' }),
    ).resolves.toBeNull();
    expect(runEnqueueAfterCommit).not.toHaveBeenCalled();
  });
});
