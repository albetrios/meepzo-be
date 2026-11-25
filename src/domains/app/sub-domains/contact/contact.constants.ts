import { RECORD_SHORT_TEXT_MAX_LENGTH } from '@/shared/constants/record-fields.constants.js';
import { CHANNEL_CAPABILITIES } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';

/**
 * The most tags one contact holds (`chk_contacts_tags`, CT9): past it, a run's new tag is dropped and
 * logged (the run still completes); the owner's route 20 answers `422 contact_tag_limit`.
 */
export const CONTACT_TAGS_MAX_COUNT = 50;

/** The longest tag (CT9, plan:L1029; launch 255) — the tag step names its tags. */
export const CONTACT_TAG_MAX_LENGTH = 50;

/** The longest note the owner writes on a contact (CT5, `chk_contacts_note`; the plan's `_CHARS`, P6). */
export const CONTACT_NOTE_MAX_CHARACTERS = 2000;

/** The longest email a contact stores (CT9, `chk_contacts_email`; the plan's `EMAIL_MAX_LENGTH`). */
export const CONTACT_EMAIL_MAX_LENGTH = 254;

/**
 * The strict email shape `chk_contacts_email` holds (CT9, plan:L2976) — plus addresses accepted (P19).
 * A normalised (lower-case) email must match it.
 */
export const CONTACT_EMAIL_PATTERN = '^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$';

/** The shortest `q` the contact list searches (S6, P97) — a shorter one is a `400`. */
export const CONTACT_SEARCH_MIN_LENGTH = 3;

/** The search's own statement timeout (S6): a `q` page that runs longer is cancelled. */
export const CONTACT_SEARCH_STATEMENT_TIMEOUT_MS = 2000;

/** How many tags one route-20 change adds or removes at most (CT5). */
export const CONTACT_TAG_CHANGE_MAX_COUNT = 20;

/** How many contact ids one bulk action names at most (CT7, P66). */
export const CONTACT_BULK_ACTION_IDS_MAX_COUNT = 500;

/** The most contacts one bulk action reaches; past it `422 contact_bulk_too_many` (CT7). */
export const CONTACT_BULK_ACTION_MATCH_MAX_COUNT = 100_000;

/** The pieces the bulk job works in, one short commit each (CT7, plan's `TAG_BULK_PIECE`). */
export const CONTACT_BULK_ACTION_PIECE_SIZE = 500;

/** The bulk actions route 21 takes (CT7). */
export const CONTACT_BULK_ACTIONS = [
  'add_tag',
  'remove_tag',
  'pause_automations',
  'resume_automations',
] as const;

/** One of {@link CONTACT_BULK_ACTIONS}. */
export type ContactBulkAction = (typeof CONTACT_BULK_ACTIONS)[number];

/** The tag list's page size: default and most (route 22, CT8). */
export const CONTACT_TAG_LIST_MAX_COUNT = 1000;

/** Route 24's page size (CT14): at most 100 entries. */
export const CONTACT_ACTIVITY_LIMIT_MAX = 100;

/** Route 24's page size without `limit` (3.A.8). */
export const CONTACT_ACTIVITY_LIMIT_DEFAULT = 50;

/**
 * How she came in (`came_in_via`, CT3): the way to start of her first run — every channel's
 * `trigger_type` values (AU8). Mirrors `chk_contacts_came_in_via`.
 */
export const CONTACT_CAME_IN_VIA_VALUES = [
  ...new Set(Object.values(CHANNEL_CAPABILITIES).flatMap((capability) => capability.triggerTypes)),
];

/**
 * Why the pause steps end her waiting messages and open runs (routes-final § 3.10): the owner's
 * pause (`contact_excluded`, D71) or her stop word (`opted_out`, D49).
 */
export type ContactPauseReason = 'contact_excluded' | 'opted_out';

/** Her 24-hour chat window as the contact object reads it (`is_chat_open`): 24 h less 15 minutes. */
export const CONTACT_CHAT_WINDOW_MS = (24 * 60 - 15) * 60 * 1000;

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

/** The audit resource type of every contact entry (CT10, K9). */
export const CONTACT_AUDIT_RESOURCE_TYPE = 'contact';
