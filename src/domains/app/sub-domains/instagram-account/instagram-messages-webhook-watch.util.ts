import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';

/**
 * How long an account must have been subscribed before the subscription check may call it
 * "no `messages` webhooks" (P358): a day, so a fresh connection with no DM yet is never flagged.
 */
export const INSTAGRAM_MESSAGES_WEBHOOK_GRACE_MINUTES = 24 * 60;

/**
 * How often the webhook store writes `messages_webhook_seen_at` while messages keep arriving (P358)
 * — at most once an hour per account, so a busy inbox costs no write per delivery.
 */
export const INSTAGRAM_MESSAGES_WEBHOOK_SEEN_REFRESH_MINUTES = 60;

/**
 * How often the subscription check reads Meta's conversations for an account still waiting for its
 * first messaging webhook (P358): the first 10-minute window of each hour, not every window.
 */
export const INSTAGRAM_MESSAGES_WEBHOOK_CHECK_EVERY_MINUTES = 60;

/**
 * Whether the webhook store writes the account's messaging mark for a delivery that carried a
 * messaging item (P358).
 *
 * @remarks
 * - **Algorithm:** yes when the account is flagged (the item clears the flag), when no item was
 *   seen yet, or when the last seen time is older than
 *   {@link INSTAGRAM_MESSAGES_WEBHOOK_SEEN_REFRESH_MINUTES}; else no.
 * - **Failure modes:** none — pure. **Side effects:** none.
 */
export function shouldRecordInstagramMessagesWebhookSeen({
  messagesWebhookSeenAt,
  isMessagesWebhookMissing,
  now,
}: {
  messagesWebhookSeenAt: Date | null;
  isMessagesWebhookMissing: boolean;
  now: Date;
}): boolean {
  if (isMessagesWebhookMissing || messagesWebhookSeenAt === null) return true;
  return (
    now.getTime() - messagesWebhookSeenAt.getTime() >=
    INSTAGRAM_MESSAGES_WEBHOOK_SEEN_REFRESH_MINUTES * MILLISECONDS_PER_MINUTE
  );
}

/** What the subscription check does about the account's messaging webhooks before calling Meta. */
export type InstagramMessagesWebhookCheckStep =
  | 'not_subscribed'
  | 'already_flagged'
  | 'seen'
  | 'too_soon'
  | 'not_this_hour'
  | 'read_conversations';

/**
 * The first half of the messaging-webhook check (P358): whether Meta's conversations are worth
 * reading for this account now.
 *
 * @remarks
 * - **Algorithm:** in order — no webhook stamp → `not_subscribed`; already flagged →
 *   `already_flagged`; a messaging item seen since the stamp → `seen`; stamped less than
 *   {@link INSTAGRAM_MESSAGES_WEBHOOK_GRACE_MINUTES} ago → `too_soon`; outside the first
 *   `windowMinutes` of each {@link INSTAGRAM_MESSAGES_WEBHOOK_CHECK_EVERY_MINUTES} (one read an hour,
 *   not one per 10-minute check) → `not_this_hour`; else `read_conversations`.
 * - **Failure modes:** none — pure. **Side effects:** none.
 */
export function decideInstagramMessagesWebhookCheckStep({
  webhookSubscribedAt,
  messagesWebhookSeenAt,
  messagesWebhookMissingAt,
  now,
  windowMinutes,
}: {
  webhookSubscribedAt: Date | null;
  messagesWebhookSeenAt: Date | null;
  messagesWebhookMissingAt: Date | null;
  now: Date;
  /** The subscription check's window (10 minutes). */
  windowMinutes: number;
}): InstagramMessagesWebhookCheckStep {
  if (webhookSubscribedAt === null) return 'not_subscribed';
  if (messagesWebhookMissingAt !== null) return 'already_flagged';
  if (messagesWebhookSeenAt !== null && messagesWebhookSeenAt >= webhookSubscribedAt) return 'seen';
  const graceMilliseconds = INSTAGRAM_MESSAGES_WEBHOOK_GRACE_MINUTES * MILLISECONDS_PER_MINUTE;
  if (now.getTime() - webhookSubscribedAt.getTime() < graceMilliseconds) return 'too_soon';
  const everyMilliseconds =
    INSTAGRAM_MESSAGES_WEBHOOK_CHECK_EVERY_MINUTES * MILLISECONDS_PER_MINUTE;
  if (now.getTime() % everyMilliseconds >= windowMinutes * MILLISECONDS_PER_MINUTE) {
    return 'not_this_hour';
  }
  return 'read_conversations';
}

/**
 * The second half (P358): Meta shows conversation activity after the subscription while no
 * messaging webhook arrived — the account is flagged.
 *
 * @remarks
 * - **Algorithm:** `true` only when a latest conversation time exists and is after
 *   `webhookSubscribedAt`. No conversation, or none since, proves nothing (a quiet inbox).
 * - **Failure modes:** none — pure. **Side effects:** none.
 */
export function isInstagramMessagesWebhookMissing({
  webhookSubscribedAt,
  latestConversationAt,
}: {
  webhookSubscribedAt: Date;
  latestConversationAt: Date | null;
}): boolean {
  return latestConversationAt !== null && latestConversationAt > webhookSubscribedAt;
}
