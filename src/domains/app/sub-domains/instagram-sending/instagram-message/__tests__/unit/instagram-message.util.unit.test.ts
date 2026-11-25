import { describe, expect, it } from 'vitest';
import { INSTAGRAM_MESSAGE_TYPE_OF_STEP } from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.constants.js';
import {
  channelResultOf,
  chooseInstagramMessagePlace,
  drawInstagramExtraDelayMilliseconds,
  instagramMessageStepOf,
  isInstagramChatWindowOpen,
} from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.util.js';
import type { ChannelMessageStep } from '@/domains/app/app.channel-ports.js';

/**
 * The lane rule of Instagram's messages (feat-instagram-dm-sending routes-final § 6.B, SN22; plan
 * §19.1 checks 1–3): which lane and delivery channel each step waits in, whether it counts in the
 * month, and when a DM can never go.
 */
describe('chooseInstagramMessagePlace (SN22)', () => {
  const choose = (
    step: ChannelMessageStep,
    options: { triggerType?: string; answersEventId?: string | null; isWindowOpen?: boolean } = {},
  ) =>
    chooseInstagramMessagePlace({
      step,
      triggerType: options.triggerType ?? 'comment',
      answersEventId: options.answersEventId ?? null,
      isWindowOpen: options.isWindowOpen ?? false,
    });

  it('puts a public reply and a hide in the reply lane, uncounted', () => {
    expect(choose('public_reply')).toMatchObject({
      messageType: 'public_reply',
      lane: 'reply',
      channel: 'comment_reply',
      isCountedAsDirectMessage: false,
    });
    expect(choose('hide_comment')).toMatchObject({ lane: 'reply', channel: 'comment_hide' });
  });

  it('reads a follow check in the fast lane without a channel, uncounted', () => {
    expect(choose('follow_check')).toMatchObject({
      lane: 'fast',
      channel: null,
      isCountedAsDirectMessage: false,
    });
  });

  it("sends a comment's first DM as a slow private reply while her chat is closed, a fast DM once it is open, and fast for a Live comment", () => {
    expect(choose('hello', { answersEventId: '1790' })).toMatchObject({
      messageType: 'opening_message',
      lane: 'slow',
      channel: 'private_reply',
      isCountedAsDirectMessage: true,
    });
    expect(choose('hello', { answersEventId: '1790', isWindowOpen: true })).toMatchObject({
      lane: 'fast',
      channel: 'direct',
    });
    expect(
      choose('messages', { answersEventId: '1790', triggerType: 'live_comment' }),
    ).toMatchObject({
      lane: 'fast',
      channel: 'private_reply',
    });
  });

  it('sends every other DM fast and direct while her chat is open, and skips it once closed', () => {
    expect(choose('email', { isWindowOpen: true })).toMatchObject({
      messageType: 'email_question',
      lane: 'fast',
      channel: 'direct',
    });
    expect(choose('messages')).toEqual({ kind: 'skip', reason: 'window_closed' });
    expect(choose('broadcast')).toMatchObject({ lane: 'broadcast', channel: 'direct' });
  });

  it('judges her window at 24 hours less 15 minutes', () => {
    const lastDirectMessageReceivedAt = new Date('2026-11-25T00:00:00Z');
    const windowMilliseconds = (24 * 60 - 15) * 60 * 1000;
    const open = new Date(lastDirectMessageReceivedAt.getTime() + windowMilliseconds - 1);
    const closed = new Date(lastDirectMessageReceivedAt.getTime() + windowMilliseconds);
    expect(
      isInstagramChatWindowOpen({ lastDirectMessageReceivedAt, now: open, windowMilliseconds }),
    ).toBe(true);
    expect(
      isInstagramChatWindowOpen({ lastDirectMessageReceivedAt, now: closed, windowMilliseconds }),
    ).toBe(false);
    expect(
      isInstagramChatWindowOpen({
        lastDirectMessageReceivedAt: null,
        now: open,
        windowMilliseconds,
      }),
    ).toBe(false);
  });

  it('maps each type back to its step, and an expired result to skipped (AU35)', () => {
    for (const [step, type] of Object.entries(INSTAGRAM_MESSAGE_TYPE_OF_STEP)) {
      expect(instagramMessageStepOf(type)).toBe(step);
    }
    expect(instagramMessageStepOf('invalid_email')).toBe('email');
    expect(channelResultOf('expired')).toBe('skipped');
    expect(channelResultOf('unknown')).toBe('unknown');
  });
});

describe('drawInstagramExtraDelayMilliseconds (PRO, plan §30.12 rule 2)', () => {
  it('is min + (max − min) × (r1 + r2) ÷ 2 seconds in whole milliseconds, 0 while off', () => {
    const draw = (firstRandom: number, secondRandom: number) =>
      drawInstagramExtraDelayMilliseconds({
        minimumSeconds: 3,
        maximumSeconds: 8,
        firstRandom,
        secondRandom,
      });
    expect(draw(0, 0)).toBe(3_000);
    expect(draw(1, 1)).toBe(8_000);
    // The plan's example: 5,420 ms.
    expect(draw(0.384, 0.4)).toBe(4_960);
    expect(draw(0.5, 0.468)).toBe(5_420);
    expect(
      drawInstagramExtraDelayMilliseconds({
        minimumSeconds: null,
        maximumSeconds: null,
        firstRandom: 1,
        secondRandom: 1,
      }),
    ).toBe(0);
  });
});
