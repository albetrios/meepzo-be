import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { META_CALLBACK_BODY_LIMIT_BYTES } from '@/shared/constants/limits.constants.js';
import { WEBHOOK_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { createChannelConnectionMetaCallbackController } from './channel-connection-meta-callback.controller.js';
import { MetaSignedRequestDto } from './channel-connection-meta-callback.dto.js';
import { channelConnectionProviderParamsDto } from './channel-connection.dto.js';
import type { ChannelConnectionProvider } from './channel-connection-state.js';
import { channelConnectionMetaCallbackIngressPlugin } from './channel-connection-meta-callback-ingress.plugin.js';
import type { ChannelConnectionMetaCallbackService } from './channel-connection-meta-callback.service.js';

/**
 * Route 17's config: the webhook rate limit, and `raw_response` so the envelope middleware
 * (`response-format.middleware.ts`) sends Meta's `{ url, confirmation_code }` as it is — the same
 * flag the health probes and `/metrics` carry.
 */
const DATA_DELETION_ROUTE_CONFIG = { ...WEBHOOK_RATE_LIMIT.config, raw_response: true } as const;

/**
 * Returns the Fastify plugin that registers Meta's two callbacks with the connection (routes-final
 * § 1.7, MC14, P46), mounted under `/api/v1/app`: deauthorize (route 16) and data deletion
 * (route 17) at `/social/channel-connections/{provider}/…` (`meta` only). The URLs are set on the
 * Meta app as its "Deauthorize callback URL" and "Data deletion request URL" — one of each per app,
 * and the login is Meta-wide.
 *
 * @remarks
 * PUBLIC — no `app.authenticate`: Meta's `signed_request` proves the caller, checked by
 * {@link channelConnectionMetaCallbackIngressPlugin} (registered first, so it covers both routes)
 * together with the routes' only body parser, `application/x-www-form-urlencoded` (MC14), under a
 * 16 KB body limit (`META_CALLBACK_BODY_LIMIT_BYTES`, D53 — the body is read before the signature
 * can be checked, so it is small). No
 * idempotency key (K3 — Meta's own request is safe to repeat) and no CSRF check;
 * `WEBHOOK_RATE_LIMIT` per address, as the Stripe webhook. `{provider}` other than `meta` is
 * `400 provider` (the path schema, after the signature). Route 17 answers outside the
 * `{ data, meta }` envelope (`raw_response`, Meta's documented shape).
 */
export function channelConnectionMetaCallbackRoutes(
  service: ChannelConnectionMetaCallbackService,
): FastifyPluginAsync {
  const controller = createChannelConnectionMetaCallbackController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();

    await channelConnectionMetaCallbackIngressPlugin(app, {});
    zodApplication.post<{ Params: { provider: ChannelConnectionProvider } }>(
      '/social/channel-connections/:provider/deauthorize',
      {
        ...WEBHOOK_RATE_LIMIT,
        bodyLimit: META_CALLBACK_BODY_LIMIT_BYTES,
        schema: {
          summary: 'Meta: the app was removed (deauthorize)',
          description:
            "Meta's deauthorize callback, with the connection (provider meta): the app was removed. Public — Meta posts an application/x-www-form-urlencoded body with one field, signed_request, checked against the Meta app secret (HMAC-SHA256, constant time); a missing, doubled or bad one answers 400 instagram_signed_request_invalid and changes nothing; a body over 16 KB answers 413. The signed id is matched as a channel account's provider account id first (every organization holding that account, any status), else as a connection's business id (every not-revoked account of that business's connections). In each organization every account reached is disconnected: revoked, and its connection's token deleted (with the connection revoked) when no other account uses it; a business connection left with no account is revoked too. No automation run is cancelled, and an account or connection connected after Meta signed the request (issued_at) is left alone. Always 200 { data: null } once verified — also for an id never stored (logged, and the team alerted) or a repeat — so Meta does not retry. No idempotency key. 400 provider for any provider but meta; 503 instagram_not_configured when the Meta app secret is unset.",
          tags: ['Channel connection'],
          params: channelConnectionProviderParamsDto,
          body: MetaSignedRequestDto,
        },
      },
      controller.deauthorizeChannelConnection,
    );
    zodApplication.post<{ Params: { provider: ChannelConnectionProvider } }>(
      '/social/channel-connections/:provider/data-deletion',
      {
        ...WEBHOOK_RATE_LIMIT,
        config: DATA_DELETION_ROUTE_CONFIG,
        bodyLimit: META_CALLBACK_BODY_LIMIT_BYTES,
        schema: {
          summary: "Meta: delete the person's data (data deletion)",
          description:
            "Meta's data-deletion callback, with the connection (provider meta): the person asked for their data to be deleted. Public — Meta posts an application/x-www-form-urlencoded body with one field, signed_request, checked against the Meta app secret (HMAC-SHA256, constant time); a missing, doubled or bad one answers 400 instagram_signed_request_invalid and changes nothing; a body over 16 KB answers 413. Matched as the deauthorize is (the account id first, else the business id); in each organization every account reached is disconnected as the deauthorize does, its Instagram profile erased and its stored posts deleted — on an account match revoked rows of that account too; contacts are not touched, and an account or connection connected after Meta signed the request (issued_at) is left alone. Answers Meta's own shape outside the { data, meta } envelope: { url, confirmation_code } — the code derived from the signed request (the same request gets the same code), the url the frontend's status page. Always 200 once verified — also for an id never stored (logged, and the team alerted to delete by hand) or a repeat. No idempotency key. 400 provider for any provider but meta; 503 instagram_not_configured when the Meta app secret is unset.",
          tags: ['Channel connection'],
          params: channelConnectionProviderParamsDto,
          body: MetaSignedRequestDto,
        },
      },
      controller.deleteChannelConnectionData,
    );
  };
}
