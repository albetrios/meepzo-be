import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { MetaUsagePace } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-usage.util.js';
import {
  hideInstagramComment,
  replyToInstagramComment,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { AutomationRepository } from '@/domains/app/sub-domains/automation/automation.repository.js';
import { AUTOMATION_PUBLIC_REPLY_HOUR_LIMIT_DEFAULT } from '@/domains/app/sub-domains/automation/automation.constants.js';
import type { AutomationReplyStateService } from '@/domains/app/sub-domains/automation/automation-reply-state.service.js';
import { AutomationRunRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { INSTAGRAM_COMMENT_REPLY_EXPIRY_MILLISECONDS } from './instagram-message/instagram-message.constants.js';
import {
  type InstagramMessagePickCandidate,
  InstagramMessageRepository,
} from './instagram-message/instagram-message.repository.js';
import type { InstagramMessageService } from './instagram-message/instagram-message.service.js';
import { callWithCommentCheck } from './instagram-send-compose.service.js';
import type { InstagramSendLaneRow } from './instagram-send-lane.repository.js';
import {
  type InstagramPaceRandom,
  pickReplyLineNumber,
  replyBoxMilliseconds,
  replyBoxOffsetMilliseconds,
} from './instagram-send-pace.util.js';
import { REPLY_LANE_SETTINGS, SLOW_LANE_SETTINGS } from './instagram-sending.constants.js';
import type {
  InstagramSendComposition,
  InstagramSendLaneRules,
  InstagramSendLaneTarget,
  InstagramSendLimits,
  InstagramSendMessageKey,
  InstagramSendNextTurn,
  InstagramSendPick,
  InstagramSendResult,
} from './instagram-sending.types.js';

/** The request id the reply lane's Meta calls carry. */
const REPLY_REQUEST_ID = 'instagram-reply';

/** A reply candidate and whether its send is paced ("Reply like a person" ON). */
interface ReplyChoice {
  candidate: InstagramMessagePickCandidate;
  isPaced: boolean;
}

/**
 * The reply lane's own rules (feat-instagram-dm-sending routes-final § 6.10 WC-6, § 6.A.10; plan
 * §29; D32, D33, D57, P134; ROUTE row R43) plugged into the send core: public replies and hides, one
 * call at a time, only after the DM of that comment went (the engine makes them then, R14).
 *
 * @remarks
 * - **Algorithm:** `readLimits` — no account hour limit (gate 2 only counts the `reply` group).
 *   `pickNextMessage` — first the oldest hide or unpaced reply that may go ("Reply like a person"
 *   OFF, or a plan without it: right away, no box, no gap; a hide only after its run's reply ended);
 *   else, of each "Reply like a person" automation, its newest waiting reply once its box second is
 *   reached (the automation's box 3600 ÷ its hour limit — 10–100, default 60 — the second hashed
 *   from the automation and the box start, the box twice as long at Meta's 80 % or half speed) and
 *   20 s have passed since the account's last paced reply; its box moves to the next one as it is
 *   picked (a box whose time is over starts again now). Each pick is checked again: past its comment
 *   + 7 days → `expired` (`reply_too_old`); she excluded → `skipped`. `composeMessage` — a reply: one
 *   of the automation's lines at random, never the last one used (only the first on a plan without
 *   PRO), `@username` first when the automation says so; the reply state's last line and waiting
 *   count written; a hide: `POST /{comment}?hide=true`. Both check a maybe-gone comment before a
 *   `deleted_comment` (§33.7). `nextTurnAt` — at once (the next pick finds the next due time); a
 *   paced send moves the lane's `last_sent_at` (the gap's clock).
 * - **Failure modes:** database errors propagate to the core; Meta's error is the call's.
 * - **Side effects:** the passed-over rows ended (the engine told in their commit) and the reply
 *   states' box, line and waiting count.
 * - **Notes:** the 500-waiting trim is the repair's (WC-18, R47); the 80 % draw and the duplicate
 *   rule are the engine's (P134). A failed hide changes nothing else (`hide_failed` never counts in
 *   a row).
 */
export class InstagramReplyLaneRules implements InstagramSendLaneRules {
  private readonly random: InstagramPaceRandom;

  constructor(
    private readonly dependencies: {
      messageService: Pick<InstagramMessageService, 'endWaitingMessage'>;
      replyStateService: Pick<AutomationReplyStateService, 'lockReplyState' | 'saveReplyState'>;
      /**
       * The one feature check (CA11, P50) for `reply_like_person` on the account: the plan's switch
       * (D57 — without it every reply goes as OFF).
       */
      canUseReplyLikePerson(input: InstagramSendLaneTarget): Promise<boolean>;
      random?: InstagramPaceRandom | undefined;
    },
  ) {
    this.random = dependencies.random ?? Math.random;
  }

  /**
   * No account hour limit (plan §29.5 rule 1): gate 2 counts the replies only.
   *
   * @remarks
   * Pure. Failure modes: none. Side effects: none.
   */
  async readLimits(): Promise<InstagramSendLimits> {
    return { hourLimit: REPLY_LANE_SETTINGS.hourLimitForCounting, personHourLimit: null };
  }

  /** Whether the account may use "Reply like a person" (D57: without it every reply goes as OFF). */
  private async isReplyLikePersonOffered(target: InstagramSendLaneTarget): Promise<boolean> {
    return this.dependencies.canUseReplyLikePerson(target);
  }

  /**
   * The reply lane's pick (see the class).
   *
   * @remarks
   * Algorithm: as the class says. Failure modes: database errors propagate. Side effects: the
   * passed-over rows and the picked automation's box.
   */
  async pickNextMessage({
    scope,
    target,
    lane,
    now,
    pace,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    target: InstagramSendLaneTarget;
    lane: InstagramSendLaneRow;
    now: Date;
    isTest: boolean;
    pace: MetaUsagePace;
  }): Promise<InstagramSendPick> {
    const isOffered = await this.isReplyLikePersonOffered(target);
    const isSlowed =
      pace === 'slow' ||
      (lane.half_speed_until !== null && lane.half_speed_until.getTime() > now.getTime());
    let pacedReadyAt: Date | null = null;
    for (let pick = 0; pick < SLOW_LANE_SETTINGS.picksPerTurn; pick += 1) {
      const choice = await this.chooseReply({ scope, target, lane, now, isOffered, isSlowed });
      pacedReadyAt = choice.pacedReadyAt;
      if (choice.picked === null) break;
      const key: InstagramSendMessageKey = {
        organizationId: target.organizationId,
        publicId: choice.picked.candidate.publicId,
        automationRunStartedAt: choice.picked.candidate.automationRunStartedAt,
      };
      if (
        await this.isPassedOver({ scope, target, candidate: choice.picked.candidate, key, now })
      ) {
        continue;
      }
      return { key, isPaced: choice.picked.isPaced };
    }
    const notBefore = await withAppDatabaseContext({
      scope,
      callback: () =>
        new InstagramMessageRepository().findEarliestWaitingNotBefore({
          organizationId: target.organizationId,
          channelAccountId: target.channelAccountId,
          lane: 'reply',
          now,
        }),
    });
    const times = [notBefore, pacedReadyAt].filter((time): time is Date => time !== null);
    if (times.length === 0) return { key: null, nextRunAt: null, waitReason: null };
    const nextRunAt = new Date(Math.min(...times.map((time) => time.getTime())));
    const isBox = pacedReadyAt !== null && nextRunAt.getTime() === pacedReadyAt.getTime();
    return { key: null, nextRunAt, waitReason: isBox ? 'box' : 'not_before' };
  }

  /**
   * The next reply to go now — an unpaced one first, else the newest due paced one — and the
   * earliest time a paced one becomes due.
   */
  private async chooseReply({
    scope,
    target,
    lane,
    now,
    isOffered,
    isSlowed,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    target: InstagramSendLaneTarget;
    lane: InstagramSendLaneRow;
    now: Date;
    isOffered: boolean;
    isSlowed: boolean;
  }): Promise<{ picked: ReplyChoice | null; pacedReadyAt: Date | null }> {
    const account = {
      organizationId: target.organizationId,
      channelAccountId: target.channelAccountId,
    };
    const due = await withAppDatabaseContext({
      scope,
      callback: () =>
        new InstagramMessageRepository().findReplyDueCandidate({
          ...account,
          now,
          isReplyLikePersonOffered: isOffered,
        }),
    });
    if (due !== null) return { picked: { candidate: due, isPaced: false }, pacedReadyAt: null };
    if (!isOffered) return { picked: null, pacedReadyAt: null };
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const paced = await new InstagramMessageRepository().listReplyPacedCandidates({
          ...account,
          now,
        });
        const gapEnd =
          lane.last_sent_at === null
            ? 0
            : lane.last_sent_at.getTime() + REPLY_LANE_SETTINGS.gapMilliseconds;
        let best: { candidate: InstagramMessagePickCandidate; box: number; boxStart: Date } | null =
          null;
        let earliest: number | null = null;
        for (const candidate of paced) {
          const box = replyBoxMilliseconds({
            hourLimit: candidate.publicReplyHourLimit ?? AUTOMATION_PUBLIC_REPLY_HOUR_LIMIT_DEFAULT,
            isSlowed,
          });
          const boxStart = await this.currentBoxStart({ scope, target, candidate, box, now });
          const readyAt = Math.max(
            boxStart.getTime() +
              replyBoxOffsetMilliseconds({
                automationId: candidate.automationId,
                boxStart,
                boxMilliseconds: box,
              }),
            gapEnd,
          );
          if (readyAt > now.getTime()) {
            earliest = earliest === null ? readyAt : Math.min(earliest, readyAt);
            continue;
          }
          const isNewer =
            best === null ||
            (candidate.triggerOccurredAt?.getTime() ?? 0) >
              (best.candidate.triggerOccurredAt?.getTime() ?? 0);
          if (isNewer) best = { candidate, box, boxStart };
        }
        const pacedReadyAt = earliest === null ? null : new Date(earliest);
        if (best === null) return { picked: null, pacedReadyAt };
        await this.moveBox({
          scope,
          target,
          automationId: best.candidate.automationId,
          boxStart: new Date(best.boxStart.getTime() + best.box),
        });
        return { picked: { candidate: best.candidate, isPaced: true }, pacedReadyAt };
      },
    });
  }

  /**
   * The automation's box now (plan §29.3 rule 3): its reply state's `box_start` while that box
   * runs, else a new box starting now (saved, so a lost ticket finds the same second).
   */
  private async currentBoxStart({
    scope,
    target,
    candidate,
    box,
    now,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    target: InstagramSendLaneTarget;
    candidate: InstagramMessagePickCandidate & { boxStart: Date | null };
    box: number;
    now: Date;
  }): Promise<Date> {
    if (candidate.boxStart !== null && candidate.boxStart.getTime() + box > now.getTime()) {
      return candidate.boxStart;
    }
    await this.moveBox({ scope, target, automationId: candidate.automationId, boxStart: now });
    return now;
  }

  /** Writes an automation's `box_start` in the caller's unit (its line and waiting count kept). */
  private async moveBox({
    scope,
    target,
    automationId,
    boxStart,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    target: InstagramSendLaneTarget;
    automationId: number;
    boxStart: Date;
  }): Promise<void> {
    const key = { organizationId: target.organizationId, automationId };
    const state = await this.dependencies.replyStateService.lockReplyState({ scope, key });
    await this.dependencies.replyStateService.saveReplyState({
      scope,
      key,
      channelAccountId: target.channelAccountId,
      boxStart,
      lastTextNumber: state?.last_text_number ?? null,
      waitingCount: state?.waiting_count ?? 0,
    });
  }

  /** One pick's check again (plan §29.5 rule 4): `true` when the row was ended or is gone. */
  private async isPassedOver({
    scope,
    target,
    candidate,
    key,
    now,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    target: InstagramSendLaneTarget;
    candidate: InstagramMessagePickCandidate;
    key: InstagramSendMessageKey;
    now: Date;
  }): Promise<boolean> {
    const message = await withAppDatabaseContext({
      scope,
      callback: () => new InstagramMessageRepository().findByKey(key),
    });
    if (message === null || message.status !== 'waiting') return true;
    const isTooOld =
      candidate.triggerOccurredAt !== null &&
      candidate.triggerOccurredAt.getTime() + INSTAGRAM_COMMENT_REPLY_EXPIRY_MILLISECONDS <=
        now.getTime();
    const contact = isTooOld
      ? null
      : await withAppDatabaseContext({
          scope,
          callback: () =>
            new ContactRepository().findLiveById({
              organizationId: target.organizationId,
              contactId: message.contact_id,
            }),
        });
    const ending: {
      status: 'skipped' | 'expired';
      reason: 'reply_too_old' | 'contact_excluded' | 'contact_deleted';
    } | null = isTooOld
      ? { status: 'expired', reason: 'reply_too_old' }
      : contact === null
        ? { status: 'skipped', reason: 'contact_deleted' }
        : contact.automations_off_at !== null
          ? { status: 'skipped', reason: 'contact_excluded' }
          : null;
    if (ending === null) return false;
    await withAppDatabaseContext({
      scope,
      callback: async () => {
        await this.dependencies.messageService.endWaitingMessage({ scope, key, ...ending });
        if (message.message_type === 'public_reply' && message.automation_id !== null) {
          await this.countReplyOut({
            scope,
            organizationId: target.organizationId,
            automationId: message.automation_id,
            channelAccountId: target.channelAccountId,
          });
        }
      },
    });
    return true;
  }

  /** One waiting reply fewer on the automation's reply state (plan §29.3: its 500 cap), in the unit. */
  private async countReplyOut({
    scope,
    organizationId,
    automationId,
    channelAccountId,
    lastTextNumber,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    automationId: number;
    channelAccountId: number;
    /** The line this reply used; absent = kept. */
    lastTextNumber?: number | undefined;
  }): Promise<void> {
    const key = { organizationId, automationId };
    const state = await this.dependencies.replyStateService.lockReplyState({ scope, key });
    await this.dependencies.replyStateService.saveReplyState({
      scope,
      key,
      channelAccountId,
      boxStart: state?.box_start ?? null,
      lastTextNumber: lastTextNumber ?? state?.last_text_number ?? null,
      waitingCount: Math.max((state?.waiting_count ?? 0) - 1, 0),
    });
  }

  /**
   * The claimed reply's or hide's call (see the class).
   *
   * @remarks
   * Algorithm: one unit reads the automation, run and her and, for a reply, picks the line and
   * writes the reply state; the call outside it. Failure modes: database errors propagate. Side
   * effects: the reply state.
   */
  async composeMessage({
    scope,
    message,
  }: Parameters<InstagramSendLaneRules['composeMessage']>[0]): Promise<InstagramSendComposition> {
    if (message.automation_id === null || message.automation_run_id === null) {
      return { kind: 'skip', reason: 'automation_deleted' };
    }
    const automationId = message.automation_id;
    const runId = message.automation_run_id;
    const isOffered = await this.isReplyLikePersonOffered({
      scope,
      organizationId: message.organization_id,
      channelAccountId: message.channel_account_id,
    });
    const read = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organizationId = message.organization_id;
        const automation = await new AutomationRepository().findByIdIncludingDeleted({
          organizationId,
          automationId,
        });
        const run = await new AutomationRunRepository().findByKey({
          organizationId,
          runId,
          runStartedAt: message.automation_run_started_at,
        });
        const contact = await new ContactRepository().findLiveById({
          organizationId,
          contactId: message.contact_id,
        });
        if (message.message_type !== 'public_reply' || automation === null) {
          return { automation, run, contact, lineNumber: null };
        }
        const key = { organizationId, automationId };
        const state = await this.dependencies.replyStateService.lockReplyState({ scope, key });
        const lineNumber = pickReplyLineNumber({
          lineCount: automation.public_reply_texts.length,
          lastLineNumber: state?.last_text_number ?? null,
          isFirstLineOnly: !isOffered,
          random: this.random,
        });
        await this.countReplyOut({
          scope,
          organizationId,
          automationId,
          channelAccountId: message.channel_account_id,
          lastTextNumber: lineNumber,
        });
        return { automation, run, contact, lineNumber };
      },
    });
    const { automation, run, contact } = read;
    if (automation === null || automation.deleted_at !== null || run === null) {
      return { kind: 'skip', reason: 'automation_deleted' };
    }
    const commentId = run.trigger_instagram_comment_id;
    if (commentId === null) return { kind: 'skip', reason: 'deleted_comment' };
    if (message.message_type === 'hide_comment') {
      return {
        kind: 'send',
        uploadPublicId: null,
        call: async ({ access, recordUsage }) => {
          await callWithCommentCheck({
            access,
            instagramCommentId: commentId,
            recordUsage,
            call: () =>
              hideInstagramComment({
                encryptedAccessToken: access.encryptedAccessToken ?? '',
                instagramCommentId: commentId,
                requestId: REPLY_REQUEST_ID,
                recordUsage,
              }),
          });
          return { instagramMessageId: null };
        },
      };
    }
    const line = automation.public_reply_texts[(read.lineNumber ?? 1) - 1];
    if (line === undefined) return { kind: 'skip', reason: 'cancelled_by_owner' };
    const username = contact?.username ?? null;
    const text =
      automation.is_public_reply_mention_enabled && username !== null
        ? `@${username} ${line}`
        : line;
    return {
      kind: 'send',
      uploadPublicId: null,
      call: async ({ access, recordUsage }) => {
        const reply = await callWithCommentCheck({
          access,
          instagramCommentId: commentId,
          recordUsage,
          call: () =>
            replyToInstagramComment({
              encryptedAccessToken: access.encryptedAccessToken ?? '',
              instagramCommentId: commentId,
              text,
              requestId: REPLY_REQUEST_ID,
              recordUsage,
            }),
        });
        return { instagramMessageId: reply.instagramCommentReplyId };
      },
    };
  }

  /**
   * At once after a call (the next pick finds the next due time); a paced send that reached Meta
   * moves the lane's `last_sent_at` — the 20 s gap's clock (plan §29.3 rule 4: OFF replies and
   * hides never move it). A refusal looks again a second later.
   *
   * @remarks
   * Pure. Failure modes: none. Side effects: none.
   */
  nextTurnAt({
    pick,
    result,
    now,
  }: {
    lane: InstagramSendLaneRow;
    pick: Extract<InstagramSendPick, { key: InstagramSendMessageKey }>;
    result: InstagramSendResult;
    pace: MetaUsagePace;
    limits: InstagramSendLimits;
    now: Date;
  }): InstagramSendNextTurn {
    if (result.kind === 'refused') {
      return { nextRunAt: new Date(now.getTime() + SLOW_LANE_SETTINGS.pickAgainMilliseconds) };
    }
    const isPacedSend = pick.isPaced === true && result.status !== 'waiting';
    return { nextRunAt: now, ...(isPacedSend ? { lastSentAt: now } : {}) };
  }
}
