import { RECORD_SHORT_TEXT_MAX_LENGTH } from '@/shared/constants/record-fields.constants.js';

/**
 * Every value of `app.automations.status` (feat-instagram-dm-sending routes-final § 4 AU3, D28):
 * `draft` (needs only a name), `live` (answers events), `paused` (stopped by its owner). Changed by
 * actions only — go live (route 32), pause (route 33). Mirrors `chk_automations_status`.
 */
export const AUTOMATION_STATUSES = ['draft', 'live', 'paused'] as const;

/** One value of {@link AUTOMATION_STATUSES}. */
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

/**
 * The 15 ways to start an automation (AU8, D37), each with its Flowdm group (plan §4.1 — a saved
 * automation's way to start changes only inside its group, AU12). Mirrors
 * `chk_automations_trigger_type`.
 */
export const AUTOMATION_TRIGGER_TYPE_GROUPS = {
  comment: 'comment',
  live_comment: 'comment',
  story_reply: 'story',
  story_mention: 'story',
  story_repost: 'story',
  dm_keyword: 'message',
  first_message: 'message',
  shared_post: 'message',
  starter_question: 'message',
  ref_link: 'message',
  default_reply: 'message',
  ad_comment: 'ad',
  ad_message: 'ad',
  tag_added: 'tag',
  tag_removed: 'tag',
} as const;

/** Every value of `app.automations.trigger_type` (AU8). */
export const AUTOMATION_TRIGGER_TYPES = Object.keys(AUTOMATION_TRIGGER_TYPE_GROUPS) as [
  keyof typeof AUTOMATION_TRIGGER_TYPE_GROUPS,
  ...(keyof typeof AUTOMATION_TRIGGER_TYPE_GROUPS)[],
];

/** One value of {@link AUTOMATION_TRIGGER_TYPES}. */
export type AutomationTriggerType = keyof typeof AUTOMATION_TRIGGER_TYPE_GROUPS;

/** The ways to start on a comment — the private reply allows one message until she answers (go-live check 12). */
export const AUTOMATION_COMMENT_TRIGGER_TYPES: readonly AutomationTriggerType[] = [
  'comment',
  'live_comment',
  'ad_comment',
];

/** The ways to start where she messaged first — the only ones a hello `nudge` fits (plan §18.5, D30). */
export const AUTOMATION_SHE_MESSAGED_FIRST_TRIGGER_TYPES: readonly AutomationTriggerType[] = [
  'story_reply',
  'story_mention',
  'story_repost',
  'dm_keyword',
  'first_message',
  'shared_post',
  'starter_question',
  'ref_link',
  'default_reply',
  'ad_message',
];

/** The ways to start only one live automation of an account may use (go-live check 10, D44). */
export const AUTOMATION_CATCH_ALL_TRIGGER_TYPES: readonly AutomationTriggerType[] = [
  'first_message',
  'default_reply',
];

/**
 * Every value of `app.automations.target_scope` (AU8, D39): any post or story, one `specific` one,
 * the `next` post published after go-live, or posts published `between` two dates. Mirrors
 * `chk_automations_target_scope`.
 */
export const AUTOMATION_TARGET_SCOPES = ['any', 'specific', 'next', 'between'] as const;

/** One value of {@link AUTOMATION_TARGET_SCOPES}. */
export type AutomationTargetScope = (typeof AUTOMATION_TARGET_SCOPES)[number];

/** The scopes each way to start may use at go-live (`chk_automations_live_target`, plan §18.5). */
export const AUTOMATION_TARGET_SCOPES_BY_TRIGGER_TYPE: Readonly<
  Partial<Record<AutomationTriggerType, readonly AutomationTargetScope[]>>
> = {
  comment: ['any', 'specific', 'next', 'between'],
  story_reply: ['any', 'specific'],
  shared_post: ['any', 'specific'],
};

/**
 * Every value of `app.automations.next_post_status` (AU20, P12): `waiting` for the first post
 * published after go-live, `linked` to it — no end date, so never `expired`. Mirrors
 * `chk_automations_next_post_status`.
 */
export const AUTOMATION_NEXT_POST_STATUSES = ['waiting', 'linked'] as const;

/** One value of {@link AUTOMATION_NEXT_POST_STATUSES}. */
export type AutomationNextPostStatus = (typeof AUTOMATION_NEXT_POST_STATUSES)[number];

/** The other events an automation may also start from (D38 — replaces the launch's DM switch). */
export const AUTOMATION_ALSO_START_FROM_VALUES = ['story_reply', 'dm'] as const;

/** One value of {@link AUTOMATION_ALSO_START_FROM_VALUES}. */
export type AutomationAlsoStartFrom = (typeof AUTOMATION_ALSO_START_FROM_VALUES)[number];

