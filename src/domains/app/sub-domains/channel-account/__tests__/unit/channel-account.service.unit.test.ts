import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelConnectionTokenService } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.service.js';
import type { ChannelConnectionRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection.repository.js';
import type { InstagramAccountExtensionService } from '@/domains/app/sub-domains/instagram-account/instagram-account-extension.service.js';
import type { InstagramAccountRow } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import type {
  ChannelAccountRepository,
  ChannelAccountRow,
} from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import {
  type ChannelAccountPlanAccessService,
  ChannelAccountService,
} from '@/domains/app/sub-domains/channel-account/channel-account.service.js';
import type {
  ChannelAccountLanePort,
  ChannelAccountPlanStopPort,
} from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  ConflictError,
  NotFoundError,
  UnprocessableEntityError,
  ValidationError,
} from '@/shared/errors/index.js';

const { unitOfWork } = vi.hoisted(() => ({
  /** How many units of work are open, and the open count at each Meta call or lane wake. */
  unitOfWork: { openCount: 0, openCountAtOutsideCalls: [] as number[] },
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

// The account object's shape has its own test (`channel-account.serializer.unit.test.ts`).
vi.mock('@/domains/app/sub-domains/channel-account/channel-account.serializer.js', () => ({
  serializeChannelAccount: vi.fn(({ account }: { account: ChannelAccountRow }) => ({
    id: account.public_id,
    plan_stop_reason: account.plan_stop_reason,
    is_paused: account.paused_at !== null,
  })),
  serializeChannelAccountSummary: vi.fn(
    ({ account, has_lane_stop }: { account: ChannelAccountRow; has_lane_stop: boolean }) => ({
      id: account.public_id,
      has_lane_stop,
    }),
  ),
}));

/**
 * The channel account service's own decisions (routes-final § 1B — routes 6–11, CA6–CA9) with its
 * repositories, the Instagram, token, organization and plan services and the lane/plan-stop ports
 * faked: the team checks, which accounts read as `404`, that route 8 calls Meta outside every unit
 * of work and revokes the connection only with its last account, the pause/resume answers and the
 * lane wake after commit, and route 11's swap rules. The feature check is in
 * `channel-account-feature-check.service.unit.test.ts`; the SQL in the integration test.
 */

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const USER_PUBLIC_ID = 'usr_a1b2c3d4e5f6g7h8i9j0k';
const ORGANIZATION_ID = 7;
const CONNECTION_ID = 9;
const scope: OrganizationPrincipalDatabaseScope = PRINCIPAL_SCOPE.VERIFIED({
  organizationPublicId: ORGANIZATION_PUBLIC_ID,
});
const NOW = new Date('2026-11-24T09:00:00.000Z');

function accountRow(overrides: Partial<ChannelAccountRow> = {}): ChannelAccountRow {
  return {
    id: 5,
    public_id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
    organization_id: ORGANIZATION_ID,
    channel: 'instagram',
    channel_connection_id: CONNECTION_ID,
    provider_account_id: '17841400000000001',
    display_name: '@acme.shop',
    connection_status: 'connected',
    is_automation_enabled: true,
    paused_at: null,
    paused_by_user_id: null,
    suspended_at: null,
    plan_stop_reason: null,
    plan_stopped_at: null,
    connected_by_user_id: null,
    connected_at: NOW,
    disconnected_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  } as ChannelAccountRow;
}

const OTHER_ACCOUNT = accountRow({ id: 6, public_id: 'cha_z9y8x7w6v5u4t3s2r1q0p' });
const INSTAGRAM_ROW = { id: 3, organization_id: ORGANIZATION_ID } as InstagramAccountRow;

function setup({
  organizationType = 'TEAM',
  account = accountRow() as ChannelAccountRow | null,
  accountsByPublicId = {} as Record<string, ChannelAccountRow>,
  hasInstagram = true,
  hasToken = true,
  liveOfConnection = 0,
  activeCount = 0,
  accountsMax = 1 as number | undefined,
  organizationStop = null as 'plan_limit' | 'plan_ended' | null,
}: {
  organizationType?: 'TEAM' | 'PERSONAL';
  account?: ChannelAccountRow | null;
  accountsByPublicId?: Record<string, ChannelAccountRow>;
  hasInstagram?: boolean;
  hasToken?: boolean;
  liveOfConnection?: number;
  activeCount?: number;
  accountsMax?: number | undefined;
  organizationStop?: 'plan_limit' | 'plan_ended' | null;
} = {}) {
  const accountRepository = {
    findByPublicId: vi.fn(
      async ({ channelAccountPublicId }: { channelAccountPublicId: string }) =>
        accountsByPublicId[channelAccountPublicId] ??
        (account?.public_id === channelAccountPublicId ? account : null),
    ),
    listLive: vi.fn(async () => (account === null ? [] : [account])),
    revoke: vi.fn(async () =>
      account === null ? null : { ...account, connection_status: 'revoked' },
    ),
    countLiveByConnection: vi.fn(async () => liveOfConnection),
    pause: vi.fn(async () => (account === null ? null : { ...account, paused_at: NOW })),
    resume: vi.fn(async () => (account === null ? null : { ...account, paused_at: null })),
    lockOrganizationForAccountLimit: vi.fn(async () => undefined),
    countActive: vi.fn(async () => activeCount),
    setPlanStop: vi.fn(
      async ({ channelAccountId, reason }: { channelAccountId: number; reason: string | null }) =>
        ({
          ...(channelAccountId === OTHER_ACCOUNT.id ? OTHER_ACCOUNT : account),
          plan_stop_reason: reason,
        }) as ChannelAccountRow,
    ),
  };
  const instagramExtensionService = {
    findByChannelAccountIds: vi.fn(
      async ({ channelAccountIds }: { channelAccountIds: number[] }) =>
        new Map(hasInstagram ? channelAccountIds.map((id) => [id, INSTAGRAM_ROW] as const) : []),
    ),
    clearOnRevoke: vi.fn(async () => undefined),
  };
  const instagramAccountService = {
    // WC-31, AC-2.4 (R40): the starter questions go first, outside every unit of work too.
    removeStarterQuestionsBestEffort: vi.fn(async () => {
      unitOfWork.openCountAtOutsideCalls.push(unitOfWork.openCount);
    }),
    unsubscribeWebhookFieldsBestEffort: vi.fn(async () => {
      unitOfWork.openCountAtOutsideCalls.push(unitOfWork.openCount);
    }),
  };
  const instagramSettingsService = { findSettings: vi.fn(async () => null) };
  const connectionRepository = {
    findByIds: vi.fn(async () => [
      {
        id: CONNECTION_ID,
        public_id: 'chc_a1b2c3d4e5f6g7h8i9j0k',
        provider: 'meta',
        status: 'connected',
      },
    ]),
  };
  const connectionTokenService = {
    findAccessToken: vi.fn(async () => (hasToken ? { encryptedAccessToken: 'v1:cipher' } : null)),
    revokeConnection: vi.fn(async () => undefined),
  };
  const organizationService = {
    requireOrganizationByPublicId: vi.fn(async () => ({
      id: ORGANIZATION_ID,
      public_id: ORGANIZATION_PUBLIC_ID,
      type: organizationType,
    })),
    resolveUserInternalIdByPublicId: vi.fn(async () => 41),
    resolveUserPublicIdsByInternalIds: vi.fn(async () => new Map<number, string>()),
  };
  const planAccessService = {
    getPlanAccess: vi.fn(async () => ({
      features: accountsMax === undefined ? null : { channel_accounts_max: accountsMax },
    })),
  };
  const lanePort = {
    readActiveStop: vi.fn(async () => null),
    stopLanes: vi.fn(async () => undefined),
    wakeLanes: vi.fn(async () => {
      unitOfWork.openCountAtOutsideCalls.push(unitOfWork.openCount);
    }),
  };
  const planStopPort = { readOrganizationPlanStop: vi.fn(async () => organizationStop) };
  const service = new ChannelAccountService(
    accountRepository as unknown as ChannelAccountRepository,
    instagramExtensionService as unknown as InstagramAccountExtensionService,
    instagramAccountService as unknown as InstagramAccountService,
    instagramSettingsService as unknown as InstagramAccountSettingsService,
    connectionRepository as unknown as ChannelConnectionRepository,
    connectionTokenService as unknown as ChannelConnectionTokenService,
    organizationService as unknown as OrganizationService,
    planAccessService as unknown as ChannelAccountPlanAccessService,
    lanePort as unknown as ChannelAccountLanePort,
    planStopPort as unknown as ChannelAccountPlanStopPort,
  );
  return {
    service,
    accountRepository,
    instagramExtensionService,
    instagramAccountService,
    connectionTokenService,
    lanePort,
  };
}

const ACCOUNT_PUBLIC_ID = accountRow().public_id;

beforeEach(() => {
  unitOfWork.openCount = 0;
  unitOfWork.openCountAtOutsideCalls = [];
});

describe('ChannelAccountService reads (routes 6–7)', () => {
  it('lists the accounts with whether a lane stop is active', async () => {
    const { service, lanePort } = setup();
    lanePort.readActiveStop.mockResolvedValueOnce({ reason: 'rate_limited' } as never);

    await expect(service.listAccounts({ scope, channels: ['instagram'] })).resolves.toEqual([
      { id: ACCOUNT_PUBLIC_ID, has_lane_stop: true },
    ]);
  });

  it('answers 404 team_organization_required to a personal organization', async () => {
    const { service } = setup({ organizationType: 'PERSONAL' });

    await expect(service.listAccounts({ scope, channels: ['instagram'] })).rejects.toMatchObject({
      reason: 'team_organization_required',
    });
  });

  it.each([
    ['missing', null],
    ['revoked', accountRow({ connection_status: 'revoked' })],
  ])('answers 404 channel_account_not_found for a %s account', async (_label, account) => {
    const { service } = setup({ account });

    const failure = service.getAccount({ scope, channelAccountPublicId: ACCOUNT_PUBLIC_ID });

    await expect(failure).rejects.toBeInstanceOf(NotFoundError);
    await expect(failure).rejects.toMatchObject({ reason: 'channel_account_not_found' });
  });
});

describe('ChannelAccountService.disconnectAccount (route 8)', () => {
  const caller = { scope, requestId: 'req_1', channelAccountPublicId: ACCOUNT_PUBLIC_ID };

  it('unsubscribes at Meta outside every unit of work, then revokes the account and stops its lanes', async () => {
    const {
      service,
      instagramAccountService,
      accountRepository,
      lanePort,
      instagramExtensionService,
    } = setup({ liveOfConnection: 1 });

    const change = await service.disconnectAccount(caller);

    expect(instagramAccountService.removeStarterQuestionsBestEffort).toHaveBeenCalledTimes(1);
    expect(instagramAccountService.unsubscribeWebhookFieldsBestEffort).toHaveBeenCalledTimes(1);
    expect(unitOfWork.openCountAtOutsideCalls).toEqual([0, 0]);
    expect(accountRepository.revoke).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      channelAccountId: 5,
    });
    expect(instagramExtensionService.clearOnRevoke).toHaveBeenCalledTimes(1);
    expect(lanePort.stopLanes).toHaveBeenCalledWith({
      scope,
      organizationId: ORGANIZATION_ID,
      channelAccountId: 5,
    });
    expect(change).toEqual({
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      oldValue: { connection_status: 'connected' },
      newValue: { connection_status: 'revoked' },
    });
  });

  it('keeps the connection while another live account uses it', async () => {
    const { service, connectionTokenService } = setup({ liveOfConnection: 1 });

    await service.disconnectAccount(caller);

    expect(connectionTokenService.revokeConnection).not.toHaveBeenCalled();
  });

  it('revokes the connection with its last account', async () => {
    const { service, connectionTokenService } = setup({ liveOfConnection: 0 });

    await service.disconnectAccount(caller);

    expect(connectionTokenService.revokeConnection).toHaveBeenCalledWith({
      scope,
      channelConnection: { organizationId: ORGANIZATION_ID, channelConnectionId: CONNECTION_ID },
    });
  });

  it('skips the Meta call when the connection has no token', async () => {
    const { service, instagramAccountService } = setup({ hasToken: false });

    await service.disconnectAccount(caller);

    expect(instagramAccountService.removeStarterQuestionsBestEffort).not.toHaveBeenCalled();
    expect(instagramAccountService.unsubscribeWebhookFieldsBestEffort).not.toHaveBeenCalled();
  });

  it('answers 404 when a concurrent disconnect won the revoke', async () => {
    const { service, accountRepository, connectionTokenService } = setup();
    accountRepository.revoke.mockResolvedValueOnce(null);

    await expect(service.disconnectAccount(caller)).rejects.toMatchObject({
      reason: 'channel_account_not_found',
    });
    expect(connectionTokenService.revokeConnection).not.toHaveBeenCalled();
  });

  it('answers 422 to a personal organization before any read', async () => {
    const { service, accountRepository } = setup({ organizationType: 'PERSONAL' });

    await expect(service.disconnectAccount(caller)).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
    expect(accountRepository.findByPublicId).not.toHaveBeenCalled();
  });
});

describe('ChannelAccountService pause and resume (routes 9–10)', () => {
  it("pauses with the signed-in user's internal id and reports the change", async () => {
    const { service, accountRepository } = setup();

    const result = await service.pauseAccount({
      scope,
      userPublicId: USER_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
    });

    expect(accountRepository.pause).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      channelAccountId: 5,
      pausedByUserId: 41,
    });
    expect(result.data).toMatchObject({ is_paused: true });
    expect(result.change).toEqual({
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      oldValue: { is_paused: false },
      newValue: { is_paused: true },
    });
  });

  it('resumes and wakes the lanes only after the unit of work closed', async () => {
    const { service, lanePort } = setup({ account: accountRow({ paused_at: NOW }) });

    const result = await service.resumeAccount({
      scope,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
    });

    expect(result.change).toMatchObject({
      oldValue: { is_paused: true },
      newValue: { is_paused: false },
    });
    expect(lanePort.wakeLanes).toHaveBeenCalledWith({
      scope,
      organizationId: ORGANIZATION_ID,
      channelAccountId: 5,
    });
    expect(unitOfWork.openCountAtOutsideCalls).toEqual([0]);
  });

  it('does not wake any lane when the account is not found', async () => {
    const { service, lanePort } = setup({ account: null });

    await expect(
      service.resumeAccount({ scope, channelAccountPublicId: ACCOUNT_PUBLIC_ID }),
    ).rejects.toMatchObject({ reason: 'channel_account_not_found' });
    expect(lanePort.wakeLanes).not.toHaveBeenCalled();
  });
});

