/**
 * The Instagram conversation's fixed lists and limits (feat-instagram-inbox routes-final § 2, CV1–CV4,
 * 2.A.3): one conversation per contact, its state, who holds it, who sent its newest message.
 */

/** Where a conversation stands (2.A.3): open, waiting on the team or on the contact, or closed. */
export const INSTAGRAM_CONVERSATION_STATES = [
  'open',
  'waiting_on_us',
  'waiting_on_contact',
  'closed',
] as const;

/** One value of {@link INSTAGRAM_CONVERSATION_STATES}. */
export type InstagramConversationState = (typeof INSTAGRAM_CONVERSATION_STATES)[number];

/**
 * Who holds a taken conversation (CV4): a team member, or the Instagram app when an echo our app did not
 * send arrives — either holds every automation DM to that contact on that account.
 */
export const INSTAGRAM_CONVERSATION_TAKEN_BY = ['team_member', 'instagram_app'] as const;

/** One value of {@link INSTAGRAM_CONVERSATION_TAKEN_BY}. */
export type InstagramConversationTakenBy = (typeof INSTAGRAM_CONVERSATION_TAKEN_BY)[number];

/**
 * Who sent a conversation message (I-D14): the contact, an automation, a broadcast, a team member, or
 * someone in the Instagram app — the conversation keeps the newest one's type.
 */
export const INSTAGRAM_CONVERSATION_SENDER_TYPES = [
  'contact',
  'automation',
  'broadcast',
  'team_member',
  'instagram_app',
] as const;

/** One value of {@link INSTAGRAM_CONVERSATION_SENDER_TYPES}. */
export type InstagramConversationSenderType = (typeof INSTAGRAM_CONVERSATION_SENDER_TYPES)[number];

/** The newest message's preview the list shows (2.A.3): at most this many characters. */
export const INSTAGRAM_CONVERSATION_PREVIEW_MAX_CHARACTERS = 200;

/**
 * A taken conversation is released after this many hours with no `team_member` message (CV4, I-D3) —
 * the hand-off's idle release.
 *
 * @remarks
 * Rationale: Meta's 24-hour messaging window; a member who stopped answering hands the contact back to
 * the automations after the same day. Consequences of change: decreasing → automations resume while a
 * member may still answer; increasing → a contact waits longer for automations nobody stopped on
 * purpose. Last reviewed: 2026-11-27.
 */
export const INSTAGRAM_CONVERSATION_IDLE_RELEASE_HOURS = 24;