/** Which "also start from" each way to start allows at go-live (`chk_automations_live_also_start_from`). */
export const AUTOMATION_ALSO_START_FROM_BY_TRIGGER_TYPE: Readonly<
  Partial<Record<AutomationTriggerType, readonly AutomationAlsoStartFrom[]>>
> = {
  comment: ['story_reply', 'dm'],
  story_reply: ['dm'],
  dm_keyword: ['story_reply'],
};

/** Every value of `app.automations.default_reply_mode` (D44). */
export const AUTOMATION_DEFAULT_REPLY_MODES = ['once_a_day', 'every_time'] as const;

/** One value of {@link AUTOMATION_DEFAULT_REPLY_MODES}. */
export type AutomationDefaultReplyMode = (typeof AUTOMATION_DEFAULT_REPLY_MODES)[number];

/** The "Reply like a person" public replies per hour an owner may pick (D32, `REPLY_LIKE_PERSON_LIMITS`). */
export const AUTOMATION_PUBLIC_REPLY_HOUR_LIMITS = [10, 20, 30, 60, 100] as const;

/** The hour limit an empty `public_reply_hour_limit` means (`REPLY_LIKE_PERSON_LIMIT_DEFAULT`). */
export const AUTOMATION_PUBLIC_REPLY_HOUR_LIMIT_DEFAULT = 60;

/** The fewest public reply lines "Reply like a person" needs at go-live (`PUBLIC_REPLY_LINES_MIN_ON`, D52). */
export const AUTOMATION_PUBLIC_REPLY_LINES_WITH_REPLY_LIKE_PERSON_MIN_COUNT = 3;

/** Every value of `app.automations.stopped_reason` — the automatic stops (sub-domains 5–6, AU3). */
export const AUTOMATION_STOPPED_REASONS = ['bad_text', 'post_deleted'] as const;

/** The pause modes of route 33 (AU14): keep the waiting messages, or cancel them. */
export const AUTOMATION_PAUSE_MODES = ['keep', 'cancel'] as const;

/** One value of {@link AUTOMATION_PAUSE_MODES}. */
export type AutomationPauseMode = (typeof AUTOMATION_PAUSE_MODES)[number];

/** The seven message kinds of the message list (plan §18.5 `messages[]`). */
export const AUTOMATION_MESSAGE_KINDS = [
  'text',
  'image',
  'cards',
  'quick_replies',
  'audio',
  'file',
  'post',
] as const;

/** One value of {@link AUTOMATION_MESSAGE_KINDS}. */
export type AutomationMessageKind = (typeof AUTOMATION_MESSAGE_KINDS)[number];

/** The longest automation name (`varchar(255)`, go-live check 1). */
export const AUTOMATION_NAME_MAX_LENGTH = RECORD_SHORT_TEXT_MAX_LENGTH;

/** The most keywords one automation holds (`chk_automations_keywords`). */
export const AUTOMATION_KEYWORDS_MAX_COUNT = 50;

/** The longest keyword. */
export const AUTOMATION_KEYWORD_MAX_LENGTH = 100;

/** The most tags the tag step holds (`steps.tags.list`). */
export const AUTOMATION_TAGS_MAX_COUNT = 20;

/** The longest tag (also `trigger_tag`, `varchar(50)`). */
export const AUTOMATION_TAG_MAX_LENGTH = 50;

/** The most public reply lines (`PUBLIC_REPLY_TEXTS_MAX`, `chk_automations_public_reply_texts`). */
export const AUTOMATION_PUBLIC_REPLY_TEXTS_MAX_COUNT = 20;

/** The longest public reply line. */
export const AUTOMATION_PUBLIC_REPLY_TEXT_MAX_LENGTH = 300;

/** The longest `ref_code` (`REF_CODE_MAX_CHARS`, D43). */
export const AUTOMATION_REF_CODE_MAX_LENGTH = 64;

/** A `ref_code`: letters, digits, `_`, `=` and `-` (plan §18.5, `chk_automations_ref_code`). */
export const AUTOMATION_REF_CODE_PATTERN = '^[A-Za-z0-9_=-]{1,64}$';

/** The most starter questions one automation and one account hold (`STARTER_QUESTIONS_MAX`, D42). */
export const AUTOMATION_STARTER_QUESTIONS_MAX_COUNT = 4;

/** The longest starter question (`STARTER_QUESTION_MAX_CHARS`). */
export const AUTOMATION_STARTER_QUESTION_MAX_LENGTH = 80;

/** An Instagram media, story or ad id as Meta sends it: digits only (`chk_automations_instagram_ids`). */
export const AUTOMATION_INSTAGRAM_ID_PATTERN = '^[0-9]{1,64}$';

