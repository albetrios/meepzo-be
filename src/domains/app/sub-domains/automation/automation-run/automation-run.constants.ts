import {
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_MINUTE,
} from '@/shared/constants/ttl.constants.js';

/**
 * Every value of `app.automation_runs.status` (routes-final § 3.B.3): `running` and `waiting` are
 * open (one per automation × contact, AU17); `completed`, `failed` and `cancelled` are final.
 * Mirrors `chk_automation_runs_status`.
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

/** The open statuses — the one-open-run index's predicate (AU17) and what a delete or an erase cancels. */
export const AUTOMATION_RUN_OPEN_STATUSES = ['running', 'waiting'] as const;

/**
 * Every value of `app.automation_runs.current_step` (AU18), in run order. Mirrors
 * `chk_automation_runs_current_step`.
 */
export const AUTOMATION_RUN_STEPS = [
  'keyword_match',
  'comment_reply',
  'follow_check',
  'email_collect',
  'phone_collect',
  'final_dm',
] as const;

/** One value of {@link AUTOMATION_RUN_STEPS}. */
export type AutomationRunStep = (typeof AUTOMATION_RUN_STEPS)[number];

/**
 * What a `waiting` run waits for (D19): the opening message's button, the "I'm following" button,
 * an email, a phone number. The comment log's `waiting_for` takes the same list. Mirrors
 * `chk_automation_runs_waiting_for`.
 */
export const AUTOMATION_RUN_WAITING_FOR = [
  'opening_message_button',
  'follow',
  'email',
  'phone',
] as const;

/** One value of {@link AUTOMATION_RUN_WAITING_FOR}. */
export type AutomationRunWaitingFor = (typeof AUTOMATION_RUN_WAITING_FOR)[number];

/**
 * The message a run has claimed and is sending (AU19): set before the send, cleared when its
 * result is recorded — still set after a crash, so a retry never sends it again (AQ5). Mirrors
 * `chk_automation_runs_sending_message_kind`.
 */
export const AUTOMATION_RUN_SENDING_MESSAGE_KINDS = [
  'public_reply',
  'opening_message',
  'follow_request',
  'email_question',
  'invalid_email',
  'phone_question',
  'final_message',
] as const;

/** One value of {@link AUTOMATION_RUN_SENDING_MESSAGE_KINDS}. */
export type AutomationRunSendingMessageKind = (typeof AUTOMATION_RUN_SENDING_MESSAGE_KINDS)[number];

/**
 * Why a run was cancelled: its automation was deleted (AU12), it waited 7 days (AU25), or its
 * contact was erased (AU26), the team paused automations for her (`contact_excluded`, D71) or she
 * wrote a stop word (`opted_out`, D49) — the contact's pause steps (routes-final § 3.10, ROUTE R10).
 * A disconnect cancels nothing (IQ1), so there is no `account_disconnected`. Mirrors
 * `chk_automation_runs_cancel_reason`.
 */
export const AUTOMATION_RUN_CANCEL_REASONS = [
  'automation_deleted',
  'wait_expired',
  'contact_deleted',
  'contact_excluded',
  'opted_out',
] as const;

/** One value of {@link AUTOMATION_RUN_CANCEL_REASONS}. */
export type AutomationRunCancelReason = (typeof AUTOMATION_RUN_CANCEL_REASONS)[number];

/**
 * Every value of `app.automation_run_events.event_type` (AU23): a status change, an email or a
 * phone number collected (the value itself lives on the contact, never here). Mirrors
 * `chk_automation_run_events_event_type`.
 */
export const AUTOMATION_RUN_EVENT_TYPES = [
  'status_changed',
  'email_received',
  'phone_received',
] as const;

/** One value of {@link AUTOMATION_RUN_EVENT_TYPES}. */
export type AutomationRunEventType = (typeof AUTOMATION_RUN_EVENT_TYPES)[number];

/**
 * The status of one comment-log step (schema-routes § 9): `off` — not reached or not on; `sent`;
 * `waiting` for the person; `done`; `skipped`; `failed`. Mirrors each `chk_automation_comment_logs_*_status`.
 */
export const AUTOMATION_COMMENT_LOG_STEP_STATUSES = [
  'off',
  'sent',
  'waiting',
  'done',
  'skipped',
  'failed',
] as const;

/** One value of {@link AUTOMATION_COMMENT_LOG_STEP_STATUSES}. */
export type AutomationCommentLogStepStatus = (typeof AUTOMATION_COMMENT_LOG_STEP_STATUSES)[number];

/**
 * A comment log's overall status (AU24): the run's open and final statuses, `cancelled` (added —
 * a run cancelled by a delete, a wait or an erase) and `ignored` (no run). Mirrors
 * `chk_automation_comment_logs_overall_status`.
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
 * The comment log's step names (D19 — kept apart from the run's list: the run's `comment_reply` is
 * the log's `public_reply` then `opening_dm`). Mirrors `chk_automation_comment_logs_current_step` /
 * `_failed_step`.
 */
export const AUTOMATION_COMMENT_LOG_STEPS = [
  'public_reply',
  'opening_dm',
  'follow_check',
  'email_collect',
  'phone_collect',
  'final_dm',
] as const;

/** One value of {@link AUTOMATION_COMMENT_LOG_STEPS}. */
export type AutomationCommentLogStep = (typeof AUTOMATION_COMMENT_LOG_STEPS)[number];

