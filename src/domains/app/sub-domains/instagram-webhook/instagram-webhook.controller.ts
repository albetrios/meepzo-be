import type { FastifyReply, FastifyRequest } from 'fastify';
import { getRequestIdentifier } from '@/shared/utils/http/request.util.js';
import type { InstagramWebhookSubscriptionQuery } from './instagram-webhook.dto.js';
import type { InstagramWebhookService } from './instagram-webhook.service.js';

/** Meta reads only the status; both answers are plain text, outside the `{ data, meta }` envelope. */
const PLAIN_TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';

/** Route 61's body once the events are saved (5.A.6). */
const DELIVERY_ACKNOWLEDGEMENT = 'OK';

/**
 * Builds the Instagram webhook handlers (feat-instagram-dm-sending routes-final § 5.A, routes
 * 60–61). Thin: each hands the
 * request to {@link InstagramWebhookService} and answers `200 text/plain` — the echoed challenge or
 * `OK` (the route config sets `raw_response`, so no envelope is added).
 */
export function createInstagramWebhookController(service: InstagramWebhookService) {
  return {
    /**
     * GET /api/v1/app/social/channel-connections/meta/webhooks/instagram — Meta's subscription
     * check (route 60, WH4). The
     * query is validated by the route schema; the mode and token are the service's to check.
     */
    async verifyInstagramWebhookSubscription(request: FastifyRequest, reply: FastifyReply) {
      const query = request.query as InstagramWebhookSubscriptionQuery;
      const challenge = service.verifySubscription({
        mode: query['hub.mode'],
        verifyToken: query['hub.verify_token'],
        challenge: query['hub.challenge'],
      });
      return reply.status(200).type(PLAIN_TEXT_CONTENT_TYPE).send(challenge);
    },

    /**
     * POST /api/v1/app/social/channel-connections/meta/webhooks/instagram — a Meta delivery
     * (route 61, WH9). The
     * `X-Hub-Signature-256` check already ran in `instagramWebhookIngressPlugin`, which then parsed
     * the verified bytes: `request.body` is their JSON, or `undefined` for a signed body that is not
     * JSON. `OK` only once the events are stored — a store failure propagates to the error handler
     * (`500` / `503`).
     */
    async receiveInstagramWebhookDelivery(request: FastifyRequest, reply: FastifyReply) {
      await service.receiveDelivery({
        body: request.body,
        requestId: getRequestIdentifier(request),
      });
      return reply.status(200).type(PLAIN_TEXT_CONTENT_TYPE).send(DELIVERY_ACKNOWLEDGEMENT);
    },
  };
}