/** The largest `steps` object, in bytes of its JSON text (`AUTOMATION_STEPS_MAX_BYTES`, 64 KB). */
export const AUTOMATION_STEPS_MAX_BYTES = 65_536;

/** The most versions of the hello or the follow ask (`MESSAGE_VERSIONS_MAX`). */
export const AUTOMATION_MESSAGE_VERSIONS_MAX_COUNT = 3;

/** The longest text that carries buttons — Meta's button template (`BUTTON_TEXT_MAX_CHARS`). */
export const AUTOMATION_BUTTON_TEXT_MAX_LENGTH = 640;

/** The most hello buttons (`HELLO_BUTTONS_MAX`). */
export const AUTOMATION_HELLO_BUTTONS_MAX_COUNT = 3;

/** The longest button title (`BUTTON_TITLE_MAX_CHARS`). */
export const AUTOMATION_BUTTON_TITLE_MAX_LENGTH = 20;

/** The longest `https://` link a button carries. */
export const AUTOMATION_LINK_URL_MAX_LENGTH = 2048;

/** The most wordings of the email or phone ask (`QUESTION_WORDINGS_MAX`). */
export const AUTOMATION_QUESTION_WORDINGS_MAX_COUNT = 10;

/** The longest message text without buttons, in UTF-8 bytes (`MESSAGE_TEXT_MAX_BYTES`). */
export const AUTOMATION_MESSAGE_TEXT_MAX_BYTES = 1000;

/** The most messages of the message list (`AUTOMATION_MESSAGES_MAX`). */
export const AUTOMATION_MESSAGES_MAX_COUNT = 10;

/** The longest wait before a message, in minutes (`MESSAGE_WAIT_MAX_HOURS` 23 × 60). */
export const AUTOMATION_MESSAGE_WAIT_MAX_MINUTES = 1380;

/** The most link buttons of a text message (`LINK_BUTTONS_MAX`). */
export const AUTOMATION_LINK_BUTTONS_MAX_COUNT = 3;

/** The most cards of a cards message (`CARDS_MAX`). */
export const AUTOMATION_CARDS_MAX_COUNT = 10;

/** The longest card title and card line (`CARD_TITLE_MAX_CHARS`, `CARD_SUBTITLE_MAX_CHARS`). */
export const AUTOMATION_CARD_TEXT_MAX_LENGTH = 80;

/** The most quick replies (`QUICK_REPLIES_MAX`). */
export const AUTOMATION_QUICK_REPLIES_MAX_COUNT = 13;

/** The longest quick reply (`QUICK_REPLY_MAX_CHARS`). */
export const AUTOMATION_QUICK_REPLY_MAX_LENGTH = 20;

/** The count slots of `app.automation_counts` (AU19): slot = the run's id mod 16. */
export const AUTOMATION_COUNT_SLOTS = 16;

/** How old `last_triggered_at` must be before a run start moves it (`LAST_TRIGGERED_UPDATE_SECONDS`, AU19). */
export const AUTOMATION_LAST_TRIGGERED_UPDATE_SECONDS = 60;

/** The longest keyword-test text (route 35, AU17). */
export const AUTOMATION_KEYWORD_TEST_TEXT_MAX_LENGTH = 1000;

/** Where a keyword-test text comes from (route 35, AU17). */
export const AUTOMATION_KEYWORD_TEST_SOURCES = ['comment', 'dm', 'story_reply'] as const;

/** One value of {@link AUTOMATION_KEYWORD_TEST_SOURCES}. */
export type AutomationKeywordTestSource = (typeof AUTOMATION_KEYWORD_TEST_SOURCES)[number];

/** The random tail a duplicate's or a free `ref_code` gets (AU15). */
export const AUTOMATION_REF_CODE_SUFFIX_LENGTH = 4;

/** The name suffix of a duplicate (AU15). */
export const AUTOMATION_DUPLICATE_NAME_SUFFIX = ' (copy)';

/** The automation list's sorts (AU10): `created_at` is the default; the run-count sort is gone. */
export const AUTOMATION_SORT_FIELDS = ['created_at', 'name', 'last_triggered_at'] as const;

/** One of {@link AUTOMATION_SORT_FIELDS}. */
export type AutomationSortField = (typeof AUTOMATION_SORT_FIELDS)[number];

/** The sort a list without `sort` uses (AU10). */
export const AUTOMATION_DEFAULT_SORT: AutomationSortField = 'created_at';

/** The audit resource type of every automation action (AU7, K9). */
export const AUTOMATION_AUDIT_RESOURCE_TYPE = 'automation';

/** The channel every automation has now (`chk_automations_channel`, D27). */
export const AUTOMATION_CHANNELS = ['instagram'] as const;
