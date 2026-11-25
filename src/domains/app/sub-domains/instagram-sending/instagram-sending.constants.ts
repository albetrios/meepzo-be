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
 * How many tasks of one organization one process works at once on the Meta-calling task queue
 * (`instagram-tasks`, scale review S19, P97 — a quarter of its default 20 places), so one
 * organization's uploads or set-ups never hold every place.
 */
export const INSTAGRAM_TASKS_PER_ORGANIZATION_MAX = 5;

/**
 * How many tasks of one organization one process works at once on the database-heavy task queue
 * (`instagram-database-tasks`, S19, P97 — half its default 4 places): one organization's 100,000
 * contact bulk change or segment count leaves room for every other organization's.
 */
export const INSTAGRAM_DATABASE_TASKS_PER_ORGANIZATION_MAX = 2;

/** How far a task goes back, no try used, when its organization is at its cap (S19). */
export const INSTAGRAM_TASK_ORGANIZATION_CAP_DELAY_MILLISECONDS = 2000;

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

/**
 * The result group of one send attempt (plan §33.3, SN5): `sent`, or the one group of 6.A.10 Meta's
 * answer (or its absence) maps to — `app.instagram_send_attempts.result_group`. "In a row" and the
 * outage rules read these from the attempts, never Redis.
 */
export const INSTAGRAM_SEND_RESULT_GROUPS = [
  'sent',
  'too_fast',
  'blocked',
  'account_flagged',
  'login_expired',
  'account_not_shared',
  'access_off',
  'app_not_approved',
  'app_limit',
  'comment_gone',
  'live_ended',
  'attachment',
  'other_app',
  'window_closed',
  'person',
  'wrong_permission',
  'bad_text',
  'hide_failed',
  'check_not_possible',
  'try_later',
  'no_answer',
  'never_connected',
  'already_sent_first',
] as const;

/** One value of {@link INSTAGRAM_SEND_RESULT_GROUPS}. */
export type InstagramSendResultGroup = (typeof INSTAGRAM_SEND_RESULT_GROUPS)[number];

/**
 * Meta's error codes and the group each maps to (plan §33.1, 6.A.10; P4 — the code lists are
 * constants). `subcode`: a number matches that subcode only, `'none'` an answer without a subcode,
 * `'any'` every subcode. The first entry that matches wins, so a code's subcode entries come before
 * its `'any'` entry; codes not listed are `wrong_permission` (other 10, 200–299), `bad_text` (other
 * 100) or `try_later` (any other code) — `classifyInstagramSendError`.
 *
 * @remarks
 * `CODES_ALREADY_SENT`, `CODES_LIVE_ENDED`, `CODES_ATTACHMENT_GONE` and the "account no longer
 * shared" code are still to be named by Meta's tests (SN5, P36): those groups have no entry yet.
 */
