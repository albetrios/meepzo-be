import { getEnv } from '@/shared/config/env.config.js';
import { isHmacSha256SignatureValid } from '@/shared/utils/security/webhook-signature.util.js';

/** `X-Hub-Signature-256`: `sha256=` and the 64 hex characters of an HMAC-SHA256 (WH8). */
const META_WEBHOOK_SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;
/** One base64url part of a signed request (padding allowed). */
const BASE64URL_PART_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;
/** The one algorithm Meta signs a signed request with (IA18). */
const META_SIGNED_REQUEST_ALGORITHM = 'HMAC-SHA256';
/** A signed request's `user_id`: digits only (IA18). */
const META_USER_ID_PATTERN = /^\d{1,64}$/;

/**
 * Checks Meta's `X-Hub-Signature-256` webhook header against the **raw** request body (WH8).
 *
 * @remarks
 * True only when the header is `sha256=` + 64 hex characters and those are the HMAC-SHA256 of
 * `rawBody` with the app secret, compared in constant time. A missing, malformed or wrong header —
 * or an empty app secret — is false (the ingress plugin answers 400). Pass the exact bytes Meta
 * sent: re-serialized JSON never matches.
 */
export function verifyMetaWebhookSignature({
  rawBody,
  signatureHeader,
  appSecret,
}: {
  rawBody: Buffer | string;
  signatureHeader: string | undefined;
  appSecret: string;
}): boolean {
  const match = META_WEBHOOK_SIGNATURE_PATTERN.exec(signatureHeader ?? '');
  const signatureHex = match?.[1];
  if (signatureHex === undefined) return false;
  return isHmacSha256SignatureValid({
    signedContent: rawBody,
    presentedSignature: Buffer.from(signatureHex, 'hex'),
    secret: appSecret,
  });
}

/** The verified content of Meta's signed request (IA18). */
export interface MetaSignedRequestPayload {
  /** The `user_id` Meta signed — digits, the person's app-scoped id (IQ3). */
  userId: string;
  /** The `issued_at` Meta signed (Unix seconds), or `null` when absent. */
  issuedAt: number | null;
}

/** The signed request's JSON payload as an object, or `null` when it is not one. */
function decodeMetaSignedRequestPayload(encodedPayload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A `user_id` as digits — a digit string, or a JSON number that is still exact — else `null`. */
function readMetaUserId(value: unknown): string | null {
  if (typeof value === 'string') return META_USER_ID_PATTERN.test(value) ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/**
 * Verifies and reads Meta's `signed_request` (`<signature>.<payload>`, both base64url) from the
 * deauthorize and data-deletion callbacks (IA18).
 *
 * @remarks
 * The signature is checked first — HMAC-SHA256 of the payload part as sent, with the app secret,
 * in constant time — and only then is the payload parsed. It must say `algorithm: "HMAC-SHA256"`
 * and carry a digits-only `user_id`. Anything else (missing, malformed, a wrong signature, another
 * algorithm, no `user_id`, an empty app secret) is `null` (the plugin answers
 * `400 instagram_signed_request_invalid`).
 */
export function parseMetaSignedRequest({
  signedRequest,
  appSecret,
}: {
  signedRequest: string | undefined;
  appSecret: string;
}): MetaSignedRequestPayload | null {
  const parts = (signedRequest ?? '').split('.');
  const [encodedSignature, encodedPayload] = parts;
  if (
    parts.length !== 2 ||
    encodedSignature === undefined ||
    encodedPayload === undefined ||
    !BASE64URL_PART_PATTERN.test(encodedSignature) ||
    !BASE64URL_PART_PATTERN.test(encodedPayload)
  ) {
    return null;
  }
  const signatureIsValid = isHmacSha256SignatureValid({
    signedContent: encodedPayload,
    presentedSignature: Buffer.from(encodedSignature, 'base64url'),
    secret: appSecret,
  });
  if (!signatureIsValid) return null;
  const payload = decodeMetaSignedRequestPayload(encodedPayload);
  if (payload === null || payload.algorithm !== META_SIGNED_REQUEST_ALGORITHM) return null;
  const userId = readMetaUserId(payload.user_id);
  if (userId === null) return null;
  const issuedAt =
    typeof payload.issued_at === 'number' && Number.isSafeInteger(payload.issued_at)
      ? payload.issued_at
      : null;
  return { userId, issuedAt };
}

/**
 * The two settings Meta's webhook routes prove a call with (feat-instagram-dm-sending § 5 WH4,
 * WHC3): the Meta app secret (`META_APP_SECRET`, the `X-Hub-Signature-256` key) and the Meta
 * webhook verify token (`META_WEBHOOK_VERIFY_TOKEN`, the subscription check) — each `null` while
 * unset, for the webhook to answer its own `503 instagram_webhook_not_configured`.
 */
export function readMetaWebhookSettings(): {
  appSecret: string | null;
  verifyToken: string | null;
} {
  const environment = getEnv();
  return {
    appSecret: environment.META_APP_SECRET || null,
    verifyToken: environment.META_WEBHOOK_VERIFY_TOKEN || null,
  };
}
