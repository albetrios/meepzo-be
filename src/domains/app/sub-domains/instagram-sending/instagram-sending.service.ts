import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { assertTeamOrganizationForRead } from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import type {
  ChannelAccountPlanAccessService,
  ChannelAccountService,
} from '@/domains/app/sub-domains/channel-account/channel-account.service.js';
import { CHANNEL_ACCOUNTS_MAX_WITHOUT_PLAN } from '@/domains/app/sub-domains/channel-connection/channel-connection.constants.js';
import { instagramNotConnectedError } from '@/domains/app/sub-domains/instagram-account/instagram-account-error.util.js';
import type { InstagramSendDayCountRepository } from './instagram-send-day-count.repository.js';
import type { InstagramSendLaneService } from './instagram-send-lane.service.js';
import type { MessageMonthCountService } from './message-month-count.service.js';
import type { SendingStateService } from './sending-state.service.js';
import {
  serializeAppUsage,
  serializeInstagramSendingStatus,
} from './instagram-sending.serializer.js';
import type {
  AppUsageOutput,
  InstagramSendingStatusOutput,
  InstagramSendingStatusSources,
} from './instagram-sending.types.js';

/**
 * The two reads of the sending sub-domain (feat-instagram-dm-sending routes-final § 6.A — SN14,
 * SN15, SNC11): route 63, an Instagram account's sending status (the banners), and route 64, the
 * organization's DM meter, accounts used and notices.
 *
 * @remarks
 * Algorithm:
 * - Route 63: one unit — the team check (`404 team_organization_required`), the account (`404
 *   instagram_not_connected` when it is not this organization's, revoked or not Instagram), its four
 *   lanes and today's counter row (S8); the all-accounts stop from the global row (outside the unit,
 *   maintenance scope); the later rows' parts through {@link InstagramSendingStatusSources}.
 * - Route 64: the team check; the month through its 10-second Redis copy (SN11); the active accounts;
 *   billing's plan read (the limit, `channel_accounts_max`, the plan state and trial end).
 *
 * Failure modes: as above; a Redis failure falls through to Postgres.
 *
 * Side effects: none — reads only (one Redis populate on a meter miss).
 *
 * Notes: route 63 is not copied to Redis (P306) — its writers are every send result, stop, pause,
 * suspend and plan stop, too wide to tombstone, and the S8 counter row makes it a handful of indexed
 * rows. The estimate is stored on the slow lane row by its 10-minute job (S29, P305).
 */
export class InstagramSendingService {
  private readonly organizationService: OrganizationService;
  private readonly channelAccountService: ChannelAccountService;
  private readonly laneService: InstagramSendLaneService;
  private readonly dayCountRepository: InstagramSendDayCountRepository;
  private readonly monthCountService: MessageMonthCountService;
  private readonly sendingStateService: SendingStateService;
  private readonly planAccessService: ChannelAccountPlanAccessService;
  private readonly sources: InstagramSendingStatusSources;

  constructor(dependencies: {
    organizationService: OrganizationService;
    channelAccountService: ChannelAccountService;
    instagramSendLaneService: InstagramSendLaneService;
    dayCountRepository: InstagramSendDayCountRepository;
    messageMonthCountService: MessageMonthCountService;
    sendingStateService: SendingStateService;
    planAccessService: ChannelAccountPlanAccessService;
    /** The later rows' parts of route 63; each empty until its row passes it. */
    sources?: InstagramSendingStatusSources | undefined;
  }) {
    this.organizationService = dependencies.organizationService;
    this.channelAccountService = dependencies.channelAccountService;
    this.laneService = dependencies.instagramSendLaneService;
    this.dayCountRepository = dependencies.dayCountRepository;
    this.monthCountService = dependencies.messageMonthCountService;
    this.sendingStateService = dependencies.sendingStateService;
    this.planAccessService = dependencies.planAccessService;
    this.sources = dependencies.sources ?? {};
  }

  /**
   * Route 63 (SN14, RC-35): what one Instagram account's banners need.
   *
   * @remarks
   * Algorithm: as the class says. Failure modes: `404 team_organization_required`, `404
   * instagram_not_connected`. Side effects: none.
   */
  async getSendingStatus({
    scope,
    channelAccountPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
  }): Promise<InstagramSendingStatusOutput> {
    const read = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organizationId = await this.requireReadableOrganization(scope);
        const account = await this.channelAccountService.findLiveInstagramAccount({
          scope,
          organizationId,
          channelAccountPublicId,
        });
        if (account === null) throw instagramNotConnectedError();
        const target = { scope, organizationId, channelAccountId: account.id };
        const lanes = await this.laneService.listLanes(target);
        const openStops = await this.laneService.listOpenStops(target);
        const today = await this.dayCountRepository.readToday({
          organizationId,
          channelAccountId: account.id,
        });
        const waitingByLane = (await this.sources.countWaitingByLane?.(target)) ?? {};
        const windowClosedByAutomation =
          (await this.sources.listWindowClosedByAutomation?.(target)) ?? [];
        const lastBroadcast = (await this.sources.findLastBroadcast?.(target)) ?? null;
        const lastBackfill = (await this.sources.findLastBackfill?.(target)) ?? null;
        const lastRetry = (await this.sources.findLastRetry?.(target)) ?? null;
        return {
          account,
          lanes,
          openStops,
          today,
          waitingByLane,
          windowClosedByAutomation,
          lastBroadcast,
          lastBackfill,
          lastRetry,
        };
      },
    });
    const sendingState = await this.sendingStateService.readSendingState();
    return serializeInstagramSendingStatus({
      ...read,
      sendingState,
      now: new Date(Date.now()),
    });
  }

  /**
   * Route 64 (SN15, RC-56, P14): the organization's DM meter, accounts used and notices.
   *
   * @remarks
   * Algorithm: as the class says. Failure modes: `404 team_organization_required`; a plan read
   * failure propagates. Side effects: a Redis populate on a meter miss.
   */
  async getUsage({
    scope,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
  }): Promise<AppUsageOutput> {
    const { organizationId, accountsUsed, liveAccounts } = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const id = await this.requireReadableOrganization(scope);
        const used = await this.channelAccountService.countActiveAccounts({
          scope,
          organizationId: id,
        });
        // "Being set up" (plan §46, R40): no not-revoked account yet (BL16's accounts count).
        const live = await this.channelAccountService.countLiveAccounts({
          scope,
          organizationId: id,
        });
        return { organizationId: id, accountsUsed: used, liveAccounts: live };
      },
    });
    const month = await this.monthCountService.readMonth({ scope, organizationId });
    const planAccess = await this.planAccessService.getPlanAccess({
      organizationPublicId: scope.organizationPublicId,
    });
    return serializeAppUsage({
      month,
      limit: planAccess.features?.message_month_limit ?? null,
      accounts: {
        used: accountsUsed,
        maximum: planAccess.features?.channel_accounts_max ?? CHANNEL_ACCOUNTS_MAX_WITHOUT_PLAN,
      },
      planAccess,
      hasLiveAccount: liveAccounts > 0,
      now: new Date(Date.now()),
    });
  }

  /** The scope's organization id when it is a team (`404 team_organization_required` otherwise). */
  private async requireReadableOrganization(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<number> {
    const organization = await this.organizationService.requireOrganizationByPublicId(
      scope.organizationPublicId,
    );
    assertTeamOrganizationForRead({ organization });
    return organization.id;
  }
}
