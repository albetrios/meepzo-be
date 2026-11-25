import type { ChannelMessageStep } from '@/domains/app/app.channel-ports.js';
import {
  INSTAGRAM_SEND_ERROR_CODE_GROUPS,
  type InstagramSendLane,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';

/**
 * The message types of `app.instagram_messages` (feat-instagram-dm-sending routes-final § 6.B.3,
 * plan §19.1): every Instagram call that should go to her — a DM, a nudge, a broadcast message, a
 * public reply, a hide, or a follow check.
 */
export const INSTAGRAM_MESSAGE_TYPES = [
  'opening_message',
  'nudge',
  'public_reply',
  'hide_comment',
  'follow_check',
  'follow_request',
  'email_question',
  'invalid_email',
  'phone_question',
  'message',
  'broadcast',
] as const;

/** One value of {@link INSTAGRAM_MESSAGE_TYPES}. */
export type InstagramMessageType = (typeof INSTAGRAM_MESSAGE_TYPES)[number];

/**
 * The types that go into her chat (plan §19.1 check 5): `is_counted_as_direct_message` is true
 * exactly for these — the month count's messages (D34).
 */
export const INSTAGRAM_DIRECT_MESSAGE_TYPES: readonly InstagramMessageType[] = [
  'opening_message',
  'nudge',
  'follow_request',
  'email_question',
  'invalid_email',
  'phone_question',
  'message',
  'broadcast',
];

/** The run engine's step (AU35) → the message type it saves (SN22). */
export const INSTAGRAM_MESSAGE_TYPE_OF_STEP: Readonly<
  Record<ChannelMessageStep, InstagramMessageType>
> = {
  hello: 'opening_message',
  follow: 'follow_request',
  follow_check: 'follow_check',
  email: 'email_question',
  phone: 'phone_question',
  nudge: 'nudge',
  messages: 'message',
  public_reply: 'public_reply',
  hide_comment: 'hide_comment',
  broadcast: 'broadcast',
};

/** A message's kind (CA11's capability list, plan §19.1). */
export const INSTAGRAM_MESSAGE_KINDS = [
  'text',
  'image',
  'cards',
  'quick_replies',
  'audio',
  'file',
  'post',
] as const;

/** How a message reaches her (plan §19.1): empty only for a follow check, which is a read. */
export const INSTAGRAM_MESSAGE_CHANNELS = [
  'private_reply',
  'direct',
  'comment_reply',
  'comment_hide',
] as const;

/** One value of {@link INSTAGRAM_MESSAGE_CHANNELS}. */
export type InstagramMessageChannel = (typeof INSTAGRAM_MESSAGE_CHANNELS)[number];

/** The status machine of a message (SN16, plan §20.7). */
export const INSTAGRAM_MESSAGE_STATUSES = [
  'waiting',
  'sending',
  'sent',
  'unknown',
  'failed',
  'skipped',
  'cancelled',
  'expired',
] as const;

/** One value of {@link INSTAGRAM_MESSAGE_STATUSES}. */
export type InstagramMessageStatus = (typeof INSTAGRAM_MESSAGE_STATUSES)[number];

/** The statuses a send's result ends in (`saveSendResult`, SN4). */
export const INSTAGRAM_MESSAGE_FINAL_STATUSES = [
  'sent',
  'unknown',
  'failed',
  'skipped',
  'expired',
] as const satisfies readonly InstagramMessageStatus[];

/** One value of {@link INSTAGRAM_MESSAGE_FINAL_STATUSES}. */
export type InstagramMessageFinalStatus = (typeof INSTAGRAM_MESSAGE_FINAL_STATUSES)[number];

/**
 * Every `reason` of a message, one place (plan §19.1 "All reason values", plus P35's `replaced`, the
 * engine's 7-day wait cancel `wait_expired` (R14) and a follow check's `following` /
 * `not_following` on its `sent` result (P130)).
 */
export const INSTAGRAM_MESSAGE_REASONS = [
  'opted_out',
  'hour_limit',
  'duplicate',
  'window_closed',
  'deleted_comment',
  'person_error',
  'wrong_permission',
  'once_per_post',
  'broadcast_cancelled',
  'recent_broadcast',
  'owner_chat',
  'plan_feature_off',
  'contact_excluded',
  'automation_deleted',
  'contact_deleted',
  'restore',
  'cancelled_by_owner',
  'answered',
  'replaced',
  'wait_expired',
  'expired',
  'reply_too_old',
  'live_ended',
  'plan_limit',
  'bad_text',
  'tries_used_up',
  'attachment_failed',
  'no_answer',
  'worker_lost',
  'assumed_following',
  'following',
  'not_following',
] as const;

/** One value of {@link INSTAGRAM_MESSAGE_REASONS}. */
export type InstagramMessageReason = (typeof INSTAGRAM_MESSAGE_REASONS)[number];

/** The lanes each message type may wait in (plan §19.1 checks 1–3; the lane move keeps them). */
export const INSTAGRAM_MESSAGE_LANE_CHANNELS: Readonly<
  Record<InstagramSendLane, readonly (InstagramMessageChannel | null)[]>
> = {
  slow: ['private_reply'],
  reply: ['comment_reply', 'comment_hide'],
  fast: ['direct', 'private_reply', null],
  broadcast: ['direct'],
};

/** The count group of an attempt (SN3): `none` for follow checks, hides and mark-seen calls. */
export const INSTAGRAM_SEND_ATTEMPT_COUNT_GROUPS = [
  'open',
  'reply',
  'fast',
  'broadcast',
  'none',
] as const;

/** One value of {@link INSTAGRAM_SEND_ATTEMPT_COUNT_GROUPS}. */
export type InstagramSendAttemptCountGroup = (typeof INSTAGRAM_SEND_ATTEMPT_COUNT_GROUPS)[number];

/** The longest result group an attempt stores (`sent` or a group of 6.A.10). */
export const INSTAGRAM_SEND_ATTEMPT_RESULT_GROUP_MAX_LENGTH = 20;

/** A list message's number (D29): 1–10; a broadcast's 1–3 (D68). */
export const INSTAGRAM_MESSAGE_NUMBER_MAX = 10;

/** A version (D30, D31, D68): 1–3. */
export const INSTAGRAM_MESSAGE_VERSION_MAX = 3;

/** A question's wording, or a picked reply text (D31): 1–10. */
export const INSTAGRAM_MESSAGE_WORDING_MAX = 10;

/** Messages are kept about this many days — "what happened" and the retry read them (D50, P13). */
export const INSTAGRAM_MESSAGE_KEEP_DAYS = 30;

/** Send attempts are kept this many days (D16, P33). */
export const INSTAGRAM_SEND_ATTEMPT_KEEP_DAYS = 8;

/** The owner's retry puts back at most this many messages per piece, one commit each (SN18, WC-42). */
export const INSTAGRAM_MESSAGE_RETRY_PIECE_SIZE = 500;

/**
 * An opening private reply may go until its comment's time plus 7 days minus this safety time
 * (D9, `EXPIRY_SAFETY_MINUTES`).
 */
export const INSTAGRAM_PRIVATE_REPLY_EXPIRY_MILLISECONDS = (7 * 24 * 60 - 30) * 60 * 1000;

/** A public reply or hide may go until 7 days after its comment (D32, D33, `reply_too_old`). */
export const INSTAGRAM_COMMENT_REPLY_EXPIRY_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

/**
 * Meta errors final for the person (plan §33, `CODES_PERSON` and `CODES_OTHER_APP`): she blocked
 * us, the user is not found, no consent, or another app controls her chat. A failed message whose
 * last error is one of these is never retried (SN18 `final_for_person`). `subcode: null` matches any
 * subcode. Read from the send core's one code → group table (SNC4, ROUTE row R42): its `person` and
 * `other_app` entries.
 */
export const INSTAGRAM_PERSON_FINAL_ERRORS: readonly {
  code: number;
  subcode: number | null;
}[] = INSTAGRAM_SEND_ERROR_CODE_GROUPS.filter(
  (entry) => entry.group === 'person' || entry.group === 'other_app',
).map((entry) => ({
  code: entry.code,
  subcode: typeof entry.subcode === 'number' ? entry.subcode : null,
}));

/** Why a failed message cannot go again now (SN18; the summary's `not_retryable` keys). */
export const INSTAGRAM_MESSAGE_NOT_RETRYABLE_REASONS = [
  'too_old',
  'chat_closed',
  'final_for_person',
  'text_refused',
  'broadcast',
  'already_retried',
] as const;

/** One value of {@link INSTAGRAM_MESSAGE_NOT_RETRYABLE_REASONS}. */
export type InstagramMessageNotRetryableReason =
  (typeof INSTAGRAM_MESSAGE_NOT_RETRYABLE_REASONS)[number];
