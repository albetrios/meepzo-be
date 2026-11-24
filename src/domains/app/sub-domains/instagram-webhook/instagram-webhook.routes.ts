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

/**
 * Returns the Fastify plugin for the Instagram webhook (routes-final § 4, WHC1), mounted under
 * `/api/v1/app` beside sub-domain 1's `/social/instagram/…` routes: Meta's subscription check
 * (route 16) and delivery (route 17) — both PUBLIC, proved by the verify token and the
 * `X-Hub-Signature-256` signature — and the nested `instagram-webhook-event` routes (route 18, the
 * received-events list, 4.B).
 *
 * @remarks
 * - Route 16, `GET /social/instagram/webhook`: `WEBHOOK_RATE_LIMIT` (Meta calls it once per
 *   subscription), the `hub.*` query, the challenge echoed `text/plain` (`raw_response`).
 * - Route 17, `POST /social/instagram/webhook`, in its own encapsulated context so the signature
 *   hook and the JSON-only parsing apply to it alone: `instagramWebhookIngressPlugin` registered
 *   before it (WH8), the raw body kept unparsed for `x-hub-signature-256` through the shared
 *   raw-body registry (WH2), the shared 5 MB body limit, `INSTAGRAM_WEBHOOK_RATE_LIMIT` (1,200 a
 *   minute per IP, WH11), `OK` as `text/plain`. Fastify's `text/plain` parser is removed there, so a
 *   body that is not `application/json` is a `415` (4.A.9). No `schema.body` — nothing is parsed
 *   before the signature passes, and a request without the header is refused before its body is
 *   read (D53).
 * - Neither takes `X-Idempotency-Key` (K3): Meta's own ids make a repeat safe.
 * - Route 18's gate, team-only rule and limiter are documented on `instagramWebhookEventRoutes`.
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
      '/social/instagram/webhook',
      {
        ...WEBHOOK_RATE_LIMIT,
        config: { ...WEBHOOK_RATE_LIMIT.config, raw_response: true },
        schema: {
          summary: 'Verify the Instagram webhook subscription',
          description:
            "Public endpoint Meta calls when the Instagram webhook is subscribed in the Meta App Dashboard (Meta's subscription check). hub.mode must be subscribe and hub.verify_token must equal META_WEBHOOK_VERIFY_TOKEN (compared in constant time); the hub.challenge value (1–256 characters, no spaces) is then echoed as text/plain with 200. Other parameters Meta adds are ignored. A missing hub.* parameter or a challenge too long is a 400; a wrong mode or token is a 400 with reason invalid_webhook_verify_token; without the setting it answers 503 instagram_webhook_not_configured. No Authorization header and no X-Idempotency-Key.",
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
        '/social/instagram/webhook',
        {
          ...INSTAGRAM_WEBHOOK_RATE_LIMIT,
          config: {
            ...INSTAGRAM_WEBHOOK_RATE_LIMIT.config,
            captureRawBody: true,
            rawBodySignatureHeader: INSTAGRAM_WEBHOOK_SIGNATURE_HEADER,
            raw_response: true,
          },
          bodyLimit: WEBHOOK_INGRESS_BODY_LIMIT_BYTES,
          schema: {
            summary: 'Receive an Instagram webhook delivery',
            description:
              "Public endpoint for Meta's Instagram webhook deliveries: comments, DMs, story replies and button clicks of the connected account. Verifies the X-Hub-Signature-256 header (sha256= and the HMAC-SHA256 of the raw JSON body with META_APP_SECRET, constant time) before anything is parsed: missing (refused before the body is read) or wrong is a 400 with reason invalid_webhook_signature; without the app secret it answers 503 instagram_webhook_not_configured. Each changes[] and messaging[] item is then stored, its text cleaned of NUL and lone surrogates, once per account and event key — born received, or skipped with its reason (echo, read_receipt, reaction, edit, unsupported, automation_disabled, account_disconnected) — and only then is OK answered as text/plain with 200; a repeat delivery stores nothing new, and an entry that cannot be stored never stops the others but the answer is then never a 200, so Meta delivers again. Events of an Instagram account no team holds (or a revoked one), a signed body that is not JSON, or an object other than instagram are answered OK and stored nowhere. Body application/json up to 5 MB (415 otherwise); 1,200 requests a minute per IP. No Authorization header and no X-Idempotency-Key.",
            tags: ['Instagram Webhook'],
          },
        },
        controller.receiveInstagramWebhookDelivery,
      );
    });

    await app.register(instagramWebhookEventRoutes(instagramWebhookEventService));
  };
}
