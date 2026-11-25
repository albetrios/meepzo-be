import type { ChannelFeature } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import type { ChannelAccountPlanStopReason } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';

/**
 * The sending settings file (feat-instagram-dm-sending routes-final § 6, P4, D22): every value the
 * lanes, the gates and the account settings read — the settings-file limits an empty owner value
 * falls back to (moved here from the Instagram account settings at ROUTE row R18, P122), the stop
 * words, the features, ways to start and message kinds Meta has not tested yet (P36, moved here
 * from the channel account's capability file, P118), the lanes and their stop groups, and the
 * settings version every release writes (D21, P95).
 *
 * @remarks
 * Code constants, not env (P4): none of them varies by environment. The one environment-varying
 * switch is the env var `SENDING_ENABLED` (with `SENDING_ENVIRONMENT_ID`, SN7). A change of a value
 * the lanes read raises {@link SENDING_SETTINGS_VERSION}.
 */

/** Opening DMs an hour when the owner set none (D5, `OPENING_HOUR_LIMIT_DEFAULT`). */
export const OPENING_HOUR_LIMIT_DEFAULT = 600;

/** The highest opening hour limit the API accepts (D5, `OPENING_HOUR_LIMIT_MAX`); Meta allows 750. */
export const OPENING_HOUR_LIMIT_MAX = 700;

/**
 * Opening DMs an hour of a newly connected account for its first days (D5, `NEW_ACCOUNT_HOUR_LIMIT`)
 * — any owner `opening_hour_limit` replaces it. The window is `CHANNEL_ACCOUNT_NEW_ACCOUNT_LIMIT_DAYS`.
 */
export const NEW_ACCOUNT_HOUR_LIMIT = 150;

/** Whether the opening day limit is read at all (D5, `DAY_LIMIT_ENABLED`) — off. */
export const DAY_LIMIT_ENABLED = false;

/** An empty day limit is the hour limit times this (D5, `DAY_LIMIT_DEFAULT_FACTOR`). */
export const DAY_LIMIT_DEFAULT_FACTOR = 10;

/** The owner's day limit may be at most the hour limit times this (plan:L1957). */
export const DAY_LIMIT_MAX_FACTOR = 24;

/** Fast messages an hour when the owner set none (D11, `FAST_HOUR_LIMIT_DEFAULT`). */
export const FAST_HOUR_LIMIT_DEFAULT = 10_000;

/** The highest fast hour limit the API accepts (D11, `FAST_HOUR_LIMIT_MAX`). */
export const FAST_HOUR_LIMIT_MAX = 20_000;

/** Automatic messages to one person an hour when the owner set none (D11, `PERSON_HOUR_LIMIT_DEFAULT`). */
export const PERSON_HOUR_LIMIT_DEFAULT = 60;

/** The range of the owner's person hour limit (plan:L1960). */
export const PERSON_HOUR_LIMIT_RANGE = { min: 5, max: 100 } as const;

/** Broadcast messages an hour when the owner set none (D68, `BROADCAST_HOUR_LIMIT_DEFAULT`). */
export const BROADCAST_HOUR_LIMIT_DEFAULT = 600;

/** The highest broadcast hour limit (D68, `BROADCAST_HOUR_LIMIT_MAX`). */
export const BROADCAST_HOUR_LIMIT_MAX = 2000;

/** The highest end of the extra delay before each message, in seconds (D67, `EXTRA_DELAY_MAX_SECONDS`). */
export const EXTRA_DELAY_MAX_SECONDS = 20;

/** The stop words every account has (D49, `STOP_WORDS`); the owner's `extra_stop_words` add to them. */
export const STOP_WORDS: readonly string[] = ['stop', 'unsubscribe'];

/** At most this many owner stop words (plan:L2906). */
export const EXTRA_STOP_WORDS_MAX = 50;

/** Each owner stop word is at most this many characters (IA12). */
export const EXTRA_STOP_WORD_MAX_LENGTH = 50;

/**
 * The features whose Meta test has not passed yet (P36, K12) — `feature_not_offered` until they
 * leave this list. Mark as seen is the one feature of `CHANNEL_FEATURE_KEYS` on P36's list.
 */
export const APP_UNTESTED_META_FEATURES: readonly ChannelFeature[] = ['mark_seen'];

/**
 * The ways to start an automation whose Meta test has not passed yet (P36): a story repost, an ad
 * comment, a Live comment and the 7-day ad window. Go-live refuses them (4.A AU4, a later row).
 */