export const INSTAGRAM_SEND_ERROR_CODE_GROUPS: readonly {
  code: number;
  subcode: number | 'none' | 'any';
  group: InstagramSendResultGroup;
}[] = [
  { code: 190, subcode: 'any', group: 'login_expired' },
  { code: 368, subcode: 'any', group: 'blocked' },
  { code: 10, subcode: 1_893_063, group: 'blocked' },
  { code: 100, subcode: 2_534_029, group: 'blocked' },
  { code: 613, subcode: 2_018_338, group: 'blocked' },
  { code: 613, subcode: 'any', group: 'too_fast' },
  { code: 17, subcode: 'any', group: 'too_fast' },
  { code: 32, subcode: 'any', group: 'too_fast' },
  { code: 80_002, subcode: 'any', group: 'too_fast' },
  { code: 80_006, subcode: 'any', group: 'too_fast' },
  { code: 4, subcode: 'none', group: 'app_limit' },
  { code: 4, subcode: 'any', group: 'account_flagged' },
  { code: 341, subcode: 'any', group: 'app_limit' },
  { code: 200, subcode: 2_534_041, group: 'access_off' },
  { code: 10, subcode: 2_534_077, group: 'access_off' },
  { code: 200, subcode: 2_018_028, group: 'app_not_approved' },
  { code: 10, subcode: 2_018_300, group: 'other_app' },
  { code: 100, subcode: 2_534_037, group: 'other_app' },
  { code: 10, subcode: 2_018_278, group: 'window_closed' },
  { code: 10, subcode: 2_534_022, group: 'window_closed' },
  { code: 551, subcode: 'any', group: 'person' },
  { code: 1_545_041, subcode: 'any', group: 'person' },
  { code: 10, subcode: 2_018_108, group: 'person' },
  { code: 100, subcode: 2_534_014, group: 'person' },
  { code: 100, subcode: 2_018_001, group: 'person' },
  { code: 100, subcode: 33, group: 'comment_gone' },
  { code: 100, subcode: 2_534_025, group: 'comment_gone' },
  { code: 1, subcode: 'any', group: 'try_later' },
  { code: 2, subcode: 'any', group: 'try_later' },
];

/**
 * The send core's numbers (plan §31, §33; SN3–SN5, P4), one place. Ladders are read by the stop's
 * `stop_count` (the last step repeats).
 *
 * @remarks
 * Consequences of change: a value the lanes read changed → raise {@link SENDING_SETTINGS_VERSION}.
 */
export const INSTAGRAM_SEND_CORE_SETTINGS = {
  /** A claimed message's lease and a lane turn's lease (SN3 (d)): after it the repair settles it. */
  leaseSeconds: 120,
  /** Gate 1's Redis wait (SN3); a slower answer passes the gate. */
  gateOneTimeoutMilliseconds: 100,
  /** Timeouts in a row after which gate 1 is skipped (SN3). */
  gateOneTimeoutsBeforeSkip: 3,
  /** How long gate 1 is skipped after those timeouts (SN3). */
  gateOneSkipMilliseconds: 30_000,
  /** A result save that met a deadlock or a lock timeout is tried this many more times (SN4). */
  saveLockRetries: 3,
  /** A result save that lost its connection waits these seconds before each next try (SN4). */
  saveConnectionRetrySeconds: [1, 2, 4, 8],
  /** `too_fast` stops its lane this many minutes when Meta names no longer time (plan §33.1). */
  tooFastStopMinutes: [15, 30, 60, 120, 240, 360],
  /** `blocked` and `account_flagged` are tested after these hours (plan §33.1). */
  blockedTestHours: [24, 48, 72],
  /** `access_off` and `app_not_approved` are tested every this many minutes (`ACCESS_TEST_MINUTES`). */
  accessTestMinutes: 60,
  /** The all-accounts `app_limit` stop, by its count (`APP_STOP_MINUTES`, plan §33.6). */
  appStopMinutes: [15, 30, 60],
  /**
   * After an all-accounts stop's good test the lanes are released over this many minutes
   * (`RELEASE_SPREAD_MINUTES`, plan §33.6 rule 3), each at half speed for `halfSpeedHours`.
   */
  allReleaseSpreadMinutes: 5,
  /** A lane that wakes while another takes the all-accounts test looks again this much later. */
  allTestWaitSeconds: 30,
  /** `app_limit` from two accounts within this many minutes stops every account (`APP_LIMIT_WINDOW_MINUTES`). */
  appLimitWindowMinutes: 5,
  /** "No answer" or "try later" results in a row that stop an account (`DOWN_IN_A_ROW`). */
  downInARow: 3,
  /** The account's `instagram_down` stop, by its count (`DOWN_STOP_MINUTES`, plan §33.5). */
  downStopMinutes: [5, 10, 20, 40],
  /** Different people in a row with `wrong_permission` that stop every lane (plan §33.2 rule 3). */
  wrongPermissionPeopleInARow: 3,
  /** Half speed after a passed test (`HALF_SPEED_HOURS`, plan §33.4). */
  halfSpeedHours: 1,
  /** Half speed after a passed test of a block (`HALF_SPEED_AFTER_BLOCK_HOURS`). */
  halfSpeedAfterBlockHours: 24,
  /** One account test's lease (`TEST_LEASE_MINUTES`, plan §33.4). */
  testLeaseMinutes: 2,
  /**
   * Test turns whose answer was about that person or text before the stop waits its time again
   * (`TEST_MAX_TURNS`, plan §33.4).
   */
  testMaxTurns: 3,
  /** A waiting opening DM's "try later" waits, then `failed` (`TRY_LATER_MINUTES`). */
  tryLaterMinutes: [1, 5, 15],
  /** A surely-not-sent call ("never connected") comes back after these seconds (plan §33.1). */
  neverConnectedRetrySeconds: [5, 15, 60],
  /** A follow check that could not read the follow tries once more, then counts as following (§30.9). */
  followCheckTries: 1,
  /** A lane turn with nothing to send looks again after this many seconds. */
  idleTurnSeconds: 60,
} as const;

