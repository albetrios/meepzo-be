import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import type { BroadcastService } from './broadcast.service.js';
import { createBroadcastController } from './broadcast.controller.js';
import {
  broadcastIdParamsDto,
  createBroadcastBodyDto,
  emptyBroadcastActionBodyDto,
  listBroadcastsQueryDto,
  sendBroadcastBodyDto,
  updateBroadcastBodyDto,
} from './broadcast.dto.js';
import { PLAN_GATE_OPEN_REASON } from '@/domains/billing/sub-domains/entitlement/entitlement.constants.js';

/** The draft fields as the create and edit descriptions name them (BC8). */
const DRAFT_FIELDS_DESCRIPTION =
  'name (1–255 after trim; duplicates allowed); the audience — segment_id (a saved segment of the same account) or conditions (one-off, the segment condition tree: at most 2 levels and 20 conditions), never both, either may be empty in a draft; messages (0–3, in the automation message-list shape — text, image, cards, quick_replies, audio, file, post — each checked as an automation message, at most 64 KB); start_automation_id (a live automation of the same account its button starts). A segment or automation that is not of this account, an automation of another account in the conditions, or a message’s own problem answers 400.';

/**
 * Returns the Fastify plugin that registers the broadcast routes (routes-final § 7.A, routes 70–76),
 * mounted under `/api/v1/app`: the list (70), a draft (71), one (72), edit (73), delete (74), send
 * (75) and cancel (76).
 *
 * @remarks
 * Gates (7.A.4, P20 — the automation codes): `automation:read` on 70, 72; `automation:create` on 71;
 * `automation:update` on 73, 75, 76; `automation:delete` on 74. The PRO `broadcasts` switch is the
 * service's (BC3). Route 75 declares `read_only`, so the one plan guard (`src/routes.ts`) runs on
 * it first; every write declares its `config.planGate` (change-plan-gates RG1).
 * 71 creates a row, 75 starts background work and 76 hands the broadcast to the end duty, so all
 * three need `X-Idempotency-Key` (`idempotencyRequired`, 7.7); 73 takes an optional
 * `expected_updated_at`. The writes carry the organization-scoped rate limit; the reads ride the
 * global limiter.
 */
