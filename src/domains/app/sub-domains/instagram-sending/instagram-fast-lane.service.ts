import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { readInstagramUserProfile } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { AutomationRunRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js';
import { CONTACT_CHAT_WINDOW_MS } from '@/domains/app/sub-domains/contact/contact.constants.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import {
  INSTAGRAM_PRIVATE_REPLY_EXPIRY_MILLISECONDS,
  type InstagramMessageReason,
} from './instagram-message/instagram-message.constants.js';
import {
  type InstagramMessageKey,
  InstagramMessageRepository,
  type InstagramMessageRow,
} from './instagram-message/instagram-message.repository.js';
import type { InstagramMessageService } from './instagram-message/instagram-message.service.js';
import { isInstagramChatWindowOpen } from './instagram-message/instagram-message.util.js';
import type { InstagramSendComposeService } from './instagram-send-compose.service.js';
import { FAST_LANE_SETTINGS } from './instagram-sending.constants.js';
import type {
  InstagramFastMessageCheck,
  InstagramSendAccess,
  InstagramSendComposition,
  InstagramSendLaneRules,
  InstagramSendLaneTarget,
  InstagramSendLimits,
} from './instagram-sending.types.js';
import { readInstagramEffectiveLimits } from './instagram-slow-lane.service.js';

/** The request id the fast lane's own Meta reads carry (no HTTP request behind a ticket). */
const FAST_LANE_REQUEST_ID = 'instagram-send';

/** The ways to start on a comment whose opening DM goes back to the slow lane when her window closed. */
const SLOW_LANE_COMMENT_TRIGGERS: ReadonlySet<string> = new Set(['comment', 'ad_comment']);

/** What one check read: the message, her, and the run's way to start (one unit). */
interface FastCheckRead {
  message: InstagramMessageRow | null;
  contact: Awaited<ReturnType<ContactRepository['findLiveById']>>;
  triggerType: string | null;
}

/**
 * The fast lane's own rules (feat-instagram-dm-sending routes-final § 6.10 WC-7, plan §30; ROUTE row
 * R44) plugged into the send core: every message after the opening — answers to taps and typed text,
 * the message list with its waits, the nudge, follow checks, the email and phone questions and Live
 * private replies — one ticket per message at its `not_before`.
 *
 * @remarks
 * - **Algorithm:** `readLimits` — the account's fast hour limit (10,000 unless the owner set one) and
 *   her hour limit. `checkFastMessage` (plan §30.2 step 6) — the message still `waiting` in the fast
 *   lane; she is gone / opted out / excluded → `skipped`; a Live private reply over 240 minutes old →
 *   `expired` · `live_ended`; a nudge she answered after the hello → `cancelled` · `answered`; a
 *   private reply or a follow check needs no window; her window closed (24 h − 15 min) → a comment's
 *   opening DM back to the slow lane as a private reply while under 7 days, a Live comment's DM to a
 *   private reply in the fast lane, anything else `skipped` · `window_closed` (the engine ends a list
 *   run, keeps waiting on a nudge's hello). `composeMessage` — a follow check is a read of her
 *   `is_user_follow_business` (no answer → one more try, then "following"); every other message is
 *   {@link InstagramSendComposeService.composeDirectMessage} (files, the plain-text fallback, the
 *   default texts).
 * - **Failure modes:** database errors propagate (the core puts the ticket back); Meta's errors are
 *   the core's to classify.
 * - **Side effects:** the ended or moved messages (with today's line and the engine told, through the
 *   message service); the follow check's Meta read.
 * - **Notes:** the per-person lock, one of hers `sending` at a time, the 20 / 5 audio / organization
 *   places and `sending_count` are the claim's (`InstagramSendGateService`); the delays before each
 *   message and the ticket after a waiting save are the message service's. "Seen" after a reply is
 *   not sent yet (P36's go-live gate keeps `mark_seen` off, P412).
 */
export class InstagramFastLaneRules implements InstagramSendLaneRules {
  constructor(
    private readonly dependencies: {
      messageService: Pick<InstagramMessageService, 'endWaitingMessage' | 'moveMessageLane'>;
      composeService: Pick<InstagramSendComposeService, 'composeDirectMessage'>;
    },
  ) {}

  /**
   * The fast hour limit and her hour limit (see the class).
   *
   * @remarks
   * Algorithm: `readInstagramEffectiveLimits`. Failure modes: none. Side effects: none.
   */
  async readLimits(input: {
    scope: OrganizationPrincipalDatabaseScope;
    access: InstagramSendAccess;
    now: Date;
  }): Promise<InstagramSendLimits> {
    const limits = await readInstagramEffectiveLimits(input);
    return { hourLimit: limits.fast_hour_limit, personHourLimit: limits.person_hour_limit };
  }

