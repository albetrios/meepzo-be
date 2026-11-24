import { CircuitBreakerOpenError } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  ConflictError,
  NotFoundError,
  UnprocessableEntityError,
  ValidationError,
} from '@/shared/errors/index.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import {
  instagramConnectRestartRequiredError,
  instagramUnavailableError,
  metaGraphCircuitOpenError,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-error.util.js';

/**
 * The channel connection's route errors (routes-final § 1.9) — built here once so routes 1–5, 40 and
 * 42 answer alike. Meta outages reuse the Instagram account's `503 instagram_unavailable` and
 * `409 instagram_connect_restart_required` (the frontend already branches on them, MC3).
 */

/**
 * `400 instagram_signed_request_invalid` — Meta's `signed_request` on the deauthorize or
 * data-deletion callback (routes 16–17, MC14) is missing, doubled, malformed or wrongly signed,
 * names another algorithm, or carries no `user_id`; a bad provider signature is a 400, as the
 * Stripe webhook's. The reason keeps its launch name (routes-final § 1.9 "as built"). Detail
 * `errors:instagramSignedRequestInvalid`.
 */
export function instagramSignedRequestInvalidError(): ValidationError {
  return new ValidationError('errors:instagramSignedRequestInvalid').withReason(
    'instagram_signed_request_invalid',
  );
}

/** `404 channel_connection_not_found` — not this organization's, or a revoked one on 5 and 40. */
export function channelConnectionNotFoundError(): NotFoundError {
  return new NotFoundError('Channel connection').withReason('channel_connection_not_found');
}

/** `409 channel_connection_not_connected` — the pick on an `error` or `revoked` connection (MC7). */
export function channelConnectionNotConnectedError(): ConflictError {
  return new ConflictError('errors:channelConnectionNotConnected').withReason(
    'channel_connection_not_connected',
  );
}

/** `409 channel_connection_business_mismatch` — a reconnect came back from another business (MC17). */
export function channelConnectionBusinessMismatchError(): ConflictError {
  return new ConflictError('errors:channelConnectionBusinessMismatch').withReason(
    'channel_connection_business_mismatch',
  );
}

/** `409 plan_account_limit` — the picks would exceed the plan's `channel_accounts_max` (MC7). */
export function planAccountLimitError(): ConflictError {
  return new ConflictError('errors:planAccountLimit').withReason('plan_account_limit');
}

/** `409 instagram_account_connected_elsewhere` — a pick raced another organization's (MC7). */
export function channelAccountConnectedElsewhereError(): ConflictError {
  return new ConflictError('errors:instagramAccountConnectedElsewhere').withReason(
    'instagram_account_connected_elsewhere',
  );
}

/** `422 provider_permissions_missing` — a required Meta permission was not granted (MC5 step 4). */
export function providerPermissionsMissingError(): UnprocessableEntityError {
  return new UnprocessableEntityError('errors:providerPermissionsMissing').withReason(
    'provider_permissions_missing',
  );
}

/** `422 provider_code_invalid` — Meta refused the login code (MC5 step 2). */
export function providerCodeInvalidError(): UnprocessableEntityError {
  return new UnprocessableEntityError('errors:providerCodeInvalid').withReason(
    'provider_code_invalid',
  );
}

/**
 * A callback's Meta failure as its route error (MC5 step 2, launch D56): Meta refusing the code →
 * `422 provider_code_invalid`; Meta down, throttling or its circuit open → `503
 * instagram_unavailable` while the code may still pass, and once it is spent
 * `409 instagram_connect_restart_required`. Anything else (our own failure,
 * `instagram_not_configured`) passes unchanged.
 */
export function toChannelConnectRouteError({
  error,
  isCodeSpent,
}: {
  error: unknown;
  /** Meta answered the code exchange: the one-time code never passes again. */
  isCodeSpent: boolean;
}): unknown {
  if (error instanceof CircuitBreakerOpenError) {
    return isCodeSpent ? instagramConnectRestartRequiredError() : metaGraphCircuitOpenError(error);
  }
  if (!(error instanceof MetaGraphApiError)) return error;
  if (isCodeSpent) return instagramConnectRestartRequiredError();
  if (error.errorClass === 'refused' || error.errorClass === 'auth') {
    return providerCodeInvalidError();
  }
  return instagramUnavailableError(error.retryAfterSeconds);
}

/**
 * A Meta read with a stored token (the pick's assigned accounts) as its route error: the token
 * refused → `409 channel_connection_not_connected` (reconnect first); Meta down, throttling or its
 * circuit open → `503 instagram_unavailable`. Anything else passes unchanged.
 */
export function toChannelConnectionReadError(error: unknown): unknown {
  if (error instanceof CircuitBreakerOpenError) return metaGraphCircuitOpenError(error);
  if (!(error instanceof MetaGraphApiError)) return error;
  if (error.errorClass === 'auth') return channelConnectionNotConnectedError();
  return instagramUnavailableError(error.retryAfterSeconds);
}
