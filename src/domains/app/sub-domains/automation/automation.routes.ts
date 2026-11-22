import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import type { AutomationService } from './automation.service.js';
import { createAutomationController } from './automation.controller.js';
import {
  automationIdParamsDto,
  createAutomationDto,
  deleteAutomationQueryDto,
  listAutomationsQueryDto,
  updateAutomationDto,
} from './automation.dto.js';

/**
 * Returns the Fastify plugin that registers the automation routes (routes-final § 3.A.7), mounted
 * under `/api/v1/app`: list (route 11, `GET /automations`), create (12, `POST /automations`), read
 * (13), edit (14) and delete (15) at `/automations/{automation_id}`.
 *
 * @remarks
 * Gates: `automation:read` on 11 and 13, `automation:create` on 12, `automation:update` on 14,
 * `automation:delete` on 15 (3.A.4 — a Member holds every one but delete). The writes run the
 * read-only plan guard first (`planAccessPreHandler`, AQ8, D27 — `403 organization_read_only`),
 * before the permission gate and the idempotency claim; the reads stay open. Route 12 requires
 * `X-Idempotency-Key` (K3) — merged into its `config`, never a top-level preset spread, which would
 * drop the flag. The writes carry the organization-scoped rate limit; the reads ride the global
 * limiter, as every plain authenticated read does.
 */
export function automationRoutes({
  automationService,
  planAccessPreHandler,
}: {
  automationService: AutomationService;
  /** The app domain's read-only plan guard (`createAppPlanAccessPreHandler`). */
  planAccessPreHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}): FastifyPluginAsync {
  const controller = createAutomationController(automationService);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get(
      '/automations',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_READ)],
        schema: {
          summary: 'List automations',
          description:
            "Lists the organization's automations — what answers comments, DMs and story replies on its Instagram accounts — each with its Instagram account, trigger, target, keywords, tags, the message of each step and its counters. Search q (the name, any case); filter by status (live, inactive), trigger_type (comment, story_reply, dm), target_scope (any, specific, next), next_post_status (waiting, linked, expired) and instagram_account_id (one account; an unknown one gives an empty page); sort by created_at (default, newest first), name (A to Z), last_triggered_at (never-triggered last either way) or completed_run_count (most first), order asc or desc. The first page carries an estimated total. A deleted automation is never listed. Team organizations only. Requires AUTOMATION_READ permission.",
          tags: ['Automation'],
          querystring: listAutomationsQueryDto,
        },
      },
      controller.listAutomations,
    );
    zodApplication.post(
      '/automations',
      {
        onRequest: [app.authenticate],
        preHandler: [
          planAccessPreHandler,
          requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_CREATE),
        ],
        config: { idempotencyRequired: true, ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config },
        schema: {
          summary: 'Create an automation',
          description:
            "Creates an automation on the organization's connected Instagram account (an expired or error account counts; without one, 409 instagram_not_connected) — also the frontend's Duplicate. Every save is a complete flow: the final message always, the opening and follow messages when their step is on, and on a comment automation with the opening message on its button title. next only on comment automations; dm automations take any post, need a keyword and the DM keyword trigger on; specific needs its post (comment) or story (story_reply); public replies only on comments, with 1–20 texts. A next automation needs both window dates (the start not before 24 hours ago, the end in the future and after the start) and waits for the first post inside them; a live waiting window that overlaps another of the same account sharing a keyword (or either has none) is 409 next_post_window_overlap. Keywords are trimmed, lowercased and deduplicated; tags deduplicated. Starts inactive unless sent live. instagram_account_id, the counters and the next-post status are set by the server — sending one is a 400. Team organizations only; refused with 403 organization_read_only while the plan is read-only. Requires X-Idempotency-Key and AUTOMATION_CREATE permission.",
          tags: ['Automation'],
          body: createAutomationDto,
        },
      },
      controller.createAutomation,
    );
    zodApplication.get(
      '/automations/:automation_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_READ)],
        schema: {
          summary: 'Get an automation',
          description:
            "Returns one automation with its Instagram account, trigger, target, the next-post window and status, keywords, tags, the message of each step, its counters and who created and last changed it. 404 automation_not_found when it is missing, deleted or another organization's. Team organizations only. Requires AUTOMATION_READ permission.",
          tags: ['Automation'],
          params: automationIdParamsDto,
        },
      },
      controller.getAutomation,
    );
    zodApplication.patch<{ Params: { automation_id: string } }>(
      '/automations/:automation_id',
      {
        onRequest: [app.authenticate],
        preHandler: [
          planAccessPreHandler,
          requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_UPDATE),
        ],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Edit an automation',
          description:
            "Changes any field of the create body — turn it live or inactive, change its trigger, target, keywords, tags or messages; null clears a nullable message or id. Every create rule runs on the automation as it will be after the edit, so turning it live needs a complete flow. Changing the window of an expired next automation makes it wait again; a linked one's window, target_scope and target ids are fixed (409 next_post_already_linked). An optional expected_updated_at (the automation's updated_at as read) refuses a save based on an older version with 409 record_changed. The Instagram account never changes. An edit reaches open runs from their next step; inactive stops new runs and lets open ones finish. Team organizations only; refused with 403 organization_read_only while the plan is read-only. Requires AUTOMATION_UPDATE permission.",
          tags: ['Automation'],
          params: automationIdParamsDto,
          body: updateAutomationDto,
        },
      },
      controller.updateAutomation,
    );
    zodApplication.delete<{ Params: { automation_id: string } }>(
      '/automations/:automation_id',
      {
        onRequest: [app.authenticate],
        preHandler: [
          planAccessPreHandler,
          requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_DELETE),
        ],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Delete an automation',
          description:
            "Deletes an automation, with why: reason (mistake, duplicate, not_needed, other) and a note, required for other. Its running and waiting runs are cancelled in the same step; its runs and comment logs stay. It is never listed or read again and cannot be restored. 404 automation_not_found when it is missing, already deleted or another organization's. Team organizations only; refused with 403 organization_read_only while the plan is read-only. Requires AUTOMATION_DELETE permission.",
          tags: ['Automation'],
          params: automationIdParamsDto,
          querystring: deleteAutomationQueryDto,
        },
      },
      controller.deleteAutomation,
    );
  };
}
