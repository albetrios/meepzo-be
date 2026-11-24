import { CircuitBreakerOpenError } from '@/infrastructure/resilience/circuit-breaker.js';
import { ConflictError, NotFoundError, UnprocessableEntityError } from '@/shared/errors/index.js';
import {
  INSTAGRAM_ACCESS_TOKEN_ERROR_CODE,
  MetaGraphApiError,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import {
  instagramConnectRestartRequiredError,
  instagramReconnectRequiredError,
  instagramUnavailableError,
  metaGraphCircuitOpenError,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-error.util.js';

/**
 * The channel connection's route errors (routes-final § 1.9) — built here once so routes 1–5, 15,
 * 40–42 answer alike. Meta outages reuse the Instagram account's `503 instagram_unavailable` and
 * `409 instagram_connect_restart_required` (the frontend already branches on them, MC3).
 */

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

/** `404 ad_account_not_found` — route 15's `ad_account_id` is not one of the connection's (MC13). */
export function adAccountNotFoundError(): NotFoundError {
  return new NotFoundError('Ad account').withReason('ad_account_not_found');
}

/** Whether Meta refused the connection's token itself (code 190) — the break of MC11. */
export function isMetaTokenRefused(error: unknown): boolean {
  return (
    error instanceof MetaGraphApiError &&
    error.errorClass === 'auth' &&
    error.instagramErrorCode === INSTAGRAM_ACCESS_TOKEN_ERROR_CODE
  );
}

/**
 * Whether Meta refused an ad read for a missing permission rather than the token (an `auth` class
 * answer other than code 190 — `ads_read` taken back, MC13): the picker then answers an empty list
 * with `meta.ad_access = 'missing'`.
 */
export function isMetaAdPermissionMissing(error: unknown): boolean {
  return (
    error instanceof MetaGraphApiError && error.errorClass === 'auth' && !isMetaTokenRefused(error)
  );
}

/**
 * An ad picker read's Meta failure as its route error (routes 15 and 41, MC13): the token refused
 * (code 190) → `404 instagram_reconnect_required` (the service has broken the connection first);
 * Meta refusing route 15's ads read → `404 ad_account_not_found`; Meta down, throttling, any other
 * refusal or its circuit open → `503 instagram_unavailable`. Anything else passes unchanged.
 */
export function toChannelConnectionAdReadError({
  error,
  adAccountId,
}: {
  error: unknown;
  /** Route 15's ad account on its ads read; `null` on the ad accounts read. */
  adAccountId: string | null;
}): unknown {
  if (error instanceof CircuitBreakerOpenError) return metaGraphCircuitOpenError(error);
  if (!(error instanceof MetaGraphApiError)) return error;
  if (error.errorClass === 'auth') return instagramReconnectRequiredError();
  if (error.errorClass === 'refused' && adAccountId !== null) return adAccountNotFoundError();
  return instagramUnavailableError(error.retryAfterSeconds);
}