  /**
   * The checks just before the claim (see the class).
   *
   * @remarks
   * Algorithm: as the class says. Failure modes: database errors propagate. Side effects: the ended
   * or moved message.
   */
  async checkFastMessage({
    scope,
    target,
    key,
    now,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    target: InstagramSendLaneTarget;
    key: InstagramMessageKey;
    now: Date;
  }): Promise<InstagramFastMessageCheck> {
    const { message, contact, triggerType } = await this.readCheck({ scope, target, key });
    if (message === null || message.status !== 'waiting' || message.lane !== 'fast') {
      return { kind: 'ended' };
    }
    const end = async ({
      status,
      reason,
    }: {
      status: 'skipped' | 'expired' | 'cancelled';
      reason: InstagramMessageReason;
    }) => {
      await this.dependencies.messageService.endWaitingMessage({ scope, key, status, reason });
      return { kind: 'ended' } as const;
    };
    if (contact === null) return end({ status: 'skipped', reason: 'contact_deleted' });
    if (contact.opted_out_at !== null) return end({ status: 'skipped', reason: 'opted_out' });
    if (contact.automations_off_at !== null)
      return end({ status: 'skipped', reason: 'contact_excluded' });
    const isLive = triggerType === 'live_comment';
    if (isLive && message.channel === 'private_reply') {
      const commentAt = message.trigger_occurred_at ?? message.created_at;
      const isTooOld =
        commentAt.getTime() +
          FAST_LANE_SETTINGS.liveReplyMaximumAgeMinutes * MILLISECONDS_PER_MINUTE <=
        now.getTime();
      return isTooOld ? end({ status: 'expired', reason: 'live_ended' }) : { kind: 'send' };
    }
    const lastHers = contact.last_direct_message_received_at;
    if (
      message.message_type === 'nudge' &&
      lastHers !== null &&
      lastHers.getTime() > message.created_at.getTime()
    ) {
      return end({ status: 'cancelled', reason: 'answered' });
    }
    if (message.channel !== 'direct') return { kind: 'send' };
    const isWindowOpen = isInstagramChatWindowOpen({
      lastDirectMessageReceivedAt: lastHers,
      now,
      windowMilliseconds: CONTACT_CHAT_WINDOW_MS,
    });
    if (isWindowOpen) return { kind: 'send' };
    return this.whenWindowClosed({ scope, key, message, triggerType, now, end });
  }

  /** Her window closed (plan §30.2 step 6): the comment's DM moves, anything else is `skipped`. */
  private async whenWindowClosed({
    scope,
    key,
    message,
    triggerType,
    now,
    end,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    key: InstagramMessageKey;
    message: InstagramMessageRow;
    triggerType: string | null;
    now: Date;
    end: (input: {
      status: 'skipped';
      reason: InstagramMessageReason;
    }) => Promise<InstagramFastMessageCheck>;
  }): Promise<InstagramFastMessageCheck> {
    if (message.message_type === 'opening_message' && triggerType === 'live_comment') {
      // A Live comment's DM becomes a private reply to it; the lane stays fast (§30.5 rule 1).
      const isMoved = await this.dependencies.messageService.moveMessageLane({
        scope,
        key,
        lane: 'fast',
        channel: 'private_reply',
      });
      return isMoved ? { kind: 'send' } : { kind: 'ended' };
    }
    const commentAt = message.trigger_occurred_at;
    if (
      message.message_type === 'opening_message' &&
      triggerType !== null &&
      SLOW_LANE_COMMENT_TRIGGERS.has(triggerType) &&
      commentAt !== null &&
      commentAt.getTime() + INSTAGRAM_PRIVATE_REPLY_EXPIRY_MILLISECONDS > now.getTime()
    ) {
      // The same row back to the slow lane as a private reply (§27.12); its turns pick it up.
      await this.dependencies.messageService.moveMessageLane({
        scope,
        key,
        lane: 'slow',
        channel: 'private_reply',
      });
      return { kind: 'ended' };
    }
    return end({ status: 'skipped', reason: 'window_closed' });
  }

  /** One read unit: the message, her live contact and the run's way to start. */
  private async readCheck({
    scope,
    target,
    key,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    target: InstagramSendLaneTarget;
    key: InstagramMessageKey;
  }): Promise<FastCheckRead> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const message = await new InstagramMessageRepository().findByKey(key);
        if (message === null) return { message, contact: null, triggerType: null };
        const contact = await new ContactRepository().findLiveById({
          organizationId: target.organizationId,
          contactId: message.contact_id,
        });
        const run =
          message.automation_run_id === null
            ? null
            : await new AutomationRunRepository().findByKey({
                organizationId: target.organizationId,
                runId: message.automation_run_id,
                runStartedAt: message.automation_run_started_at,
              });
        return { message, contact, triggerType: run?.trigger_type ?? null };
      },
    });
  }

  /**
   * The claimed message's call (see the class).
   *
   * @remarks
   * Algorithm: a follow check reads her follow; anything else
   * {@link InstagramSendComposeService.composeDirectMessage}. Failure modes: as it. Side effects:
   * reads.
   */
  async composeMessage({
    scope,
    message,
  }: Parameters<InstagramSendLaneRules['composeMessage']>[0]): Promise<InstagramSendComposition> {
    if (message.message_type !== 'follow_check') {
      return this.dependencies.composeService.composeDirectMessage({ scope, message });
    }
    const contact = await withAppDatabaseContext({
      scope,
      callback: () =>
        new ContactRepository().findLiveById({
          organizationId: message.organization_id,
          contactId: message.contact_id,
        }),
    });
    const instagramUserId = contact?.instagram_user_id ?? null;
    if (instagramUserId === null) return { kind: 'skip', reason: 'contact_deleted' };
    return {
      kind: 'send',
      uploadPublicId: null,
      call: async ({ access, recordUsage }) => {
        const profile = await readInstagramUserProfile({
          encryptedAccessToken: access.encryptedAccessToken ?? '',
          instagramScopedUserId: instagramUserId,
          requestId: FAST_LANE_REQUEST_ID,
          recordUsage,
        });
        if (profile.isUserFollowingBusiness === null) {
          // Not said: a failed try of the check (§30.9 rule 3), never a guess.
          throw new Error('instagram follow check: the follow was not shown');
        }
        return {
          instagramMessageId: null,
          reason: profile.isUserFollowingBusiness ? 'following' : 'not_following',
        };
      },
    };
  }
}
