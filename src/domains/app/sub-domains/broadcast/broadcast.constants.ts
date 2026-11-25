import { RECORD_SHORT_TEXT_MAX_LENGTH } from '@/shared/constants/record-fields.constants.js';

/** The longest broadcast name, after trim (BC8, `chk_broadcasts_name`). */
export const BROADCAST_NAME_MAX_LENGTH = RECORD_SHORT_TEXT_MAX_LENGTH;

/** The most messages one broadcast sends (BC8: 1–3; a draft may hold 0). */
export const BROADCAST_MESSAGES_MAX_COUNT = 3;

/** The most bytes of the messages' JSON (BC8: at most 64 KB, `chk_broadcasts_messages`). */
export const BROADCAST_MESSAGES_MAX_BYTES = 65_536;

/** The furthest ahead a scheduled send may be (BC10: at most 30 days). */
export const BROADCAST_SCHEDULE_MAX_DAYS_AHEAD = 30;

/** The fewest days a "when her chat opens" broadcast waits (BC10: 1–7). */
export const BROADCAST_OPEN_WAIT_MIN_DAYS = 1;

/** The most days a "when her chat opens" broadcast waits (BC10). */
export const BROADCAST_OPEN_WAIT_MAX_DAYS = 7;

/**
 * The broadcast's statuses (BC9), moved by actions only: `draft` → `sending` · `scheduled` ·
 * `waiting_for_chats` (route 75); `scheduled` → `sending` (the start duty, R47); `sending` ·
 * `waiting_for_chats` → `done` (the end duty, R47); any but `done` → `cancelled`.
 */
export const BROADCAST_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'waiting_for_chats',
  'done',
  'cancelled',
] as const;

/** One of {@link BROADCAST_STATUSES}. */
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

/** The statuses a broadcast is "active" in — deleting one is `409 broadcast_active` (BC11). */
export const BROADCAST_ACTIVE_STATUSES = [
  'scheduled',
  'sending',
  'waiting_for_chats',
] as const satisfies readonly BroadcastStatus[];

/** The statuses route 76 may cancel from (BC9) — every one but `done` and `cancelled`. */
export const BROADCAST_CANCELLABLE_STATUSES = [
  'draft',
  ...BROADCAST_ACTIVE_STATUSES,
] as const satisfies readonly BroadcastStatus[];

/** The send modes, chosen at send (BC10). */
export const BROADCAST_MODES = ['now', 'scheduled', 'when_chat_opens'] as const;

/** One of {@link BROADCAST_MODES}. */
export type BroadcastMode = (typeof BROADCAST_MODES)[number];

/** The status each send mode moves a draft to (BC9, BC10). */
export const BROADCAST_STATUS_BY_MODE: Readonly<Record<BroadcastMode, BroadcastStatus>> = {
  now: 'sending',
  scheduled: 'scheduled',
  when_chat_opens: 'waiting_for_chats',
};

/** Why a broadcast was cancelled (BC9, BC11): the owner, or a move down (6's plan-change task). */
export const BROADCAST_CANCEL_REASONS = ['owner', 'plan_feature_off'] as const;

/** One of {@link BROADCAST_CANCEL_REASONS}. */
export type BroadcastCancelReason = (typeof BROADCAST_CANCEL_REASONS)[number];

/** The list's sort fields (route 70, 7.A.8): newest first (default) or by name. */
export const BROADCAST_SORT_FIELDS = ['created_at', 'name'] as const;

/** One of {@link BROADCAST_SORT_FIELDS}. */
export type BroadcastSortField = (typeof BROADCAST_SORT_FIELDS)[number];

/** The audit resource of every broadcast route (BC6). */
export const BROADCAST_AUDIT_RESOURCE_TYPE = 'broadcast';
