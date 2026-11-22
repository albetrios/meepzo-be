import { randomInt } from 'node:crypto';
import type { InstagramAccountSettingsRow } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { MILLISECONDS_PER_SECOND } from '@/shared/constants/ttl.constants.js';
import {
  AUTOMATION_PUBLIC_REPLY_CHANCE_SCALE,
  AUTOMATION_PUBLIC_REPLY_HOUR_WINDOW_MILLISECONDS,
  type AutomationPublicReplySkipReason,
} from './automation-run.constants.js';
import type { AutomationCommentLogRepository } from './automation-comment-log.repository.js';

/**
 * Draws a whole number in `[0, maxExclusive)` — `crypto.randomInt` in production, a fixed source
 * in tests (AU20: "reply safety order with a fixed random source").
 *
 * @remarks
 * Injected into the reply-safety and message services, so a test fixes every draw (the chance, the
 * gap, the text, the pause).
 */
export type AutomationRandomSource = (maxExclusive: number) => number;

/**
 * The reply-safety settings of the account (sub-domain 1's row, IA15).
 *
 * @remarks
 * Read once per engine call with the account (`findAutomationAccountAccess`); `null` there means
 * the defaults — safety off.
 */
export type AutomationPublicReplySafetySettings = Pick<
  InstagramAccountSettingsRow,
  | 'is_public_reply_safety_enabled'
  | 'public_reply_chance_percent'
  | 'public_reply_hour_limit'
  | 'public_reply_gap_min_seconds'
  | 'public_reply_gap_max_seconds'
>;

/**
 * What reply safety decided for one comment's public reply (AU20).
 *
 * @remarks
 * `reply` carries the text to send; `skip` the reason saved as the comment log's
 * `public_reply_skip_reason`.
 */
export type AutomationPublicReplyDecision =
  | { kind: 'reply'; text: string }
  | { kind: 'skip'; skipReason: AutomationPublicReplySkipReason };

/**
 * One public reply text, at random among the automation's texts other than its last one (AU20:
 * never the automation's last reply text, safety on or off). With a single text, that text.
 *
 * @remarks
 * Pure — the draw is the injected source. Failure modes: throws on an empty list, which the flow
 * rules (AU8: 1–20 texts while the public reply is on) keep from happening.
 */
export function pickPublicReplyText({
  texts,
  lastSentText,
  drawInteger,
}: {
  texts: readonly string[];
  lastSentText: string | null;
  drawInteger: AutomationRandomSource;
}): string {
  const others = texts.filter((text) => text !== lastSentText);
  const pool = others.length > 0 ? others : texts;
  if (pool.length === 0) throw new Error('pickPublicReplyText: the automation has no reply text');
  return pool[drawInteger(pool.length)] as string;
}

/**
 * Public reply safety (routes-final § 3.B AU20, D17): whether a comment's public reply goes, and
 * with which text.
 *
 * @remarks
 * Algorithm — only when the account's `is_public_reply_safety_enabled` is on, in this order, the
 * first that applies is the skip reason:
 * 1. **duplicate** — the comment already got a public reply from the account (any comment log of
 *    it `sent`);
 * 2. **random** — reply only when a draw under 100 is below `public_reply_chance_percent`;
 * 3. **hour_limit** — the organization's public replies `sent` in the last 60 minutes reach
 *    `public_reply_hour_limit`;
 * 4. **gap** — the last one is closer than a gap drawn between `public_reply_gap_min_seconds` and
 *    `public_reply_gap_max_seconds`.
 * Then, on or off, the text: never the automation's last reply text ({@link pickPublicReplyText}).
 *
 * Failure modes: none of its own — a database error propagates to the engine (a temporary
 * failure). Side effects: reads only.
 *
 * Notes: the counts come from comment logs in Postgres, the only source of truth — one account's
 * events run in order (D15), so no two replies race and the count is exact; there is no Redis
 * count, so D17's "counts unreadable → reply anyway" has nothing to guard. The DM is never held
 * back. Counts are per organization (one connected account per organization, D5).
 */
export class AutomationPublicReplySafetyService {
  constructor(
    private readonly drawInteger: AutomationRandomSource = (maxExclusive) =>
      randomInt(maxExclusive),
  ) {}

  /**
   * Decides one comment's public reply (AU20) — the caller's comment-log repository is bound to its
   * unit of work.
   */
  async decide({
    commentLogRepository,
    settings,
    organizationId,
    automationId,
    instagramCommentId,
    replyTexts,
    now,
  }: {
    commentLogRepository: AutomationCommentLogRepository;
    /** The account's settings; `null` = the defaults (safety off). */
    settings: AutomationPublicReplySafetySettings | null;
    organizationId: number;
    automationId: number;
    instagramCommentId: string;
    /** The automation's `public_reply_texts` (1–20, AU8). */
    replyTexts: readonly string[];
    now: Date;
  }): Promise<AutomationPublicReplyDecision> {
    if (settings?.is_public_reply_safety_enabled === true) {
      const skipReason = await this.findSkipReason({
        commentLogRepository,
        settings,
        organizationId,
        instagramCommentId,
        now,
      });
      if (skipReason !== null) return { kind: 'skip', skipReason };
    }
    const lastSentText = await commentLogRepository.findLastSentPublicReplyText({
      organizationId,
      automationId,
    });
    return {
      kind: 'reply',
      text: pickPublicReplyText({ texts: replyTexts, lastSentText, drawInteger: this.drawInteger }),
    };
  }

  /** The first safety check that applies, in D17's order; `null` when the reply may go. */
  private async findSkipReason({
    commentLogRepository,
    settings,
    organizationId,
    instagramCommentId,
    now,
  }: {
    commentLogRepository: AutomationCommentLogRepository;
    settings: AutomationPublicReplySafetySettings;
    organizationId: number;
    instagramCommentId: string;
    now: Date;
  }): Promise<AutomationPublicReplySkipReason | null> {
    if (await commentLogRepository.hasSentPublicReply({ organizationId, instagramCommentId })) {
      return 'duplicate';
    }
    if (
      this.drawInteger(AUTOMATION_PUBLIC_REPLY_CHANCE_SCALE) >= settings.public_reply_chance_percent
    ) {
      return 'random';
    }
    const sentInLastHour = await commentLogRepository.countSentPublicRepliesSince({
      organizationId,
      since: new Date(now.getTime() - AUTOMATION_PUBLIC_REPLY_HOUR_WINDOW_MILLISECONDS),
    });
    if (sentInLastHour >= settings.public_reply_hour_limit) return 'hour_limit';
    const lastSentAt = await commentLogRepository.findLastSentPublicReplyAt({ organizationId });
    if (lastSentAt !== null) {
      const gapSeconds =
        settings.public_reply_gap_min_seconds +
        this.drawInteger(
          settings.public_reply_gap_max_seconds - settings.public_reply_gap_min_seconds + 1,
        );
      if (now.getTime() - lastSentAt.getTime() < gapSeconds * MILLISECONDS_PER_SECOND) {
        return 'gap';
      }
    }
    return null;
  }
}
