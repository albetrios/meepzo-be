import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import type { AutomationBackfillService } from './automation-backfill.service.js';
import { createAutomationBackfillController } from './automation-backfill.controller.js';
import {
  automationBackfillParamsDto,
  automationBackfillsParamsDto,
  startAutomationBackfillDto,
} from './automation-backfill.dto.js';

/**
 * Returns the Fastify plugin that registers the past-comments routes (feat-instagram-dm-sending
 * routes-final § 4.C.7 — routes 38–39), mounted under `/api/v1/app`: start a read
 * (`POST /automations/{automation_id}/backfills`) and read one
 * (`GET /automations/{automation_id}/backfills/{automation_backfill_id}`). No list route (AU33).
 *
 * @remarks
 * Gates (4.C.4): `automation:update` on 38, `automation:read` on 39 (P20 — no new codes).
 * `X-Idempotency-Key` is required on 38 (AU5, P89 — it starts background work). Route 38 carries
 * the organization-scoped rate limit; route 39 rides the global limiter. The read itself is the
 * job's (ROUTE row R41) — no Meta call inside the request.
 */
export function automationBackfillRoutes(
  automationBackfillService: AutomationBackfillService,
): FastifyPluginAsync {
  const controller = createAutomationBackfillController(automationBackfillService);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.post<{ Params: { automation_id: string } }>(
      '/automations/:automation_id/backfills',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_UPDATE)],
        config: {
          idempotencyRequired: true,
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { gates: ['feature:past_comments'] },
        },
        schema: {
          summary: 'Answer past comments',
          description:
            "Starts a past-comments read on a live comment or ad-comment automation: days (1–7) back from now, each comment found then goes through the usual intake (the 7-day rule, the once rule, the lowest priority). Answers the read queued; the account's reads run one at a time. 403 plan_lacks_feature when the plan has no past comments; 422 channel_lacks_feature or 409 permission_not_granted from the account's feature check; 409 automation_not_live for a draft or paused automation; 422 automation_backfill_not_supported for any other way to start (never a Live comment); 409 automation_backfill_in_progress while a read of it is queued or reading. A new start after a failed read makes a new one. Team organizations only. Requires X-Idempotency-Key and AUTOMATION_UPDATE permission.",
          tags: ['Automation backfill'],
          params: automationBackfillsParamsDto,
          body: startAutomationBackfillDto,
        },
      },
      controller.startAutomationBackfill,
    );
    zodApplication.get<{ Params: { automation_id: string; automation_backfill_id: string } }>(
      '/automations/:automation_id/backfills/:automation_backfill_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_READ)],
        schema: {
          summary: 'Get a past-comments read',
          description:
            "Returns one past-comments read of the automation: its days, status (queued, reading, done, failed), posts read, comments found, matched and opening messages queued so far, why it failed (meta_error, plan_feature_off), who started it and when it started and ended. 404 automation_backfill_not_found when it is another automation's or organization's; 404 automation_not_found when the automation is missing or deleted. Team organizations only. Requires AUTOMATION_READ permission.",
          tags: ['Automation backfill'],
          params: automationBackfillParamsDto,
        },
      },
      controller.getAutomationBackfill,
    );
  };
}
