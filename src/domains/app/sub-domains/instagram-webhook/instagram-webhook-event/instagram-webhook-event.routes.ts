import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import type { InstagramWebhookEventService } from './instagram-webhook-event.service.js';
import { createInstagramWebhookEventController } from './instagram-webhook-event.controller.js';
import { ListInstagramWebhookEventsQueryDto } from './instagram-webhook-event.dto.js';

/**
 * Returns the Fastify plugin that registers route 62, the received-events list
 * (feat-instagram-dm-sending routes-final § 5.B): `GET /social/instagram/webhook-events`, mounted under `/api/v1/app` by the
 * parent's `instagram-webhook.routes.ts`.
 *
 * @remarks
 * Gate `instagram-webhook-event:read` (Owner and Admin, never Member — D4); team-only
 * (`404 team_organization_required` on a personal organization, K1); a plain authenticated read,
 * so it rides the global limiter, as every such read does.
 */
export function instagramWebhookEventRoutes(
  service: InstagramWebhookEventService,
): FastifyPluginAsync {
  const controller = createInstagramWebhookEventController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get(
      '/social/instagram/webhook-events',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.INSTAGRAM_WEBHOOK_EVENT_READ)],
        schema: {
          summary: 'List received Instagram webhook events',
          description:
            "Lists the Instagram events saved for the organization's channel accounts and what intake did with each — received, queued, processed, skipped (with the reason) or failed (with the error and next_attempt_at) — newest first: the debugging view. Filter by channel_account_id (a cha_ id; another organization's finds nothing), status, event_kind and received time (received_from inclusive, received_to exclusive, ISO 8601 with an offset); keyset pages (limit 1–100, default 25; a next-page cursor is valid only with the same filters); include_total=true adds a capped count. A waiting or failed event's payload keeps its shape with personal data masked: message and comment text cut to 40 characters, emails and phone numbers masked, media and attachment links replaced by [link]; ids, kinds and usernames stay. A done event's payload is null — the body is cleared when intake finishes. Events are kept 8 days. Reads the database only and changes nothing. Team organizations only. Requires INSTAGRAM_WEBHOOK_EVENT_READ permission.",
          tags: ['Instagram Webhook'],
          querystring: ListInstagramWebhookEventsQueryDto,
        },
      },
      controller.listInstagramWebhookEvents,
    );
  };
}
