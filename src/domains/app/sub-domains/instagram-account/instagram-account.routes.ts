import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import {
  channelAccountIdParamsDto,
  emptyChannelAccountBodyDto,
} from '@/domains/app/sub-domains/channel-account/channel-account.dto.js';
import type { InstagramAccountMessageAccessService } from './instagram-account-message-access.service.js';
import { createInstagramAccountController } from './instagram-account.controller.js';

/**
 * Returns the Fastify plugin that registers the Instagram account's own route
 * (feat-meta-connect-flow routes-final § 3), mounted under `/api/v1/app`: check "Allow access to
 * messages" now (route 154) at `/social/instagram/accounts/{channel_account_id}/message-access-checks`.
 *
 * @remarks
 * Gate `instagram-account:manage` (3.4). No `X-Idempotency-Key` — a repeat lands in the same state
 * and the 60-second rule spares Meta (IG2). The organization-scoped rate limit, as every write.
 */
export function instagramAccountRoutes(
  service: InstagramAccountMessageAccessService,
): FastifyPluginAsync {
  const controller = createInstagramAccountController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.post<{ Params: { channel_account_id: string } }>(
      '/social/instagram/accounts/:channel_account_id/message-access-checks',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.INSTAGRAM_ACCOUNT_MANAGE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Check message access now',
          description:
            "Checks Instagram's Allow access to messages setting for one account now, with the same read-only probe the account's set-up runs, and stores the answer: on ends the account's access_off sending stop, off starts it on every lane (or keeps it), unknown leaves it. A check within 60 seconds of the last answers the stored result without calling Instagram (is_from_meta false). Answers channel_account_id, status (on, off, unknown), checked_at and is_from_meta. No body; no X-Idempotency-Key. 404 channel_account_not_found when it is not this organization's Instagram account or is revoked; 409 instagram_not_connected when the account or its connection is not connected (a refused token breaks the connection first); 503 instagram_unavailable when Instagram is down, nothing stored. Team organizations only. Requires INSTAGRAM_ACCOUNT_MANAGE permission.",
          tags: ['Instagram account'],
          params: channelAccountIdParamsDto,
          body: emptyChannelAccountBodyDto,
        },
      },
      controller.checkInstagramMessageAccess,
    );
  };
}
