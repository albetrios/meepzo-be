import { createHmac } from 'node:crypto';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/** `POST /app/social/instagram/deauthorize` (route 7). */
export const INSTAGRAM_DEAUTHORIZE_PATH = testApiPath('/app/social/instagram/deauthorize');
/** `POST /app/social/instagram/data-deletion` (route 8). */
export const INSTAGRAM_DATA_DELETION_PATH = testApiPath('/app/social/instagram/data-deletion');

/** The form media type Meta posts both callbacks with. */
export const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

/** What Meta signs: by default `HMAC-SHA256`, a fixed `issued_at` and the given `user_id`. */
export interface TestMetaSignedRequestPayload {
  algorithm?: unknown;
  issued_at?: unknown;
  user_id?: unknown;
  [field: string]: unknown;
}

/**
 * `<base64url HMAC-SHA256 of the payload part>.<base64url JSON payload>` — Meta's `signed_request`,
 * signed with `appSecret`.
 */
export function buildMetaSignedRequest({
  payload,
  appSecret,
}: {
  payload: TestMetaSignedRequestPayload;
  appSecret: string;
}): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', appSecret).update(encodedPayload).digest('base64url');
  return `${signature}.${encodedPayload}`;
}

/**
 * An `issued_at` after every connection made so far (Unix seconds): Meta signs a request about the
 * connection that exists, and one connected after it is left alone (D53). A minute ahead, so a
 * database clock a little ahead of this process does not matter.
 */
export function metaIssuedAtAfterConnections(): number {
  return Math.floor(Date.now() / 1000) + 60;
}

/** The payload Meta signs for `userId`: `HMAC-SHA256`, `issued_at`, `user_id`. */
export function metaSignedRequestPayload({
  userId,
  issuedAt = 1_763_740_000,
}: {
  userId: string;
  issuedAt?: number;
}): TestMetaSignedRequestPayload {
  return { algorithm: 'HMAC-SHA256', issued_at: issuedAt, user_id: userId };
}

/** `signed_request=<value>` as a form body (URL-encoded). */
export function metaCallbackFormBody(signedRequest: string): string {
  return new URLSearchParams({ signed_request: signedRequest }).toString();
}
