import {
  ExternalServiceError,
  type OutboundCategory,
} from '@/infrastructure/outbound/outbound-error.js';
import {
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_SECOND,
} from '@/shared/constants/ttl.constants.js';

/**
 * The four ways an Instagram call fails (IA4): `auth` — the token is dead or lacks a permission;
 * `throttled` — Instagram asks us to slow down; `refused` — Instagram refused this one request;
 * `outage` — Instagram did not answer (timeout, network, 5xx, an open circuit, an unreadable body).
 */
export type InstagramErrorClass = 'auth' | 'throttled' | 'refused' | 'outage';

/** The account's `connection_status` an `auth` failure moves it to (IA9): `expired` or `error`. */
export type InstagramBrokenConnectionStatus = 'expired' | 'error';

/**
 * What Instagram's error body says, read once — every field `null` when the body does not say it.
 * Its text (`message`, `error_message`) is not read at all: it can name a person or quote a token,
 * so no row and no log line may carry it (D52, D53).
 */
export interface InstagramErrorDetails {
  /** Graph `error.code` (or the OAuth body's `code`). */
  code: number | null;
  /** Graph `error.error_subcode`. */
  subcode: number | null;
  /** Graph `error.type` (or the OAuth body's `error_type`), e.g. `OAuthException`. */
  type: string | null;
  /** Graph `error.fbtrace_id` — the id Meta support asks for. */
  fbtraceId: string | null;
}

/** The class an Instagram error falls into and, for `auth`, the connection status it means. */
export interface InstagramErrorClassification {
  errorClass: InstagramErrorClass;
  connectionStatus: InstagramBrokenConnectionStatus | null;
}

/** Graph error code for an invalid or expired access token — the one code that breaks a connection (MC11). */
export const INSTAGRAM_ACCESS_TOKEN_ERROR_CODE = 190;
/** Subcode of {@link INSTAGRAM_ACCESS_TOKEN_ERROR_CODE}: the token's time ran out. */
const INSTAGRAM_ACCESS_TOKEN_EXPIRED_SUBCODE = 463;
/**
 * Graph error code for a permission the token does not hold — and, with one of
 * {@link INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODES}, for a message outside the messaging window.
 */
const INSTAGRAM_PERMISSION_ERROR_CODE = 10;
/**
 * Subcode of Graph error code 10 that Instagram's messaging API sends for a message outside the
 * 24-hour messaging window (`(#10) This message is sent outside of allowed window`).
 *
 * @remarks
 * A refusal of that one send, not a broken token: the account stays `connected` (D32, IA4).
 */
export const INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODE = 2534022;
/**
 * Subcode of Graph error code 10 that Meta's Messenger Platform sends for a message outside the
 * 24-hour messaging window (`Message sent outside of allowed window`); Instagram sends it too.
 *
 * @remarks
 * A refusal of that one send, not a broken token: the account stays `connected` (D32, IA4).
 */
export const MESSENGER_OUTSIDE_MESSAGING_WINDOW_SUBCODE = 2018278;
/**
 * Meta's "outside the messaging window" subcodes of Graph error code 10:
 * {@link INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODE} and
 * {@link MESSENGER_OUTSIDE_MESSAGING_WINDOW_SUBCODE}.
 */
const INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODES: ReadonlySet<number> = new Set([
  INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODE,
  MESSENGER_OUTSIDE_MESSAGING_WINDOW_SUBCODE,
]);
/** Graph's permission error codes, `200`–`299`. */
const INSTAGRAM_PERMISSION_ERROR_CODE_RANGE = { first: 200, last: 299 } as const;
/**
 * Graph's rate-limit codes: application (4), user (17), page (32), call-rate (613) and the Instagram
 * business-use-case limit of one account (80002, D53).
 */