/**
 * The slow lane's numbers (plan §28, WC-5, D5): the box, the gap, the pick's mix and how many picks
 * one turn may look at.
 *
 * @remarks
 * Consequences of change: a value the lanes read changed → raise {@link SENDING_SETTINGS_VERSION}.
 */
export const SLOW_LANE_SETTINGS = {
  /** At least this long between two opening DMs of one account (`OPENING_MIN_GAP_MS`). */
  minimumGapMilliseconds: 1500,
  /** Half speed makes the box this many times longer (`HALF_SPEED_FACTOR`). */
  halfSpeedFactor: 2,
  /** A comment under this many minutes old is "new" (`PICK_NEW_MINUTES`). */
  newCommentMinutes: 60,
  /** The mix places of one round (`pick_count` 1–5). */
  mixPlaces: 5,
  /** Places 1–4 take a new comment (`PICK_MIX_NORMAL` 4 : 1). */
  newPlacesNormal: 4,
  /** Places 1–3 take a new comment while the oldest is urgent (`PICK_MIX_URGENT` 3 : 2). */
  newPlacesUrgent: 3,
  /** The oldest waiting comment with fewer hours left than this is urgent (`URGENT_HOURS_LEFT`). */
  urgentHoursLeft: 12,
  /** Messages one turn may look at before it gives up for a second (`PICK_TRIES_PER_TURN`). */
  picksPerTurn: 5,
  /** A turn whose picks were all passed over looks again this much later. */
  pickAgainMilliseconds: 1000,
  /** One opening private reply per person per this many hours (D8, the 24-hour person rule). */
  personGapHours: 24,
} as const;

/**
 * The reply lane's numbers (plan §29, WC-6, D32): "Reply like a person"'s gap and Meta's 80 %
 * factor; the lane has no account hour limit, so gate 2 counts its replies against
 * `hourLimitForCounting` only for the watch numbers (§29.5 rule 1).
 *
 * @remarks
 * Consequences of change: a value the lanes read changed → raise {@link SENDING_SETTINGS_VERSION}.
 */
export const REPLY_LANE_SETTINGS = {
  /** At least this long after the account's last ON reply (`PUBLIC_REPLY_GAP_MIN_SECONDS`). */
  gapMilliseconds: 20_000,
  /** ON boxes at Meta's 80 % or at half speed are this many times longer (`REPLY_USAGE_FACTOR`). */
  usageSlowFactor: 2,
  /** Gate 2's limit for the `reply` group: no real limit (§29.5 rule 1), counted for the watch. */
  hourLimitForCounting: 1_000_000,
} as const;

