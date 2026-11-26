import type { ValidationErrorItem } from './validation.error.js';
/** Discriminator for {@link AppError} subclasses; mapped to wire-format codes via {@link ERROR_CODE_TO_SNAKE}. */
export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNPROCESSABLE_ENTITY'
  | 'GONE'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'NOT_IMPLEMENTED';

/** Paddle-style snake_case error code for API responses */
export const ERROR_CODE_TO_SNAKE: Record<AppErrorCode, string> = {
  VALIDATION_ERROR: 'invalid_field',
  NOT_FOUND: 'not_found',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  UNPROCESSABLE_ENTITY: 'unprocessable_entity',
  GONE: 'gone',
  SERVICE_UNAVAILABLE: 'service_unavailable',
  INTERNAL_ERROR: 'internal_error',
  NOT_IMPLEMENTED: 'not_implemented',
};

/**
 * The only extra fields an error body may carry beside `type`, `code`, `reason`, `detail` and
 * `errors[]`, each with the JSON kind the error handler lets through (anything else is dropped):
 *
 * - AT3: `tries_left` (the wrong-code tries left on this code) and `retry_after_seconds` (the wait of
 *   a `429`, beside the `Retry-After` header, so a browser app need not read headers);
 * - the plan refusal contract (plan-gating close, P269): `feature` (the plan feature key a
 *   `plan_lacks_feature` names), `limit` and `used` (`plan_account_limit`, `seat_limit_reached`),
 *   `grace_ends_at` (`organization_read_only`: when write access ended, ISO 8601 or `null`) and
 *   `upgrade_required` (`true` when a plan change is what lifts the refusal — the client picks the
 *   plan from `GET /billing/plans` by `feature` / `limit`);
 * - the month refusal's numbers (change-plan-gates P6): `limit` and `used` on
 *   `message_month_limit_reached`, and `resets_on` (the 1st of next month, `YYYY-MM-DD`, when the
 *   month's count starts again).
 *
 * A unit test pins this map; a new field is a contract change.
 */
export const APP_ERROR_FIELD_KINDS = {
  tries_left: 'integer',
  retry_after_seconds: 'integer',
  feature: 'string',
  limit: 'integer',
  used: 'integer',
  grace_ends_at: 'timestamp_or_null',
  upgrade_required: 'boolean',
  resets_on: 'date',
  missing_permissions: 'string_list',
  expected_client_business_id: 'string',
  plan_room: 'plan_room',
  permission: 'string',
} as const;

/** The names of {@link APP_ERROR_FIELD_KINDS}, in their order. */
export const APP_ERROR_FIELD_NAMES = Object.keys(APP_ERROR_FIELD_KINDS) as ReadonlyArray<
  keyof typeof APP_ERROR_FIELD_KINDS
>;

/** The JSON value each {@link APP_ERROR_FIELD_KINDS} kind carries. */
interface AppErrorFieldValueByKind {
  integer: number;
  string: string;
  timestamp_or_null: string | null;
  boolean: boolean;
  date: string;
  /** A non-empty list of non-empty strings (feat-meta-connect-flow CN3: `missing_permissions`). */
  string_list: string[];
  /** The plan's room for channel accounts (feat-meta-connect-flow CN6), as the success answers carry it. */
  plan_room: { accounts_max: number; accounts_used: number; accounts_free: number };
}

/** The extra error-body fields set with {@link AppError.withFields} — see {@link APP_ERROR_FIELD_KINDS}. */
export type AppErrorFields = {
  -readonly [Name in keyof typeof APP_ERROR_FIELD_KINDS]?: AppErrorFieldValueByKind[(typeof APP_ERROR_FIELD_KINDS)[Name]];
};

