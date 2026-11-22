import { createHmac } from 'node:crypto';
import type { MetaSignedRequestPayload } from '@/infrastructure/social/meta-signature.util.js';
import { PUBLIC_ID_LENGTH } from '@/shared/utils/identity/public-id.util.js';

/** The code's length: 21 characters, as a public id's tail (IA20). */
const META_DATA_DELETION_CONFIRMATION_CODE_LENGTH = PUBLIC_ID_LENGTH;
/** Separates the purpose from the signed values, so the code never equals another HMAC we make. */
const CONFIRMATION_CODE_PURPOSE = 'meta-data-deletion-confirmation';
/** The alphabet of the code: base 36 — `[0-9a-z]`. */
const CONFIRMATION_CODE_RADIX = 36;

/**
 * The confirmation code of Meta's data-deletion request (route 8, IA20): 21 characters
 * `[a-z0-9]`, derived from the signed request so Meta repeating one request gets the same code.
 *
 * @remarks
 * - **Algorithm:** HMAC-SHA256 with the app secret over the purpose, the signed `user_id` and
 *   `issued_at` (empty when Meta sent none); the 256-bit MAC read as a number, written in base 36
 *   and cut to its last 21 characters (zero-padded first) — about 108 bits, no bias that matters
 *   for a receipt. Nothing is stored: the audit entry carries the code (IQ2).
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 * - **Notes:** keyed with the app secret, so nobody without it can tell a code from a user id; a
 *   rotated app secret gives new codes for new requests only (the old ones are in the audit log).
 */
export function deriveMetaDataDeletionConfirmationCode({
  signedRequest,
  appSecret,
}: {
  signedRequest: MetaSignedRequestPayload;
  appSecret: string;
}): string {
  const mac = createHmac('sha256', appSecret)
    .update(`${CONFIRMATION_CODE_PURPOSE}:${signedRequest.userId}:${signedRequest.issuedAt ?? ''}`)
    .digest('hex');
  return BigInt(`0x${mac}`)
    .toString(CONFIRMATION_CODE_RADIX)
    .padStart(META_DATA_DELETION_CONFIRMATION_CODE_LENGTH, '0')
    .slice(-META_DATA_DELETION_CONFIRMATION_CODE_LENGTH);
}
