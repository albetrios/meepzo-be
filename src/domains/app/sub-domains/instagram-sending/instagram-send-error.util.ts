import { randomInt } from 'node:crypto';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import {
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_SECOND,
} from '@/shared/constants/ttl.constants.js';
import type {
  InstagramOutgoingMessageChannel,
  InstagramOutgoingMessageReason,
} from './instagram-outgoing-message/instagram-outgoing-message.constants.js';
import {
  FAST_LANE_SETTINGS,
  INSTAGRAM_ATTACHMENT_UPLOAD_MAX_TRIES,
  INSTAGRAM_SEND_CORE_SETTINGS,
  INSTAGRAM_SEND_ERROR_CODE_GROUPS,
  type InstagramSendLane,
  type InstagramSendResultGroup,
  type InstagramSendStopReason,
} from './instagram-sending.constants.js';

/** What one Meta answer (or its absence) was, read once (SN5): its group, status and codes. */
export interface InstagramSendErrorReading {
  group: InstagramSendResultGroup;
  httpStatus: number | null;
  errorCode: number | null;
  errorSubcode: number | null;
  /** Meta's wait (`Retry-After`) on a throttle, else `null`. */
  retryAfterMilliseconds: number | null;
}

/** Network error codes that prove the call never reached Meta ("never connected", plan §33.1). */
const NEVER_CONNECTED_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/** Graph's permission codes: 10 and 200–299 (plan §33.2 rule 3). */
const PERMISSION_CODE = 10;
const PERMISSION_CODE_RANGE = { first: 200, last: 299 } as const;
/** Graph's invalid-parameter code: any 100 not listed is `bad_text`. */
const INVALID_PARAMETER_CODE = 100;
/** HTTP 429 without a Graph code is `too_fast`. */
const HTTP_TOO_MANY_REQUESTS = 429;

/** The groups that are a stop: the message goes back to `waiting`, no try used (plan §33.2 rule 1). */
export const INSTAGRAM_SEND_STOP_GROUPS: readonly InstagramSendResultGroup[] = [
  'too_fast',
  'blocked',
  'account_flagged',
  'login_expired',
  'account_not_shared',
  'access_off',
  'app_not_approved',
  'app_limit',
];

