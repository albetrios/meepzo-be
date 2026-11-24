import type { FastifyPluginAsync } from 'fastify';
import { readMetaAppSecret } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { parseMetaSignedRequest } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-signature.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { instagramSignedRequestInvalidError } from '@/domains/app/sub-domains/instagram-account/instagram-account-error.util.js';
import { META_CALLBACK_FORM_CONTENT_TYPE } from './instagram-account-meta-callback.constants.js';
import {
  MetaSignedRequestDto,
  type MetaSignedRequestInput,
} from './instagram-account-meta-callback.dto.js';

/**
 * One `signed_request` field of a form body, its value still encoded — at the start of the text or
 * after an `&`, up to the next `&`. A single pass with nothing to backtrack over.
 */
const SIGNED_REQUEST_FIELD_PATTERN = /(?:^|&)(signed_request(?:=[^&]*)?)(?=&|$)/g;

/**
 * Reads the one field of an `application/x-www-form-urlencoded` body the two callbacks use,
 * `signed_request` — absent when the body does not carry it exactly once, so a doubled one is
 * refused, never silently picked.
 *
 * @remarks
 * - **Algorithm:** one pass over the text finds the field, stopping at a second one; only that one
 *   pair is decoded (`URLSearchParams`: `+` and `%XX` as a browser does). Every other field is
 *   skipped without being decoded or collected, so a body of thousands of fields costs what a body
 *   of one does — this runs before the signature, for anybody (D53). The body itself is capped at
 *   `META_CALLBACK_BODY_LIMIT_BYTES` by the routes.
 * - **Failure modes:** none — any text parses (an empty body is `{}`).
 * - **Side effects:** none.
 * - **Notes:** Meta sends the field's name plainly, so an escaped spelling of it
 *   (`signed%5Frequest`) is another field. Exported for the unit test.
 */
export function parseMetaCallbackFormBody(body: string): Partial<MetaSignedRequestInput> {
  let signedRequestPair: string | undefined;
  for (const match of body.matchAll(SIGNED_REQUEST_FIELD_PATTERN)) {
    if (signedRequestPair !== undefined) return {};
    signedRequestPair = match[1];
  }
  if (signedRequestPair === undefined) return {};
  return { signed_request: new URLSearchParams(signedRequestPair).get('signed_request') ?? '' };
}

/**
 * The ingress of Meta's two callbacks (routes 7–8, IA18), registered inside their routes plugin
 * before the routes — the `stripeWebhookIngressPlugin` pattern: the routes' only body parser, and
 * the signed-request check every request passes before its handler.
 *
 * @remarks
 * - **Algorithm:** (1) drops every inherited body parser and adds one for
 *   `application/x-www-form-urlencoded` (encapsulated: only this plugin's routes), so JSON or any
 *   other body answers `415`, and which reads nothing but `signed_request`
 *   ({@link parseMetaCallbackFormBody}); (2) a `preValidation` hook — before the route's body schema, so a
 *   missing field is this `400`, not a field error — reads the app secret
 *   (`503 instagram_not_configured` when unset), takes the one `signed_request` field, and verifies
 *   it with `parseMetaSignedRequest` (HMAC-SHA256 with the app secret in constant time,
 *   `algorithm` `HMAC-SHA256`, a digits `user_id` — the helper shared with the webhook's
 *   signature). A good one is set on `request.metaSignedRequest`.
 * - **Failure modes:** `415` for a body that is not form-encoded (Fastify's parser lookup); `413`
 *   for one over the routes' 16 KB limit, before it is parsed;
 *   `400 instagram_signed_request_invalid` for a missing, doubled, malformed or wrongly signed
 *   request, another algorithm, or no `user_id`; `503 instagram_not_configured` without an app
 *   secret. A refused request changes nothing.
 * - **Side effects:** one log line per refused request (`app.instagram_account.meta_callback.
 *   signed_request_invalid`, the route only — never the request or a secret).
 * - **Notes:** no authentication, no idempotency key, no CSRF check (K3) — the signature is the
 *   proof. Controllers read `request.metaSignedRequest` and never parse the body themselves.
 */
export const instagramAccountMetaCallbackIngressPlugin: FastifyPluginAsync = async (
  application,
) => {
  application.removeAllContentTypeParsers();
  application.addContentTypeParser(
    META_CALLBACK_FORM_CONTENT_TYPE,
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, parseMetaCallbackFormBody(String(body)));
    },
  );

  application.addHook('preValidation', async (request) => {
    const appSecret = readMetaAppSecret();
    const body = MetaSignedRequestDto.safeParse(request.body ?? {});
    const signedRequest = body.success
      ? parseMetaSignedRequest({ signedRequest: body.data.signed_request, appSecret })
      : null;
    if (signedRequest === null) {
      logger.warn(
        { route: request.routeOptions.url },
        'app.instagram_account.meta_callback.signed_request_invalid',
      );
      throw instagramSignedRequestInvalidError();
    }
    request.metaSignedRequest = signedRequest;
  });
};
