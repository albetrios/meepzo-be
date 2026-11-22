import { RECORD_SHORT_TEXT_MAX_LENGTH } from '@/shared/constants/record-fields.constants.js';

/**
 * The most tags one contact holds (`chk_contacts_tags`, CT10): past it, a new tag is dropped and
 * logged, and the run that added it still completes.
 */
export const CONTACT_TAGS_MAX_COUNT = 50;

/** The longest tag (CT10) — an automation's name becomes the tag when it has none. */
export const CONTACT_TAG_MAX_LENGTH = RECORD_SHORT_TEXT_MAX_LENGTH;

/** The longest full name the column holds (`varchar(255)`); a longer one is cut. */
export const CONTACT_FULL_NAME_MAX_LENGTH = RECORD_SHORT_TEXT_MAX_LENGTH;

/** The longest username the column holds (`varchar(64)`); Instagram's own limit is 30. */
export const CONTACT_USERNAME_MAX_LENGTH = 64;

/** The most tags the contact list's `tags` filter takes (routes-final § 2.8). */
export const CONTACT_LIST_TAGS_FILTER_MAX_COUNT = 10;

/**
 * The event kinds that create or touch a contact (routes-final § 2.10): every one moves
 * `last_message_received_at`; every one but `comment` also moves `last_direct_message_received_at`
 * — the events that open Instagram's 24-hour messaging window (CT10).
 */
export const CONTACT_INTERACTION_KIND = {
  COMMENT: 'comment',
  DIRECT_MESSAGE: 'direct_message',
  STORY_REPLY: 'story_reply',
  BUTTON_CLICK: 'button_click',
} as const;

/** One of {@link CONTACT_INTERACTION_KIND}. */
export type ContactInteractionKind =
  (typeof CONTACT_INTERACTION_KIND)[keyof typeof CONTACT_INTERACTION_KIND];

/**
 * The contact list's sorts (CT6, CQ2): `last_message_received_at` is the default; the two times
 * default to newest first, `username` to A→Z, with the contacts without a username last either way.
 */
export const CONTACT_SORT_FIELDS = [
  'last_message_received_at',
  'first_seen_at',
  'username',
] as const;

/** One of {@link CONTACT_SORT_FIELDS}. */
export type ContactSortField = (typeof CONTACT_SORT_FIELDS)[number];

/** The sort a list without `sort` uses (CT6). */
export const CONTACT_DEFAULT_SORT: ContactSortField = 'last_message_received_at';

/** The audit resource type of a contact erase (CT12, K9). */
export const CONTACT_AUDIT_RESOURCE_TYPE = 'contact';