describe('ChannelAccountService.activateAccount (route 11)', () => {
  const downgraded = accountRow({ plan_stop_reason: 'plan_downgrade' });

  it('answers 409 channel_account_already_active for an account not held by a downgrade', async () => {
    const { service } = setup();

    const failure = service.activateAccount({
      scope,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      stopChannelAccountPublicId: null,
    });

    await expect(failure).rejects.toBeInstanceOf(ConflictError);
    await expect(failure).rejects.toMatchObject({ reason: 'channel_account_already_active' });
  });

  it('answers 409 plan_account_limit at the limit when no account is named', async () => {
    const { service, accountRepository } = setup({ account: downgraded, activeCount: 1 });

    await expect(
      service.activateAccount({
        scope,
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        stopChannelAccountPublicId: null,
      }),
    ).rejects.toMatchObject({ reason: 'plan_account_limit' });
    expect(accountRepository.lockOrganizationForAccountLimit).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(accountRepository.setPlanStop).not.toHaveBeenCalled();
  });

  it('activates below the limit, clearing the downgrade, and wakes its lanes after commit', async () => {
    const { service, accountRepository, lanePort } = setup({ account: downgraded, activeCount: 0 });

    const result = await service.activateAccount({
      scope,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      stopChannelAccountPublicId: null,
    });

    expect(accountRepository.setPlanStop).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      channelAccountId: 5,
      reason: null,
    });
    expect(result.change).toEqual({
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      oldValue: { plan_stop_reason: 'plan_downgrade' },
      newValue: { plan_stop_reason: null },
    });
    expect(result.stoppedChannelAccountPublicId).toBeNull();
    expect(lanePort.stopLanes).not.toHaveBeenCalled();
    expect(lanePort.wakeLanes).toHaveBeenCalledTimes(1);
  });

  it('uses the no-plan account maximum when the plan has no features', async () => {
    const { service } = setup({ account: downgraded, activeCount: 1, accountsMax: undefined });

    await expect(
      service.activateAccount({
        scope,
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        stopChannelAccountPublicId: null,
      }),
    ).rejects.toMatchObject({ reason: 'plan_account_limit' });
  });

  it('swaps out the named active account with plan_downgrade and stops its lanes', async () => {
    const { service, accountRepository, lanePort } = setup({
      account: downgraded,
      accountsByPublicId: { [OTHER_ACCOUNT.public_id]: OTHER_ACCOUNT },
      activeCount: 1,
    });

    const result = await service.activateAccount({
      scope,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      stopChannelAccountPublicId: OTHER_ACCOUNT.public_id,
    });

    expect(accountRepository.setPlanStop).toHaveBeenNthCalledWith(1, {
      organizationId: ORGANIZATION_ID,
      channelAccountId: OTHER_ACCOUNT.id,
      reason: 'plan_downgrade',
    });
    expect(lanePort.stopLanes).toHaveBeenCalledWith({
      scope,
      organizationId: ORGANIZATION_ID,
      channelAccountId: OTHER_ACCOUNT.id,
      planStopReason: 'plan_downgrade',
    });
    expect(result.stoppedChannelAccountPublicId).toBe(OTHER_ACCOUNT.public_id);
  });

  it("gives the activated account the organization's own plan stop and stops its lanes", async () => {
    const { service, accountRepository, lanePort } = setup({
      account: downgraded,
      organizationStop: 'plan_ended',
    });

    const result = await service.activateAccount({
      scope,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      stopChannelAccountPublicId: null,
    });

    expect(accountRepository.setPlanStop).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      channelAccountId: 5,
      reason: 'plan_ended',
    });
    expect(lanePort.stopLanes).toHaveBeenCalledWith(
      expect.objectContaining({ channelAccountId: 5, planStopReason: 'plan_ended' }),
    );
    expect(result.change.newValue).toEqual({ plan_stop_reason: 'plan_ended' });
  });

  it.each([
    ['the same account', () => downgraded],
    [
      'a revoked account',
      () => accountRow({ id: 6, public_id: OTHER_ACCOUNT.public_id, connection_status: 'revoked' }),
    ],
    [
      'an account already downgraded',
      () =>
        accountRow({
          id: 6,
          public_id: OTHER_ACCOUNT.public_id,
          plan_stop_reason: 'plan_downgrade',
        }),
    ],
  ])('answers 400 stop_channel_account_id when the named account is %s', async (_label, named) => {
    const namedAccount = named();
    const { service } = setup({
      account: downgraded,
      accountsByPublicId: { [namedAccount.public_id]: namedAccount },
    });

    await expect(
      service.activateAccount({
        scope,
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        stopChannelAccountPublicId: namedAccount.public_id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('answers 400 stop_channel_account_id when the named account is not found', async () => {
    const { service } = setup({ account: downgraded });

    await expect(
      service.activateAccount({
        scope,
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        stopChannelAccountPublicId: 'cha_unknown00000000000000',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('ChannelAccountService route 63/64 ports', () => {
  it('counts the active accounts of the organization', async () => {
    const { service, accountRepository } = setup({ activeCount: 3 });

    await expect(
      service.countActiveAccounts({ scope, organizationId: ORGANIZATION_ID }),
    ).resolves.toBe(3);
    expect(accountRepository.countActive).toHaveBeenCalledWith(ORGANIZATION_ID);
  });

  it.each([
    ['a revoked account', accountRow({ connection_status: 'revoked' })],
    ['another channel', accountRow({ channel: 'facebook' })],
    ['a missing account', null],
  ])('finds no live Instagram account for %s', async (_label, account) => {
    const { service } = setup({ account });

    await expect(
      service.findLiveInstagramAccount({
        scope,
        organizationId: ORGANIZATION_ID,
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      }),
    ).resolves.toBeNull();
  });

  it('finds a connected or broken Instagram account', async () => {
    const broken = accountRow({ connection_status: 'error' });
    const { service } = setup({ account: broken });

    await expect(
      service.findLiveInstagramAccount({
        scope,
        organizationId: ORGANIZATION_ID,
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      }),
    ).resolves.toBe(broken);
  });
});