/** Whether an error's cause chain names a network code that proves the call never left. */
function isNeverConnected(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NEVER_CONNECTED_NETWORK_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The table's group for a code and subcode, else the fallback of plan §33.1. */
function groupOfCode({
  code,
  subcode,
}: {
  code: number;
  subcode: number | null;
}): InstagramSendResultGroup {
  for (const entry of INSTAGRAM_SEND_ERROR_CODE_GROUPS) {
    if (entry.code !== code) continue;
    if (entry.subcode === 'any') return entry.group;
    if (entry.subcode === 'none' && subcode === null) return entry.group;
    if (entry.subcode === subcode) return entry.group;
  }
  if (
    code === PERMISSION_CODE ||
    (code >= PERMISSION_CODE_RANGE.first && code <= PERMISSION_CODE_RANGE.last)
  ) {
    return 'wrong_permission';
  }
  if (code === INVALID_PARAMETER_CODE) return 'bad_text';
  return 'try_later';
}

/**
 * Reads a failed Meta call into its one group (feat-instagram-dm-sending routes-final § 6 SN5,
 * SNC4; plan §33.1, §33.3).
 *
 * @remarks
 * - **Algorithm:** a `MetaGraphApiError` that carries Meta's code → the table
 *   ({@link INSTAGRAM_SEND_ERROR_CODE_GROUPS}), then the fallbacks (other 10 / 200–299
 *   `wrong_permission`, other 100 `bad_text`, any other code `try_later`); HTTP 429 without a code
 *   → `too_fast`; a 5xx answer → `try_later`; an open circuit or a refused / unresolved connection →
 *   `never_connected` (surely not sent); a timeout, a cut connection or an unreadable answer →
 *   `no_answer` (D17: maybe sent). Anything that is not Meta's error (our own failure before the
 *   call left, such as a token that does not decrypt) → `never_connected`. A hide's error that is
 *   not a stop or a gone comment → `hide_failed`; a follow check's (no channel) that is not a stop —
 *   a time-out too — → `check_not_possible`.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 * - **Notes:** the circuit (`metaGraphCircuit`) stays the backstop of every call class — an open
 *   circuit reads as `never_connected`, so it puts messages back and never fails one (S14, P109).
 */
export function classifyInstagramSendError({
  error,
  channel,
}: {
  error: unknown;
  channel: InstagramOutgoingMessageChannel | null;
}): InstagramSendErrorReading {
  const reading = readGroup(error);
  if (INSTAGRAM_SEND_STOP_GROUPS.includes(reading.group)) return reading;
  // A hide of a comment that is gone is `skipped` · `deleted_comment` (plan §33.7 rule 4).
  if (
    channel === 'comment_hide' &&
    reading.group !== 'no_answer' &&
    reading.group !== 'comment_gone'
  ) {
    return { ...reading, group: 'hide_failed' };
  }
  // A follow check sends her nothing: a time-out is a failed try too, never `unknown` (§30.9 rule 6).
  if (channel === null) return { ...reading, group: 'check_not_possible' };
  return reading;
}

/** {@link classifyInstagramSendError} before the hide and follow-check rules. */
function readGroup(error: unknown): InstagramSendErrorReading {
  if (!(error instanceof MetaGraphApiError)) {
    return {
      group: 'never_connected',
      httpStatus: null,
      errorCode: null,
      errorSubcode: null,
      retryAfterMilliseconds: null,
    };
  }
  const base = {
    httpStatus: error.status ?? null,
    errorCode: error.instagramErrorCode,
    errorSubcode: error.instagramErrorCode === null ? null : error.instagramErrorSubcode,
    retryAfterMilliseconds: error.retryAfterMs ?? null,
  };
  if (error.instagramErrorCode !== null) {
    return {
      ...base,
      group: groupOfCode({ code: error.instagramErrorCode, subcode: error.instagramErrorSubcode }),
    };
  }
  if (error.status === HTTP_TOO_MANY_REQUESTS) return { ...base, group: 'too_fast' };
  if (error.category === 'circuit_open' || isNeverConnected(error)) {
    return { ...base, group: 'never_connected' };
  }
  if (error.category === 'http_5xx') return { ...base, group: 'try_later' };
  if (error.category === 'http_4xx') return { ...base, group: 'bad_text' };
  return { ...base, group: 'no_answer' };
}

/** A stop the core starts after a result (SN5, 6.A.10). */
export type InstagramSendStopAction =
  | {
      kind: 'lanes';
      reason: InstagramSendStopReason;
      lanes: readonly InstagramSendLane[] | 'all';
      /** `null` = until the owner acts; else from the lane's `stop_count`. */
      durationMilliseconds: ((stopCount: number) => number) | null;
    }
  /** `login_expired`: every account of the connection (MC11, AC-17.12). */
  | { kind: 'connection' }
  /** `account_not_shared`: the account's break (CA4). */
  | { kind: 'account' }
  /** `app_limit`: all accounts when a second account got it within 5 minutes, else as `too_fast`. */
  | { kind: 'app_limit'; lane: InstagramSendLane };

/** What the result save does with one message after its call (SN4, plan §33.1). */
export interface InstagramSendOutcome {
  /** The final status, or `waiting` — the message goes back. */
  status: 'sent' | 'unknown' | 'failed' | 'skipped' | 'expired' | 'waiting';
  reason: InstagramOutgoingMessageReason | null;
  /** Back to `waiting` only: whether a try is used up (`tries` + 1). */
  isTryUsed: boolean;
  /** Back to `waiting` only: not before this many milliseconds from now. */
  notBeforeDelayMilliseconds: number;
  /** The claim's minute and month counts given back — exactly when the message goes back. */
  isGivenBack: boolean;
  stop: InstagramSendStopAction | null;
}

/** The ladder's step for a stop count (the last step repeats). */
export function ladderStep({
  ladder,
  stopCount,
}: {
  ladder: readonly number[];
  stopCount: number;
}): number {
  return ladder[Math.min(Math.max(stopCount, 0), ladder.length - 1)] ?? 0;
}

const SETTINGS = INSTAGRAM_SEND_CORE_SETTINGS;

/** A message back to `waiting` (a stop, or a sure "not sent"). */
function putBack({
  isTryUsed,
  delayMilliseconds = 0,
  stop = null,
}: {
  isTryUsed: boolean;
  delayMilliseconds?: number;
  stop?: InstagramSendStopAction | null;
}): InstagramSendOutcome {
  return {
    status: 'waiting',
    reason: null,
    isTryUsed,
    notBeforeDelayMilliseconds: delayMilliseconds,
    isGivenBack: true,
    stop,
  };
}

/** A final status after a call (the counts stay: Meta was tried). */
function settle({
  status,
  reason,
}: {
  status: InstagramSendOutcome['status'];
  reason: InstagramOutgoingMessageReason | null;
}): InstagramSendOutcome {
  return {
    status,
    reason,
    isTryUsed: false,
    notBeforeDelayMilliseconds: 0,
    isGivenBack: false,
    stop: null,
  };
}

/**
 * How long a lane stop of `reason` lasts at its `stopCount`-th step (6.A.10, plan §33.1, §33.5):
 * `too_fast` 15 → 360 minutes (a broadcast lane twice as long), `blocked` / `account_flagged` tested
 * after 24, 48, then every 72 hours, `access_off` / `app_not_approved` hourly, `instagram_down` 5 → 40
 * minutes; `null` for a stop only the owner ends.
 */
export function stopDurationOf({
  reason,
  stopCount,
  lane,
}: {
  reason: InstagramSendStopReason;
  stopCount: number;
  lane: InstagramSendLane;
}): number | null {
  switch (reason) {
    case 'too_fast': {
      const ladder =
        ladderStep({ ladder: SETTINGS.tooFastStopMinutes, stopCount }) * MILLISECONDS_PER_MINUTE;
      return lane === 'broadcast' ? 2 * ladder : ladder;
    }
    case 'blocked':
    case 'account_flagged':
      return ladderStep({ ladder: SETTINGS.blockedTestHours, stopCount }) * MILLISECONDS_PER_HOUR;
    case 'access_off':
    case 'app_not_approved':
      return SETTINGS.accessTestMinutes * MILLISECONDS_PER_MINUTE;
    case 'instagram_down':
      return ladderStep({ ladder: SETTINGS.downStopMinutes, stopCount }) * MILLISECONDS_PER_MINUTE;
    default:
      return null;
  }
}

/** The stop a stop group starts (6.A.10), from the message's lane. */
function stopOf({
  group,
  lane,
  retryAfterMilliseconds,
}: {
  group: InstagramSendResultGroup;
  lane: InstagramSendLane;
  retryAfterMilliseconds: number | null;
}): InstagramSendStopAction | null {
  const laneStop = ({
    reason,
    lanes,
  }: {
    reason: InstagramSendStopReason;
    lanes: readonly InstagramSendLane[] | 'all';
  }): InstagramSendStopAction => ({
    kind: 'lanes',
    reason,
    lanes,
    durationMilliseconds: (stopCount) => {
      const ladder = stopDurationOf({ reason, stopCount, lane }) ?? 0;
      if (reason !== 'too_fast') return ladder;
      // A broadcast's too fast lasts twice Meta's time too (plan §30.14 rule 3); the ladder is
      // already doubled for it.
      const metaTime = (retryAfterMilliseconds ?? 0) * (lane === 'broadcast' ? 2 : 1);
      return Math.max(ladder, metaTime);
    },
  });
  switch (group) {
    case 'too_fast':
      // The slow or fast lane's too fast holds the broadcast lane for the same time (plan §30.14
      // rule 3); the reply lane's and the broadcast lane's own hold only that lane.
      return laneStop({
        reason: 'too_fast',
        lanes: lane === 'slow' || lane === 'fast' ? [lane, 'broadcast'] : [lane],
      });
    case 'blocked':
      // A reply or hide stops the reply lane only (6.A.10).
      return laneStop({ reason: 'blocked', lanes: lane === 'reply' ? ['reply'] : 'all' });
    case 'account_flagged':
      return laneStop({ reason: 'account_flagged', lanes: [lane] });
    case 'access_off':
    case 'app_not_approved':
      return laneStop({ reason: group, lanes: 'all' });
    case 'login_expired':
      return { kind: 'connection' };
    case 'account_not_shared':
      return { kind: 'account' };
    case 'app_limit':
      return { kind: 'app_limit', lane };
    default:
      return null;
  }
}

/**
 * What one answer does to its message (feat-instagram-dm-sending routes-final § 6 SN4, SN5; plan
 * §33.1–§33.2): its status and reason, whether it goes back to `waiting` (with or without a used
 * try, and when), whether the claim's counts are given back, and the stop it starts.
 *
 * @remarks
 * - **Algorithm:** a stop group → back to `waiting`, no try used, counts given back (rule 1) + its
 *   stop; `sent` → `sent`; `never_connected` → back after 5 / 15 / 60 s, no try used; `no_answer` →
 *   `unknown` (D17 — a follow check goes back with a used try); `try_later` → an opening private
 *   reply goes back after 1 / 5 / 15 minutes, then `failed` · `tries_used_up`, anything else
 *   `unknown`; `attachment` → back with a used try, `failed` · `attachment_failed` after 3;
 *   `person` / `other_app` → `skipped` · `person_error`; `window_closed` → `skipped`;
 *   `comment_gone` → `skipped` · `deleted_comment`; `live_ended` → `expired`; `wrong_permission` →
 *   `failed`; `bad_text` and `hide_failed` → `failed` · `bad_text`; `check_not_possible` → one more
 *   try after a random 2–5 s, then `sent` · `assumed_following`; `already_sent_first` → `skipped` · `duplicate`.
 * - **Failure modes:** none — pure but for the follow check's random retry wait.
 * - **Side effects:** none.
 * - **Notes:** the counts stay for a final status: Meta was tried (WC-20's daily check compares the
 *   month with the tried DMs). The comment's re-read before `deleted_comment` is the lane's call
 *   (`callWithCommentCheck`, R43); the automation's `bad_text` stop after 5 in a row is the send
 *   core's, read from the attempts (`automationBadTextInARow`, R54).
 */
export function decideInstagramSendOutcome({
  reading,
  lane,
  messageType,
  channel,
  tries,
}: {
  reading: InstagramSendErrorReading;
  lane: InstagramSendLane;
  messageType: string;
  channel: InstagramOutgoingMessageChannel | null;
  /** The message's tries before this call. */
  tries: number;
}): InstagramSendOutcome {
  const { group } = reading;
  const stop = stopOf({ group, lane, retryAfterMilliseconds: reading.retryAfterMilliseconds });
  if (stop !== null) return putBack({ isTryUsed: false, stop });
  switch (group) {
    case 'sent':
      return settle({ status: 'sent', reason: null });
    case 'never_connected':
      return putBack({
        isTryUsed: false,
        delayMilliseconds:
          ladderStep({ ladder: SETTINGS.neverConnectedRetrySeconds, stopCount: tries }) *
          MILLISECONDS_PER_SECOND,
      });
    case 'no_answer':
      return channel === null
        ? putBack({ isTryUsed: true })
        : settle({ status: 'unknown', reason: null });
    case 'try_later':
      return decideTryLater({ messageType, channel, tries });
    case 'attachment':
      // Never counted: the file did not reach her (plan §33.1 "Attachment error").
      return tries + 1 >= INSTAGRAM_ATTACHMENT_UPLOAD_MAX_TRIES
        ? { ...settle({ status: 'failed', reason: 'attachment_failed' }), isGivenBack: true }
        : putBack({ isTryUsed: true });
    case 'person':
    case 'other_app':
      return settle({ status: 'skipped', reason: 'person_error' });
    case 'window_closed':
      return settle({ status: 'skipped', reason: 'window_closed' });
    case 'comment_gone':
      return settle({ status: 'skipped', reason: 'deleted_comment' });
    case 'live_ended':
      return settle({ status: 'expired', reason: 'live_ended' });
    case 'wrong_permission':
      return settle({ status: 'failed', reason: 'wrong_permission' });
    case 'check_not_possible':
      return tries < SETTINGS.followCheckTries
        ? putBack({
            isTryUsed: true,
            delayMilliseconds: randomInt(
              FAST_LANE_SETTINGS.followCheckRetryMinimumMilliseconds,
              FAST_LANE_SETTINGS.followCheckRetryMaximumMilliseconds + 1,
            ),
          })
        : settle({ status: 'sent', reason: 'assumed_following' });
    case 'already_sent_first':
      return settle({ status: 'skipped', reason: 'duplicate' });
    default:
      return settle({ status: 'failed', reason: 'bad_text' });
  }
}

/** "Try later" (plan §33.1): an opening private reply waits 1 / 5 / 15 minutes, others `unknown`. */
function decideTryLater({
  messageType,
  channel,
  tries,
}: {
  messageType: string;
  channel: InstagramOutgoingMessageChannel | null;
  tries: number;
}): InstagramSendOutcome {
  if (messageType !== 'opening_message' || channel !== 'private_reply') {
    return settle({ status: 'unknown', reason: null });
  }
  if (tries >= SETTINGS.tryLaterMinutes.length)
    return settle({ status: 'failed', reason: 'tries_used_up' });
  return putBack({
    isTryUsed: true,
    delayMilliseconds:
      ladderStep({ ladder: SETTINGS.tryLaterMinutes, stopCount: tries }) * MILLISECONDS_PER_MINUTE,
  });
}
