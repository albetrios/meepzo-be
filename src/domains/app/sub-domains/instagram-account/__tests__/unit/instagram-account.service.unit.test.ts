import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstagramAccountExtensionService } from '@/domains/app/sub-domains/instagram-account/instagram-account-extension.service.js';
import type { ChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { NotFoundError } from '@/shared/errors/index.js';
import type {
  InstagramAccountRepository,
  InstagramAccountRow,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { ChannelConnectionTokenService } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.service.js';
import type { InstagramAccountSettingsRow } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import type { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';

const { unitOfWork, instagramClient, enqueueReconnectNotice, runEnqueueAfterCommit, loggerWarn } =
  vi.hoisted(() => ({
    /** How many units of work are open, and whether one was open at any Instagram call. */
    unitOfWork: { openCount: 0, openCountAtInstagramCalls: [] as number[] },
    instagramClient: {
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
const STORED_CIPHERTEXT = 'v1:stored-ciphertext';
const NOW = new Date('2026-11-21T09:00:00.000Z');
/** {@link NOW} as Meta signs a time: Unix seconds. */
const NOW_SECONDS = NOW.getTime() / 1000;
const scope: OrganizationPrincipalDatabaseScope = PRINCIPAL_SCOPE.VERIFIED({
  organizationPublicId: ORGANIZATION_PUBLIC_ID,
});
const TEAM = { id: 7, public_id: ORGANIZATION_PUBLIC_ID, type: 'TEAM' };
const ACCOUNT_PUBLIC_ID = 'cha_k7x9m2pqr4w8n1v3a1b2c';
const instagramAccount = { organizationId: TEAM.id, instagramAccountId: 3 };
const CHANNEL_CONNECTION_ID = 12;
const channelConnection = { organizationId: TEAM.id, channelConnectionId: CHANNEL_CONNECTION_ID };

function accountRow(overrides: Partial<InstagramAccountRow> = {}): InstagramAccountRow {
  return {
    id: instagramAccount.instagramAccountId,
    public_id: ACCOUNT_PUBLIC_ID,
    organization_id: TEAM.id,
    channel_connection_id: CHANNEL_CONNECTION_ID,
    channel_account_id: 5,
    instagram_user_id: INSTAGRAM_USER_ID,
    username: 'acme.shop',
    biography: 'Handmade things.',
    website: 'https://example.com',
    profile_picture_url: 'https://cdn.example.com/picture.jpg',
    followers_count: 1204,
    follows_count: 87,
    media_count: 54,
    account_type: 'business',
    is_private: false,
    connection_status: 'connected',
    webhook_subscribed_at: null,
    starter_questions_set_at: null,
    connected_at: NOW,
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
    listLiveByOrganizationId: vi.fn(async () => (liveAccount === null ? [] : [liveAccount])),
    lockByInstagramUserInOrganization: vi.fn(async (): Promise<InstagramAccountRow[]> => []),
    lockByOrganizationId: vi.fn(async (): Promise<InstagramAccountRow[]> => []),
  };
  // The channel account's status moves (R6: the extension holds none).
  const channelAccountRepository = {
    markBroken: vi.fn(async (): Promise<{ public_id: string; updated_at: Date } | null> => null),
    revoke: vi.fn(async (): Promise<{ id: number } | null> => ({ id: 5 })),
    // No other not-revoked account uses the connection: a disconnect takes its token (CA8).
    countLiveByConnection: vi.fn(async () => 0),
  };
  const extensionService = {
    clearOnRevoke: vi.fn(async () => true),
    eraseProfile: vi.fn(
      async (): Promise<InstagramAccountRow | null> => accountRow({ username: null }),
    ),
    recordWebhookSubscribed: vi.fn(
      async (): Promise<InstagramAccountRow | null> => accountRow({ webhook_subscribed_at: NOW }),
    ),
  };
  const tokenService = {
    findAccessToken: vi.fn(async () =>
      storedToken === null ? null : { encryptedAccessToken: storedToken, expiresAt: null },
    ),
    revokeConnection: vi.fn(async () => true),
    revokeOrganizationConnections: vi.fn(async () => 0),
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
    extensionService as unknown as InstagramAccountExtensionService,
    channelAccountRepository as unknown as ChannelAccountRepository,
    tokenService as unknown as ChannelConnectionTokenService,
    settingsService as unknown as InstagramAccountSettingsService,
    organizationService as unknown as OrganizationService,
  );
  return {
    service,
    accountRepository,
    channelAccountRepository,
    extensionService,
    tokenService,
    settingsService,
    organizationService,
  };
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
      expect(tokenService.findAccessToken).toHaveBeenCalledWith({ scope, channelConnection });
    });

    it('answers no token, and a broken account as it is — the caller decides', async () => {
      const { service } = setup({
        liveAccount: accountRow({ connection_status: 'error' }),
        storedToken: null,
      });

      await expect(service.findLiveAccountAccess({ scope })).resolves.toMatchObject({
        account: { connection_status: 'error' },
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
        channelAccountId: 5,
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        instagramUserId: INSTAGRAM_USER_ID,
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
        instagramUserId: INSTAGRAM_USER_ID,
        username: 'acme.shop',
        connectionStatus: 'connected',
        encryptedAccessToken: STORED_CIPHERTEXT,
        settings: settingsRow(),
      });
    });

    it('answers a broken account with its status, and no token or settings when it has none', async () => {
      const { service } = setup({
        liveAccount: accountRow({ connection_status: 'error' }),
        storedToken: null,
        settings: null,
      });

      await expect(
        service.findAutomationAccountAccess({ scope, instagramAccountPublicId: ACCOUNT_PUBLIC_ID }),
      ).resolves.toMatchObject({
        connectionStatus: 'error',
        encryptedAccessToken: null,
        settings: null,
      });
    });

    it.each([
      ['the organization is gone', { isOrganizationKnown: false }],
      ['no account is live', { liveAccount: null }],
      [
        'another account is connected now',
        { liveAccount: accountRow({ public_id: 'cha_z9y8x7w6v5u4t3s2r1q0p' }) },
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
    it.each(['error', 'revoked'])(
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
      public_id: 'cha_z9y8x7w6v5u4t3s2r1q0p',
      connection_status: 'revoked',
    }),
  ];

  it('a deauthorize revokes each account and erases its token, keeping the profile and calling no Instagram', async () => {
    const { service, accountRepository, channelAccountRepository, extensionService, tokenService } =
      setup();
    accountRepository.lockByInstagramUserInOrganization.mockResolvedValueOnce(
      accountsOfThePerson(),
    );
    // The second account was already revoked and holds no token.
    channelAccountRepository.revoke.mockResolvedValueOnce({ id: 5 }).mockResolvedValueOnce(null);
    tokenService.revokeConnection.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const changes = await service.disconnectForMeta({
      scope,
      instagramAppUserId: INSTAGRAM_APP_USER_ID,
      issuedAt: NOW_SECONDS,
      shouldEraseProfile: false,
    });

    expect(accountRepository.lockByInstagramUserInOrganization).toHaveBeenCalledWith({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      instagramUserId: INSTAGRAM_APP_USER_ID,
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
        instagramAccountPublicId: 'cha_z9y8x7w6v5u4t3s2r1q0p',
        wasRevoked: false,
        wasTokenErased: false,
        wasProfileErased: false,
      },
    ]);
    expect(extensionService.eraseProfile).not.toHaveBeenCalled();
    // Only the account revoked now loses its webhook stamp.
    expect(extensionService.clearOnRevoke.mock.calls).toEqual([[{ scope, instagramAccount }]]);
    expect(unitOfWork.openCountAtInstagramCalls).toEqual([]);
  });

  it('a data deletion also erases each profile — a revoked account’s too, and only once', async () => {
    const { service, accountRepository, channelAccountRepository, extensionService } = setup();
    accountRepository.lockByInstagramUserInOrganization.mockResolvedValueOnce(
      accountsOfThePerson(),
    );
    // The second profile was erased by an earlier request.
    extensionService.eraseProfile
      .mockResolvedValueOnce(accountRow({ username: null }))
      .mockResolvedValueOnce(null);

    const changes = await service.disconnectForMeta({
      scope,
      instagramAppUserId: INSTAGRAM_APP_USER_ID,
      issuedAt: NOW_SECONDS,
      shouldEraseProfile: true,
    });

    expect(extensionService.eraseProfile.mock.calls).toEqual([
      [{ scope, instagramAccount }],
      [{ scope, instagramAccount: revokedKey }],
    ]);
    expect(changes.map((change) => change.wasProfileErased)).toEqual([true, false]);
    // The profile is erased once the account is revoked — only a revoked one may lose its username.
    expect(channelAccountRepository.revoke.mock.invocationCallOrder[0]).toBeLessThan(
      extensionService.eraseProfile.mock.invocationCallOrder[0] as number,
    );
  });

  it('answers an empty list for an organization without such an account', async () => {
    const { service, channelAccountRepository, tokenService } = setup();

    await expect(
      service.disconnectForMeta({
        scope,
        instagramAppUserId: INSTAGRAM_APP_USER_ID,
        issuedAt: NOW_SECONDS,
        shouldEraseProfile: true,
      }),
    ).resolves.toEqual([]);
    expect(channelAccountRepository.revoke).not.toHaveBeenCalled();
    expect(tokenService.revokeConnection).not.toHaveBeenCalled();
  });

  it('leaves an account connected after Meta signed the request alone, and changes an older one (D53)', async () => {
    const { service, accountRepository, channelAccountRepository, extensionService, tokenService } =
      setup();
    const [reconnected, older] = accountsOfThePerson() as [
      InstagramAccountRow,
      InstagramAccountRow,
    ];
    accountRepository.lockByInstagramUserInOrganization.mockResolvedValueOnce([
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
    expect(channelAccountRepository.revoke.mock.calls).toEqual([
      [{ organizationId: TEAM.id, channelAccountId: 5 }],
    ]);
    expect(tokenService.revokeConnection.mock.calls).toEqual([[{ scope, channelConnection }]]);
    expect(extensionService.eraseProfile.mock.calls).toEqual([
      [{ scope, instagramAccount: revokedKey }],
    ]);
  });

  it('changes an account connected in the second Meta signed the request in', async () => {
    const { service, accountRepository } = setup();
    // Meta signs whole seconds: 09:00:00.900 is not after 09:00:00.
    accountRepository.lockByInstagramUserInOrganization.mockResolvedValueOnce([
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
    accountRepository.lockByInstagramUserInOrganization.mockResolvedValueOnce([
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
  it('unsubscribes every live account outside the unit of work that read them (IAC5)', async () => {
    const { service, accountRepository, channelAccountRepository } = setup();
    const second = accountRow({ id: 4, instagram_user_id: '17841400000000002' });
    accountRepository.listLiveByOrganizationId.mockResolvedValueOnce([accountRow(), second]);

    await service.unsubscribeForOrganizationOffboarding({ scope });

    expect(instagramClient.unsubscribeInstagramWebhookFields.mock.calls).toEqual([
      [
        {
          encryptedAccessToken: STORED_CIPHERTEXT,
          instagramUserId: INSTAGRAM_USER_ID,
          requestId: undefined,
        },
      ],
      [
        {
          encryptedAccessToken: STORED_CIPHERTEXT,
          instagramUserId: '17841400000000002',
          requestId: undefined,
        },
      ],
    ]);
    expect(unitOfWork.openCountAtInstagramCalls).toEqual([0, 0]);
    expect(channelAccountRepository.revoke).not.toHaveBeenCalled();
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
    const { service, accountRepository, channelAccountRepository, extensionService, tokenService } =
      setup();
    const formerKey = { organizationId: TEAM.id, instagramAccountId: 4 };
    accountRepository.lockByOrganizationId.mockResolvedValueOnce([
      accountRow(),
      accountRow({
        id: formerKey.instagramAccountId,
        public_id: 'cha_z9y8x7w6v5u4t3s2r1q0p',
        connection_status: 'revoked',
      }),
    ]);
    channelAccountRepository.revoke.mockResolvedValueOnce({ id: 5 }).mockResolvedValueOnce(null);
    tokenService.revokeConnection.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

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
        instagramAccountPublicId: 'cha_z9y8x7w6v5u4t3s2r1q0p',
        wasRevoked: false,
        wasTokenErased: false,
        wasProfileErased: true,
      },
    ]);
    expect(extensionService.eraseProfile.mock.calls).toEqual([
      [{ scope, instagramAccount }],
      [{ scope, instagramAccount: formerKey }],
    ]);
    // A connection left with no account is revoked with its token too (IAC5).
    expect(tokenService.revokeOrganizationConnections).toHaveBeenCalledWith({
      scope,
      organizationId: TEAM.id,
    });
    expect(unitOfWork.openCountAtInstagramCalls).toEqual([]);
  });

  it('changes nothing when the organization is gone', async () => {
    const { service, accountRepository } = setup({ isOrganizationKnown: false });

    await expect(service.disconnectForOrganizationOffboarding({ scope })).resolves.toEqual([]);
    expect(accountRepository.lockByOrganizationId).not.toHaveBeenCalled();
  });
});

describe('InstagramAccountService.markConnectionBroken (CA4, IA9)', () => {
  it.each(['expired', 'error'] as const)(
    'moves the channel account to error on %s and enqueues the break’s notice after the commit',
    async (connectionStatus) => {
      const { service, accountRepository, channelAccountRepository } = setup();
      const brokenAt = new Date('2026-11-21T09:30:00.000Z');
      const after = accountRow({ connection_status: 'error' });
      accountRepository.findById.mockResolvedValueOnce(accountRow()).mockResolvedValueOnce(after);
      channelAccountRepository.markBroken.mockResolvedValueOnce({
        public_id: ACCOUNT_PUBLIC_ID,
        updated_at: brokenAt,
      });

      await expect(
        service.markConnectionBroken({
          scope,
          instagramAccount,
          connectionStatus,
          requestId: 'job-request',
        }),
      ).resolves.toBe(after);

      expect(channelAccountRepository.markBroken).toHaveBeenCalledWith({
        organizationId: TEAM.id,
        channelAccountId: 5,
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
    const { service, accountRepository, channelAccountRepository } = setup();
    accountRepository.findById.mockResolvedValue(accountRow());
    channelAccountRepository.markBroken.mockResolvedValueOnce({
      public_id: ACCOUNT_PUBLIC_ID,
      updated_at: NOW,
    });
    // The unit never commits: what was deferred does not run.
    runEnqueueAfterCommit.mockImplementationOnce(async () => {});

    await service.markConnectionBroken({ scope, instagramAccount, connectionStatus: 'error' });

    expect(runEnqueueAfterCommit).toHaveBeenCalledTimes(1);
    expect(enqueueReconnectNotice).not.toHaveBeenCalled();
  });

  it('answers null and enqueues nothing when the account had already left connected', async () => {
    const { service, accountRepository } = setup();
    accountRepository.findById.mockResolvedValueOnce(accountRow());

    await expect(
      service.markConnectionBroken({ scope, instagramAccount, connectionStatus: 'expired' }),
    ).resolves.toBeNull();
    expect(runEnqueueAfterCommit).not.toHaveBeenCalled();
  });
});
