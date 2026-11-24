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
  emptyAutomationActionDto,
  keywordTestAutomationDto,
  listAutomationsQueryDto,
  pauseAutomationDto,
  updateAutomationDto,
} from './automation.dto.js';

/**
 * Returns the Fastify plugin that registers the automation routes (feat-instagram-dm-sending
 * routes-final § 4.A.7 — routes 27–35), mounted under `/api/v1/app`: list and save a draft
 * (`/automations`), read, save content and delete (`/automations/{automation_id}`), and the actions
 * `go-live`, `pause`, `duplicate` and `keyword-test`. Routes 36–37 (failed messages) land with
 * ROUTE row R19.
 *
 * @remarks
 * Gates (4.A.4): `automation:read` on 27, 29, 35; `automation:create` on 28, 34;
 * `automation:update` on 30, 32, 33; `automation:delete` on 31. The read-only plan guard
 * (`planAccessPreHandler`, AU4 (1), P10) runs on route 32 only, first — create, edit, pause,
 * duplicate and delete stay open. `X-Idempotency-Key` is required on 28 and 34 (AU5); 32, 33 (state
 * no-ops) and 35 (saves nothing) take none. The writes and route 35 carry the organization-scoped
 * rate limit; the reads ride the global limiter.
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
            "Lists one channel account's automations (channel_account_id required — an unknown one gives an empty page) — draft, live and paused — each with its status, way to start, automatic stop, all-time runs started and % tapped (taps and typed answers over runs), last trigger time and when it was last edited. Filter by status and trigger_type (each comma-separated) and q (the name, any case); sort by created_at (default, newest first), name (A to Z) or last_triggered_at (never-triggered last either way), order asc or desc. meta.totals carries the account's live count and all-time runs started. A deleted automation is never listed. Team organizations only. Requires AUTOMATION_READ permission.",
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
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_CREATE)],
        config: { idempotencyRequired: true, ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config },
        schema: {
          summary: 'Save an automation draft',
          description:
            "Saves a draft automation on one of the organization's channel accounts: name, channel_account_id and trigger_type (one of 15 ways to start) are required; every other field — the start fields, target, keywords, public reply and its pacing, and the steps object (hello, follow, email, phone, the message list, tags) — is optional and checked for shape only. Nothing is sent and nothing else is checked until go-live. 400 channel_account_id when the account is not the organization's; 409 instagram_not_connected when it is disconnected; 409 automation_ref_code_exists when another automation of the account holds the link name. A link automation without a link name gets a free one. Reply like a person starts on when the plan allows it. Team organizations only; a read-only plan may save drafts. Requires X-Idempotency-Key and AUTOMATION_CREATE permission.",
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
            "Returns one automation in full — its account, status, way to start and target, keywords, public reply, steps, automatic stop, counts (runs started, taps, typed answers, % tapped, and the same per step version), the PRO parts the plan ignores now, its chat link for a link automation, and who created and last changed it. 404 automation_not_found when it is missing, deleted or another organization's. Team organizations only. Requires AUTOMATION_READ permission.",
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
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_UPDATE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Save automation content',
          description:
            "Saves any writable field (never status or channel_account_id; null clears a nullable field). A draft saves anything of the right shape. A live or paused automation must also pass the go-live content checks on the merged result — each problem is one errors[] item of a 400 whose field is the step path — and may not turn on a PRO part the plan lacks (403 plan_lacks_feature). The way to start changes only within its group (400 trigger_type); a linked next-post automation's target is fixed (409 next_post_already_linked); 409 automation_ref_code_exists when another automation of the account holds the link name. An optional expected_updated_at refuses a stale save with 409 record_changed. Waiting messages read the new text when they go. meta.warnings lists keywords another live automation of the account also uses. Team organizations only. Requires AUTOMATION_UPDATE permission.",
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
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_DELETE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Delete an automation',
          description:
            "Deletes an automation from any status, at once: an optional reason (mistake, duplicate, not_needed, other — other needs a note); its open runs are cancelled (automation_deleted) in the same step; the contacts it collected stay. It is never listed or read again and cannot be restored. 404 automation_not_found when it is missing, already deleted or another organization's. Team organizations only. Requires AUTOMATION_DELETE permission.",
          tags: ['Automation'],
          params: automationIdParamsDto,
          querystring: deleteAutomationQueryDto,
        },
      },
      controller.deleteAutomation,
    );
    zodApplication.post<{ Params: { automation_id: string } }>(
      '/automations/:automation_id/go-live',
      {
        onRequest: [app.authenticate],
        preHandler: [
          planAccessPreHandler,
          requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_UPDATE),
        ],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Go live',
          description:
            "Turns a draft or paused automation live after the full check: the account connected, the month limit not reached, the name, the way to start complete, keywords, starter questions (the account's live total at most 4), a free link name, one live first-message and default-reply automation per account, the hello (a 'sends your next step' button in every version), a comment start without a hello sending one plain text, the follow, email and phone asks, the message list (1–10, each complete, waits up to 23 hours, files uploaded and checked), public reply lines (3 or more with Reply like a person), tags, and every part through the account's feature check. Every problem is listed at once as 409 automation_not_ready with errors[] (field, reason, message). 403 organization_read_only while the plan has ended. A live automation answers as it is. meta.warnings lists a keyword another live automation uses and a private account on a comment kind — never a refusal. Strictly empty body. Team organizations only. Requires AUTOMATION_UPDATE permission.",
          tags: ['Automation'],
          params: automationIdParamsDto,
          body: emptyAutomationActionDto,
        },
      },
      controller.goLiveAutomation,
    );
    zodApplication.post<{ Params: { automation_id: string } }>(
      '/automations/:automation_id/pause',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_UPDATE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Pause an automation',
          description:
            'Pauses a live automation: mode keep (its waiting messages go on and people in the middle finish) or cancel (its waiting messages made until now are cancelled). A paused one with keep then cancel sets the cancel cut-off; the same mode again changes nothing. 409 transition_not_allowed for a draft. Allowed while the plan is read-only. Team organizations only. Requires AUTOMATION_UPDATE permission.',
          tags: ['Automation'],
          params: automationIdParamsDto,
          body: pauseAutomationDto,
        },
      },
      controller.pauseAutomation,
    );
    zodApplication.post<{ Params: { automation_id: string } }>(
      '/automations/:automation_id/duplicate',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_CREATE)],
        config: { idempotencyRequired: true, ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config },
        schema: {
          summary: 'Duplicate an automation',
          description:
            "Copies an automation of any status as a draft named '<name> (copy)' on the same account: its settings and steps (files by the same uploads); counters, reply pacing, past-comment reads, the automatic stop and the next-post link are not copied, and a link automation gets a new free link name. Strictly empty body. Team organizations only. Requires X-Idempotency-Key and AUTOMATION_CREATE permission.",
          tags: ['Automation'],
          params: automationIdParamsDto,
          body: emptyAutomationActionDto,
        },
      },
      controller.duplicateAutomation,
    );
    zodApplication.post<{ Params: { automation_id: string } }>(
      '/automations/:automation_id/keyword-test',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_READ)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Try an automation keyword',
          description:
            "Runs a text (1–1,000 characters) through the same matching intake uses — contains, plus one wrong letter in words of 5 or more letters, the words of a several-word keyword together and in order — for this automation and the account's live ones: whether it would start this automation, the keyword and exact or close, and which automation would answer first. source (comment, dm, story_reply) defaults from its way to start. Saves and sends nothing. Team organizations only. Requires AUTOMATION_READ permission.",
          tags: ['Automation'],
          params: automationIdParamsDto,
          body: keywordTestAutomationDto,
        },
      },
      controller.testAutomationKeyword,
    );
  };
}
