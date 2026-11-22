import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import type { InstagramMediaService } from './instagram-media.service.js';
import { createInstagramMediaController } from './instagram-media.controller.js';
import { ListInstagramMediaQueryDto } from './instagram-media.dto.js';

/**
 * Returns the Fastify plugin that registers the post and story pickers (routes-final § 1.C —
 * routes 5–6), mounted under `/api/v1/app`: `GET /social/instagram/media` and
 * `GET /social/instagram/stories`, both read live from Instagram.
 *
 * @remarks
 * Gate: `instagram-account:read` on both (1.C.4) — a Member may browse. Both ride the global
 * limiter, as every plain authenticated read does. The query is Instagram's own paging
 * (`limit` 1–50, `after`), strict.
 */
export function instagramMediaRoutes(service: InstagramMediaService): FastifyPluginAsync {
  const controller = createInstagramMediaController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get(
      '/social/instagram/media',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.INSTAGRAM_ACCOUNT_READ)],
        schema: {
          summary: 'List Instagram posts and reels',
          description:
            "Returns one page of the connected Instagram account's posts and reels, read live from Instagram for the post picker — type, product type, caption, media and thumbnail links, permalink, publish time, comment and like counts, and a carousel's items. Stores nothing. Paging is Instagram's own cursor: limit 1–50 (default 25), after = the previous page's meta.pagination.next; no total. 404 instagram_not_connected with no account; 404 instagram_reconnect_required when the account is expired or error, or Instagram refuses its token (the account then needs a reconnect); 503 instagram_unavailable (with Retry-After) when Instagram is down or throttling. Team organizations only. Requires INSTAGRAM_ACCOUNT_READ permission.",
          tags: ['Instagram account'],
          querystring: ListInstagramMediaQueryDto,
        },
      },
      controller.listInstagramMedia,
    );
    zodApplication.get(
      '/social/instagram/stories',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.INSTAGRAM_ACCOUNT_READ)],
        schema: {
          summary: 'List live Instagram stories',
          description:
            "Returns one page of the connected Instagram account's stories that are live now, read live from Instagram for the story picker — type, media and thumbnail links, permalink, publish time, and when each ends (24 hours after it was published). Stores nothing. Paging is Instagram's own cursor: limit 1–50 (default 25), after = the previous page's meta.pagination.next; no total. 404 instagram_not_connected with no account; 404 instagram_reconnect_required when the account is expired or error, or Instagram refuses its token; 503 instagram_unavailable (with Retry-After) when Instagram is down or throttling. Team organizations only. Requires INSTAGRAM_ACCOUNT_READ permission.",
          tags: ['Instagram account'],
          querystring: ListInstagramMediaQueryDto,
        },
      },
      controller.listInstagramStories,
    );
  };
}
