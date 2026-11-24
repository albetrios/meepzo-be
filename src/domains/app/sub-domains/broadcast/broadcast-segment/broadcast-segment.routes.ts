import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import type { BroadcastSegmentService } from './broadcast-segment.service.js';
import { createBroadcastSegmentController } from './broadcast-segment.controller.js';
import {
  createSegmentBodyDto,
  listSegmentsQueryDto,
  segmentAudienceCountBodyDto,
  segmentIdParamsDto,
  updateSegmentBodyDto,
} from './broadcast-segment.dto.js';

/** The conditions as every route's description names them (BC12). */
const CONDITIONS_DESCRIPTION =
  "conditions is a group { op: and | or, items } of conditions and groups of conditions — at most 2 levels and 20 conditions in all; each condition is one of tags (match any, all or none of values), automation (automation_id and state started, finished, in_progress, never, tapped_hello or got_message with message_number, over runs of the last 90 days), came_in (via first_automation with value an automation id, ref with an optional value, starter_question, ad, story_mention, first_message), commented (post a media id or any, optional days, keyword, at_least), active (one of last_message_within_hours, last_message_within_days, first_seen_within_days), details (has email, phone, neither or follows_account), story_activity (days) and no_broadcast (days). An automation id that is not this account's answers 400.";

/**
 * Returns the Fastify plugin that registers the segment routes (routes-final § 7.B, routes 77–82),
 * mounted under `/api/v1/app`: the list (77), save (78), open (79), change (80), delete (81) and the
 * audience count (82).
 *
 * @remarks
 * Gates (7.B.4, P20 — the automation codes): `automation:read` on 77, 79, 82; `automation:create`
 * on 78; `automation:update` on 80; `automation:delete` on 81. The PRO `segments` switch is the
 * service's (BC19). 78 creates a row and 82 may start background work, so both need
 * `X-Idempotency-Key` (`idempotencyRequired`, P89); 80 takes an optional `expected_updated_at`. The
 * writes and the count carry the organization-scoped rate limit; the reads ride the global limiter.
 */
export function broadcastSegmentRoutes(service: BroadcastSegmentService): FastifyPluginAsync {
  const controller = createBroadcastSegmentController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get(
      '/segments',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_READ)],
        schema: {
          summary: 'List segments',
          description:
            "Lists one channel account's saved segments — each with its name, conditions, how many conditions it holds and who saved it. channel_account_id is required (an unknown one gives an empty page). Search q over the name; sort by name (default, A to Z) or created_at (newest first), order asc or desc. The first page carries an estimated total. A deleted segment is never listed. Open on every plan, so a trial's segments stay readable after a move down. Team organizations only. Requires AUTOMATION_READ permission.",
          tags: ['Segments'],
          querystring: listSegmentsQueryDto,
        },
      },
      controller.listSegments,
    );
    zodApplication.post(
      '/segments',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_CREATE)],
        config: { idempotencyRequired: true, ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config },
        schema: {
          summary: 'Create a segment',
          description: `Saves an audience on one channel account: channel_account_id (fixed), name (1–255 after trim; duplicates allowed) and conditions. ${CONDITIONS_DESCRIPTION} A plan without segments answers 403 plan_lacks_feature. 404 channel_account_not_found when the account is not this organization's (a revoked one may still hold segments). Answers the segment. Needs X-Idempotency-Key. Team organizations only. Requires AUTOMATION_CREATE permission.`,
          tags: ['Segments'],
          body: createSegmentBodyDto,
        },
      },
      controller.createSegment,
    );
    zodApplication.post(
      '/segments/audience-count',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_READ)],
        config: { idempotencyRequired: true, ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config },
        schema: {
          summary: 'Count a segment audience',
          description: `Counts the audience of channel_account_id for a saved segment_id of that account or unsaved conditions — exactly one. ${CONDITIONS_DESCRIPTION} Answers matched (the live contacts the conditions match, always leaving out opted-out, paused and deleted contacts and anyone who got a broadcast in the last 24 hours) and can_receive_now (of those, the ones whose chat is open: their last message within 24 hours less 15 minutes), with counted_at. A count that takes longer than 2 seconds goes to the background: the answer says is_counting true with null numbers — ask again; until the background count is available it answers 503 segment_count_unavailable. A plan without segments answers 403 plan_lacks_feature. 404 channel_account_not_found or segment_not_found; a segment of another account answers 400 on segment_id. Needs X-Idempotency-Key. Team organizations only. Requires AUTOMATION_READ permission.`,
          tags: ['Segments'],
          body: segmentAudienceCountBodyDto,
        },
      },
      controller.countSegmentAudience,
    );
    zodApplication.get<{ Params: { segment_id: string } }>(
      '/segments/:segment_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_READ)],
        schema: {
          summary: 'Get a segment',
          description:
            "Opens one saved segment. 404 segment_not_found when it is not this organization's or was deleted. Open on every plan. Team organizations only. Requires AUTOMATION_READ permission.",
          tags: ['Segments'],
          params: segmentIdParamsDto,
        },
      },
      controller.getSegment,
    );
    zodApplication.patch<{ Params: { segment_id: string } }>(
      '/segments/:segment_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_UPDATE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Update a segment',
          description: `Changes a segment's name or conditions — at least one; drafts that use it follow it, sent broadcasts keep their copy. ${CONDITIONS_DESCRIPTION} Optional expected_updated_at answers 409 record_changed when the segment changed since it was read. A plan without segments answers 403 plan_lacks_feature. 404 segment_not_found when it is not this organization's or was deleted. Answers the segment. Team organizations only. Requires AUTOMATION_UPDATE permission.`,
          tags: ['Segments'],
          params: segmentIdParamsDto,
          body: updateSegmentBodyDto,
        },
      },
      controller.updateSegment,
    );
    zodApplication.delete<{ Params: { segment_id: string } }>(
      '/segments/:segment_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.AUTOMATION_DELETE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Delete a segment',
          description:
            'Deletes a segment: it leaves every list and read at once and is removed for good 90 days later; draft broadcasts that use it lose their audience and need a new one before sending. Open on every plan. A repeat answers 404 segment_not_found. Team organizations only. Requires AUTOMATION_DELETE permission.',
          tags: ['Segments'],
          params: segmentIdParamsDto,
        },
      },
      controller.deleteSegment,
    );
  };
}
