import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import type { InstagramAccountService } from './instagram-account.service.js';
import { createInstagramAccountController } from './instagram-account.controller.js';
import { InstagramAccountQueryDto } from './instagram-account.dto.js';

/**
 * Returns the Fastify plugin that registers the Instagram account routes (routes-final § 1.A),
 * mounted under `/api/v1/app`: read (route 2) and disconnect (route 4) at `/social/instagram/…`.
 * The launch's connect (route 1, Instagram Login) is gone (feat-instagram-dm-sending RC-6) —
 * accounts come in through a channel connection's pick. The two routes read the organization's
 * oldest-connected account until ROUTE row R5 names the account in the path (CA2).
 *
 * @remarks
 * Gates: `instagram-account:manage` on 4, `instagram-account:read` on 2 (1.A.4). The write carries
 * the organization-scoped rate limit; the read rides the global limiter, as every plain
 * authenticated read does.
 */
export function instagramAccountRoutes(service: InstagramAccountService): FastifyPluginAsync {
  const controller = createInstagramAccountController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get(
      '/social/instagram/account',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.INSTAGRAM_ACCOUNT_READ)],
        schema: {
          summary: 'Get the connected Instagram account',
          description:
            "Returns the organization's connected Instagram account — connected, expired or error (a reconnect is needed) — with its profile, when its token ends, whether its webhook events are subscribed, and its settings. Never the token. Reads the database only. 404 instagram_not_connected when no account is connected (a disconnected account is never shown). Team organizations only. Requires INSTAGRAM_ACCOUNT_READ permission.",
          tags: ['Instagram account'],
          querystring: InstagramAccountQueryDto,
        },
      },
      controller.getInstagramAccount,
    );
    zodApplication.delete(
      '/social/instagram/account',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.INSTAGRAM_ACCOUNT_MANAGE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Disconnect Instagram',
          description:
            "Disconnects the organization's Instagram account: unsubscribes it from Instagram's events (best effort), marks it revoked and erases its token. Its settings and profile are kept, and the organization may connect another account. No automation run is cancelled and automations stay live; nothing runs while no account is connected. Team organizations only. Requires INSTAGRAM_ACCOUNT_MANAGE permission.",
          tags: ['Instagram account'],
        },
      },
      controller.disconnectInstagramAccount,
    );
  };
}