/**
 * The broadcast lane's numbers (plan §30.14, §11.7, WC-8, D68): the 24-hour gap between two
 * broadcasts to one person and how long a message waits when her hour limit is full. The box is
 * the slow lane's (3600 ÷ the broadcast hour limit, ≥ 1.5 s apart, twice as long at half speed).
 *
 * @remarks
 * Consequences of change: a value the lanes read changed → raise {@link SENDING_SETTINGS_VERSION}.
 */
export const BROADCAST_LANE_SETTINGS = {
  /** At most one broadcast per person in this many hours (`BROADCAST_MIN_GAP_HOURS`). */
  personGapHours: 24,
  /** Her hour limit full (plan §30.14 step 7): the message's `not_before` moves this much later. */
  personLimitRetryMinutes: 5,
} as const;

/**
 * The fast lane's numbers (plan §30, WC-7, S21): the waits of one fast message's ticket, the
 * per-account and per-organization in-flight caps, the answer delays and the Live reply's age.
 *
 * @remarks
 * Consequences of change: a value the lanes read changed → raise {@link SENDING_SETTINGS_VERSION}.
 * The organization cap is a quarter of the default fast places of one server
 * (`WORKER_CONCURRENCY_INSTAGRAM_SEND_FAST` 100, scale review S21).
 */
export const FAST_LANE_SETTINGS = {
  /** Her contact is being claimed, or another of her messages is `sending` (`FAST_PERSON_BUSY_RETRY_MS`). */
  personBusyRetryMilliseconds: 1000,
  /** The account's (or the organization's) places are all taken (`FAST_ACCOUNT_BUSY_RETRY_MS`). */
  accountBusyRetryMilliseconds: 500,
  /** Audio messages of one account `sending` at once (`AUDIO_MAX_PARALLEL_PER_ACCOUNT`). */
  audioSendingMax: 5,
  /** Fast messages of one organization `sending` at once across its accounts (S21). */
  organizationSendingMax: 25,
  /** The random delay before an answer, lowest (`ANSWER_DELAY_MIN_MS`, plan §30.2 step 13). */
  answerDelayMinimumMilliseconds: 500,
  /** The random delay before an answer, highest (`ANSWER_DELAY_MAX_MS`). */
  answerDelayMaximumMilliseconds: 2000,
  /** Her event + both delays at most this long (`BOT_ANSWER_MAX_SECONDS` 30 − 5 safety, §30.12). */
  answerLatestMilliseconds: 25_000,
  /** A follow check's second try comes after a random wait, lowest (`FOLLOW_CHECK_RETRY_MIN_MS`). */
  followCheckRetryMinimumMilliseconds: 2000,
  /** … and highest (`FOLLOW_CHECK_RETRY_MAX_MS`). */
  followCheckRetryMaximumMilliseconds: 5000,
  /** A Live private reply older than this is `expired` · `live_ended` without a call (`LIVE_REPLY_MAX_AGE_MINUTES`). */
  liveReplyMaximumAgeMinutes: 240,
} as const;

/**
 * How often the plan-stop backup looks for organizations still holding `plan_ended` (WC-38's
 * 15-minute backup — ROUTE row R52): every 15 minutes, its own repair duty.
 */
export const INSTAGRAM_PLAN_STOP_BACKUP_MINUTES = 15;

/** An organization's lane wake after its plan stops end is spread over 5 minutes (WC-37). */
export const INSTAGRAM_PLAN_WAKE_SPREAD_MINUTES = 5;

/**
 * The watches' numbers (ROUTE row R48 — routes-final § 6 SN6, SNC5, SNC9; WC-16, WC-21–WC-24;
 * plan §12.3, §33.5, §33.6, helper rules 10, 15–17): the outage watch, the Live check, the waiting
 * estimate, the server clock and the "Redis lost" watch. Engine numbers in the one settings file
 * (P4, AC-17.25).
 */
