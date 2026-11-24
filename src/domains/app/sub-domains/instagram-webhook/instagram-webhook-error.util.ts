import { ServiceUnavailableError, ValidationError } from '@/shared/errors/index.js';
import { getPostgresErrorCode } from '@/shared/utils/infrastructure/postgres-error.util.js';

/**
 * The SQLSTATEs of a store unit that ran past its time: `57014` (a statement cancelled by the
 * unit's `statement_timeout`) and `55P03` (a lock wait cancelled by `lock_timeout`).
 */
const STORE_TIMEOUT_SQLSTATES: ReadonlySet<string> = new Set(['57014', '55P03']);

/** `Retry-After` (seconds) on the store-timeout 503 — Meta retries on its own schedule anyway. */
const STORE_TIMEOUT_RETRY_AFTER_SECONDS = 1;

/**
 * The webhook's answer for an entry whose store unit ran past its time (WH2, WHC2): a statement
 * cancelled by the unit's `statement_timeout` (SQLSTATE 57014) or a lock wait cancelled by
 * `lock_timeout` (55P03) — on the error or its `cause` chain (Drizzle wraps the driver's) — becomes a `503` with `Retry-After`, so Meta delivers again — the other
 * routes keep the error handler's `504` / `409` for those. Any other error is returned as it is
 * (the handler already answers a lost or refused connection `503`).
 *
 * @remarks
 * The 503 carries no `reason` (the internal signal is its `logReason`,
 * `instagram_webhook_store_timeout`): Meta reads only the status.
 */
export function toInstagramWebhookStoreFailure(error: unknown): unknown {
  const sqlState = getPostgresErrorCode(error);
  if (sqlState === undefined || !STORE_TIMEOUT_SQLSTATES.has(sqlState)) return error;
  return new ServiceUnavailableError()
    .withLogReason('instagram_webhook_store_timeout')
    .withRetryAfter(STORE_TIMEOUT_RETRY_AFTER_SECONDS);
}

/**
 * `503 instagram_webhook_not_configured` — the webhook's verify token (route 60) or the Meta
 * app secret (route 61) is not set, so Meta's proof cannot be checked and the route fails closed
 * (WH7, WH8). The reason survives on a 503 (D34).
 */
export function instagramWebhookNotConfiguredError(): ServiceUnavailableError {
  return new ServiceUnavailableError('errors:instagramWebhookNotConfigured').withReason(
    'instagram_webhook_not_configured',
  );
}

/**
 * `400 invalid_webhook_signature` — route 61's `X-Hub-Signature-256` is missing, malformed or not
 * the raw body's HMAC (WH8). The message is the one both webhook receivers share.
 */
export function invalidWebhookSignatureError(): ValidationError {
  return new ValidationError('errors:webhookSignatureVerificationFailed').withReason(
    'invalid_webhook_signature',
  );
}

/**
 * `400 invalid_webhook_verify_token` — route 60's `hub.mode` is not `subscribe`, or its
 * `hub.verify_token` differs from the setting (WH7). A failed webhook proof is a 400 in this
 * repository, never a 403 (`response-codes.md`).
 */
export function invalidWebhookVerifyTokenError(): ValidationError {
  return new ValidationError('errors:invalidWebhookVerifyToken').withReason(
    'invalid_webhook_verify_token',
  );
}
