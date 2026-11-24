import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { instagramSendingStatusParamsDto } from './instagram-sending.dto.js';
import type { InstagramSendingService } from './instagram-sending.service.js';
import { createInstagramSendingController } from './instagram-sending.controller.js';

/**
 * Returns the Fastify plugin that registers the sending sub-domain's two reads
 * (feat-instagram-dm-sending routes-final § 6.A, routes 63–64), mounted under `/api/v1/app`: one
 * Instagram account's sending status at `/social/instagram/accounts/{channel_account_id}/sending-status`
 * and the organization's DM meter at `/usage`.
 *
 * @remarks
 * Gates `instagram-account:read` (63) and `organization:read` (64), 6.A.4. Reads: no
 * `X-Idempotency-Key`, no audit; team organizations only (a personal one → `404
 * team_organization_required`).
 */
export function instagramSendingRoutes(service: InstagramSendingService): FastifyPluginAsync {
  const controller = createInstagramSendingController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get<{ Params: { channel_account_id: string } }>(
      '/social/instagram/accounts/:channel_account_id/sending-status',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.INSTAGRAM_ACCOUNT_READ)],
        schema: {
          summary: 'Get an Instagram account sending status',
          description:
            "Returns what one Instagram account's sending banners need: whether it is paused or suspended, when its new-account limit ends, each of its four lanes (slow, reply, fast, broadcast) with its waiting messages, state, wait reason, next send time, its own stop (reason, until, since) and the account's plan stop when that holds the lane, a stop of every account, the waiting estimate (about how many will go, how many may expire, done at about), today's results in the organization's day (sent, not sure, skipped and of those chat closed, expired), the chat-closed lines per automation and the last broadcast, past-comments and retry results. Reads the database only, never Instagram. 400 channel_account_id when the id is not a cha_ id; 404 instagram_not_connected when it is not this organization's Instagram account or is revoked. Team organizations only (404 team_organization_required). Requires INSTAGRAM_ACCOUNT_READ permission.",
          tags: ['Instagram sending'],
          params: instagramSendingStatusParamsDto,
        },
      },
      controller.getInstagramSendingStatus,
    );
    zodApplication.get(
      '/usage',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ORGANIZATION_READ)],
        schema: {
          summary: 'Get the organization usage',
          description:
            "Returns the organization's DM meter for this month of its time zone — messages sent into people's chats across every account (used), the plan's monthly limit, the day it starts again (resets_on, the 1st of next month) and its state (ok; nearly from 80 %; reached at 100 %) — the channel accounts in use against the plan's maximum, and the notices to show (limit nearly reached or reached, payment failed, plan ended, trial ends soon). Reads the database only; the meter may be up to 10 seconds behind. Team organizations only (404 team_organization_required). Requires ORGANIZATION_READ permission.",
          tags: ['Instagram sending'],
        },
      },
      controller.getAppUsage,
    );
  };
}