/**
 * Base class for every typed application error. Carries an HTTP status code,
 * an i18n `messageKey`, optional `messageParams` for interpolation, and a
 * fallback English message used when no i18n context is available. The error
 * handler middleware translates `messageKey` via `request.t()`.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;
  /** Translation key (e.g. "errors:notFound"); error handler uses request.t(messageKey, messageParams). */
  readonly messageKey: string;
  /** Interpolation params for request.t(messageKey, messageParams). */
  readonly messageParams?: Record<string, string | number>;
  /**
   * Optional stable, machine-readable sub-code (snake_case) the frontend can branch on
   * (e.g. `membership_already_exists`, `organization_slug_exists`) — distinct from the
   * status-class `code`. Set via {@link AppError.withReason}; the error handler serializes it as
   * `error.reason` on every 4xx and on a 503 (a dependency down or unset — launch D34), never on
   * another 5xx. A stable cause the client can act on, so never internal detail.
   */
  reason?: string;
  /**
   * Why the server answered this, for its one log line only — an internal signal the client must
   * not see, unlike {@link AppError.reason}. Set via {@link AppError.withLogReason}; the error
   * handler logs it as the `reason` of a 503's `request.service_unavailable` warning.
   */
  logReason?: string;
  /**
   * Seconds the client should wait before retrying — the error handler sends it as `Retry-After`.
   * Set via {@link AppError.withRetryAfter}; meaningful on 429 and 503.
   */
  retryAfterSeconds?: number;
  /**
   * Extra snake_case fields the error body carries as `error.<name>` (AT3, P269) — only the names
   * and kinds in {@link APP_ERROR_FIELD_KINDS}. Set via {@link AppError.withFields}; serialized on a 4xx only.
   */
  fields?: AppErrorFields;
  /**
   * A list of problems a non-validation error carries as `error.errors[]` — the one use today is
   * `409 automation_not_ready` (feat-instagram-dm-sending AUQ1, P68), each item with its `field`,
   * `reason` and translated message. Set via {@link AppError.withErrorItems}; a `ValidationError`
   * keeps its own `errors`.
   */
  errorItems?: ValidationErrorItem[];

  constructor(
    code: AppErrorCode,
    statusCode: number,
    messageKey: string,
    messageParams?: Record<string, string | number>,
    fallbackMessage?: string,
  ) {
    super(fallbackMessage ?? messageKey);
    this.code = code;
    this.statusCode = statusCode;
    this.messageKey = messageKey;
    if (messageParams !== undefined) {
      this.messageParams = messageParams;
    }
    this.name = this.constructor.name;
  }

  /**
   * Attaches a stable machine-readable {@link AppError.reason} slug and returns `this` (fluent),
   * e.g. `throw new ConflictError('errors:membershipAlreadyExists').withReason('membership_already_exists')`.
   */
  withReason(reason: string): this {
    this.reason = reason;
    return this;
  }

  /**
   * Attaches {@link AppError.logReason} and returns `this` (fluent), e.g.
   * `throw new ServiceUnavailableError().withLogReason('event_loop_overload')` — logged, never sent.
   */
  withLogReason(logReason: string): this {
    this.logReason = logReason;
    return this;
  }

  /**
   * Attaches {@link AppError.retryAfterSeconds} and returns `this` (fluent), e.g.
   * `throw new ServiceUnavailableError().withRetryAfter(1)`; the error handler sends `Retry-After`.
   */
  withRetryAfter(seconds: number): this {
    this.retryAfterSeconds = seconds;
    return this;
  }

  /**
   * Attaches extra body fields ({@link AppError.fields}) and returns `this` (fluent), e.g.
   * `throw new UnauthorizedError('errors:emailCodeWrong').withReason('code_wrong').withFields({ tries_left: 3 })`.
   * Merges with fields set before; the names and value kinds are limited to {@link APP_ERROR_FIELD_KINDS} by the type.
   */
  withFields(fields: AppErrorFields): this {
    this.fields = { ...this.fields, ...fields };
    return this;
  }

  /**
   * Attaches {@link AppError.errorItems} and returns `this` (fluent), e.g.
   * `throw new ConflictError('errors:automationNotReady').withReason('automation_not_ready').withErrorItems(items)`.
   */
  withErrorItems(items: ValidationErrorItem[]): this {
    this.errorItems = items;
    return this;
  }
}
