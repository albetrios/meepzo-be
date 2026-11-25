import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  type RequestScopedPostgresDatabase,
  setLocalDatabaseConfig,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { runEnqueueAfterCommit } from '@/core/events/event-bus.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { MILLISECONDS_PER_HOUR } from '@/shared/constants/ttl.constants.js';
import { ChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import {
  CHANNEL_ACCOUNT_CHANNELS,
  CHANNEL_ACCOUNT_PLAN_STOP_REASON,
} from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import {
  type InstagramMessageKey,
  InstagramMessageRepository,
  type InstagramMessageRow,
} from './instagram-message/instagram-message.repository.js';
import {
  type InstagramSendAttemptKey,
  InstagramSendAttemptRepository,
} from './instagram-message/instagram-send-attempt.repository.js';
import type {
  InstagramMessageChannel,
  InstagramSendAttemptCountGroup,
} from './instagram-message/instagram-message.constants.js';
import {
  InstagramSendLaneRepository,
  type InstagramSendLaneRow,
} from './instagram-send-lane.repository.js';
import { InstagramSendMinuteCountRepository } from './instagram-send-minute-count.repository.js';
import { MessageMonthCountRepository } from './message-month-count.repository.js';
import { invalidateCachedMessageMonthCount } from './message-month-count.cache.js';
import type { InstagramSendLaneService } from './instagram-send-lane.service.js';
import {
  FAST_LANE_SETTINGS,
  INSTAGRAM_SEND_CORE_SETTINGS,
  INSTAGRAM_SEND_FAST_SENDING_MAX,
  type InstagramSendLane,
} from './instagram-sending.constants.js';

/** Logical key prefix of gate 1's per-account, per-group sorted set (SN3). */
const GATE_ONE_KEY_PREFIX = 'app:instagram_send_gate';

/** Gate 1's key, built from the verified job scope and the account's public id (SN3). */
function gateOneKey({
  organizationPublicId,
  channelAccountPublicId,
  countGroup,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  countGroup: InstagramSendAttemptCountGroup;
}): string {
  return `${GATE_ONE_KEY_PREFIX}:${organizationPublicId}:${channelAccountPublicId}:${countGroup}`;
}

/**
 * What the claim's one commit is asked to do (SN3).
 *
 * @remarks
 * Notes: the limits are read before the commit (the lane's settings, billing's plan).
 */
export interface InstagramSendClaimInput {
  scope: OrganizationPrincipalDatabaseScope;
  key: InstagramMessageKey;
  lane: InstagramSendLane;
  channel: InstagramMessageChannel | null;
  countGroup: InstagramSendAttemptCountGroup;
  /** Gate 2's hour limit of the group (the lane's, from the account's settings). */
  hourLimit: number;
  /** Her limit an hour (`person_hour_limit`); `null` = not checked (not a DM). */
  personHourLimit: number | null;
  /** The plan's `message_month_limit`, read before the commit; `null` = no limit. */
  monthLimit: number | null;
}

/**
 * The claim's answer (SN3): claimed, or why the message stays `waiting`.
 *
 * @remarks
 * Notes: a refusal changed nothing but, for `month_limit`, the plan stop.
 */
export type InstagramSendClaim =
  | {
      kind: 'claimed';
      message: InstagramMessageRow;
      attempt: InstagramSendAttemptKey;
      /** The month reached the limit with this message (its plan stop started, SN8). */
      isMonthLimitReached: boolean;
    }
  | {
      kind: 'refused';
      reason: 'gone' | 'hour_limit' | 'person_limit' | 'month_limit' | 'person_busy' | 'fast_busy';
    };

/**
 * The two gates and the month count of a send (feat-instagram-dm-sending routes-final § 6 SN3, SN8,
 * SNC3, SNC7): gate 1 in Redis (advisory), then one Postgres commit that checks gate 2, her hour
 * limit and the month, adds to the minute and month counts, marks the message `sending` and starts
 * its attempt.
 *
 * @remarks
 * - **Algorithm:** gate 1 — a sorted set per account and count group of the last hour's claims
 *   (100 ms timeout; after 3 timeouts in a row skipped for 30 s; never inside a transaction). The
 *   claim — one unit with `lock_timeout` 1 s and `statement_timeout` 5 s: a fast or broadcast
 *   message first takes her contact (`NO KEY UPDATE SKIP LOCKED`, plan §30.14 step 6) and a fast one
 *   finds none of hers `sending` (else `person_busy`, plan §30.2 steps 2, 5); the lane row locked (two
 *   claims of one account and group never check and add at once), the message still `waiting` in
 *   this lane and channel, the fast places — the account's 20 `sending`, 5 audio, the organization's
 *   25 (S21; else `fast_busy`) — gate 2 (the 61 minute rows of the group against the hour limit), her
 *   sent messages of the last hour, the month's 16 slots against the plan's limit (a DM only), the
 *   adds, `sending` (a fast one + 1 on `sending_count`), the attempt. A DM that fills the month starts the organization's `plan_limit`
 *   in the same commit (SN8: slow, fast and broadcast lanes stop; the reply lane goes on).
 * - **Failure modes:** gate 1 fails open (Postgres decides, P32); database errors roll the claim back
 *   (nothing was sent, the ticket goes back).
 * - **Side effects:** the claim's rows; after commit the month's Redis copy is tombstoned and gate 1
 *   records the claim.
 * - **Notes:** the month at 80 % and 100 % notices and emails are WC-56's (ROUTE row R53).
 */
export class InstagramSendGateService {
  private gateOneTimeoutsInARow = 0;
  private gateOneSkippedUntil = 0;

  constructor(
    private readonly options: {
      laneService: Pick<InstagramSendLaneService, 'recordPlanStop'>;
      /** Gate 1's Redis (the cache connection); `null` skips gate 1 (Postgres decides). */
      redis?: Redis | null | undefined;
    },
  ) {}

  private redis(): Redis | null {
    return this.options.redis === undefined ? redisConnection : this.options.redis;
  }

  /** Runs one gate-1 Redis step within its timeout; a timeout or error answers `null`. */
  private async withGateOneTimeout<T>(step: (redis: Redis) => Promise<T>): Promise<T | null> {
    const redis = this.redis();
    if (redis === null || Date.now() < this.gateOneSkippedUntil) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        step(redis),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(
            () => resolve('timeout'),
            INSTAGRAM_SEND_CORE_SETTINGS.gateOneTimeoutMilliseconds,
          );
        }),
      ]);
      if (answer === 'timeout') {
        this.gateOneTimeoutsInARow += 1;
        if (this.gateOneTimeoutsInARow >= INSTAGRAM_SEND_CORE_SETTINGS.gateOneTimeoutsBeforeSkip) {
          this.gateOneSkippedUntil =
            Date.now() + INSTAGRAM_SEND_CORE_SETTINGS.gateOneSkipMilliseconds;
          this.gateOneTimeoutsInARow = 0;
          logger.warn({}, 'app.instagram_send.gate_one_skipped');
        }
        return null;
      }
      this.gateOneTimeoutsInARow = 0;
      return answer;
    } catch (error) {
      logger.warn(
        { error_name: (error as Error | null)?.name },
        'app.instagram_send.gate_one_failed',
      );
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Gate 1 (SN3): whether the group's claims of the last hour in Redis are under the hour limit — an
   * advisory look that only saves a wasted claim. Fails open.
   *
   * @remarks
   * Algorithm: drop members older than an hour, count. Failure modes: a timeout or Redis error
   * answers `true`. Side effects: the prune.
   */
  async passGateOne({
    scope,
    channelAccountPublicId,
    countGroup,
    hourLimit,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
    countGroup: InstagramSendAttemptCountGroup;
    hourLimit: number;
  }): Promise<boolean> {
    if (countGroup === 'none') return true;
    const key = gateOneKey({
      organizationPublicId: scope.organizationPublicId,
      channelAccountPublicId,
      countGroup,
    });
    const count = await this.withGateOneTimeout(async (redis) => {
      await redis.zremrangebyscore(key, 0, Date.now() - MILLISECONDS_PER_HOUR);
      return redis.zcard(key);
    });
    return count === null || count < hourLimit;
  }

  /**
   * Records one committed claim in gate 1 (SN3), after the claim's commit.
   *
   * @remarks
   * Algorithm: one member at now, the key kept an hour. Failure modes: none (fails open, logged).
   * Side effects: the Redis key.
   */
  async recordGateOne({
    scope,
    channelAccountPublicId,
    countGroup,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
    countGroup: InstagramSendAttemptCountGroup;
  }): Promise<void> {
    if (countGroup === 'none') return;
    const key = gateOneKey({
      organizationPublicId: scope.organizationPublicId,
      channelAccountPublicId,
      countGroup,
    });
    const now = Date.now();
    await this.withGateOneTimeout(async (redis) => {
      await redis.zadd(key, now, `${String(now)}-${randomUUID()}`);
      await redis.pexpire(key, MILLISECONDS_PER_HOUR);
    });
  }

  /**
   * The claim's one commit (SN3 (a)–(d), SN8): gate 2, her hour, the month, the adds, `sending` and
   * the attempt — or why the message stays `waiting`.
   *
   * @remarks
   * Algorithm: as the class says. Failure modes: database errors roll it back. Side effects: the
   * rows; the month's copy tombstoned after commit.
   */
  async claimSend(input: InstagramSendClaimInput): Promise<InstagramSendClaim> {
    return withAppDatabaseContext({
      scope: input.scope,
      callback: async (databaseHandle) => {
        await setLocalDatabaseConfig({ databaseHandle, key: 'lock_timeout', value: '1s' });
        await setLocalDatabaseConfig({ databaseHandle, key: 'statement_timeout', value: '5s' });
        return this.claimInUnit({ input, databaseHandle });
      },
    });
  }

  /** {@link claimSend}'s unit. */
  private async claimInUnit({
    input,
    databaseHandle,
  }: {
    input: InstagramSendClaimInput;
    databaseHandle: RequestScopedPostgresDatabase;
  }): Promise<InstagramSendClaim> {
    const messages = new InstagramMessageRepository(databaseHandle);
    const found = await messages.findByKey(input.key);
    if (found === null || found.status !== 'waiting' || found.lane !== input.lane) {
      return { kind: 'refused', reason: 'gone' };
    }
    const account = {
      organizationId: found.organization_id,
      channelAccountId: found.channel_account_id,
    };
    const lanes = new InstagramSendLaneRepository(databaseHandle);
    if (input.lane === 'fast' || input.lane === 'broadcast') {
      // Her contact, skip locked (plan §30.2 step 7, §30.14 step 6): another claim of hers now →
      // the next pick.
      const isHers = await new ContactRepository(databaseHandle).lockForFastSend({
        organizationId: found.organization_id,
        contactId: found.contact_id,
      });
      if (!isHers) return { kind: 'refused', reason: 'person_busy' };
    }
    if (input.lane === 'fast') {
      const hersSending = await messages.countFastSending({
        organizationId: found.organization_id,
        contactId: found.contact_id,
      });
      if (hersSending > 0) return { kind: 'refused', reason: 'person_busy' };
    }
    const laneRow = await lanes.lockLane({ ...account, lane: input.lane });
    if (input.lane === 'fast' && laneRow !== null) {
      const isBusy = await this.isFastLaneBusy({ found, laneRow, lanes, messages });
      if (isBusy) return { kind: 'refused', reason: 'fast_busy' };
    }
    const minutes = new InstagramSendMinuteCountRepository(databaseHandle);
    const hourRefusal = await this.hourLimitRefusal({ input, found, messages, minutes });
    if (hourRefusal !== null) return { kind: 'refused', reason: hourRefusal };
    const isCounted = found.is_counted_as_direct_message;
    const month = new MessageMonthCountRepository(databaseHandle);
    let isMonthLimitReached = false;
    if (isCounted && input.monthLimit !== null) {
      const used = (await month.readMonth(found.organization_id))?.used ?? 0;
      if (used >= input.monthLimit) {
        await this.startPlanLimit({ scope: input.scope, organizationId: found.organization_id });
        return { kind: 'refused', reason: 'month_limit' };
      }
      isMonthLimitReached = used + 1 >= input.monthLimit;
    }
    if (input.countGroup !== 'none') {
      await minutes.addToMinute({ ...account, countGroup: input.countGroup, count: 1 });
    }
    if (isCounted) {
      await month.addToMonth({ ...account, count: 1 });
      await runEnqueueAfterCommit(() =>
        invalidateCachedMessageMonthCount(input.scope.organizationPublicId),
      );
    }
    const message = await messages.claimWaiting({
      key: input.key,
      lane: input.lane,
      channel: input.channel,
    });
    if (message === null) return { kind: 'refused', reason: 'gone' };
    if (input.lane === 'fast') await lanes.addToSendingCount({ ...account, delta: 1 });
    const attempt = await new InstagramSendAttemptRepository(databaseHandle).start({
      ...account,
      messageId: message.id,
      automationId: message.automation_id,
      contactId: message.contact_id,
      lane: input.lane,
      countGroup: input.countGroup,
    });
    if (isMonthLimitReached) {
      await this.startPlanLimit({ scope: input.scope, organizationId: found.organization_id });
    }
    return { kind: 'claimed', message, attempt, isMonthLimitReached };
  }

  /**
   * {@link claimInUnit}'s fast places (plan §30.2 step 8, S21): the account's 20 `sending`, its 5
   * audio messages, and the organization's cap across its accounts.
   */
  private async isFastLaneBusy({
    found,
    laneRow,
    lanes,
    messages,
  }: {
    found: InstagramMessageRow;
    laneRow: InstagramSendLaneRow;
    lanes: InstagramSendLaneRepository;
    messages: InstagramMessageRepository;
  }): Promise<boolean> {
    if (laneRow.sending_count >= INSTAGRAM_SEND_FAST_SENDING_MAX) return true;
    if (found.message_kind === 'audio') {
      const audioSending = await messages.countFastSending({
        organizationId: found.organization_id,
        channelAccountId: found.channel_account_id,
        messageKind: 'audio',
      });
      if (audioSending >= FAST_LANE_SETTINGS.audioSendingMax) return true;
    }
    const organizationSending = await lanes.sumOrganizationSendingCount(found.organization_id);
    return organizationSending >= FAST_LANE_SETTINGS.organizationSendingMax;
  }

  /**
   * {@link claimInUnit}'s hour checks: the account's count group over its last-hour limit
   * (`hour_limit`), else a counted DM over the person's last-hour limit (`person_limit`), else `null`.
   */
  private async hourLimitRefusal({
    input,
    found,
    messages,
    minutes,
  }: {
    input: InstagramSendClaimInput;
    found: InstagramMessageRow;
    messages: InstagramMessageRepository;
    minutes: InstagramSendMinuteCountRepository;
  }): Promise<'hour_limit' | 'person_limit' | null> {
    if (input.countGroup !== 'none') {
      const lastHour = await minutes.sumLastHour({
        organizationId: found.organization_id,
        channelAccountId: found.channel_account_id,
        countGroup: input.countGroup,
      });
      if (lastHour >= input.hourLimit) return 'hour_limit';
    }
    if (found.is_counted_as_direct_message && input.personHourLimit !== null) {
      const hers = await messages.countSentToContactInLastHour({
        organizationId: found.organization_id,
        contactId: found.contact_id,
      });
      if (hers >= input.personHourLimit) return 'person_limit';
    }
    return null;
  }

  /**
   * The organization's month is full (SN8, D34): `plan_limit` on each of its live accounts that has
   * no plan stop yet, with its history row — in the caller's unit. A turn reads the account's plan
   * stop, so the slow, fast and broadcast lanes hold and the reply lane goes on (D62).
   */
  private async startPlanLimit({
    scope,
    organizationId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
  }): Promise<void> {
    const accounts = new ChannelAccountRepository();
    const live = await accounts.listLive({ organizationId, channels: CHANNEL_ACCOUNT_CHANNELS });
    for (const account of live) {
      if (account.plan_stop_reason !== null) continue;
      const changed = await accounts.setPlanStop({
        organizationId,
        channelAccountId: account.id,
        reason: CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_LIMIT,
      });
      if (changed === null) continue;
      await this.options.laneService.recordPlanStop({
        scope,
        organizationId,
        channelAccountId: account.id,
        planStopReason: CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_LIMIT,
      });
    }
  }
}
