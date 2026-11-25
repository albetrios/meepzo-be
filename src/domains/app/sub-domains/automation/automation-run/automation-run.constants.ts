import { MILLISECONDS_PER_DAY, MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';

/**
 * Every value of `app.automation_runs.status` (routes-final § 4.B.3): `running` and `waiting` are
 * open (one per automation and person — the key table `app.automation_run_open_keys`, AU37);
 * `completed`, `failed` and `cancelled` are final. Mirrors `chk_automation_runs_status`.
 */
export const AUTOMATION_RUN_STATUSES = [
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
] as const;

/** One value of {@link AUTOMATION_RUN_STATUSES}. */
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

/** The open statuses — what holds an open-run key (AU37) and what a delete, erase or pause cancels. */
export const AUTOMATION_RUN_OPEN_STATUSES = ['running', 'waiting'] as const;

/**
 * Every value of `app.automation_runs.current_step` (AU21), in run order: the start, the hello and
 * its comment reply, the follow check, the email and phone asks, the message list. Mirrors
 * `chk_automation_runs_current_step`.
 */
export const AUTOMATION_RUN_STEPS = [
  'keyword_match',
  'comment_reply',
  'follow_check',
  'email_collect',
  'phone_collect',
  'messages',
] as const;

/** One value of {@link AUTOMATION_RUN_STEPS}. */
export type AutomationRunStep = (typeof AUTOMATION_RUN_STEPS)[number];

/**
 * What a `waiting` run waits for (AU21, AU25): the hello's "sends your next step" tap (or any text),
 * the "I'm following" tap, an email, a phone number, or `any` message or tap of hers after a send
 * whose result is unknown (D17). Mirrors `chk_automation_runs_waiting_for`.
 */
export const AUTOMATION_RUN_WAITING_FOR = [
  'opening_message_button',
  'follow',
  'email',
  'phone',
  'any',
] as const;

/** One value of {@link AUTOMATION_RUN_WAITING_FOR}. */
export type AutomationRunWaitingFor = (typeof AUTOMATION_RUN_WAITING_FOR)[number];

/**
 * Why a run was cancelled (AU21): its automation was deleted, it waited 7 days (WC-45), her contact
 * was erased, the owner paused automations for her (`contact_excluded`) or she wrote a stop word
 * (`opted_out`), a message expired, her window closed before a list message (`window_closed`, D29),
 * or a new allowed comment replaced it (`replaced`, P35). Mirrors `chk_automation_runs_cancel_reason`.
 */
export const AUTOMATION_RUN_CANCEL_REASONS = [
  'automation_deleted',
  'wait_expired',
  'contact_deleted',
  'contact_excluded',
  'opted_out',
  'expired',
  'window_closed',
  'replaced',
] as const;

/** One value of {@link AUTOMATION_RUN_CANCEL_REASONS}. */
export type AutomationRunCancelReason = (typeof AUTOMATION_RUN_CANCEL_REASONS)[number];

/**
 * Every value of `app.automation_run_events.event_type` (AU27): a status change, an email or phone
 * collected (the value lives on the contact, never here), a hello tap and a follow tap. Mirrors
 * `chk_automation_run_events_event_type`.
 */
export const AUTOMATION_RUN_EVENT_TYPES = [
  'status_changed',
  'email_received',
  'phone_received',
  'hello_tapped',
  'follow_tapped',
] as const;

/** One value of {@link AUTOMATION_RUN_EVENT_TYPES}. */
export type AutomationRunEventType = (typeof AUTOMATION_RUN_EVENT_TYPES)[number];

/**
 * The status of one comment-log step (AU28): `off` — not reached or not on; `sent`; `waiting` for
 * her or for its lane; `done`; `skipped`; `failed`; `expired` (too old to go); `unknown` (no answer
 * from the channel — never sent again by itself, D17). Mirrors each `chk_automation_comment_logs_*_status`.
 */
export const AUTOMATION_COMMENT_LOG_STEP_STATUSES = [
  'off',
  'sent',
  'waiting',
  'done',
  'skipped',
  'failed',
  'expired',
  'unknown',
] as const;

/** One value of {@link AUTOMATION_COMMENT_LOG_STEP_STATUSES}. */
export type AutomationCommentLogStepStatus = (typeof AUTOMATION_COMMENT_LOG_STEP_STATUSES)[number];

/**
 * A comment log's overall status: the run's open and final statuses, `cancelled` and `ignored` (no
 * run). Mirrors `chk_automation_comment_logs_overall_status`.
 */
export const AUTOMATION_COMMENT_LOG_OVERALL_STATUSES = [
  'started',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'ignored',
] as const;

/** One value of {@link AUTOMATION_COMMENT_LOG_OVERALL_STATUSES}. */
export type AutomationCommentLogOverallStatus =
  (typeof AUTOMATION_COMMENT_LOG_OVERALL_STATUSES)[number];

/**
 * The comment log's step names (AU28 — kept apart from the run's list: the run's `comment_reply` is
 * the log's `opening_dm`, `public_reply` and `hide_comment`). Mirrors
 * `chk_automation_comment_logs_current_step` / `_failed_step`.
 */
export const AUTOMATION_COMMENT_LOG_STEPS = [
  'public_reply',
  'opening_dm',
  'follow_check',
  'email_collect',
  'phone_collect',
  'messages',
  'hide_comment',
] as const;

/** One value of {@link AUTOMATION_COMMENT_LOG_STEPS}. */
export type AutomationCommentLogStep = (typeof AUTOMATION_COMMENT_LOG_STEPS)[number];

/**
 * Why a matching comment started no run (AU23, AU28): another automation's run waits for her email
 * (P23), this automation's run waits or runs, she already got this post's DM (`once_per_post`),
 * another automation answers the comment, a reply under another comment while the account's switch
 * is off (`thread_reply_off`), the account's own comment (`own_comment`, P24), or the owner paused
 * automations for her (`contact_excluded`). Mirrors `chk_automation_comment_logs_ignored_reason`.
 */
export const AUTOMATION_COMMENT_LOG_IGNORED_REASONS = [
  'waiting_for_other_email',
  'already_waiting',
  'run_in_progress',
  'once_per_post',
  'comment_already_answered',
  'thread_reply_off',
  'own_comment',
  'contact_excluded',
] as const;

/** One value of {@link AUTOMATION_COMMENT_LOG_IGNORED_REASONS}. */
export type AutomationCommentLogIgnoredReason =
  (typeof AUTOMATION_COMMENT_LOG_IGNORED_REASONS)[number];

/**
 * How a step failed: the channel refused it (`instagram_api` — the as-built name, any channel's
 * refusal), the token is dead, the network, or our own code. Mirrors
 * `chk_automation_comment_logs_error_type`.
 */
export const AUTOMATION_COMMENT_LOG_ERROR_TYPES = [
  'instagram_api',
  'token',
  'network',
  'code',
] as const;

/** One value of {@link AUTOMATION_COMMENT_LOG_ERROR_TYPES}. */
export type AutomationCommentLogErrorType = (typeof AUTOMATION_COMMENT_LOG_ERROR_TYPES)[number];

/**
 * Why a public reply was held back (AU28): the comment already has one (`duplicate`), "Reply like a
 * person" drew no reply (`random`), it was pushed out of the automation's waiting line
 * (`hour_limit`, the reply lane), or the comment is gone or a reply under another comment
 * (`deleted_comment`). Mirrors `chk_automation_comment_logs_public_reply_skip_reason`.
 */
export const AUTOMATION_PUBLIC_REPLY_SKIP_REASONS = [
  'duplicate',
  'random',
  'hour_limit',
  'deleted_comment',
] as const;

/** One value of {@link AUTOMATION_PUBLIC_REPLY_SKIP_REASONS}. */
export type AutomationPublicReplySkipReason = (typeof AUTOMATION_PUBLIC_REPLY_SKIP_REASONS)[number];

/**
 * Days a run may wait — for a tap, any message, a follow, an email or a phone — before the hourly
 * check cancels it `wait_expired` (`RUN_WAIT_MAX_DAYS`, WC-45). A product rule, not a setting.
 */
export const AUTOMATION_RUN_WAIT_MAX_DAYS = 7;

/**
 * Days a run, its events and a comment log are kept (D16): a runs part goes once its month ended
 * more than {@link AUTOMATION_RUN_PART_DROP_AFTER_DAYS} days ago; a comment-log part 90 days after its
 * month (AU36 — the shared upkeep, ROUTE row R49, drops them).
 */
export const AUTOMATION_RUN_KEEP_DAYS = 90;

/**
 * Days after its month ends that a runs part (and its run-events part) may be dropped: 90 days after
 * the last run in it can have ended — a run waits at most 7 days, plus a day (AU36 (5)).
 */
export const AUTOMATION_RUN_PART_DROP_AFTER_DAYS =
  AUTOMATION_RUN_KEEP_DAYS + AUTOMATION_RUN_WAIT_MAX_DAYS + 1;

/** Milliseconds of the 7-day wait. */
export const AUTOMATION_RUN_WAIT_MAX_MILLISECONDS =
  AUTOMATION_RUN_WAIT_MAX_DAYS * MILLISECONDS_PER_DAY;

/** The longest Instagram event key a run keeps (`varchar(512)`, as the webhook event key). */
export const AUTOMATION_RUN_EVENT_KEY_MAX_LENGTH = 512;

/** The longest once key (`post_key`, D13) a run keeps (`varchar(255)`). */
export const AUTOMATION_RUN_ONCE_KEY_MAX_LENGTH = 255;

/** A media, comment or story id as the channel sends it: digits only. */
export const AUTOMATION_RUN_INSTAGRAM_ID_PATTERN = '^[0-9]{1,64}$';

/** The highest message number of the list (`last_message_number`, 1–10). */
export const AUTOMATION_RUN_LAST_MESSAGE_NUMBER_MAX = 10;

/** Her chat window (plan §9): her last message or tap + 24 hours − 15 minutes. */
export const AUTOMATION_RUN_CHAT_WINDOW_MILLISECONDS = (24 * 60 - 15) * MILLISECONDS_PER_MINUTE;

/** When the nudge goes after a hello that got no tap (`NUDGE_AFTER_MINUTES`, D30). */
export const AUTOMATION_RUN_NUDGE_AFTER_MILLISECONDS = 60 * MILLISECONDS_PER_MINUTE;

/** How many times an email or phone question is asked in all (`ASK_AGAIN_MAX`, plan §14). */
export const AUTOMATION_RUN_ASK_MAX_COUNT = 3;

/** "Reply like a person": the chance in percent a comment gets a public reply (`PUBLIC_REPLY_CHANCE_PERCENT`). */
export const AUTOMATION_PUBLIC_REPLY_CHANCE_PERCENT = 80;

/** The public reply's draw takes a whole number under this. */
export const AUTOMATION_PUBLIC_REPLY_CHANCE_SCALE = 100;

/** A tag start whose chain number reaches this starts nothing (`TAG_CHAIN_MAX`, D45). */
export const AUTOMATION_TAG_CHAIN_MAX = 3;

/**
 * Joins the two public ids of a button payload: `<aut_…>::<run_…>` — the hello's and the follow
 * ask's "sends your next step" buttons carry it back as a postback.
 */
export const AUTOMATION_BUTTON_PAYLOAD_SEPARATOR = '::';

/** The longest error message a run or a comment log keeps — a code and a short reason, never message text. */
export const AUTOMATION_RUN_ERROR_MESSAGE_MAX_LENGTH = 500;

/**
 * The default texts a sent message falls back to (English, the channel's sending sub-domain reads
 * them at send — ROUTE rows R19–R20). Kept here with the run's own constants: the run never stores
 * text (AU35 — content by reference).
 */
export const AUTOMATION_MESSAGE_KEYS = {
  emailQuestion: 'common:automationMessages.emailQuestion',
  phoneQuestion: 'common:automationMessages.phoneQuestion',
  invalidEmail: 'common:automationMessages.invalidEmail',
  buttonTemplateText: 'common:automationMessages.buttonTemplateText',
  linkButtonTitle: 'common:automationMessages.linkButtonTitle',
} as const;