/**
 * Why a matching comment started no run (AU16, AU17): another run waits for the contact's email,
 * this automation's run waits or runs, its last run is final, or another automation answers the
 * comment (`comment_already_answered`, AQ1, D26). Mirrors `chk_automation_comment_logs_ignored_reason`.
 */
export const AUTOMATION_COMMENT_LOG_IGNORED_REASONS = [
  'waiting_for_other_email',
  'already_waiting',
  'run_in_progress',
  'previous_run_final',
  'comment_already_answered',
] as const;

/** One value of {@link AUTOMATION_COMMENT_LOG_IGNORED_REASONS}. */
export type AutomationCommentLogIgnoredReason =
  (typeof AUTOMATION_COMMENT_LOG_IGNORED_REASONS)[number];

/**
 * How a step failed (schema-routes § 8.12): Instagram refused it, the token is dead, the outcome is
 * unknown (a timeout, a crash — AQ5), or our own code failed. Mirrors
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
 * Why reply safety held a public reply back (AU20), in the order the checks run. Mirrors
 * `chk_automation_comment_logs_public_reply_skip_reason`.
 */
export const AUTOMATION_PUBLIC_REPLY_SKIP_REASONS = [
  'duplicate',
  'random',
  'hour_limit',
  'gap',
] as const;

/** One value of {@link AUTOMATION_PUBLIC_REPLY_SKIP_REASONS}. */
export type AutomationPublicReplySkipReason = (typeof AUTOMATION_PUBLIC_REPLY_SKIP_REASONS)[number];

/**
 * The most automations one run holds in `queued_automations` (AU21) — a backstop: one entry per
 * automation, so the list is bounded by the organization's automations. Mirrors
 * `chk_automation_runs_queued_automations`.
 */
export const AUTOMATION_RUN_QUEUED_AUTOMATIONS_MAX_COUNT = 100;

/**
 * Days a run may wait — for a button, a follow, an email or a phone — before the hourly check
 * cancels it `wait_expired` (D8, AU25, WC-13). A product rule, not a setting.
 */
export const AUTOMATION_RUN_WAIT_MAX_DAYS = 7;

/** The longest Instagram event key a run keeps (`varchar(512)`, as the webhook event key, 4.B.3). */
export const AUTOMATION_RUN_EVENT_KEY_MAX_LENGTH = 512;

/** An Instagram media, comment, story or user id as Meta sends it: digits only. */
export const AUTOMATION_RUN_INSTAGRAM_ID_PATTERN = '^[0-9]{1,64}$';

/**
 * The opening message is skipped when the contact got a DM from the account within this window
 * (AU18, D14 — schema-routes § 6.5 step 3).
 */
export const AUTOMATION_OPENING_MESSAGE_SKIP_WINDOW_MILLISECONDS = 24 * MILLISECONDS_PER_HOUR;

/**
 * Instagram's messaging window (3.B.10): a normal DM reaches a person who sent the account a DM, a
 * story reply, a quick reply or a button click within it (`last_direct_message_received_at`).
 */
export const INSTAGRAM_MESSAGING_WINDOW_MILLISECONDS = 24 * MILLISECONDS_PER_HOUR;

/** How long after a comment its one private reply may still go (3.B.10, Meta's private-reply rule). */
export const INSTAGRAM_PRIVATE_REPLY_WINDOW_MILLISECONDS = 7 * MILLISECONDS_PER_DAY;

/** The shortest random pause before each send (K10). */
export const AUTOMATION_SEND_PAUSE_MIN_MILLISECONDS = 200;

/** The longest random pause before each send (K10). */
export const AUTOMATION_SEND_PAUSE_MAX_MILLISECONDS = 1000;

/** The hour-limit window of reply safety (AU20): public replies `sent` in the last 60 minutes. */
export const AUTOMATION_PUBLIC_REPLY_HOUR_WINDOW_MILLISECONDS = 60 * MILLISECONDS_PER_MINUTE;

/** Reply safety's random check draws a whole number under this (AU20: reply when the draw < the chance). */
export const AUTOMATION_PUBLIC_REPLY_CHANCE_SCALE = 100;

/**
 * Joins the two public ids of a button payload: `<aut_…>::<run_…>` (schema-routes § 5.6) — the
 * opening message's button and the "I'm following" button carry it back as a postback.
 */
export const AUTOMATION_BUTTON_PAYLOAD_SEPARATOR = '::';

/** The longest error message a run or a comment log keeps — a code and a short reason, never message text. */
export const AUTOMATION_RUN_ERROR_MESSAGE_MAX_LENGTH = 500;

/** Where a follow request's profile button points: the account's own Instagram page. */
export const INSTAGRAM_PROFILE_BASE_URL = 'https://www.instagram.com/';

/**
 * The default texts every DM falls back to (AU22, D20): English, read with
 * `i18next.t(key, { lng: 'en' })`. The email and phone questions are used when the automation saved
 * none (their objects are nullable, schema-routes § 10); the button-template text and the link title
 * only when a saved text or title is blank.
 */
export const AUTOMATION_MESSAGE_KEYS = {
  emailQuestion: 'common:automationMessages.emailQuestion',
  phoneQuestion: 'common:automationMessages.phoneQuestion',
  invalidEmail: 'common:automationMessages.invalidEmail',
  buttonTemplateText: 'common:automationMessages.buttonTemplateText',
  linkButtonTitle: 'common:automationMessages.linkButtonTitle',
} as const;

/** The language every automation DM is written in (AU22: English at launch). */
export const AUTOMATION_MESSAGE_LANGUAGE = 'en';
