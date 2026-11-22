import { RECORD_SHORT_TEXT_MAX_LENGTH } from '@/shared/constants/record-fields.constants.js';
import { MILLISECONDS_PER_HOUR } from '@/shared/constants/ttl.constants.js';

/**
 * Every value of `app.automations.status` (routes-final § 3.A.3): `live` answers events, `inactive`
 * is a draft or switched off. Mirrors `chk_automations_status`.
 */
export const AUTOMATION_STATUSES = ['live', 'inactive'] as const;

/** One value of {@link AUTOMATION_STATUSES}. */
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

/**
 * Every value of `app.automations.trigger_type`: a comment on a post, a reply to a story, a DM.
 * Mirrors `chk_automations_trigger_type`.
 */
export const AUTOMATION_TRIGGER_TYPES = ['comment', 'story_reply', 'dm'] as const;

/** One value of {@link AUTOMATION_TRIGGER_TYPES}. */
export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

/**
 * Every value of `app.automations.target_scope`: any post or story, one `specific` post or story,
 * or the `next` post published inside a window (comment automations only, AU9). Mirrors
 * `chk_automations_target_scope`.
 */
export const AUTOMATION_TARGET_SCOPES = ['any', 'specific', 'next'] as const;

/** One value of {@link AUTOMATION_TARGET_SCOPES}. */
export type AutomationTargetScope = (typeof AUTOMATION_TARGET_SCOPES)[number];

/**
 * Every value of `app.automations.next_post_status` (AU9, AU15): `waiting` for a post inside its
 * window, `linked` to the first one, `expired` when the window ended with none. Set exactly when
 * `target_scope = 'next'`. Mirrors `chk_automations_next_post_status`.
 */
export const AUTOMATION_NEXT_POST_STATUSES = ['waiting', 'linked', 'expired'] as const;

/** One value of {@link AUTOMATION_NEXT_POST_STATUSES}. */
export type AutomationNextPostStatus = (typeof AUTOMATION_NEXT_POST_STATUSES)[number];

/** The longest automation name (`varchar(255)`, AU7). */
export const AUTOMATION_NAME_MAX_LENGTH = RECORD_SHORT_TEXT_MAX_LENGTH;

/** The most keywords one automation holds (AU7, `chk_automations_keywords`). */
export const AUTOMATION_KEYWORDS_MAX_COUNT = 50;

/** The longest keyword (AU7). */
export const AUTOMATION_KEYWORD_MAX_LENGTH = 100;

/** The most tags one automation holds (AU7, `chk_automations_tags`). */
export const AUTOMATION_TAGS_MAX_COUNT = 20;

/** The longest tag (AU7). */
export const AUTOMATION_TAG_MAX_LENGTH = 50;

/** The most public reply texts one comment automation holds (AU8, `chk_automations_public_reply_texts`). */
export const AUTOMATION_PUBLIC_REPLY_TEXTS_MAX_COUNT = 20;

/** The longest public reply text (AU7). */
export const AUTOMATION_PUBLIC_REPLY_TEXT_MAX_LENGTH = 300;

/** The longest text of a step's message (schema-routes § 10). */
export const AUTOMATION_MESSAGE_TEXT_MAX_LENGTH = 1000;

/** The longest title of a message button or link (schema-routes § 10). */
export const AUTOMATION_BUTTON_TITLE_MAX_LENGTH = 20;

/** The most link buttons the final message carries (schema-routes § 10). */
export const AUTOMATION_FINAL_MESSAGE_LINKS_MAX_COUNT = 3;

/**
 * The longest `https://` address a final-message link takes. The review fixes the scheme only
 * (schema-routes § 10); this is the address length browsers and Instagram's link buttons accept.
 */
export const AUTOMATION_LINK_URL_MAX_LENGTH = 2048;

/** An Instagram media or story id as Meta sends it: digits only (`chk_automations_instagram_ids`). */
export const AUTOMATION_INSTAGRAM_ID_PATTERN = '^[0-9]{1,64}$';

/**
 * How far back a new or changed "next post" start may go (AU9): 24 hours, so the frontend can send
 * the user's local midnight.
 */
export const AUTOMATION_NEXT_POST_START_GRACE_MILLISECONDS = 24 * MILLISECONDS_PER_HOUR;

/**
 * The automation list's sorts (AU13, AQ9): `created_at` is the default; `last_triggered_at` puts
 * never-triggered automations last in both directions.
 */
export const AUTOMATION_SORT_FIELDS = [
  'created_at',
  'name',
  'last_triggered_at',
  'completed_run_count',
] as const;

/** One of {@link AUTOMATION_SORT_FIELDS}. */
export type AutomationSortField = (typeof AUTOMATION_SORT_FIELDS)[number];

/** The sort a list without `sort` uses (AU13). */
export const AUTOMATION_DEFAULT_SORT: AutomationSortField = 'created_at';

/** The audit resource type of every automation action (AU4, K9). */
export const AUTOMATION_AUDIT_RESOURCE_TYPE = 'automation';