export function broadcastRoutes({
  broadcastService,
}: {
  broadcastService: BroadcastService;
}): FastifyPluginAsync {
  const controller = createBroadcastController(broadcastService);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get(
      '/broadcasts',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_READ)],
        schema: {
          summary: 'List broadcasts',
          description:
            "Lists one channel account's broadcasts — each with its name, status, mode, audience, messages, times and numbers (matched, sent, skipped, failed, replies, taps). channel_account_id is required (an unknown one gives an empty page). Filter by status (several, comma-separated) and mode; search q over the name; sort by created_at (default, newest first) or name, order asc or desc. The first page carries an estimated total. A deleted broadcast is never listed. Open on every plan. Team organizations only. Requires AUTOMATION_READ permission.",
          tags: ['Broadcasts'],
          querystring: listBroadcastsQueryDto,
        },
      },
      controller.listBroadcasts,
    );
    zodApplication.post(
      '/broadcasts',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_CREATE)],
        config: {
          idempotencyRequired: true,
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { gates: ['feature:broadcasts'] },
        },
        schema: {
          summary: 'Create a broadcast draft',
          description: `Makes a draft broadcast on one channel account: channel_account_id (fixed) and ${DRAFT_FIELDS_DESCRIPTION} Nothing is sent until send. A plan without broadcasts answers 403 plan_lacks_feature; a message kind the account's channel cannot send 422 channel_lacks_feature; 409 permission_not_granted when the connection lacks the messaging permission. 404 instagram_not_connected when the account is not this organization's or is disconnected. Answers the broadcast. Needs X-Idempotency-Key. Team organizations only. Requires AUTOMATION_CREATE permission.`,
          tags: ['Broadcasts'],
          body: createBroadcastBodyDto,
        },
      },
      controller.createBroadcast,
    );
    zodApplication.get<{ Params: { broadcast_id: string } }>(
      '/broadcasts/:broadcast_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_READ)],
        schema: {
          summary: 'Get a broadcast',
          description:
            "Opens one broadcast with its numbers. 404 broadcast_not_found when it is not this organization's or was deleted. Open on every plan. Team organizations only. Requires AUTOMATION_READ permission.",
          tags: ['Broadcasts'],
          params: broadcastIdParamsDto,
        },
      },
      controller.getBroadcast,
    );
    zodApplication.patch<{ Params: { broadcast_id: string } }>(
      '/broadcasts/:broadcast_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_UPDATE)],
        config: {
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.DRAFT },
        },
        schema: {
          summary: 'Update a broadcast draft',
          description: `Edits a draft — at least one of ${DRAFT_FIELDS_DESCRIPTION} Sending one audience clears the other; null clears a field. Optional expected_updated_at answers 409 record_changed when the broadcast changed since it was read. 409 broadcast_not_draft once it was sent or cancelled. Open on every plan. 404 broadcast_not_found. Answers the broadcast. Team organizations only. Requires AUTOMATION_UPDATE permission.`,
          tags: ['Broadcasts'],
          params: broadcastIdParamsDto,
          body: updateBroadcastBodyDto,
        },
      },
      controller.updateBroadcast,
    );
    zodApplication.delete<{ Params: { broadcast_id: string } }>(
      '/broadcasts/:broadcast_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_DELETE)],
        config: {
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.REMOVING },
        },
        schema: {
          summary: 'Delete a broadcast',
          description:
            'Deletes a draft, done or cancelled broadcast: it leaves every list and read at once and is removed for good, with its messages, 90 days later. A scheduled, sending or waiting-for-chats broadcast answers 409 broadcast_active — cancel it first. Open on every plan. A repeat answers 404 broadcast_not_found. Team organizations only. Requires AUTOMATION_DELETE permission.',
          tags: ['Broadcasts'],
          params: broadcastIdParamsDto,
        },
      },
      controller.deleteBroadcast,
    );
    zodApplication.post<{ Params: { broadcast_id: string } }>(
      '/broadcasts/:broadcast_id/send',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_UPDATE)],
        config: {
          idempotencyRequired: true,
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { gates: ['read_only', 'feature:broadcasts', 'limit:message_month_limit'] },
        },
        schema: {
          summary: 'Send a broadcast',
          description:
            "Sends a draft: mode now (sending, to the people of its audience whose chat is open), scheduled with scheduled_at (in the future, at most 30 days ahead — it starts then) or when_chat_opens with open_wait_days 1–7 (each person of the audience when her chat next opens before ends_at). The audience is copied at send — a saved segment's later edit never changes it. Always left out: opted-out, paused and deleted contacts and anyone who got a broadcast in the last 24 hours. A field of another mode answers 400. 409 transition_not_allowed when it is not a draft; 409 instagram_not_connected when the account is disconnected or broken; 409 message_month_limit_reached when this month's DMs are used up; 422 broadcast_incomplete with errors[] naming messages or audience (none, or its segment was deleted) or a file that is not usable. A plan without broadcasts answers 403 plan_lacks_feature; 403 organization_read_only while the plan has ended. Answers the broadcast. Needs X-Idempotency-Key. Team organizations only. Requires AUTOMATION_UPDATE permission.",
          tags: ['Broadcasts'],
          params: broadcastIdParamsDto,
          body: sendBroadcastBodyDto,
        },
      },
      controller.sendBroadcast,
    );
    zodApplication.post<{ Params: { broadcast_id: string } }>(
      '/broadcasts/:broadcast_id/cancel',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_UPDATE)],
        config: {
          idempotencyRequired: true,
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.REMOVING },
        },
        schema: {
          summary: 'Cancel a broadcast',
          description:
            'Cancels a draft, scheduled, sending or waiting-for-chats broadcast (cancel_reason owner): its waiting people are skipped and their waiting messages cancelled in the background; messages already sent stay sent. 409 transition_not_allowed when it is already done or cancelled. Open on every plan. 404 broadcast_not_found. Strictly empty body. Answers the broadcast. Needs X-Idempotency-Key. Team organizations only. Requires AUTOMATION_UPDATE permission.',
          tags: ['Broadcasts'],
          params: broadcastIdParamsDto,
          body: emptyBroadcastActionBodyDto,
        },
      },
      controller.cancelBroadcast,
    );
  };
}
