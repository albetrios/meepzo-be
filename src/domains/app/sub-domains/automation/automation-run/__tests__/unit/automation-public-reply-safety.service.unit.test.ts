import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AutomationPublicReplySafetySettings,
  AutomationPublicReplySafetyService,
  pickPublicReplyText,
} from '@/domains/app/sub-domains/automation/automation-run/automation-public-reply-safety.service.js';
import type { AutomationCommentLogRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.repository.js';

/**
 * Public reply safety (routes-final § 3.B AU20, D17) with a fixed random source and the comment-log
 * counts faked: the order duplicate → random → hour limit → gap, the first that applies is the
 * reason; safety off always replies; the text is never the automation's last one.
 */

const now = new Date('2026-11-21T12:00:00.000Z');

const safetyOn: AutomationPublicReplySafetySettings = {
  is_public_reply_safety_enabled: true,
  public_reply_chance_percent: 80,
  public_reply_hour_limit: 60,
  public_reply_gap_min_seconds: 20,
  public_reply_gap_max_seconds: 60,
};

describe('AutomationPublicReplySafetyService (AU20)', () => {
  let repository: {
    hasSentPublicReply: ReturnType<typeof vi.fn>;
    countSentPublicRepliesSince: ReturnType<typeof vi.fn>;
    findLastSentPublicReplyAt: ReturnType<typeof vi.fn>;
    findLastSentPublicReplyText: ReturnType<typeof vi.fn>;
  };
  /** The draws the fixed source answers, in order (then 0). */
  let draws: number[];

  beforeEach(() => {
    repository = {
      hasSentPublicReply: vi.fn(async () => false),
      countSentPublicRepliesSince: vi.fn(async () => 0),
      findLastSentPublicReplyAt: vi.fn(async () => null),
      findLastSentPublicReplyText: vi.fn(async () => null),
    };
    draws = [];
  });

  function decide(settings: AutomationPublicReplySafetySettings | null = safetyOn) {
    const service = new AutomationPublicReplySafetyService(() => draws.shift() ?? 0);
    return service.decide({
      commentLogRepository: repository as unknown as AutomationCommentLogRepository,
      settings,
      organizationId: 7,
      automationId: 3,
      instagramCommentId: '17950000000000001',
      replyTexts: ['First', 'Second'],
      now,
    });
  }

  it('skips a comment that already got a public reply (duplicate) before drawing', async () => {
    repository.hasSentPublicReply.mockResolvedValue(true);

    await expect(decide()).resolves.toEqual({ kind: 'skip', skipReason: 'duplicate' });
    expect(repository.countSentPublicRepliesSince).not.toHaveBeenCalled();
  });

  it('skips at random when the draw is not below the chance (random)', async () => {
    draws = [80];

    await expect(decide()).resolves.toEqual({ kind: 'skip', skipReason: 'random' });
  });

  it('skips when the last 60 minutes reached the hour limit (hour_limit)', async () => {
    draws = [79];
    repository.countSentPublicRepliesSince.mockResolvedValue(60);

    await expect(decide()).resolves.toEqual({ kind: 'skip', skipReason: 'hour_limit' });
    expect(repository.countSentPublicRepliesSince).toHaveBeenCalledWith({
      organizationId: 7,
      since: new Date(now.getTime() - 60 * 60 * 1000),
    });
  });

  it('skips inside the drawn gap after the last reply (gap)', async () => {
    // chance draw 0 (reply), gap draw 10 → 30 seconds; the last reply was 25 seconds ago.
    draws = [0, 10];
    repository.findLastSentPublicReplyAt.mockResolvedValue(new Date(now.getTime() - 25_000));

    await expect(decide()).resolves.toEqual({ kind: 'skip', skipReason: 'gap' });
  });

  it('replies past the gap, with a text other than the last one', async () => {
    draws = [0, 10, 0];
    repository.findLastSentPublicReplyAt.mockResolvedValue(new Date(now.getTime() - 31_000));
    repository.findLastSentPublicReplyText.mockResolvedValue('First');

    await expect(decide()).resolves.toEqual({ kind: 'reply', text: 'Second' });
  });

  it('with safety off, always replies and checks nothing', async () => {
    repository.hasSentPublicReply.mockResolvedValue(true);

    await expect(decide({ ...safetyOn, is_public_reply_safety_enabled: false })).resolves.toEqual({
      kind: 'reply',
      text: 'First',
    });
    await expect(decide(null)).resolves.toEqual({ kind: 'reply', text: 'First' });
    expect(repository.hasSentPublicReply).not.toHaveBeenCalled();
  });
});

describe('pickPublicReplyText (AU20)', () => {
  it('never the last text when another exists; the only text when there is one', () => {
    expect(
      pickPublicReplyText({ texts: ['A', 'B', 'C'], lastSentText: 'B', drawInteger: () => 1 }),
    ).toBe('C');
    expect(pickPublicReplyText({ texts: ['A'], lastSentText: 'A', drawInteger: () => 0 })).toBe(
      'A',
    );
  });
});