export const INSTAGRAM_SENDING_WATCH_SETTINGS = {
  /** The outage watch's cadence (`DOWN_CHECK_EVERY_SECONDS`, P7): every 10 seconds. */
  outageCheckMilliseconds: 10_000,
  /** The window the "30 % bad calls" rule reads (`BAD_WINDOW_SECONDS`). */
  badWindowSeconds: 30,
  /** At least this many calls in the window before the rule counts (`BAD_MIN_CALLS`). */
  badMinCalls: 50,
  /** This share of bad calls in the window stops every account (`BAD_PERCENT`). */
  badPercent: 30,
  /** This share of active accounts in a down stop stops every account (`DOWN_ALL_SHARE_PERCENT`). */
  downAllSharePercent: 30,
  /** The all-accounts `instagram_down` stop, by its count (`DOWN_STOP_MINUTES`, plan §33.5). */
  allDownStopMinutes: [5, 10, 20, 40],
  /** The all-accounts stop count goes back to 0 after this many quiet hours (plan §33.6 rule 4). */
  allStopCountResetHours: 24,
  /** A lane `ready` or `sleeping` this many minutes past its turn counts as late (`LATE_TICKET_MINUTES`). */
  lateTicketMinutes: 1,
  /** A Live reply waits at most this long after its comment (`LIVE_REPLY_MAX_AGE_MINUTES`). */
  liveReplyMaxAgeMinutes: FAST_LANE_SETTINGS.liveReplyMaximumAgeMinutes,
  /** Accounts one Live check page reads. */
  liveCheckPageSize: 200,
  /** The estimate's cadence (`PENDING_ESTIMATE_EVERY_MINUTES`, D10, S29). */
  estimateEveryMinutes: 10,
  /** Accounts one estimate page reads. */
  estimatePageSize: 200,
  /** The estimate looks this many hours ahead (plan §12.3: h = 1 … 168). */
  estimateHorizonHours: 168,
  /** The old line's share of an hour (plan §28: new : old 4 : 1). */
  estimateOldShare: 1 / 5,
  /** The old line's share with the urgent mix on (3 : 2, a waiting DM under 12 hours left). */
  estimateUrgentOldShare: 2 / 5,
  /** A waiting DM with under this many hours left turns the urgent mix on (plan §28). */
  estimateUrgentHours: 12,
  /** A server clock this far from Postgres's takes no tickets (`CLOCK_SKEW_MAX_MS`, WC-23). */
  clockSkewMaxMilliseconds: 2_000,
  /** The clock check's cadence in each server process (helper rule 15: every minute). */
  clockCheckMilliseconds: 60_000,
  /** The "Redis lost" watch's cadence in each server process (P7: a 10-second Redis-down check). */
  redisWatchMilliseconds: 10_000,
} as const;

/**
 * The sending repair duties' numbers (feat-instagram-dm-sending § 6 SN6, WC-13–WC-20; P94), one
 * place. The 40 s budget and the 500-row piece are every repair duty's (`repair-duty.util.ts`).
 *
 * @remarks
 * Consequences of change: none for the lanes — the duties read these, the lanes do not.
 */
export const INSTAGRAM_SENDING_REPAIR_SETTINGS = {
  /** A turn or a fast message over this late with no ticket is lost (WC-13). */
  lateTurnMilliseconds: 60_000,
  /** After a fast stop ended, its waiting fast messages are spread over this time (WC-13). */
  fastSpreadAfterStopMilliseconds: 5 * 60_000,
  /** "Reply like a person": waiting public replies kept per automation (WC-18). */
  replyBacklogMax: 500,
  /** Minute counts are kept this long (WC-20). */
  minuteCountKeepMilliseconds: 2 * 60 * 60_000,
  /** Gate 1's quick count may differ from the minute counts by this much before it is a mismatch (WC-20). */
  quickCountTolerance: 2,
  /** The UTC hour of the daily month-count comparison (WC-20, "once a day"). */
  dailyMonthCheckHourUtc: 3,
} as const;
