import { RECORD_SHORT_TEXT_MAX_LENGTH } from '@/shared/constants/record-fields.constants.js';

/** The longest segment name, after trim (BC12, `chk_segments_name`). */
export const SEGMENT_NAME_MAX_LENGTH = RECORD_SHORT_TEXT_MAX_LENGTH;

/** The most conditions one segment's tree holds, in all its groups (BC12). */
export const SEGMENT_CONDITIONS_MAX_COUNT = 20;

/** The most values one `tags` condition names (BC12). */
export const SEGMENT_TAG_VALUES_MAX_COUNT = 20;

/** The longest `commented` keyword (BC12). */
export const SEGMENT_COMMENT_KEYWORD_MAX_LENGTH = 100;

/** The longest `came_in` ref value — the column `contacts.came_in_ref` (`varchar(64)`). */
export const SEGMENT_CAME_IN_REF_MAX_LENGTH = 64;

/** The most days a condition looks back (BC12) — a year. */
export const SEGMENT_LOOKBACK_MAX_DAYS = 365;

/** The most hours `active.last_message_within_hours` looks back — a week. */
export const SEGMENT_LOOKBACK_MAX_HOURS = 168;

/** The highest `got_message` message number and `commented.at_least` (BC12). */
export const SEGMENT_MESSAGE_NUMBER_MAX = 20;

/** The most comments `commented.at_least` asks for. */
export const SEGMENT_COMMENT_AT_LEAST_MAX = 1000;

/** How far back the `automation` condition reads runs (BC12: "runs of the last 90 days"). */
export const SEGMENT_AUTOMATION_RUN_LOOKBACK_DAYS = 90;

/**
 * A broadcast in the last 24 hours always leaves her out of an audience (routes-final § 7.10 — the
 * hard cap on `contact_activities.last_broadcast_at`).
 */
export const SEGMENT_BROADCAST_COOLDOWN_HOURS = 24;

/** The inline audience count's statement timeout (BC14): past it, the count goes to the background. */
export const SEGMENT_AUDIENCE_COUNT_STATEMENT_TIMEOUT_MS = 2000;

/** The group operators of the condition tree (BC12). */
export const SEGMENT_GROUP_OPERATORS = ['and', 'or'] as const;

/** The eight condition fields (BC12). */
export const SEGMENT_CONDITION_FIELDS = [
  'tags',
  'automation',
  'came_in',
  'commented',
  'active',
  'details',
  'story_activity',
  'no_broadcast',
] as const;

/** One of {@link SEGMENT_CONDITION_FIELDS}. */
export type SegmentConditionField = (typeof SEGMENT_CONDITION_FIELDS)[number];

/** How a `tags` condition matches its values (BC12). */
export const SEGMENT_TAG_MATCHES = ['any', 'all', 'none'] as const;

/** The states of an `automation` condition (BC12). */
export const SEGMENT_AUTOMATION_STATES = [
  'started',
  'finished',
  'in_progress',
  'never',
  'tapped_hello',
  'got_message',
] as const;

/** The ways in of a `came_in` condition (BC12). */
export const SEGMENT_CAME_IN_VIAS = [
  'first_automation',
  'ref',
  'starter_question',
  'ad',
  'story_mention',
  'first_message',
] as const;

/** What a `details` condition asks she has (BC12). */
export const SEGMENT_DETAILS_HAS = ['email', 'phone', 'neither', 'follows_account'] as const;

/** The list's sort fields (route 77, 7.B.8): by name (default) or newest first. */
export const SEGMENT_SORT_FIELDS = ['name', 'created_at'] as const;

/** One of {@link SEGMENT_SORT_FIELDS}. */
export type SegmentSortField = (typeof SEGMENT_SORT_FIELDS)[number];

/** The audit resource of every segment route (BC6). */
export const SEGMENT_AUDIT_RESOURCE_TYPE = 'segment';
