import { describe, expect, it } from 'vitest';
import {
  INSTAGRAM_MESSAGES_WEBHOOK_GRACE_MINUTES,
  decideInstagramMessagesWebhookCheckStep,
  isInstagramMessagesWebhookMissing,
  shouldRecordInstagramMessagesWebhookSeen,
} from '@/domains/app/sub-domains/instagram-account/instagram-messages-webhook-watch.util.js';
import { INSTAGRAM_MESSAGING_EVENT_KINDS } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.constants.js';

/**
 * The messaging-webhook watch's decisions (P358): Meta's Unified Login may send no `messages`
 * webhooks for an account shared without its linked Facebook Page — when the subscription check
 * reads Meta, when it flags, and when the webhook store writes the seen mark.
 */

const MINUTE = 60_000;
const SUBSCRIBED_AT = new Date('2026-11-20T09:00:00.000Z');
/** Two days after the subscription, in the first 10-minute window of the hour. */
const FIRST_WINDOW = new Date('2026-11-22T09:04:00.000Z');

function step(overrides: Partial<Parameters<typeof decideInstagramMessagesWebhookCheckStep>[0]>) {
  return decideInstagramMessagesWebhookCheckStep({
    webhookSubscribedAt: SUBSCRIBED_AT,
    messagesWebhookSeenAt: null,
    messagesWebhookMissingAt: null,
    now: FIRST_WINDOW,
    windowMinutes: 10,
    ...overrides,
  });
}

describe('decideInstagramMessagesWebhookCheckStep', () => {
  it('reads Meta for a subscribed account with no messaging item since, after the grace, once an hour', () => {
    expect(step({})).toBe('read_conversations');
  });

  it('never reads for an account not subscribed', () => {
    expect(step({ webhookSubscribedAt: null })).toBe('not_subscribed');
  });

  it('never reads again once flagged', () => {
    expect(step({ messagesWebhookMissingAt: new Date('2026-11-21T10:00:00.000Z') })).toBe(
      'already_flagged',
    );
  });

  it('a messaging item since the subscription is proof enough; one before it is not', () => {
    expect(step({ messagesWebhookSeenAt: SUBSCRIBED_AT })).toBe('seen');
    expect(step({ messagesWebhookSeenAt: new Date(SUBSCRIBED_AT.getTime() - MINUTE) })).toBe(
      'read_conversations',
    );
  });

  it('waits a full day after the subscription', () => {
    const graceEnd = SUBSCRIBED_AT.getTime() + INSTAGRAM_MESSAGES_WEBHOOK_GRACE_MINUTES * MINUTE;
    expect(step({ now: new Date(graceEnd - 6 * MINUTE) })).toBe('too_soon');
    expect(step({ now: new Date(graceEnd) })).toBe('read_conversations');
  });

  it('reads only in the first window of each hour', () => {
    expect(step({ now: new Date('2026-11-22T09:09:59.000Z') })).toBe('read_conversations');
    expect(step({ now: new Date('2026-11-22T09:10:00.000Z') })).toBe('not_this_hour');
    expect(step({ now: new Date('2026-11-22T09:55:00.000Z') })).toBe('not_this_hour');
  });
});

describe('isInstagramMessagesWebhookMissing', () => {
  it('flags conversation activity after the subscription only', () => {
    expect(
      isInstagramMessagesWebhookMissing({
        webhookSubscribedAt: SUBSCRIBED_AT,
        latestConversationAt: new Date('2026-11-21T00:00:00.000Z'),
      }),
    ).toBe(true);
    expect(
      isInstagramMessagesWebhookMissing({
        webhookSubscribedAt: SUBSCRIBED_AT,
        latestConversationAt: SUBSCRIBED_AT,
      }),
    ).toBe(false);
    expect(
      isInstagramMessagesWebhookMissing({
        webhookSubscribedAt: SUBSCRIBED_AT,
        latestConversationAt: null,
      }),
    ).toBe(false);
  });
});

describe('shouldRecordInstagramMessagesWebhookSeen', () => {
  const now = new Date('2026-11-22T09:00:00.000Z');

  it('writes the first time, then at most hourly', () => {
    const base = { isMessagesWebhookMissing: false, now };
    expect(shouldRecordInstagramMessagesWebhookSeen({ ...base, messagesWebhookSeenAt: null })).toBe(
      true,
    );
    expect(
      shouldRecordInstagramMessagesWebhookSeen({
        ...base,
        messagesWebhookSeenAt: new Date(now.getTime() - 59 * MINUTE),
      }),
    ).toBe(false);
    expect(
      shouldRecordInstagramMessagesWebhookSeen({
        ...base,
        messagesWebhookSeenAt: new Date(now.getTime() - 60 * MINUTE),
      }),
    ).toBe(true);
  });

  it('always writes for a flagged account, so the flag clears at once', () => {
    expect(
      shouldRecordInstagramMessagesWebhookSeen({
        isMessagesWebhookMissing: true,
        messagesWebhookSeenAt: now,
        now,
      }),
    ).toBe(true);
  });
});

describe('INSTAGRAM_MESSAGING_EVENT_KINDS', () => {
  it('counts the messaging kinds, never a comment, a Live comment or an unknown item', () => {
    expect(INSTAGRAM_MESSAGING_EVENT_KINDS.has('message')).toBe(true);
    expect(INSTAGRAM_MESSAGING_EVENT_KINDS.has('echo')).toBe(true);
    expect(INSTAGRAM_MESSAGING_EVENT_KINDS.has('reaction')).toBe(true);
    for (const kind of ['comment', 'live_comment', 'unknown'] as const) {
      expect(INSTAGRAM_MESSAGING_EVENT_KINDS.has(kind)).toBe(false);
    }
  });
});
