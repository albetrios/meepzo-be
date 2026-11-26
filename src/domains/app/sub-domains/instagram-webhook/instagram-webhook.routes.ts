import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { WEBHOOK_INGRESS_BODY_LIMIT_BYTES } from '@/shared/constants/limits.constants.js';
import {
  INSTAGRAM_WEBHOOK_RATE_LIMIT,
  WEBHOOK_RATE_LIMIT,
} from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import type { InstagramWebhookEventService } from './instagram-webhook-event/instagram-webhook-event.service.js';
import { instagramWebhookEventRoutes } from './instagram-webhook-event/instagram-webhook-event.routes.js';
import { INSTAGRAM_WEBHOOK_SIGNATURE_HEADER } from './instagram-webhook.constants.js';
import { createInstagramWebhookController } from './instagram-webhook.controller.js';
import { InstagramWebhookSubscriptionQueryDto } from './instagram-webhook.dto.js';
import type { InstagramWebhookService } from './instagram-webhook.service.js';
import { instagramWebhookIngressPlugin } from './instagram-webhook-ingress.plugin.js';
import { PLAN_GATE_OPEN_REASON } from '@/domains/billing/sub-domains/entitlement/entitlement.constants.js';

/**
 * Returns the Fastify plugin for the Instagram webhook (feat-instagram-dm-sending routes-final § 5,
 * WHC1), mounted under `/api/v1/app`: Meta's subscription check (route 60) and delivery (route 61)
 * at the Instagram object's own Meta webhook path (P53) — both PUBLIC, proved by the verify token
 * and the `X-Hub-Signature-256` signature — and the nested `instagram-webhook-event` routes (route
 * 62, the received-events list, 5.B).
 *
 * @remarks
 * - Route 60, `GET /social/channel-connections/meta/webhooks/instagram`: `WEBHOOK_RATE_LIMIT` (Meta
 *   calls it once per subscription), the `hub.*` query, the challenge echoed `text/plain`
 *   (`raw_response`).
 * - Route 61, `POST /social/channel-connections/meta/webhooks/instagram`, in its own encapsulated
 *   context so the signature hook and the JSON-only parsing apply to it alone:
 *   `instagramWebhookIngressPlugin` registered before it (WH4), the raw body kept unparsed for
 *   `x-hub-signature-256` through the shared raw-body registry (WH2), the shared 5 MB body limit,
 *   `INSTAGRAM_WEBHOOK_RATE_LIMIT` (no per-IP cap on the route; the plugin counts unsigned traffic
 *   only — 1,200 a minute per IP, S9), `overloadShedLast` (its own slice above the overload guard's
 *   thresholds, the UI sheds first — S10), `OK` as `text/plain`. Fastify's `text/plain` parser is
 *   removed there, so a body that is not `application/json` is a `415` (5.A.9). No `schema.body` —
 *   nothing is parsed before the signature passes, and a request without the header is refused
 *   before its body is read (D53).
 * - Neither takes `X-Idempotency-Key` (K3): Meta's own ids make a repeat safe.
 * - Route 62's gate, team-only rule and limiter are documented on `instagramWebhookEventRoutes`.
 */
export function instagramWebhookRoutes({
  instagramWebhookService,
  instagramWebhookEventService,
}: {
  instagramWebhookService: InstagramWebhookService;
  instagramWebhookEventService: InstagramWebhookEventService;
}): FastifyPluginAsync {
  const controller = createInstagramWebhookController(instagramWebhookService);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get(
      '/social/channel-connections/meta/webhooks/instagram',
      {
        ...WEBHOOK_RATE_LIMIT,
        config: { ...WEBHOOK_RATE_LIMIT.config, raw_response: true },
        schema: {
          summary: 'Verify the Instagram webhook subscription',
          description:
            "Public endpoint Meta calls when the Instagram object's webhook is subscribed in the Meta App Dashboard (Meta's subscription check; this path is the Instagram object's callback URL — each Meta object has its own). hub.mode must be subscribe and hub.verify_token must equal META_WEBHOOK_VERIFY_TOKEN (compared in constant time); the hub.challenge value (1–256 characters, no spaces) is then echoed as text/plain with 200. Other parameters Meta adds are ignored. A missing hub.* parameter or a challenge too long is a 400; a wrong mode or token is a 400 with reason invalid_webhook_verify_token; without the setting it answers 503 instagram_webhook_not_configured. No Authorization header and no X-Idempotency-Key.",
          tags: ['Instagram Webhook'],
          querystring: InstagramWebhookSubscriptionQueryDto,
        },
      },
      controller.verifyInstagramWebhookSubscription,
    );

    await app.register(async (receiver) => {
      receiver.removeContentTypeParser('text/plain');
      await instagramWebhookIngressPlugin(receiver, {});
      const zodApplication = receiver.withTypeProvider<ZodTypeProvider>();
      zodApplication.post(
        '/social/channel-connections/meta/webhooks/instagram',
        {
          ...INSTAGRAM_WEBHOOK_RATE_LIMIT,
          config: {
            ...INSTAGRAM_WEBHOOK_RATE_LIMIT.config,
            captureRawBody: true,
            rawBodySignatureHeader: INSTAGRAM_WEBHOOK_SIGNATURE_HEADER,
            raw_response: true,
            overloadShedLast: true,
            planGate: { open: PLAN_GATE_OPEN_REASON.META_CALLBACK },
          },
          bodyLimit: WEBHOOK_INGRESS_BODY_LIMIT_BYTES,
          schema: {
            summary: 'Receive an Instagram webhook delivery',
            description:
              "Public endpoint for Meta's Instagram webhook deliveries — the six subscribed fields (comments, live_comments, messages, messaging_postbacks, messaging_referral, message_reactions) of a connected channel account. Verifies the X-Hub-Signature-256 header (sha256= and the HMAC-SHA256 of the raw JSON body with the Meta app secret, constant time) before anything is parsed: missing (refused before the body is read) or wrong is a 400 with reason invalid_webhook_signature; without the app secret it answers 503 instagram_webhook_not_configured. Each changes[] and messaging[] item is then saved — nothing else is done here — its text cleaned of NUL and lone surrogates, once per account and event key: born received, or skipped with its reason (own_comment, edit, unsupported, automation_disabled); read receipts and the echoes of messages we sent are never saved, and neither is an event whose Meta time is over 8 days old. Only then is OK answered as text/plain with 200; a repeat delivery saves nothing new. An entry that cannot be saved never stops the others, but the answer is then never a 200: Postgres down, or the save over its 3-second limit, is a 503 (500 for any other failure), nothing is kept anywhere else, and Meta delivers again. Events of an Instagram account no team holds (or a revoked one), a signed body that is not JSON, or an object other than instagram are answered OK and saved nowhere. Body application/json up to 5 MB (415 otherwise); requests without a valid signature are capped at 1,200 a minute per IP (429), validly signed ones are never counted. No Authorization header and no X-Idempotency-Key.",
            tags: ['Instagram Webhook'],
          },
        },
        controller.receiveInstagramWebhookDelivery,
      );
    });

    await app.register(instagramWebhookEventRoutes(instagramWebhookEventService));
  };
}
