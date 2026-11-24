import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelAccountPlanAccessService,
  ChannelAccountService,
} from '@/domains/app/sub-domains/channel-account/channel-account.service.js';
import { CHANNEL_ACCOUNTS_MAX_WITHOUT_PLAN } from '@/domains/app/sub-domains/channel-connection/channel-connection.constants.js';
import type { InstagramSendDayCountRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-day-count.repository.js';
import type { InstagramSendLaneService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.service.js';
import { InstagramSendingService } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.service.js';
import type { InstagramSendingStatusSources } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import type { MessageMonthCountService } from '@/domains/app/sub-domains/instagram-sending/message-month-count.service.js';
import type { SendingStateService } from '@/domains/app/sub-domains/instagram-sending/sending-state.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import { NotFoundError } from '@/shared/errors/index.js';

const { unitOfWork, serializeInstagramSendingStatus, serializeAppUsage } = vi.hoisted(() => ({
  /** How many units of work are open; the global sending state is read outside one. */
  unitOfWork: { openCount: 0, openCountAtSendingStateRead: [] as number[] },
  // The serializers have their own unit test: here they hand back what the service assembled.
  serializeInstagramSendingStatus: vi.fn((input: unknown) => ({ serialized: 'status', input })),
  serializeAppUsage: vi.fn((input: unknown) => ({ serialized: 'usage', input })),
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
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

vi.mock('@/domains/app/sub-domains/instagram-sending/instagram-sending.serializer.js', () => ({
  serializeInstagramSendingStatus,
  serializeAppUsage,
}));

/**
 * The sending sub-domain's two reads (routes-final § 6.A — SN14, SN15, routes 63–64) with the
 * organization, channel-account, lane, counter, month, sending-state and plan services faked: the
 * team check and the not-connected 404, which parts route 63 gathers (and that a later row's part
 * left unset reads empty), the global stop read outside the unit, and route 64's plan fallbacks. The
 * shaping is in `instagram-sending.serializer.unit.test.ts`.
 */

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const ACCOUNT_PUBLIC_ID = 'cha_k7x9m2pqr4w8n1v3a1b2c';
const NOW = new Date('2026-11-24T09:00:00.000Z');
const scope: OrganizationPrincipalDatabaseScope = PRINCIPAL_SCOPE.VERIFIED({
  organizationPublicId: ORGANIZATION_PUBLIC_ID,
});
const ACCOUNT = { id: 5, public_id: ACCOUNT_PUBLIC_ID };
const LANES = [{ lane: 'reply' }];
const OPEN_STOPS = [{ lane: 'broadcast', reason: 'rate_limited' }];
const TODAY = { sent_count: 12 };
const SENDING_STATE = { is_stopped: false };
const MONTH = { count: 340 };

function setup({
  organizationType = 'TEAM',
  account = ACCOUNT as typeof ACCOUNT | null,
  sources,
  features = { message_month_limit: 1000, channel_accounts_max: 3 } as Record<
    string,
    unknown
  > | null,
}: {
  organizationType?: 'TEAM' | 'PERSONAL';
  account?: typeof ACCOUNT | null;
  sources?: InstagramSendingStatusSources;
  features?: Record<string, unknown> | null;
} = {}) {
  const organizationService = {
    requireOrganizationByPublicId: vi.fn(async () => ({ id: 7, type: organizationType })),
  };
  const channelAccountService = {
    findLiveInstagramAccount: vi.fn(async () => account),
    countActiveAccounts: vi.fn(async () => 2),
  };
  const laneService = {
    listLanes: vi.fn(async () => LANES),
    listOpenStops: vi.fn(async () => OPEN_STOPS),
  };
  const dayCountRepository = { readToday: vi.fn(async () => TODAY) };
  const monthCountService = { readMonth: vi.fn(async () => MONTH) };
  const sendingStateService = {
    readSendingState: vi.fn(async () => {
      unitOfWork.openCountAtSendingStateRead.push(unitOfWork.openCount);
      return SENDING_STATE;
    }),
  };
  const planAccess = { features, state: 'active' };
  const planAccessService = { getPlanAccess: vi.fn(async () => planAccess) };
  const service = new InstagramSendingService({
    organizationService: organizationService as unknown as OrganizationService,
    channelAccountService: channelAccountService as unknown as ChannelAccountService,
    instagramSendLaneService: laneService as unknown as InstagramSendLaneService,
    dayCountRepository: dayCountRepository as unknown as InstagramSendDayCountRepository,
    messageMonthCountService: monthCountService as unknown as MessageMonthCountService,
    sendingStateService: sendingStateService as unknown as SendingStateService,
    planAccessService: planAccessService as unknown as ChannelAccountPlanAccessService,
    sources,
  });
  return {
    service,
    organizationService,
    channelAccountService,
    laneService,
    dayCountRepository,
    monthCountService,
    planAccessService,
    planAccess,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  unitOfWork.openCount = 0;
  unitOfWork.openCountAtSendingStateRead = [];
  serializeInstagramSendingStatus.mockClear();
  serializeAppUsage.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InstagramSendingService.getSendingStatus (route 63)', () => {
  it("gathers the account's lanes, open stops and today's counter for the serializer", async () => {
    const { service, channelAccountService, laneService, dayCountRepository } = setup();

    await service.getSendingStatus({ scope, channelAccountPublicId: ACCOUNT_PUBLIC_ID });

    expect(channelAccountService.findLiveInstagramAccount).toHaveBeenCalledWith({
      scope,
      organizationId: 7,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
    });
    const target = { scope, organizationId: 7, channelAccountId: ACCOUNT.id };
    expect(laneService.listLanes).toHaveBeenCalledWith(target);
    expect(laneService.listOpenStops).toHaveBeenCalledWith(target);
    expect(dayCountRepository.readToday).toHaveBeenCalledWith({
      organizationId: 7,
      channelAccountId: ACCOUNT.id,
    });
    expect(serializeInstagramSendingStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        account: ACCOUNT,
        lanes: LANES,
        openStops: OPEN_STOPS,
        today: TODAY,
        sendingState: SENDING_STATE,
        now: NOW,
      }),
    );
  });

  it("reads every later row's part as empty while no source is passed", async () => {
    const { service } = setup();

    await service.getSendingStatus({ scope, channelAccountPublicId: ACCOUNT_PUBLIC_ID });

    expect(serializeInstagramSendingStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        waitingByLane: {},
        windowClosedByAutomation: [],
        lastBroadcast: null,
        lastBackfill: null,
        lastRetry: null,
      }),
    );
  });

  it("passes each source's answer through, called with the account's target", async () => {
    const lastRetry = { at: NOW } as never;
    const sources: InstagramSendingStatusSources = {
      countWaitingByLane: vi.fn(async () => ({ reply: 4 })),
      findLastRetry: vi.fn(async () => lastRetry),
    };
    const { service } = setup({ sources });

    await service.getSendingStatus({ scope, channelAccountPublicId: ACCOUNT_PUBLIC_ID });

    expect(sources.countWaitingByLane).toHaveBeenCalledWith({
      scope,
      organizationId: 7,
      channelAccountId: ACCOUNT.id,
    });
    expect(serializeInstagramSendingStatus).toHaveBeenCalledWith(
      expect.objectContaining({ waitingByLane: { reply: 4 }, lastRetry, lastBroadcast: null }),
    );
  });

  it('reads the global sending state outside the unit of work', async () => {
    const { service } = setup();

    await service.getSendingStatus({ scope, channelAccountPublicId: ACCOUNT_PUBLIC_ID });

    expect(unitOfWork.openCountAtSendingStateRead).toEqual([0]);
  });

  it('answers 404 instagram_not_connected when the account is not live in this organization', async () => {
    const { service, laneService } = setup({ account: null });

    const failure = service.getSendingStatus({ scope, channelAccountPublicId: ACCOUNT_PUBLIC_ID });

    await expect(failure).rejects.toBeInstanceOf(NotFoundError);
    await expect(failure).rejects.toMatchObject({ reason: 'instagram_not_connected' });
    expect(laneService.listLanes).not.toHaveBeenCalled();
    expect(serializeInstagramSendingStatus).not.toHaveBeenCalled();
  });

  it('answers 404 team_organization_required for a personal organization', async () => {
    const { service, channelAccountService } = setup({ organizationType: 'PERSONAL' });

    await expect(
      service.getSendingStatus({ scope, channelAccountPublicId: ACCOUNT_PUBLIC_ID }),
    ).rejects.toMatchObject({ reason: 'team_organization_required' });
    expect(channelAccountService.findLiveInstagramAccount).not.toHaveBeenCalled();
  });
});

describe('InstagramSendingService.getUsage (route 64)', () => {
  it("hands the month, the plan's limits and the active-account count to the serializer", async () => {
    const { service, monthCountService, planAccessService, planAccess } = setup();

    await service.getUsage({ scope });

    expect(monthCountService.readMonth).toHaveBeenCalledWith({ scope, organizationId: 7 });
    expect(planAccessService.getPlanAccess).toHaveBeenCalledWith({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
    });
    expect(serializeAppUsage).toHaveBeenCalledWith({
      month: MONTH,
      limit: 1000,
      accounts: { used: 2, maximum: 3 },
      planAccess,
      now: NOW,
    });
  });

  it('falls back to no limit and the no-plan account maximum when the plan has no features', async () => {
    const { service } = setup({ features: null });

    await service.getUsage({ scope });

    expect(serializeAppUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: null,
        accounts: { used: 2, maximum: CHANNEL_ACCOUNTS_MAX_WITHOUT_PLAN },
      }),
    );
  });

  it('answers 404 team_organization_required for a personal organization before any read', async () => {
    const { service, monthCountService, planAccessService } = setup({
      organizationType: 'PERSONAL',
    });

    await expect(service.getUsage({ scope })).rejects.toMatchObject({
      reason: 'team_organization_required',
    });
    expect(monthCountService.readMonth).not.toHaveBeenCalled();
    expect(planAccessService.getPlanAccess).not.toHaveBeenCalled();
  });
});
