import {
  type CircuitBreakerOpenError,
  META_GRAPH_CIRCUIT_RESET_TIMEOUT_MS,
} from '@/infrastructure/resilience/circuit-breaker.js';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '@/shared/errors/index.js';
import { MILLISECONDS_PER_SECOND } from '@/shared/constants/ttl.constants.js';

/**
 * The Instagram account sub-domain's shared route errors (routes-final § 1.5, 1.A.9, 1.C.9, 1.D.9,
 * IA10) — built here once so the account routes, the post and story pickers and Meta's callbacks
 * answer alike.
 */

/** `Retry-After` (seconds) for an Instagram outage that named no wait: the circuit's reset window. */
const INSTAGRAM_OUTAGE_RETRY_AFTER_SECONDS = Math.ceil(
  META_GRAPH_CIRCUIT_RESET_TIMEOUT_MS / MILLISECONDS_PER_SECOND,
);

/**
 * `404 instagram_not_connected` — the organization has no account that is not revoked (routes 2–6;
 * IA13–IA16). The one builder of that answer, shared by the account, settings (route 3) and media
 * services.
 *
 * @remarks
 * Detail `errors:notFound` naming the `Instagram account` resource word (under `resources` in
 * `errors.json`); clients branch on the `reason`. A revoked account reads as not connected.
 */
export function instagramNotConnectedError(): NotFoundError {
  return new NotFoundError('Instagram account').withReason('instagram_not_connected');
}

/**
 * `409 instagram_not_connected` — a write that needs the organization's account found none that is
 * not revoked: creating an automation (routes-final § 3.A AU27, route 12). A conflict, not a 404,
 * because the state passes once an account connects; the reason and the detail are the route 2
 * answer's (`errors:notFound` naming the `Instagram account` resource word), reused.
 */
export function instagramNotConnectedConflictError(): ConflictError {
  return new ConflictError('errors:notFound', { resource: 'Instagram account' }).withReason(
    'instagram_not_connected',
  );
}

/**
 * `404 instagram_reconnect_required` — the account is `expired` or `error`, or Instagram just
 * refused its token (routes 5–6, IA16; a GET is never a 409, IA10). The frontend branches on the
 * reason and shows the reconnect card; the detail is the not-found message naming the Instagram
 * account resource, as `NotFoundError` builds every 404.
 */
export function instagramReconnectRequiredError(): NotFoundError {
  return new NotFoundError('Instagram account').withReason('instagram_reconnect_required');
}

/**
 * `400 instagram_signed_request_invalid` — Meta's `signed_request` on the deauthorize or
 * data-deletion callback (routes 7–8, IA18) is missing, doubled, malformed or wrongly signed,
 * names another algorithm, or carries no `user_id`; a bad provider signature is a 400, as the
 * Stripe webhook's (IA10). Detail `errors:instagramSignedRequestInvalid`.
 */
export function instagramSignedRequestInvalidError(): ValidationError {
  return new ValidationError('errors:instagramSignedRequestInvalid').withReason(
    'instagram_signed_request_invalid',
  );
}

/**
 * `503 instagram_unavailable` with `Retry-After`: Instagram's own wait when it named one (a
 * throttle), else the circuit's reset window (IA4, IA10).
 */
export function instagramUnavailableError(
  retryAfterSeconds: number | undefined,
): ServiceUnavailableError {
  return new ServiceUnavailableError('errors:instagramUnavailable')
    .withReason('instagram_unavailable')
    .withRetryAfter(retryAfterSeconds ?? INSTAGRAM_OUTAGE_RETRY_AFTER_SECONDS);
}

/**
 * `409 instagram_connect_restart_required` — connect (route 1, D56): Instagram's one-time code is
 * spent, and Instagram then failed, throttled or its circuit opened before the account was stored.
 *
 * @remarks
 * Detail `errors:instagramConnectRestartRequired`. Never with `Retry-After`: the same code would
 * answer `422 instagram_code_invalid`, so only a new "Connect Instagram" helps. Nothing of this
 * connect is stored; an account connected before stays as it is.
 */
export function instagramConnectRestartRequiredError(): ConflictError {
  return new ConflictError('errors:instagramConnectRestartRequired').withReason(
    'instagram_connect_restart_required',
  );
}

/**
 * `503 instagram_unavailable` for a call the open `instagram` circuit refused, with the circuit's
 * remaining open time as `Retry-After` (at least one second).
 */
export function metaGraphCircuitOpenError(error: CircuitBreakerOpenError): ServiceUnavailableError {
  return instagramUnavailableError(
    Math.max(1, Math.ceil(error.retryAfterMs / MILLISECONDS_PER_SECOND)),
  );
}
