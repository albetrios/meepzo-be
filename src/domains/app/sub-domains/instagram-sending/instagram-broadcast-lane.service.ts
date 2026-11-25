import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_MINUTE,
} from '@/shared/constants/ttl.constants.js';
import type { MetaUsagePace } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-usage.util.js';
import { BROADCAST_ACTIVE_STATUSES } from '@/domains/app/sub-domains/broadcast/broadcast.constants.js';
import { CONTACT_CHAT_WINDOW_MS } from '@/domains/app/sub-domains/contact/contact.constants.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import type { InstagramMessageReason } from './instagram-message/instagram-message.constants.js';
import {
  type InstagramBroadcastPickCandidate,
  InstagramMessageRepository,
} from './instagram-message/instagram-message.repository.js';
import type { InstagramMessageService } from './instagram-message/instagram-message.service.js';
import { isInstagramChatWindowOpen } from './instagram-message/instagram-message.util.js';
import type { InstagramSendComposeService } from './instagram-send-compose.service.js';
import type { InstagramSendLaneRow } from './instagram-send-lane.repository.js';
import {
  broadcastBoxMilliseconds,
  type InstagramPaceRandom,
  planNextOpeningTurn,
} from './instagram-send-pace.util.js';
import { BROADCAST_LANE_SETTINGS, SLOW_LANE_SETTINGS } from './instagram-sending.constants.js';
import type {
  InstagramSendAccess,
  InstagramSendLaneRules,
  InstagramSendLaneTarget,
  InstagramSendLimits,
  InstagramSendMessageKey,
  InstagramSendNextTurn,
  InstagramSendPick,
  InstagramSendResult,
} from './instagram-sending.types.js';
import { readInstagramEffectiveLimits } from './instagram-slow-lane.service.js';

/** A ticket's early arrival the turn still takes as "on time" (the queue's own delay jitter). */
const BOX_SECOND_TOLERANCE_MILLISECONDS = 50;

/** How one pick's check again ends a message for good (plan §30.14 step 7). */
interface BroadcastEnding {
  status: 'skipped' | 'cancelled';
  reason: InstagramMessageReason;
}

/**
 * The broadcast lane's own rules (feat-instagram-dm-sending routes-final § 6.10 WC-8, § 6.A.10;
 * plan §30.14, §11.7; D68, P3; ROUTE row R45) plugged into the send core: broadcast messages (PRO)
 * one at a time, at a random second in each box, behind the account's other lanes.
 *
 * @remarks
 * - **Algorithm:** `readLimits` — the account's broadcast hour limit (600, ≤ 2,000; gate 2 counts
 *   the `broadcast` group) and her hour limit. `pickNextMessage` — the box second and the 1.5 s gap
 *   first (else the lane sleeps until then); then up to 5 waiting broadcast messages whose
 *   `not_before` is over, her window closing soonest first, across the account's broadcasts, each
 *   checked again — the broadcast no longer active → message `cancelled`, recipient `skipped`, both
 *   `broadcast_cancelled`; she erased, opted out or excluded → `skipped`; her window closed (24 h −
 *   15 min) → `skipped` · `window_closed`; message 1 to her within 24 h of her last broadcast →
 *   `skipped` · `recent_broadcast`; her hour limit full → `not_before` 5 minutes later. Nothing can go
 *   now → the earliest `not_before`. `composeMessage` —
 *   {@link InstagramSendComposeService.composeBroadcastMessage}. `nextTurnAt` — the next box
 *   ({@link planNextOpeningTurn} over {@link broadcastBoxMilliseconds}; twice as long at half speed
 *   or Meta's 80 %).
 * - **Failure modes:** database errors propagate to the core (the ticket goes back before the
 *   claim).
 * - **Side effects:** the passed-over messages ended or delayed (their recipients settled in the
 *   same commit through the result port).
 * - **Notes:** the core claims (her contact skip locked, gate 2 of the `broadcast` group, her hour,
 *   the month — a broadcast message is a DM; P3: the month's `plan_limit` holds this lane), calls,
 *   saves — her `last_broadcast_at` and the recipient in the save's commit, message N + 1 after a
 *   `sent` N — and stops (a too fast here twice as long; the slow or fast lane's too fast holds this
 *   lane too). The lowest priority is the ticket's (`INSTAGRAM_BROADCAST_TURN_PRIORITY`). The
 *   `owner_chat` re-check of a "when her chat opens" broadcast is left to intake's hook (R47): no
 *   row keeps the owner's last typed time yet.
 */