const INSTAGRAM_THROTTLE_ERROR_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613, 80002]);
/** Graph's invalid-parameter code. */
const INSTAGRAM_INVALID_PARAMETER_ERROR_CODE = 100;
/** Subcode of {@link INSTAGRAM_INVALID_PARAMETER_ERROR_CODE}: the email / phone quick reply is refused. */
const INSTAGRAM_QUICK_REPLY_REFUSED_SUBCODE = 2534015;
/** HTTP status of a throttle without a Graph code. */
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * How long a throttled call waits when Instagram names no `Retry-After`.
 *
 * @remarks
 * Rationale: Instagram's rate-limit windows are rolling hours and its throttle answers seldom carry
 * `Retry-After`; one minute keeps a paused queue or a retrying client from hammering it.
 *
 * Consequences of change:
 * - Decreasing → throttled callers come back sooner, likely into the same throttle.
 * - Increasing → a short throttle holds work back longer than needed.
 *
 * Last reviewed: 2026-11-21.
 */
export const INSTAGRAM_THROTTLE_DEFAULT_RETRY_AFTER_MS = MILLISECONDS_PER_MINUTE;

/**
 * The longest wait a throttled call takes from Instagram's `Retry-After` (D56).
 *
 * @remarks
 * Rationale: the wait pauses the whole queue that met the throttle — every organization's events —
 * and is what a client is told to wait, so one long header (an hour, a day) must not hold the
 * product still; the next try after the pause finds out whether the throttle is over.
 *
 * Consequences of change:
 * - Decreasing → more tries into a throttle that is still on.
 * - Increasing → one throttled account holds every account's queue for longer.
 *
 * Last reviewed: 2026-11-22.
 */
export const INSTAGRAM_THROTTLE_MAX_RETRY_AFTER_MS = 15 * MILLISECONDS_PER_MINUTE;

const EMPTY_INSTAGRAM_ERROR_DETAILS: InstagramErrorDetails = {
  code: null,
  subcode: null,
  type: null,
  fbtraceId: null,
};

/** A whole number from a JSON number or a digit string, else `null`. */
function readWholeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return Number(value);
  return null;
}

