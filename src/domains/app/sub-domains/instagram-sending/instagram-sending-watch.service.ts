import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { MILLISECONDS_PER_DAY, MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { NotFoundError } from '@/shared/errors/index.js';
import { ChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { InstagramAccountSettingsRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import type { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import { CHANNEL_ACCOUNT_NEW_ACCOUNT_LIMIT_DAYS } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import {
  listInstagramLiveMedia,
  readInstagramAccountProfile,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type { InstagramSendAccess } from './instagram-sending.types.js';
import type { InstagramOutgoingMessageService } from './instagram-outgoing-message/instagram-outgoing-message.service.js';
import { InstagramOutgoingMessageRepository } from './instagram-outgoing-message/instagram-outgoing-message.repository.js';
import { InstagramSendLaneRepository } from './instagram-send-lane.repository.js';
import type { InstagramSendAccessService } from './instagram-send-access.service.js';
import type { SendingStateService } from './sending-state.service.js';
import type { InstagramSendingWatchAccount } from './instagram-sending-watch.repository.js';
import {
  type InstagramWaitingEstimate,
  type InstagramWaitingEstimateInput,
  computeInstagramWaitingEstimate,
} from './instagram-send-estimate.util.js';
import { planStopHoldsLane } from './instagram-send-lane.util.js';
import {
  INSTAGRAM_SENDING_WATCH_SETTINGS,
  NEW_ACCOUNT_HOUR_LIMIT,
  OPENING_HOUR_LIMIT_DEFAULT,
} from './instagram-sending.constants.js';

const SETTINGS = INSTAGRAM_SENDING_WATCH_SETTINGS;

/**
 * What the outage watch decided this round (WC-22).
 *
 * @remarks
 * Notes: `stopUntil` is set when this round started the all-accounts stop.
 */
export interface InstagramOutageCheckResult {
  callCount: number;
  badCount: number;
  activeCount: number;
  downCount: number;
  stopUntil: Date | null;
  isCountReset: boolean;
}

/**
 * The counts the outage watch reads across organizations (the watch repository's, under the
 * retention context — the processor reads them).
 *
 * @remarks
 * Notes: plain numbers so the rule is tested without a database.
 */
export interface InstagramOutageReadings {
  callCount: number;
  badCount: number;
  activeCount: number;
  downCount: number;
}

/**
 * Whether the all-accounts outage rule holds (plan §33.5 rule 3): at least 50 calls in 30 s with
 * 30 % or more bad, or 30 % or more of the active accounts in a down stop — pure.
 *
 * @remarks
 * Algorithm: the two shares against `INSTAGRAM_SENDING_WATCH_SETTINGS`. Failure modes: none. Side
 * effects: none.
 */
export function isInstagramDownForAll(readings: InstagramOutageReadings): boolean {
  const isCallsBad =
    readings.callCount >= SETTINGS.badMinCalls &&
    readings.badCount * 100 >= readings.callCount * SETTINGS.badPercent;
  const isAccountsDown =
    readings.activeCount > 0 &&
    readings.downCount * 100 >= readings.activeCount * SETTINGS.downAllSharePercent;
  return isCallsBad || isAccountsDown;
}

/**
 * The read-only call that tests an `instagram_down` stop (plan §33.5 rule 2, ROUTE row R48): the
 * account's own profile. `answered` when Instagram answered — also with an error of the token or
 * the account (the test DM then meets it and its own stop); `unclear` when it did not (an outage, a
 * throttle, no answer) or there is nothing to call with.
 *
 * @remarks
 * Algorithm: one `GET /{instagram_user_id}` with the connection's token, its usage recorded.
 * Failure modes: none — every failure is an answer. Side effects: one Meta call.
 */
export async function probeInstagramAccountReadOnly({
  scope,
  access,
  accessService,
  readProfile = readInstagramAccountProfile,
}: {
  scope: OrganizationPrincipalDatabaseScope;
  access: InstagramSendAccess;
  accessService: Pick<InstagramSendAccessService, 'buildUsageRecorder'>;
  readProfile?: typeof readInstagramAccountProfile;
}): Promise<'answered' | 'unclear'> {
  if (access.encryptedAccessToken === null) return 'unclear';
  try {
    await readProfile({
      encryptedAccessToken: access.encryptedAccessToken,
      instagramUserId: access.instagramUserId,
      recordUsage: accessService.buildUsageRecorder({ scope, access }),
    });
    return 'answered';
  } catch (error) {
    if (
      error instanceof MetaGraphApiError &&
      (error.errorClass === 'auth' || error.errorClass === 'refused')
    ) {
      return 'answered';
    }
    return 'unclear';
  }
}

/**
 * The watches' work (feat-instagram-dm-sending routes-final § 6 SN6, SNC5; WC-16, WC-22, WC-24 —
 * ROUTE row R48): the all-accounts outage stop, the Live check of one account and the waiting
 * estimate of one account. The cross-organization reads and the paging are the watch processor's.
 *
 * @remarks
 * - **Algorithm:** the outage stop goes through the sending state (one row, maintenance scope); an
 *   account's Live check and estimate run in that account's organization scope (the processor mints
 *   it) — reads first, Meta outside any transaction, then one unit of writes.
 * - **Failure modes:** a database error propagates (the duty's round logs it and goes on with the
 *   next account); a Meta failure on the Live check leaves the replies waiting (the age rule and the
 *   stored ends still apply) and is logged.
 * - **Side effects:** the sending row, messages, media, the slow lane's estimate columns.
 * - **Notes:** intake and the watches never send (6.10's rules).
 */
export class InstagramSendingWatchService {
  constructor(
    private readonly dependencies: {
      sendingStateService: Pick<
        SendingStateService,
        'startAllAccountsDownStop' | 'resetQuietAllStop' | 'readAllAccountsStop' | 'mayTakeTickets'
      >;
      accessService: Pick<InstagramSendAccessService, 'readSendAccess' | 'buildUsageRecorder'>;
      messageService: Pick<InstagramOutgoingMessageService, 'expireWaitingLiveReplies'>;
      mediaService: Pick<InstagramMediaService, 'recordLiveEnded'>;
      /** The Graph read of the Lives on air (tests pass a fake). */
      listLiveMedia?: typeof listInstagramLiveMedia | undefined;
      /**
       * Runs one unit of database work in a slot of the process's `instagram-database` limiter
       * (SN24 — the repair worker's Postgres budget is the limiter's); none by default (tests).
       */
      runInDatabaseSlot?: (<T>(callback: () => Promise<T>) => Promise<T>) | undefined;
    },
  ) {}

  private inSlot<T>(callback: () => Promise<T>): Promise<T> {
    return this.dependencies.runInDatabaseSlot === undefined
      ? callback()
      : this.dependencies.runInDatabaseSlot(callback);
  }

  /**
   * The outage watch's decision (WC-22, plan §33.5 rule 3, §33.6 rule 4): the all-accounts
   * `instagram_down` stop when {@link isInstagramDownForAll} holds, and the all-stop count back to
   * the start after 24 quiet hours.
   *
   * @remarks
   * Algorithm: the reset first, then the rule; the stop starts only when none holds (the sending
   * state). Failure modes: propagates. Side effects: the sending row; a warn log on a stop.
   */
  async applyOutageReadings({
    readings,
    now = new Date(),
  }: {
    readings: InstagramOutageReadings;
    now?: Date;
  }): Promise<InstagramOutageCheckResult> {
    const isCountReset = await this.inSlot(() =>
      this.dependencies.sendingStateService.resetQuietAllStop({ now }),
    );
    let stopUntil: Date | null = null;
    if (isInstagramDownForAll(readings)) {
      stopUntil = await this.inSlot(() =>
        this.dependencies.sendingStateService.startAllAccountsDownStop({ now }),
      );
      if (stopUntil !== null) {
        logger.warn(
          { ...readings, stop_until: stopUntil.toISOString() },
          'app.instagram_watch.instagram_down_for_all',
        );
      }
    }
    return { ...readings, stopUntil, isCountReset };
  }

  /**
   * The Live check of one account (WC-16, AC-16.18, plan helper rule 10): one `GET
   * /<account>/live_media`, then the waiting Live replies of the Lives no longer on air (or older
   * than 240 minutes) end `expired` · `live_ended` and each ended Live's `live_ended_at` is saved.
   * Answers how many replies expired.
   *
   * @remarks
   * Algorithm: may this server call Meta (`mayTakeTickets`) and may the account's call go — else
   * only the age rule and the stored ends apply (no call); the Graph read outside any transaction;
   * the message service's one unit; `recordLiveEnded` per ended Live. Failure modes: a Meta failure
   * is logged and treated as "not read"; a gone account answers 0. Side effects: as the class says.
   */
  async checkLiveReplies({
    scope,
    account,
    now = new Date(),
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    account: InstagramSendingWatchAccount;
    now?: Date;
  }): Promise<number> {
    const onAirMediaIds = await this.readOnAirLives({ scope, account });
    const channelAccount = {
      organizationId: account.organizationId,
      channelAccountId: account.channelAccountId,
    };
    const { expiredCount, endedMediaIds } = await this.inSlot(() =>
      this.dependencies.messageService.expireWaitingLiveReplies({
        scope,
        ...channelAccount,
        onAirMediaIds,
        oldestCommentAt: new Date(
          now.getTime() - SETTINGS.liveReplyMaxAgeMinutes * MILLISECONDS_PER_MINUTE,
        ),
      }),
    );
    for (const instagramMediaId of endedMediaIds) {
      await this.inSlot(() =>
        this.dependencies.mediaService.recordLiveEnded({
          scope,
          channelAccount,
          instagramMediaId,
          endedAt: now,
        }),
      );
    }
    return expiredCount;
  }

  /** The Lives Instagram lists on air for the account, or `null` when not read (no call made). */
  private async readOnAirLives({
    scope,
    account,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    account: InstagramSendingWatchAccount;
  }): Promise<string[] | null> {
    if (!(await this.inSlot(() => this.dependencies.sendingStateService.mayTakeTickets()))) {
      return null;
    }
    let access: Awaited<ReturnType<InstagramSendAccessService['readSendAccess']>>;
    try {
      access = await this.inSlot(() =>
        this.dependencies.accessService.readSendAccess({
          scope,
          channelAccountPublicId: account.channelAccountPublicId,
        }),
      );
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
    if (!access.isSendable || access.encryptedAccessToken === null) return null;
    try {
      const page = await (this.dependencies.listLiveMedia ?? listInstagramLiveMedia)({
        encryptedAccessToken: access.encryptedAccessToken,
        instagramUserId: access.instagramUserId,
        limit: 50,
        recordUsage: this.dependencies.accessService.buildUsageRecorder({ scope, access }),
      });
      return page.items.map((item) => item.id);
    } catch (error) {
      logger.warn(
        {
          channel_account_public_id: account.channelAccountPublicId,
          error_name: (error as Error | null)?.name,
        },
        'app.instagram_watch.live_check_failed',
      );
      return null;
    }
  }

  /**
   * Refreshes one account's "will go / may expire" estimate on its slow lane row (WC-24, S29,
   * AC-17.24, plan §12.3) — route 63 answers it. Answers the stored estimate.
   *
   * @remarks
   * Algorithm: one unit in the account's scope — the grouped count of waiting opening DMs by hours
   * left, the account (pause, suspend, plan stop, connection), its slow lane (error stop), the
   * owner's opening hour limit (else 150 for a new account, else 600), the all-accounts stop; then
   * {@link computeInstagramWaitingEstimate} and the write. Failure modes: propagates; a gone
   * account answers `null`. Side effects: the slow lane's `estimate_*` columns.
   */
  async refreshWaitingEstimate({
    scope,
    account,
    now = new Date(),
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    account: InstagramSendingWatchAccount;
    now?: Date;
  }): Promise<InstagramWaitingEstimate | null> {
    const allStop = await this.inSlot(() =>
      this.dependencies.sendingStateService.readAllAccountsStop(now),
    );
    const key = {
      organizationId: account.organizationId,
      channelAccountId: account.channelAccountId,
    };
    return this.inSlot(() => this.estimateInUnit({ scope, account, key, allStop, now }));
  }

  /** {@link refreshWaitingEstimate}'s one unit. */
  private estimateInUnit({
    scope,
    account,
    key,
    allStop,
    now,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    account: InstagramSendingWatchAccount;
    key: { organizationId: number; channelAccountId: number };
    allStop: { until: Date } | null;
    now: Date;
  }): Promise<InstagramWaitingEstimate | null> {
    return withAppDatabaseContext({
      scope,
      callback: async (databaseHandle) => {
        const channelAccount = await new ChannelAccountRepository(databaseHandle).findById(key);
        if (channelAccount === null) return null;
        const lanes = new InstagramSendLaneRepository(databaseHandle);
        const slowLane = (await lanes.listByAccount(key)).find((lane) => lane.lane === 'slow');
        if (slowLane === undefined) return null;
        const settings = await new InstagramAccountSettingsRepository(
          databaseHandle,
        ).findByChannelAccount(key);
        const summary = await new InstagramOutgoingMessageRepository(
          databaseHandle,
        ).summarizeWaitingOpeningMessages({ ...key, now });
        const isNewAccount =
          now.getTime() - channelAccount.connected_at.getTime() <
          CHANNEL_ACCOUNT_NEW_ACCOUNT_LIMIT_DAYS * MILLISECONDS_PER_DAY;
        const hourLimit =
          settings?.opening_hour_limit ??
          (isNewAccount ? NEW_ACCOUNT_HOUR_LIMIT : OPENING_HOUR_LIMIT_DEFAULT);
        const estimate = computeInstagramWaitingEstimate({
          now,
          waitingByHoursLeft: summary.waitingByHoursLeft,
          hourLimit,
          newOpeningMessagesLastHour: summary.newLastHour,
          stop: readEstimateStop({ channelAccount, slowLane, allStop, account, now }),
          lastExpiresAt: summary.lastExpiresAt,
        });
        await lanes.writeEstimate({ key, estimate });
        return estimate;
      },
    });
  }
}

/** What stops the slow lane for the estimate (plan §12.3 steps 4 and 7). */
function readEstimateStop({
  channelAccount,
  slowLane,
  allStop,
  account,
  now,
}: {
  channelAccount: {
    connection_status: string;
    paused_at: Date | null;
    suspended_at: Date | null;
    plan_stop_reason: string | null;
  };
  slowLane: { state: string; stop_reason: string | null; stop_until: Date | null };
  allStop: { until: Date } | null;
  account: InstagramSendingWatchAccount;
  now: Date;
}): InstagramWaitingEstimateInput['stop'] {
  if (
    channelAccount.connection_status !== 'connected' ||
    channelAccount.paused_at !== null ||
    channelAccount.suspended_at !== null ||
    (channelAccount.plan_stop_reason !== null && channelAccount.plan_stop_reason !== 'plan_limit')
  ) {
    return { kind: 'endless' };
  }
  const ends: Date[] = [];
  if (planStopHoldsLane({ planStopReason: channelAccount.plan_stop_reason, lane: 'slow' })) {
    ends.push(account.monthEndsAt);
  }
  if (slowLane.stop_reason !== null) {
    if (slowLane.stop_until === null) return { kind: 'endless' };
    ends.push(slowLane.stop_until);
  }
  if (allStop !== null) ends.push(allStop.until);
  const latest = ends
    .filter((end) => end.getTime() > now.getTime())
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return latest === undefined ? { kind: 'none' } : { kind: 'until', until: latest };
}
