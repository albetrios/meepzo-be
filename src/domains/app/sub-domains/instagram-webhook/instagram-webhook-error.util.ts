import { ServiceUnavailableError, ValidationError } from '@/shared/errors/index.js';

/**
 * `503 instagram_webhook_not_configured` — the webhook's verify token (route 16) or the Instagram
 * app secret (route 17) is not set, so Meta's proof cannot be checked and the route fails closed
 * (WH7, WH8). The reason survives on a 503 (D34).
 */
export function instagramWebhookNotConfiguredError(): ServiceUnavailableError {
  return new ServiceUnavailableError('errors:instagramWebhookNotConfigured').withReason(
    'instagram_webhook_not_configured',
  );
}

/**
 * `400 invalid_webhook_signature` — route 17's `X-Hub-Signature-256` is missing, malformed or not
 * the raw body's HMAC (WH8). The message is the one both webhook receivers share.
 */
export function invalidWebhookSignatureError(): ValidationError {
  return new ValidationError('errors:webhookSignatureVerificationFailed').withReason(
    'invalid_webhook_signature',
  );
}

/**
 * `400 invalid_webhook_verify_token` — route 16's `hub.mode` is not `subscribe`, or its
 * `hub.verify_token` differs from the setting (WH7). A failed webhook proof is a 400 in this
 * repository, never a 403 (`response-codes.md`).
 */
export function invalidWebhookVerifyTokenError(): ValidationError {
  return new ValidationError('errors:invalidWebhookVerifyToken').withReason(
    'invalid_webhook_verify_token',
  );
}