export const APP_UNTESTED_META_TRIGGER_TYPES: readonly string[] = [
  'story_repost',
  'ad_comment',
  'live_comment',
  'ad_message',
];

/** The message kinds whose Meta test on Unified Login has not passed yet (P36): quick replies, cards. */
export const APP_UNTESTED_META_MESSAGE_KINDS: readonly string[] = ['quick_replies', 'cards'];

/**
 * The settings version of this build (D21, SN7). Each release writes it to `app.sending_states`; a
 * newer one raises `settings_version`. A whole number, written as text — raise it by one whenever a
 * value the lanes read changes.
 */
export const SENDING_SETTINGS_VERSION = '1';

/**
 * The oldest settings version this build can send beside (P95). Raised only by a release that is
 * actually incompatible with older servers; a server older than the stored minimum takes no tickets.
 */
export const SENDING_MINIMUM_COMPATIBLE_SETTINGS_VERSION = '1';

/** The four lanes of an account (SN12, D4): opening DMs, public replies and hides, every other DM, broadcasts. */
export const INSTAGRAM_SEND_LANES = ['slow', 'reply', 'fast', 'broadcast'] as const;

/** One value of {@link INSTAGRAM_SEND_LANES}. */
export type InstagramSendLane = (typeof INSTAGRAM_SEND_LANES)[number];

/** A lane's state (6.A.3): the fast lane is only `ready` or `stopped`. */
export const INSTAGRAM_SEND_LANE_STATE = {
  READY: 'ready',
  WORKING: 'working',
  SLEEPING: 'sleeping',
  STOPPED: 'stopped',
} as const;

/** One value of {@link INSTAGRAM_SEND_LANE_STATE}. */
export type InstagramSendLaneState =
  (typeof INSTAGRAM_SEND_LANE_STATE)[keyof typeof INSTAGRAM_SEND_LANE_STATE];

/** Why a lane waits (6.A.3). */
export const INSTAGRAM_SEND_WAIT_REASONS = [
  'box',
  'gap',
  'hour_limit',
  'day_limit',
  'not_before',
  'stop',
  'test',
] as const;

/** One value of {@link INSTAGRAM_SEND_WAIT_REASONS}. */
export type InstagramSendWaitReason = (typeof INSTAGRAM_SEND_WAIT_REASONS)[number];

/**
 * The error stop groups a lane can hold (SN5, 6.A.10), weakest first: a new stop replaces the
 * lane's current one only when it is at least as strong ({@link INSTAGRAM_SEND_STOP_STRENGTH}).
 * `app_limit` stops every account through `app.sending_states`, never a lane row.
 */
export const INSTAGRAM_SEND_STOP_REASONS = [
  'too_fast',
  'instagram_down',
  'access_off',
  'app_not_approved',
  'account_flagged',
  'blocked',
  'wrong_permission',
  'account_not_shared',
  'login_expired',
] as const;

/** One value of {@link INSTAGRAM_SEND_STOP_REASONS}. */
export type InstagramSendStopReason = (typeof INSTAGRAM_SEND_STOP_REASONS)[number];

/**
 * Each stop group's strength: its place in {@link INSTAGRAM_SEND_STOP_REASONS}. A stop the owner
 * must end (a reconnect: `login_expired`, `account_not_shared`, `wrong_permission`) outranks every
 * stop that ends by itself; among those, the longer-lasting group outranks the shorter.
 */
export const INSTAGRAM_SEND_STOP_STRENGTH: Readonly<Record<InstagramSendStopReason, number>> =
  Object.fromEntries(INSTAGRAM_SEND_STOP_REASONS.map((reason, index) => [reason, index])) as Record<
    InstagramSendStopReason,
    number
  >;

/** The stop groups a reconnect ends (MC6, SN5): the owner acted, so their lanes go again. */
export const INSTAGRAM_SEND_RECONNECT_STOP_REASONS: readonly InstagramSendStopReason[] = [
  'login_expired',
  'account_not_shared',
  'wrong_permission',
];

/** The stop history's `lane`: one lane, or `all` for a plan stop or an account-wide stop (SN13). */
export const INSTAGRAM_SEND_STOP_LANES = [...INSTAGRAM_SEND_LANES, 'all'] as const;

/** One value of {@link INSTAGRAM_SEND_STOP_LANES}. */
export type InstagramSendStopLane = (typeof INSTAGRAM_SEND_STOP_LANES)[number];

