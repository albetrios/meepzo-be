import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_MINUTE,
} from '@/shared/constants/ttl.constants.js';
import type { MetaUsagePace } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-usage.util.js';
import { ChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { CONTACT_CHAT_WINDOW_MS } from '@/domains/app/sub-domains/contact/contact.constants.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { InstagramAccountSettingsRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { resolveInstagramEffectiveLimits } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.serializer.js';
import { INSTAGRAM_PRIVATE_REPLY_EXPIRY_MILLISECONDS } from './instagram-message/instagram-message.constants.js';
import {
  type InstagramMessagePickCandidate,
  InstagramMessageRepository,
} from './instagram-message/instagram-message.repository.js';
import type { InstagramMessageService } from './instagram-message/instagram-message.service.js';
import { isInstagramChatWindowOpen } from './instagram-message/instagram-message.util.js';
import type { InstagramSendComposeService } from './instagram-send-compose.service.js';
import type { InstagramSendLaneRow } from './instagram-send-lane.repository.js';
import {
  type InstagramPaceRandom,
  isNewCommentPlace,
  nextSlowPickPlace,
  openingBoxMilliseconds,
  planNextOpeningTurn,
} from './instagram-send-pace.util.js';
import { SLOW_LANE_SETTINGS } from './instagram-sending.constants.js';
import type {
  InstagramSendAccess,
  InstagramSendLaneRules,
  InstagramSendLaneTarget,
  InstagramSendLimits,
  InstagramSendNextTurn,
  InstagramSendPick,
  InstagramSendResult,
} from './instagram-sending.types.js';
import { enqueueInstagramSendFastMessage } from './queues/instagram-send-fast.queue.js';

/** A ticket's early arrival the turn still takes as "on time" (the queue's own delay jitter). */
const BOX_SECOND_TOLERANCE_MILLISECONDS = 50;

/** What one pick's check again decided (plan §28.1 step 7). */
type CheckAgain = 'send' | 'passed_over';

/**
 * The account's limits as its lanes read them (`resolveInstagramEffectiveLimits`): the settings row
 * and the channel account's connect time in one read; no settings row → every default.
 *
 * @remarks
 * Algorithm: one read unit. Failure modes: none of its own. Side effects: none.
 */
export async function readInstagramEffectiveLimits({
  scope,
  access,
  now,
}: {
  scope: OrganizationPrincipalDatabaseScope;
  access: InstagramSendAccess;
  now: Date;
}): Promise<ReturnType<typeof resolveInstagramEffectiveLimits>> {
  return withAppDatabaseContext({
    scope,
    callback: async () => {
      const settings = await new InstagramAccountSettingsRepository().findByChannelAccount(
        access.channelAccount,
      );
      const account = await new ChannelAccountRepository().findById(access.channelAccount);
      return resolveInstagramEffectiveLimits({
        settings: settings ?? {
          opening_hour_limit: null,
          opening_day_limit: null,
          fast_hour_limit: null,
          person_hour_limit: null,
          broadcast_hour_limit: null,
        },
        connected_at: account?.connected_at ?? now,
        now,
      });
    },
  });
}

/**
 * The slow lane's own rules (feat-instagram-dm-sending routes-final § 6.10 WC-5, § 6.A.10; plan
 * §28; D5, D8; ROUTE row R43) plugged into the send core: opening DMs as private replies to her
 * comment, one per box at a random second, at least 1.5 s apart.
 *
 * @remarks
 * - **Algorithm:** `readLimits` — the account's opening hour limit (600, ≤ 700; 150 for a new
 *   account's first 7 days) and her hour limit. `pickNextMessage` — the box second and the 1.5 s gap
 *   first (else the lane sleeps until then); then up to 5 picks: of each live automation its newest
 *   new comment (under 60 minutes) and its oldest old one, mixed 4 : 1 by the lane's `pick_count`
 *   (3 : 2 while the oldest has under 12 hours left), each checked again — past comment + 7 days −
 *   30 minutes → `expired`; she erased, opted out or excluded → `skipped`; her window open now → moved
 *   to the fast lane as a DM (its ticket added); an opening DM to her in the last 24 hours → its
 *   `not_before` moved to that + 24 h (D8). Nothing can go now → the earliest `not_before`.
 *   `composeMessage` — {@link InstagramSendComposeService}. `nextTurnAt` — the next box
 *   ({@link planNextOpeningTurn}; twice as long at half speed or Meta's 80 %).
 * - **Failure modes:** database errors propagate to the core (the ticket goes back before the
 *   claim); a failed fast ticket is logged (the repair adds it, R47).
 * - **Side effects:** the passed-over messages ended or moved (the engine told in their commit);
 *   the fast ticket.
 * - **Notes:** the core claims, gates, counts, calls, saves and stops (R42). Past comments (4.C)
 *   pick as old comments by their comment time; the once rule is the intake's (one open run per
 *   automation and person, P100).
 */
export class InstagramSlowLaneRules implements InstagramSendLaneRules {
  private readonly random: InstagramPaceRandom;
  private readonly enqueueFastMessage: typeof enqueueInstagramSendFastMessage;

  constructor(
    private readonly dependencies: {
      messageService: Pick<InstagramMessageService, 'endWaitingMessage' | 'moveMessageLane'>;
      composeService: Pick<InstagramSendComposeService, 'composeDirectMessage'>;
      /** The fast ticket of a message moved to the fast lane (tests record it). */
      enqueueFastMessage?: typeof enqueueInstagramSendFastMessage | undefined;
      random?: InstagramPaceRandom | undefined;
    },
  ) {
    this.random = dependencies.random ?? Math.random;
    this.enqueueFastMessage = dependencies.enqueueFastMessage ?? enqueueInstagramSendFastMessage;
  }

  /**
   * The opening hour limit and her hour limit (see the class).
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
    return { hourLimit: limits.opening_hour_limit, personHourLimit: limits.person_hour_limit };
  }

  /**
   * The slow lane's pick (see the class).
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
    const place = nextSlowPickPlace(lane.pick_count);
    for (let pick = 0; pick < SLOW_LANE_SETTINGS.picksPerTurn; pick += 1) {
      const candidates = await withAppDatabaseContext({
        scope,
        callback: () =>
          repository().listSlowPickCandidates({
            organizationId: target.organizationId,
            channelAccountId: target.channelAccountId,
            now,
            newSince: new Date(
              now.getTime() - SLOW_LANE_SETTINGS.newCommentMinutes * MILLISECONDS_PER_MINUTE,
            ),
          }),
      });
      const candidate = this.chooseCandidate({ ...candidates, place, now });
      if (candidate === null) {
        const nextRunAt = await withAppDatabaseContext({
          scope,
          callback: () =>
            repository().findEarliestWaitingNotBefore({
              organizationId: target.organizationId,
              channelAccountId: target.channelAccountId,
              lane: 'slow',
              now,
            }),
        });
        return { key: null, nextRunAt, waitReason: nextRunAt === null ? null : 'not_before' };
      }
      const key = {
        organizationId: target.organizationId,
        publicId: candidate.publicId,
        automationRunStartedAt: candidate.automationRunStartedAt,
      };
      if ((await this.checkAgain({ scope, target, candidate, key, now })) === 'send') {
        return { key };
      }
    }
    return {
      key: null,
      nextRunAt: new Date(now.getTime() + SLOW_LANE_SETTINGS.pickAgainMilliseconds),
      waitReason: 'box',
    };
  }

  /** The box second and the 1.5 s gap (plan §28.1 step 5, §28.3 rule 4): when, or `null` = now. */
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

  /** The mix (plan §28.2 rule 3): a new comment at places 1–4 (1–3 when urgent), else an old one. */
  private chooseCandidate({
    newest,
    oldest,
    place,
    now,
  }: {
    newest: InstagramMessagePickCandidate | null;
    oldest: InstagramMessagePickCandidate | null;
    place: number;
    now: Date;
  }): InstagramMessagePickCandidate | null {
    const isUrgent =
      oldest?.triggerOccurredAt != null &&
      oldest.triggerOccurredAt.getTime() +
        INSTAGRAM_PRIVATE_REPLY_EXPIRY_MILLISECONDS -
        now.getTime() <
        SLOW_LANE_SETTINGS.urgentHoursLeft * MILLISECONDS_PER_HOUR;
    if (isNewCommentPlace({ place, isUrgent })) return newest ?? oldest;
    return oldest ?? newest;
  }

  /** One pick's check again (plan §28.1 step 7, §28.2 rule 4): send it, or it was passed over. */
  private async checkAgain({
    scope,
    target,
    candidate,
    key,
    now,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    target: InstagramSendLaneTarget;
    candidate: InstagramMessagePickCandidate;
    key: { organizationId: number; publicId: string; automationRunStartedAt: Date };
    now: Date;
  }): Promise<CheckAgain> {
    const end = async ({
      status,
      reason,
    }: {
      status: 'skipped' | 'expired';
      reason: 'expired' | 'contact_deleted' | 'opted_out' | 'contact_excluded';
    }) => {
      await this.dependencies.messageService.endWaitingMessage({ scope, key, status, reason });
      return 'passed_over' as const;
    };
    if (
      candidate.triggerOccurredAt !== null &&
      candidate.triggerOccurredAt.getTime() + INSTAGRAM_PRIVATE_REPLY_EXPIRY_MILLISECONDS <=
        now.getTime()
    ) {
      return end({ status: 'expired', reason: 'expired' });
    }
    const message = await withAppDatabaseContext({
      scope,
      callback: () => new InstagramMessageRepository().findByKey(key),
    });
    if (message === null || message.status !== 'waiting') return 'passed_over';
    const contact = await withAppDatabaseContext({
      scope,
      callback: () =>
        new ContactRepository().findLiveById({
          organizationId: target.organizationId,
          contactId: message.contact_id,
        }),
    });
    if (contact === null) return end({ status: 'skipped', reason: 'contact_deleted' });
    if (contact.opted_out_at !== null) return end({ status: 'skipped', reason: 'opted_out' });
    if (contact.automations_off_at !== null)
      return end({ status: 'skipped', reason: 'contact_excluded' });
    if (
      isInstagramChatWindowOpen({
        lastDirectMessageReceivedAt: contact.last_direct_message_received_at,
        now,
        windowMilliseconds: CONTACT_CHAT_WINDOW_MS,
      })
    ) {
      await this.moveToFastLane({ scope, key });
      return 'passed_over';
    }
    const lastOpening = contact.last_opening_message_at;
    const personGap = SLOW_LANE_SETTINGS.personGapHours * MILLISECONDS_PER_HOUR;
    if (lastOpening !== null && lastOpening.getTime() + personGap > now.getTime()) {
      await withAppDatabaseContext({
        scope,
        callback: () =>
          new InstagramMessageRepository().delayWaiting({
            key,
            notBefore: new Date(lastOpening.getTime() + personGap),
          }),
      });
      return 'passed_over';
    }
    return 'send';
  }

  /** Her window opened (plan §27.12): the same row to the fast lane as a DM, and its ticket. */
  private async moveToFastLane({
    scope,
    key,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    key: { organizationId: number; publicId: string; automationRunStartedAt: Date };
  }): Promise<void> {
    const isMoved = await this.dependencies.messageService.moveMessageLane({
      scope,
      key,
      lane: 'fast',
      channel: 'direct',
    });
    if (!isMoved) return;
    const message = await withAppDatabaseContext({
      scope,
      callback: () => new InstagramMessageRepository().findByKey(key),
    });
    const access = await withAppDatabaseContext({
      scope,
      callback: () =>
        message === null
          ? Promise.resolve(null)
          : new ChannelAccountRepository().findById({
              organizationId: key.organizationId,
              channelAccountId: message.channel_account_id,
            }),
    });
    if (message === null || access === null) return;
    try {
      await this.enqueueFastMessage({
        organizationPublicId: scope.organizationPublicId,
        channelAccountPublicId: access.public_id,
        instagramMessagePublicId: key.publicId,
        automationRunStartedAt: key.automationRunStartedAt.toISOString(),
        tries: message.tries,
      });
    } catch (error) {
      logger.warn(
        { error_name: (error as Error | null)?.name },
        'app.instagram_send.enqueue_failed',
      );
    }
  }

  /**
   * The claimed opening DM's call (see the class).
   *
   * @remarks
   * Algorithm: {@link InstagramSendComposeService.composeDirectMessage}. Failure modes: as it.
   * Side effects: reads.
   */
  async composeMessage({
    scope,
    message,
  }: Parameters<InstagramSendLaneRules['composeMessage']>[0]) {
    return this.dependencies.composeService.composeDirectMessage({ scope, message });
  }

  /**
   * The next box after a send (see the class); a refusal or a message put back keeps the box.
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
    const isSlowed =
      pace === 'slow' ||
      (lane.half_speed_until !== null && lane.half_speed_until.getTime() > now.getTime());
    const boxMilliseconds = openingBoxMilliseconds({ hourLimit: limits.hourLimit, isSlowed });
    const isTried = result.kind === 'done' && result.status !== 'waiting';
    if (!isTried) return { nextRunAt: new Date(now.getTime() + boxMilliseconds) };
    return planNextOpeningTurn({
      boxStart: lane.box_start,
      pickCount: lane.pick_count,
      boxMilliseconds,
      now,
      random: this.random,
    });
  }
}
