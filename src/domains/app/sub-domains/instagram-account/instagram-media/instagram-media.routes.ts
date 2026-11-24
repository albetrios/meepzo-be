import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { channelAccountIdParamsDto } from '@/domains/app/sub-domains/channel-account/channel-account.dto.js';
import type { InstagramMediaService } from './instagram-media.service.js';
import { createInstagramMediaController } from './instagram-media.controller.js';
import { ListInstagramMediaQueryDto } from './instagram-media.dto.js';

/**
 * Returns the Fastify plugin that registers the post and story pickers (routes-final § 2.C —
 * routes 13–14), mounted under `/api/v1/app`:
 * `GET /social/instagram/accounts/{channel_account_id}/media` and `…/stories`, both read live from
 * Meta for the named account (IA15, P47).
 *
 * @remarks
 * Gate: `instagram-account:read` on both (2.C.4) — Owner, Admin, Editor and Viewer. Both ride the
 * global limiter, as every plain authenticated read does. The query is Meta's own paging
 * (`limit` 1–50, `after`), strict.
 */
export function instagramMediaRoutes(service: InstagramMediaService): FastifyPluginAsync {
  const controller = createInstagramMediaController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get(
      '/social/instagram/accounts/:channel_account_id/media',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.INSTAGRAM_ACCOUNT_READ)],
        schema: {
          summary: 'List Instagram posts and reels',
          description:
            "Returns one page of the named Instagram account's posts and reels, read live from Meta with its connection's token for the post picker — kind (post, reel, ad_post), type, product type, caption, media link (falling back to the thumbnail, then the permalink), thumbnail link, permalink, publish time, comment and like counts, and a carousel's items. Stores nothing. Paging is Meta's own cursor: limit 1–50 (default 25), after = the previous page's meta.pagination.next; no total. 404 channel_account_not_found for another organization's, a revoked or a non-Instagram account; 404 instagram_reconnect_required when the account or its connection is error, or Meta refuses its token (the connection and its accounts then need a reconnect); 503 instagram_unavailable (with Retry-After) when Meta is down or throttling. Team organizations only. Requires INSTAGRAM_ACCOUNT_READ permission.",
          tags: ['Instagram account'],
          params: channelAccountIdParamsDto,
          querystring: ListInstagramMediaQueryDto,
        },
      },
      controller.listInstagramMedia,
    );
    zodApplication.get(
      '/social/instagram/accounts/:channel_account_id/stories',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.INSTAGRAM_ACCOUNT_READ)],
        schema: {
          summary: 'List live Instagram stories',
          description:
            "Returns one page of the named Instagram account's stories that are live now, read live from Meta with its connection's token for the story picker — type, media and thumbnail links, permalink, publish time, and when each ends (24 hours after it was published). Stores nothing. Paging is Meta's own cursor: limit 1–50 (default 25), after = the previous page's meta.pagination.next; no total. 404 channel_account_not_found for another organization's, a revoked or a non-Instagram account; 404 instagram_reconnect_required when the account or its connection is error, or Meta refuses its token; 503 instagram_unavailable (with Retry-After) when Meta is down or throttling. Team organizations only. Requires INSTAGRAM_ACCOUNT_READ permission.",
          tags: ['Instagram account'],
          params: channelAccountIdParamsDto,
          querystring: ListInstagramMediaQueryDto,
        },
      },
      controller.listInstagramStories,
    );
  };
}