export class InstagramBroadcastLaneRules implements InstagramSendLaneRules {
  private readonly random: InstagramPaceRandom;

  constructor(
    private readonly dependencies: {
      messageService: Pick<InstagramMessageService, 'endWaitingMessage'>;
      composeService: Pick<InstagramSendComposeService, 'composeBroadcastMessage'>;
      random?: InstagramPaceRandom | undefined;
    },
  ) {
    this.random = dependencies.random ?? Math.random;
  }

  /**
   * The broadcast hour limit and her hour limit (see the class).
   *
   * @remarks
   * Algorithm: {@link readInstagramEffectiveLimits}. Failure modes: none. Side effects: none.
   */
  async readLimits(input: {
    scope: OrganizationPrincipalDatabaseScope;
    access: InstagramSendAccess;
    now: Date;
  }): Promise<InstagramSendLimits> {
    const limits = await readInstagramEffectiveLimits(input);
    return { hourLimit: limits.broadcast_hour_limit, personHourLimit: limits.person_hour_limit };
  }

  /**
   * The broadcast lane's pick (see the class).
   *
   * @remarks
   * Algorithm: as the class says. Failure modes: database errors propagate. Side effects: the
   * passed-over messages.
   */
  async pickNextMessage({
    scope,
    target,
    lane,
    now,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    target: InstagramSendLaneTarget;
    lane: InstagramSendLaneRow;
    now: Date;
    isTest: boolean;
    pace: MetaUsagePace;
  }): Promise<InstagramSendPick> {
    const notYet = this.boxSecondNotReached({ lane, now });
    if (notYet !== null) return { key: null, nextRunAt: notYet, waitReason: 'box' };
    const repository = () => new InstagramMessageRepository();
    const candidates = await withAppDatabaseContext({
      scope,
      callback: () =>
        repository().listBroadcastPickCandidates({
          organizationId: target.organizationId,
          channelAccountId: target.channelAccountId,
          now,
          limit: SLOW_LANE_SETTINGS.picksPerTurn,
        }),
    });
    const personHourLimit =
      candidates.length === 0
        ? 0
        : (
            await readInstagramEffectiveLimits({
              scope,
              access: {
                channelAccount: {
                  organizationId: target.organizationId,
                  channelAccountId: target.channelAccountId,
                },
              },
              now,
            })
          ).person_hour_limit;
    for (const candidate of candidates) {
      const key: InstagramSendMessageKey = {
        organizationId: target.organizationId,
        publicId: candidate.publicId,
        automationRunStartedAt: candidate.automationRunStartedAt,
      };
      if (await this.isSendable({ scope, target, candidate, key, personHourLimit, now })) {
        return { key };
      }
    }
    if (candidates.length === SLOW_LANE_SETTINGS.picksPerTurn) {
      return {
        key: null,
        nextRunAt: new Date(now.getTime() + SLOW_LANE_SETTINGS.pickAgainMilliseconds),
        waitReason: 'box',
      };
    }
    const nextRunAt = await withAppDatabaseContext({
      scope,
      callback: () =>
        repository().findEarliestWaitingNotBefore({
          organizationId: target.organizationId,
          channelAccountId: target.channelAccountId,
          lane: 'broadcast',
          now,
        }),
    });
    return { key: null, nextRunAt, waitReason: nextRunAt === null ? null : 'not_before' };
  }

  /** The box second and the 1.5 s gap (plan §30.14 step 5): when, or `null` = now. */
  private boxSecondNotReached({
    lane,
    now,
  }: {
    lane: InstagramSendLaneRow;
    now: Date;
  }): Date | null {
    const gapEnd =
      lane.last_sent_at === null
        ? 0
        : lane.last_sent_at.getTime() + SLOW_LANE_SETTINGS.minimumGapMilliseconds;
    const boxSecond = lane.next_run_at?.getTime() ?? 0;
    const due = Math.max(gapEnd, boxSecond);
    return due > now.getTime() + BOX_SECOND_TOLERANCE_MILLISECONDS ? new Date(due) : null;
  }