/** What ended a stop (SN13). */
export const INSTAGRAM_SEND_STOP_ENDED_BY = {
  TIME: 'time',
  TEST: 'test',
  OWNER: 'owner',
  TEAM: 'team',
} as const;

/** One value of {@link INSTAGRAM_SEND_STOP_ENDED_BY}. */
export type InstagramSendStopEndedBy =
  (typeof INSTAGRAM_SEND_STOP_ENDED_BY)[keyof typeof INSTAGRAM_SEND_STOP_ENDED_BY];

/** The count groups of gate 2 (SN3): one per lane's kind of message. */
export const INSTAGRAM_SEND_COUNT_GROUPS = ['open', 'reply', 'fast', 'broadcast'] as const;

/** One value of {@link INSTAGRAM_SEND_COUNT_GROUPS}. */
export type InstagramSendCountGroup = (typeof INSTAGRAM_SEND_COUNT_GROUPS)[number];

/** The slots one organization's month count is split into, by account (D34). */
export const MESSAGE_MONTH_COUNT_SLOTS = 16;

/** The month meter's `nearly` share (SN15, D34): 80 % of the limit. */
export const MESSAGE_MONTH_NEARLY_SHARE = 0.8;

/** At most this many fast messages of one account are `sending` at once (plan §30). */
export const INSTAGRAM_SEND_FAST_SENDING_MAX = 20;

/**
 * The lanes each plan stop of the channel account holds (CA3, D62, P99): `plan_limit` lets the reply
 * lane go on; `plan_ended` and `plan_downgrade` hold all four.
 */
export const PLAN_STOP_HELD_LANES: Readonly<
  Record<ChannelAccountPlanStopReason, readonly InstagramSendLane[]>
> = {
  plan_limit: ['slow', 'fast', 'broadcast'],
  plan_ended: INSTAGRAM_SEND_LANES,
  plan_downgrade: INSTAGRAM_SEND_LANES,
};

/** The all-accounts stop's reasons on `app.sending_states` (6.A.3). */
export const SENDING_ALL_STOP_REASONS = ['app_limit', 'instagram_down'] as const;

/** Route 64 lists `trial_ending` while the trial ends within this many days (SN15). */
export const APP_USAGE_TRIAL_ENDING_NOTICE_DAYS = 3;

/**
 * The lanes whose turns ride the slow-lane queue `instagram-send-slow` (SN2): one ticket per lane
 * turn; the fast lane has one ticket per message on `instagram-send-fast`.
 */
export const INSTAGRAM_SLOW_QUEUE_LANES = ['slow', 'reply', 'broadcast'] as const;

/** A lane whose turns ride `instagram-send-slow` (SN2). */
export type InstagramSlowQueueLane = (typeof INSTAGRAM_SLOW_QUEUE_LANES)[number];

/** BullMQ priority of a broadcast lane turn on `instagram-send-slow` (SN2): behind the others. */
export const INSTAGRAM_BROADCAST_TURN_PRIORITY = 10;

/**
 * Name of the in-process database limiter the Instagram send, intake and task workers share (SN24,
 * P91) — one per process, sized by `WORKER_INSTAGRAM_DATABASE_SLOTS`.
 */
export const INSTAGRAM_DATABASE_SLOT_LIMITER_NAME = 'instagram-database';

/**
 * How far a ticket goes back when this server may not take tickets now (SN7, P95 — sending off,
 * another environment, an older settings version): the minute `mayTakeTickets` keeps its answer.
 */
export const SENDING_REFUSED_TICKET_DELAY_MILLISECONDS = 60_000;

/**
 * Tries of a file's upload to Meta just before a send when the account has no attachment row yet
 * (SN20): after this many the message ends `failed` · `attachment_failed`, not counted (the send
 * core counts the tries on the message, ROUTE row R42).
 */
export const INSTAGRAM_ATTACHMENT_UPLOAD_MAX_TRIES = 3;

/**
 * The message-file content types Instagram takes and the attachment type each is sent as (SN20,
 * SN21 — the upload domain's `message-media` purpose, RC-61): images, voice notes, PDFs.
 */
export const INSTAGRAM_ATTACHMENT_TYPE_OF_CONTENT_TYPE: Readonly<
  Record<string, 'image' | 'audio' | 'file'>
> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'audio/aac': 'audio',
  'audio/mp4': 'audio',
  'audio/x-m4a': 'audio',
  'audio/wav': 'audio',
  'application/pdf': 'file',
};
