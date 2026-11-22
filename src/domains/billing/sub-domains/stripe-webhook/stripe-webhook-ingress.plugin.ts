import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  constructStripeWebhookEvent,
  isStripeWebhookIngressConfigured,
} from '@/infrastructure/payment/stripe.client.js';
import { ServiceUnavailableError, ValidationError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/** The request's `stripe-signature`, or the refusal: 503 unconfigured first, then 400 without the header. */
function requireStripeSignature(request: FastifyRequest): string {
  if (!isStripeWebhookIngressConfigured()) {
    throw new ServiceUnavailableError('errors:stripeNotConfigured');
  }

  const signature = request.headers['stripe-signature'];
  if (!signature || typeof signature !== 'string') {
    throw new ValidationError('errors:missingStripeSignature');
  }
  return signature;
}

/**
 * Enforces Stripe webhook HMAC verification on every route registered after this plugin.
 * Controllers must read {@link FastifyRequest.stripeWebhookEvent} — not parse the body themselves.
 *
 * @remarks
 * - **Algorithm:** (1) a `preParsing` hook — after the rate limit, before the body is read —
 *   refuses a request without `stripe-signature`, which Stripe always sends (D53); (2) a
 *   `preHandler` hook verifies the raw bytes (`request.rawBody`, kept unparsed through the shared
 *   raw-body registry, WH2) with `constructStripeWebhookEvent`, which parses them only once their
 *   signature passed, and sets `request.stripeWebhookEvent` and `request.body`.
 * - **Failure modes:** `503 errors:stripeNotConfigured`; 400 for a missing header
 *   (`errors:missingStripeSignature`), no raw body (`errors:missingRawBody`), or a wrong signature
 *   or a signed body that is not JSON (`errors:webhookSignatureVerificationFailed`).
 * - **Side effects:** one log line per verified event (its id and type) or refusal (the SDK's message).
 */
export const stripeWebhookIngressPlugin: FastifyPluginAsync = async (application) => {
  application.addHook('preParsing', async (request, _reply, payload) => {
    requireStripeSignature(request);
    return payload;
  });

  application.addHook('preHandler', async (request) => {
    const signature = requireStripeSignature(request);

    // sec-B finding #7: the prior `Buffer.from(JSON.stringify(request.body))` fallback
    // was dead code at best (re-stringified JSON CANNOT produce a byte-identical body
    // for HMAC verification — key order, whitespace, escape sequences all diverge),
    // and at worst masked the real bug: the route's `bodyLimit` / content-type-parser
    // wiring failed to populate `request.rawBody`. With the fallback removed, a wiring
    // bug fails closed AT THE FIRST REQUEST instead of silently rejecting every
    // production webhook for the 3-day Stripe retry window.
    //
    // The app's JSON parser keeps the bytes on `request.rawBody` and leaves `request.body`
    // unparsed on this route (`src/app.ts`, D53). The Buffer and string branches handle another
    // parser's body: Fastify's own `text/plain` parser hands the text on unparsed.
    let parsedBody: Buffer | undefined;
    if (Buffer.isBuffer(request.body)) {
      parsedBody = request.body;
    } else if (typeof request.body === 'string') {
      parsedBody = Buffer.from(request.body);
    }
    const rawBody = request.rawBody ?? parsedBody;
    if (!rawBody) {
      throw new ValidationError('errors:missingRawBody');
    }

    try {
      const stripeWebhookEvent = constructStripeWebhookEvent({ body: rawBody, signature });
      request.stripeWebhookEvent = stripeWebhookEvent;
      request.body = stripeWebhookEvent;
      logger.info(
        { eventId: stripeWebhookEvent.id, eventType: stripeWebhookEvent.type },
        'stripe.webhook.verified',
      );
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'stripe.webhook.verification_failed',
      );
      throw new ValidationError('errors:webhookSignatureVerificationFailed');
    }
  });
};