/** A non-empty string, else `null`. */
function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `value` as a plain object, else `null`. */
function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads Instagram's error body once: the Graph shape `{ error: { code, error_subcode, type,
 * fbtrace_id } }` or the code exchange's `{ error_type, code }`.
 *
 * @remarks
 * A body that is not JSON, or JSON of neither shape, reads as all `null` — the HTTP status alone
 * then decides the class. The body's text (`message`, `error_message`) is left unread (D53).
 */
export function readInstagramErrorBody(body: string): InstagramErrorDetails {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return EMPTY_INSTAGRAM_ERROR_DETAILS;
  }
  const root = readObject(parsed);
  if (root === null) return EMPTY_INSTAGRAM_ERROR_DETAILS;
  const graphError = readObject(root.error);
  return {
    code: readWholeNumber(graphError ? graphError.code : root.code),
    subcode: graphError ? readWholeNumber(graphError.error_subcode) : null,
    type: graphError ? readText(graphError.type) : readText(root.error_type),
    fbtraceId: graphError ? readText(graphError.fbtrace_id) : null,
  };
}

/** Whether `code` is one of Graph's permission codes: `10` or `200`–`299`. */
function isInstagramPermissionErrorCode(code: number): boolean {
  return (
    code === INSTAGRAM_PERMISSION_ERROR_CODE ||
    (code >= INSTAGRAM_PERMISSION_ERROR_CODE_RANGE.first &&
      code <= INSTAGRAM_PERMISSION_ERROR_CODE_RANGE.last)
  );
}

/** Whether Instagram refused a message for falling outside the messaging window (code 10, D32). */
function isInstagramOutsideMessagingWindowRefusal({
  code,
  subcode,
}: {
  code: number | null;
  subcode: number | null;
}): boolean {
  return (
    code === INSTAGRAM_PERMISSION_ERROR_CODE &&
    subcode !== null &&
    INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODES.has(subcode)
  );
}

/**
 * The class of an Instagram error answer (IA4), by its Graph code first, then its HTTP status.
 *
 * @remarks
 * `auth`: code 190 — subcode 463 → `expired`, any other → `error`; the permission codes 10 and
 * 200–299 → `error`, except code 10 with an "outside the messaging window" subcode
 * ({@link INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODE},
 * {@link MESSENGER_OUTSIDE_MESSAGING_WINDOW_SUBCODE}), which is `refused`: that send fails, the
 * account stays `connected` (D32). `throttled`: codes 4, 17, 32, 613, 80002, or HTTP 429. `refused`:
 * any other 4xx. `outage`: 5xx (and anything below 400 that still is not the expected answer).
 */
export function classifyInstagramErrorResponse({
  httpStatus,
  details,
}: {
  httpStatus: number;
  details: InstagramErrorDetails;
}): InstagramErrorClassification {
  const { code, subcode } = details;
  if (code === INSTAGRAM_ACCESS_TOKEN_ERROR_CODE) {
    const connectionStatus =
      subcode === INSTAGRAM_ACCESS_TOKEN_EXPIRED_SUBCODE ? 'expired' : 'error';
    return { errorClass: 'auth', connectionStatus };
  }
  if (isInstagramOutsideMessagingWindowRefusal({ code, subcode })) {
    return { errorClass: 'refused', connectionStatus: null };
  }
  if (code !== null && isInstagramPermissionErrorCode(code)) {
    return { errorClass: 'auth', connectionStatus: 'error' };
  }
  if (
    (code !== null && INSTAGRAM_THROTTLE_ERROR_CODES.has(code)) ||
    httpStatus === HTTP_TOO_MANY_REQUESTS
  ) {
    return { errorClass: 'throttled', connectionStatus: null };
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    return { errorClass: 'refused', connectionStatus: null };
  }
  return { errorClass: 'outage', connectionStatus: null };
}

/**
 * How long Instagram asked us to wait: a `Retry-After` header in whole seconds (at least one, at
 * most {@link INSTAGRAM_THROTTLE_MAX_RETRY_AFTER_MS}), or
 * {@link INSTAGRAM_THROTTLE_DEFAULT_RETRY_AFTER_MS} when it names none.
 */
export function readInstagramRetryAfterMs(retryAfterHeader: string | null): number {
  const seconds = Number.parseInt(retryAfterHeader ?? '', 10);
  if (!Number.isFinite(seconds) || seconds < 0) return INSTAGRAM_THROTTLE_DEFAULT_RETRY_AFTER_MS;
  return Math.min(
    Math.max(seconds, 1) * MILLISECONDS_PER_SECOND,
    INSTAGRAM_THROTTLE_MAX_RETRY_AFTER_MS,
  );
}

/** Options for {@link MetaGraphApiError}. */
export interface MetaGraphApiErrorOptions {
  errorClass: InstagramErrorClass;
  category: OutboundCategory;
  connectionStatus?: InstagramBrokenConnectionStatus | null;
  httpStatus?: number;
  retryAfterMs?: number;
  details?: InstagramErrorDetails;
  cause?: unknown;
  fallbackMessage: string;
}

/**
 * Every failure of an Instagram call — Instagram's error answer read once, or the call not reaching
 * it — as one of the four classes of IA4.
 *
 * @remarks
 * - **Algorithm:** an {@link ExternalServiceError} (`integration: 'meta-graph'`, so an unmapped one
 *   answers 503, with `Retry-After` when it carries `retryAfterMs`) plus `errorClass`, the
 *   `connectionStatus` an `auth` failure means, Instagram's code, subcode, type and `fbtraceId`, and `isQuickReplyRefused` (code 100, subcode 2534015 — the email / phone quick
 *   reply refused; the question goes again as plain text, schema-routes §6.5).
 * - **Failure modes:** none — a value object.
 * - **Side effects:** none.
 * - **Notes:** `countsAsCircuitFailure` is false for `auth`, `refused` and `throttled`: Instagram
 *   answered, so a burst of bad codes, dead tokens or one account's throttle cannot open the
 *   `instagram` circuit for every organization (as `ResendApiError`). Only an `outage` counts.
 *   The message names the class, status and codes; no field keeps Instagram's text (D53).
 */
export class MetaGraphApiError extends ExternalServiceError {
  /** Which of the four classes this failure is. */
  readonly errorClass: InstagramErrorClass;
  /** For `auth`: the connection status it means (`expired` for code 190 / 463, else `error`). */
  readonly connectionStatus: InstagramBrokenConnectionStatus | null;
  /** Instagram's error code, when its body named one. */
  readonly instagramErrorCode: number | null;
  /** Instagram's error subcode, when its body named one. */
  readonly instagramErrorSubcode: number | null;
  /** Instagram's error type (`OAuthException`, …), when its body named one. */
  readonly instagramErrorType: string | null;
  /** Meta's trace id for this failure, when its body had one. */
  readonly fbtraceId: string | null;
  /** Whether Instagram refused the email / phone quick reply (code 100, subcode 2534015). */
  readonly isQuickReplyRefused: boolean;
  /** Read by the circuit breaker: false unless this is an `outage`. */
  readonly countsAsCircuitFailure: boolean;

  constructor(options: MetaGraphApiErrorOptions) {
    const details = options.details ?? EMPTY_INSTAGRAM_ERROR_DETAILS;
    super({
      integration: 'meta-graph',
      category: options.category,
      ...(options.httpStatus !== undefined ? { status: options.httpStatus } : {}),
      ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
      ...(details.fbtraceId !== null ? { upstreamRequestId: details.fbtraceId } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
      fallbackMessage: options.fallbackMessage,
    });
    this.name = 'MetaGraphApiError';
    this.errorClass = options.errorClass;
    this.connectionStatus = options.connectionStatus ?? null;
    this.instagramErrorCode = details.code;
    this.instagramErrorSubcode = details.subcode;
    this.instagramErrorType = details.type;
    this.fbtraceId = details.fbtraceId;
    this.isQuickReplyRefused =
      details.code === INSTAGRAM_INVALID_PARAMETER_ERROR_CODE &&
      details.subcode === INSTAGRAM_QUICK_REPLY_REFUSED_SUBCODE;
    this.countsAsCircuitFailure = options.errorClass === 'outage';
  }
}

/** `Instagram answered HTTP 400: refused (code 100, subcode 2534015)` — no Instagram text, no token. */
function describeInstagramErrorAnswer({
  httpStatus,
  errorClass,
  details,
}: {
  httpStatus: number;
  errorClass: InstagramErrorClass;
  details: InstagramErrorDetails;
}): string {
  const codes = [
    details.code === null ? null : `code ${details.code}`,
    details.subcode === null ? null : `subcode ${details.subcode}`,
  ].filter((part) => part !== null);
  const suffix = codes.length > 0 ? ` (${codes.join(', ')})` : '';
  return `Instagram answered HTTP ${httpStatus}: ${errorClass}${suffix}`;
}

/**
 * Reads Instagram's error answer once into an {@link MetaGraphApiError} — the
 * `classifyResponseError` of every Instagram call.
 *
 * @remarks
 * The body is parsed by {@link readInstagramErrorBody} and classed by
 * {@link classifyInstagramErrorResponse}; a `throttled` answer carries how long to wait
 * ({@link readInstagramRetryAfterMs}).
 */
export function readMetaGraphErrorResponse({
  httpStatus,
  body,
  retryAfterHeader,
}: {
  httpStatus: number;
  body: string;
  retryAfterHeader: string | null;
}): MetaGraphApiError {
  const details = readInstagramErrorBody(body);
  const { errorClass, connectionStatus } = classifyInstagramErrorResponse({ httpStatus, details });
  return new MetaGraphApiError({
    errorClass,
    category: httpStatus >= 500 ? 'http_5xx' : 'http_4xx',
    connectionStatus,
    httpStatus,
    ...(errorClass === 'throttled'
      ? { retryAfterMs: readInstagramRetryAfterMs(retryAfterHeader) }
      : {}),
    details,
    fallbackMessage: describeInstagramErrorAnswer({ httpStatus, errorClass, details }),
  });
}

/**
 * Any error an Instagram call threw, as an {@link MetaGraphApiError}: one already is passes as is;
 * an {@link ExternalServiceError} from the outbound layer (timeout, network, an open circuit, a 5xx
 * or an unreadable body) becomes an `outage` keeping its category, status and `retryAfterMs`.
 *
 * @remarks
 * Anything else — our own failure, such as a token that does not decrypt — is returned unchanged,
 * so it stays a 500 instead of passing for Instagram being down.
 */
export function toMetaGraphApiError(error: unknown): unknown {
  if (error instanceof MetaGraphApiError || !(error instanceof ExternalServiceError)) {
    return error;
  }
  const { errorClass, connectionStatus } =
    error.category === 'http_4xx' && error.status !== undefined
      ? classifyInstagramErrorResponse({
          httpStatus: error.status,
          details: EMPTY_INSTAGRAM_ERROR_DETAILS,
        })
      : { errorClass: 'outage' as const, connectionStatus: null };
  return new MetaGraphApiError({
    errorClass,
    category: error.category,
    connectionStatus,
    ...(error.status !== undefined ? { httpStatus: error.status } : {}),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    cause: error,
    fallbackMessage: `Instagram call failed: ${errorClass} (${error.category})`,
  });
}

/**
 * The error for an Instagram success answer that lacks what the call needs (no `access_token`, no
 * `data` list): Instagram misbehaving, so an `outage`.
 */
export function buildMetaGraphMalformedAnswerError({
  operation,
  missing,
}: {
  operation: string;
  missing: string;
}): MetaGraphApiError {
  return new MetaGraphApiError({
    errorClass: 'outage',
    category: 'unknown',
    fallbackMessage: `Instagram answered ${operation} without ${missing}`,
  });
}

/**
 * Longest description {@link describeMetaGraphError} answers — the `varchar(500)` of
 * `app.channel_connections.last_check_error`.
 */
export const META_GRAPH_ERROR_DESCRIPTION_MAX_LENGTH = 500;

/**
 * A failed Meta call as a log line or `last_check_error` keeps it (IA8, MC11): Meta's class, code,
 * subcode and HTTP status — never its text, which can quote the token (Meta answers "Malformed
 * access token …" with it) — cut to 500 characters.
 *
 * @remarks
 * - **Algorithm:** a `MetaGraphApiError` → `<class> (code …, subcode …, HTTP …)`; anything else →
 *   its error name (an open circuit, a failure on our side), never its message.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 * - **Notes:** the client builds its errors without the request URL or the token, so nothing here
 *   can carry one. Used by the Instagram account jobs and the connection's break (MC11).
 */
export function describeMetaGraphError(error: unknown): string {
  if (!(error instanceof MetaGraphApiError)) {
    return `failed: ${error instanceof Error ? error.name : typeof error}`;
  }
  const details = [
    error.instagramErrorCode === null ? null : `code ${error.instagramErrorCode}`,
    error.instagramErrorSubcode === null ? null : `subcode ${error.instagramErrorSubcode}`,
    error.status === undefined ? null : `HTTP ${error.status}`,
  ].filter((part) => part !== null);
  const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  return `${error.errorClass}${suffix}`.slice(0, META_GRAPH_ERROR_DESCRIPTION_MAX_LENGTH);
}
