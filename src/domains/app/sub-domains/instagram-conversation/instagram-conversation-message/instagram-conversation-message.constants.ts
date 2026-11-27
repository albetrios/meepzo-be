/**
 * The conversation message's fixed lists and limits (feat-instagram-inbox routes-final § 2.B.3, I-D14):
 * every message both ways, its kind, a team reply's send status, kept 12 months.
 */

/** What a conversation message is (I-D14). */
export const INSTAGRAM_CONVERSATION_MESSAGE_KINDS = [
  'text',
  'image',
  'video',
  'audio',
  'file',
  'story_reply',
  'story_mention',
  'shared_post',
  'button_tap',
  'reaction',
  'referral',
] as const;

/** One value of {@link INSTAGRAM_CONVERSATION_MESSAGE_KINDS}. */
export type InstagramConversationMessageKind =
  (typeof INSTAGRAM_CONVERSATION_MESSAGE_KINDS)[number];

/** A team reply's send status (CV5): saved `sending`, then `sent` or `failed` — team replies only. */
export const INSTAGRAM_CONVERSATION_MESSAGE_SEND_STATUSES = ['sending', 'sent', 'failed'] as const;

/** One value of {@link INSTAGRAM_CONVERSATION_MESSAGE_SEND_STATUSES}. */
export type InstagramConversationMessageSendStatus =
  (typeof INSTAGRAM_CONVERSATION_MESSAGE_SEND_STATUSES)[number];

/** A message's text: at most this many characters (Meta's DM limit, 2.B.3). */
export const INSTAGRAM_CONVERSATION_MESSAGE_TEXT_MAX_CHARACTERS = 2200;

/** A message's files: at most this many (2.B.3). */
export const INSTAGRAM_CONVERSATION_MESSAGE_ATTACHMENTS_MAX = 10;

/** A failure reason's length cap — our own reason code, never Meta's text (K2). */
export const INSTAGRAM_CONVERSATION_MESSAGE_FAILURE_REASON_MAX_LENGTH = 50;

/**
 * Days a conversation message part is kept after the end of its month (2.B.3, I-D5): the upkeep drops
 * the month part after this many days.
 *
 * @remarks
 * Rationale: the team inbox keeps a year of history (the user's I-D5). Consequences of change:
 * decreasing → older threads disappear sooner; increasing → more storage, and the upkeep refuses more
 * than 400 days. Last reviewed: 2026-11-27.
 */
export const INSTAGRAM_CONVERSATION_MESSAGE_KEEP_DAYS = 365;
