import { createHmac, timingSafeEqual } from 'node:crypto';

/** A hex string of whole bytes (an even number of hex digits). */
const HEX_BYTES_PATTERN = /^(?:[0-9a-f]{2})+$/i;

/**
 * HMAC-SHA256 signature for outbound webhook payloads (`timestamp.payload` convention).
 */
export function signWebhookPayload({
  secret,
  payload,
  timestamp,
}: {
  secret: string;
  payload: string;
  timestamp: number;
}): string {
  const signedPayload = `${timestamp}.${payload}`;
  return createHmac('sha256', secret).update(signedPayload).digest('hex');
}

/** Builds the `X-Webhook-Signature` header value: `t=<timestamp>,v1=<signature>`. */
export function buildWebhookSignatureHeader({
  secret,
  payload,
  timestamp,
}: {
  secret: string;
  payload: string;
  timestamp: number;
}): string {
  return `t=${timestamp},v1=${signWebhookPayload({ secret, payload, timestamp })}`;
}

/**
 * Whether `presentedSignature` is the HMAC-SHA256 of `signedContent` (the raw bytes, or the exact
 * signed string) keyed with `secret`, compared in constant time — the one HMAC check behind every
 * webhook signature: Meta's `X-Hub-Signature-256` and signed request, and
 * {@link verifyWebhookPayloadSignature} (WHC2).
 *
 * @remarks
 * - **Algorithm:** the expected MAC is always computed, and `timingSafeEqual` runs whenever the
 *   lengths match (a MAC's length is public: 32 bytes), so a wrong signature costs the same time
 *   however close it is.
 * - **Failure modes:** none thrown — an empty secret never verifies anything, and a presented MAC
 *   of the wrong length is `false`.
 * - **Notes:** pass the exact bytes the sender signed; re-serialized JSON never matches.
 */
export function isHmacSha256SignatureValid({
  signedContent,
  presentedSignature,
  secret,
}: {
  signedContent: Buffer | string;
  presentedSignature: Buffer;
  secret: string;
}): boolean {
  if (secret.length === 0) return false;
  const expectedSignature = createHmac('sha256', secret).update(signedContent).digest();
  if (presentedSignature.length !== expectedSignature.length) return false;
  return timingSafeEqual(presentedSignature, expectedSignature);
}

/**
 * Constant-time verification of a hex signature from {@link signWebhookPayload}, through
 * {@link isHmacSha256SignatureValid}.
 */
export function verifyWebhookPayloadSignature({
  secret,
  payload,
  timestamp,
  signatureHex,
}: {
  secret: string;
  payload: string;
  timestamp: number;
  signatureHex: string;
}): boolean {
  // Whole bytes of hex only: `Buffer.from(…, 'hex')` silently drops a trailing odd character.
  if (!HEX_BYTES_PATTERN.test(signatureHex)) return false;
  return isHmacSha256SignatureValid({
    signedContent: `${timestamp}.${payload}`,
    presentedSignature: Buffer.from(signatureHex, 'hex'),
    secret,
  });
}
