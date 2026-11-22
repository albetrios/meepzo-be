import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { META_CALLBACK_BODY_LIMIT_BYTES } from '@/shared/constants/limits.constants.js';
import { WEBHOOK_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { createInstagramAccountMetaCallbackController } from './instagram-account-meta-callback.controller.js';
import { MetaSignedRequestDto } from './instagram-account-meta-callback.dto.js';
import { instagramAccountMetaCallbackIngressPlugin } from './instagram-account-meta-callback-ingress.plugin.js';
import type { InstagramAccountMetaCallbackService } from './instagram-account-meta-callback.service.js';

/**
 * Route 8's config: the webhook rate limit, and `raw_response` so the envelope middleware
 * (`response-format.middleware.ts`) sends Meta's `{ url, confirmation_code }` as it is — the same
 * flag the health probes and `/metrics` carry.
 */
const DATA_DELETION_ROUTE_CONFIG = { ...WEBHOOK_RATE_LIMIT.config, raw_response: true } as const;

/**
 * Returns the Fastify plugin that registers Meta's two callbacks for the Instagram account
 * (routes-final § 1.D), mounted under `/api/v1/app`: deauthorize (route 7) and data deletion
 * (route 8) at `/social/instagram/…`. The URLs are set on the Instagram app as its "Deauthorize
 * callback URL" and "Data deletion request URL".
 *
 * @remarks
 * PUBLIC — no `app.authenticate`: Meta's `signed_request` proves the caller, checked by
 * {@link instagramAccountMetaCallbackIngressPlugin} (registered first, so it covers both routes)
 * together with the routes' only body parser, `application/x-www-form-urlencoded` (IA18), under a
 * 16 KB body limit (`META_CALLBACK_BODY_LIMIT_BYTES`, D53 — the body is read before the signature
 * can be checked, so it is small). No
 * idempotency key (K3 — Meta's own request is safe to repeat) and no CSRF check;
 * `WEBHOOK_RATE_LIMIT` per address, as the Stripe webhook. Route 8 answers outside the
 * `{ data, meta }` envelope (`raw_response`, Meta's documented shape).
 */
export function instagramAccountMetaCallbackRoutes(
  service: InstagramAccountMetaCallbackService,
): FastifyPluginAsync {
  const controller = createInstagramAccountMetaCallbackController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();

    await instagramAccountMetaCallbackIngressPlugin(app, {});
    zodApplication.post(
      '/social/instagram/deauthorize',
      {
        ...WEBHOOK_RATE_LIMIT,
        bodyLimit: META_CALLBACK_BODY_LIMIT_BYTES,
        schema: {
          summary: 'Meta: Instagram app removed (deauthorize)',
          description:
            "Meta's deauthorize callback: the owner of a connected Instagram account removed the app. Public — Meta posts an application/x-www-form-urlencoded body with one field, signed_request, checked against the Instagram app secret (HMAC-SHA256, constant time); a missing, doubled or bad one answers 400 instagram_signed_request_invalid and changes nothing; a body over 16 KB answers 413. In every organization holding that Instagram account the account is disconnected: revoked and its token erased (no automation run is cancelled); an account connected after Meta signed the request (issued_at) is left alone. Always 200 { data: null } once verified — also for an account never stored, or a repeat — so Meta does not retry. No idempotency key. 503 instagram_not_configured when the Instagram app secret is unset.",
          tags: ['Instagram account'],
          body: MetaSignedRequestDto,
        },
      },
      controller.deauthorizeInstagramAccount,
    );
    zodApplication.post(
      '/social/instagram/data-deletion',
      {
        ...WEBHOOK_RATE_LIMIT,
        config: DATA_DELETION_ROUTE_CONFIG,
        bodyLimit: META_CALLBACK_BODY_LIMIT_BYTES,
        schema: {
          summary: "Meta: delete the Instagram owner's data (data deletion)",
          description:
            "Meta's data-deletion callback: the owner of a connected Instagram account asked for their data to be deleted. Public — Meta posts an application/x-www-form-urlencoded body with one field, signed_request, checked against the Instagram app secret (HMAC-SHA256, constant time); a missing, doubled or bad one answers 400 instagram_signed_request_invalid and changes nothing; a body over 16 KB answers 413. In every organization holding that Instagram account — disconnected rows included — the account is disconnected (revoked, token erased), its profile erased and its stored posts deleted; contacts are not touched, and an account connected after Meta signed the request (issued_at) is left alone. Answers Meta's own shape outside the { data, meta } envelope: { url, confirmation_code } — the code derived from the signed request (the same request gets the same code), the url the frontend's status page. Always 200 once verified — also for an account never stored, or a repeat. No idempotency key. 503 instagram_not_configured when the Instagram app secret is unset.",
          tags: ['Instagram account'],
          body: MetaSignedRequestDto,
        },
      },
      controller.deleteInstagramAccountData,
    );
  };
}