  /**
   * One pick's check again (plan §30.14 step 7): `true` = send it; `false` = it was ended, delayed
   * or is gone.
   */
  private async isSendable({
    scope,
    target,
    candidate,
    key,
    personHourLimit,
    now,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    target: InstagramSendLaneTarget;
    candidate: InstagramBroadcastPickCandidate;
    key: InstagramSendMessageKey;
    /** Her hour limit (`person_hour_limit`, 60 by default). */
    personHourLimit: number;
    now: Date;
  }): Promise<boolean> {
    const contact = await withAppDatabaseContext({
      scope,
      callback: () =>
        new ContactRepository().findLiveById({
          organizationId: target.organizationId,
          contactId: candidate.contactId,
        }),
    });
    const ending = this.endingOf({ candidate, contact, now });
    if (ending !== null) {
      await this.dependencies.messageService.endWaitingMessage({ scope, key, ...ending });
      return false;
    }
    const hers = await withAppDatabaseContext({
      scope,
      callback: () =>
        new InstagramMessageRepository().countSentToContactInLastHour({
          organizationId: target.organizationId,
          contactId: candidate.contactId,
        }),
    });
    if (hers < personHourLimit) return true;
    await withAppDatabaseContext({
      scope,
      callback: () =>
        new InstagramMessageRepository().delayWaiting({
          key,
          notBefore: new Date(
            now.getTime() +
              BROADCAST_LANE_SETTINGS.personLimitRetryMinutes * MILLISECONDS_PER_MINUTE,
          ),
        }),
    });
    return false;
  }

  /** The check again's ending for her and the broadcast, or `null` when the message may go. */
  private endingOf({
    candidate,
    contact,
    now,
  }: {
    candidate: InstagramBroadcastPickCandidate;
    contact: Awaited<ReturnType<ContactRepository['findLiveById']>>;
    now: Date;
  }): BroadcastEnding | null {
    if (!(BROADCAST_ACTIVE_STATUSES as readonly string[]).includes(candidate.broadcastStatus)) {
      return { status: 'cancelled', reason: 'broadcast_cancelled' };
    }
    if (contact === null) return { status: 'skipped', reason: 'contact_deleted' };
    if (contact.opted_out_at !== null) return { status: 'skipped', reason: 'opted_out' };
    if (contact.automations_off_at !== null) {
      return { status: 'skipped', reason: 'contact_excluded' };
    }
    if (
      !isInstagramChatWindowOpen({
        lastDirectMessageReceivedAt: contact.last_direct_message_received_at,
        now,
        windowMilliseconds: CONTACT_CHAT_WINDOW_MS,
      })
    ) {
      return { status: 'skipped', reason: 'window_closed' };
    }
    const lastBroadcast = contact.last_broadcast_at;
    const gap = BROADCAST_LANE_SETTINGS.personGapHours * MILLISECONDS_PER_HOUR;
    // Messages 2–3 follow message 1 of the same broadcast (plan §30.14 step 11): the gap is
    // between two broadcasts, so only message 1 checks it.
    if (
      candidate.messageNumber === 1 &&
      lastBroadcast !== null &&
      lastBroadcast.getTime() + gap > now.getTime()
    ) {
      return { status: 'skipped', reason: 'recent_broadcast' };
    }
    return null;
  }

  /**
   * The claimed broadcast message's call (see the class).
   *
   * @remarks
   * Algorithm: {@link InstagramSendComposeService.composeBroadcastMessage}. Failure modes: as it.
   * Side effects: reads.
   */
  async composeMessage({
    scope,
    message,
  }: Parameters<InstagramSendLaneRules['composeMessage']>[0]) {
    return this.dependencies.composeService.composeBroadcastMessage({ scope, message });
  }

  /**
   * The next box after a send (see the class); a refusal looks again a second later; a message put
   * back keeps the box.
   *
   * @remarks
   * Algorithm: as the class says. Failure modes: none. Side effects: none.
   */
  nextTurnAt({
    lane,
    result,
    pace,
    limits,
    now,
  }: {
    lane: InstagramSendLaneRow;
    result: InstagramSendResult;
    pace: MetaUsagePace;
    limits: InstagramSendLimits;
    now: Date;
  }): InstagramSendNextTurn {
    if (result.kind === 'refused') {
      return { nextRunAt: new Date(now.getTime() + SLOW_LANE_SETTINGS.pickAgainMilliseconds) };
    }
    const isSlowed =
      pace === 'slow' ||
      (lane.half_speed_until !== null && lane.half_speed_until.getTime() > now.getTime());
    const boxMilliseconds = broadcastBoxMilliseconds({ hourLimit: limits.hourLimit, isSlowed });
    if (result.status === 'waiting')
      return { nextRunAt: new Date(now.getTime() + boxMilliseconds) };
    const { pickCount: _pickCount, ...next } = planNextOpeningTurn({
      boxStart: lane.box_start,
      pickCount: lane.pick_count,
      boxMilliseconds,
      now,
      random: this.random,
    });
    return next;
  }
}
