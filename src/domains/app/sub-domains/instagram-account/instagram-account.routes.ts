import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import type { InstagramAccountService } from './instagram-account.service.js';
import { createInstagramAccountController } from './instagram-account.controller.js';
import { ConnectInstagramAccountDto } from './instagram-account.dto.js';

/**
 * Returns the Fastify plugin that registers the Instagram account routes (routes-final § 1.A),
 * mounted under `/api/v1/app`: connect (route 1), read (route 2) and disconnect (route 4) at
 * `/social/instagram/…`. The account is one per organization, so no route carries a path id.
 *
 * @remarks
 * Gates: `instagram-account:manage` on 1 and 4, `instagram-account:read` on 2 (1.A.4). Route 1
 * requires `X-Idempotency-Key` (K3) — merged into its `config`, never a top-level preset spread,
 * which would drop the flag. The two writes carry the organization-scoped rate limit; the read
 * rides the global limiter, as every plain authenticated read does.
 */
export function instagramAccountRoutes(service: InstagramAccountService): FastifyPluginAsync {
  const controller = createInstagramAccountController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.post(
      '/social/instagram/connect',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.INSTAGRAM_ACCOUNT_MANAGE)],
        config: { idempotencyRequired: true, ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config },
        schema: {
          summary: 'Connect Instagram',
          description:
            'Finishes "Connect Instagram": swaps the authorization code Instagram sent to the frontend\'s callback for a long-lived token, reads the professional account\'s profile, and stores the account (connected), its default settings and its encrypted token; then subscribes it to comment, message and button-click events (a failed subscription never fails the connect). Reconnecting an account this organization had before — revoked included — reuses it and keeps its settings (is_new_connection false). Refuses a personal Instagram account, a missing permission, a code Instagram rejects, another live account in this organization and an account live in another organization; nothing is stored then. Team organizations only. Requires X-Idempotency-Key and INSTAGRAM_ACCOUNT_MANAGE permission.',
          tags: ['Instagram account'],
          body: ConnectInstagramAccountDto,
        },
      },
      controller.connectInstagramAccount,
    );
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
