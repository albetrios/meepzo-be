import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginatedResponse, successResponse } from '@/shared/utils/http/response.util.js';
import {
  getActingUserPublicId,
  getRequestIdentifier,
  requireOrganizationScope,
  requirePrincipal,
} from '@/shared/utils/http/request.util.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import {
  buildAuditActorFields,
  recordScopedAuditEvent,
} from '@/shared/utils/infrastructure/audit-request-context.util.js';
import { SEGMENT_AUDIT_RESOURCE_TYPE } from './broadcast-segment.constants.js';
import type { BroadcastSegmentService } from './broadcast-segment.service.js';
import type { SegmentCaller } from './broadcast-segment.types.js';
import {
  validateCreateSegmentBody,
  validateListSegmentsQuery,
  validateSegmentAudienceCountBody,
  validateUpdateSegmentBody,
} from './broadcast-segment.validator.js';

/** A request on one segment (routes 79–81). */
type SegmentRequest = FastifyRequest<{ Params: { segment_id: string } }>;

/** The `{segment_id}` path id, validated. */
function segmentPublicIdOf(request: SegmentRequest): string {
  return validatePublicIdParam({ value: request.params.segment_id, fieldName: 'segment_id' });
}

/** The caller of a write route: the verified organization scope and the acting user (`usr_…`). */
function segmentCallerOf(request: FastifyRequest): SegmentCaller {
  return {
    scope: requireOrganizationScope(request),
    userPublicId: getActingUserPublicId(requirePrincipal(request)) ?? '',
  };
}

/**
 * Builds the handler map for the segment routes (routes-final § 7.B — routes 77–82): reads the
 * organization scope, validates the query, path id or body, calls {@link BroadcastSegmentService}
 * and shapes the answer.
 *
 * @remarks
 * Audit (BC6, K9), each after the commit, best-effort, public ids and field names only:
 * `app.segment.create` (INFO), `app.segment.update` (INFO, `changed_fields`, only when something
 * changed) and `app.segment.delete` (WARNING). The reads and the audience count write none.
 */
export function createBroadcastSegmentController(service: BroadcastSegmentService) {
  /** One audit entry of a segment route (resource `segment`). */
  async function recordSegmentAudit({
    request,
    action,
    severity,
    metadata,
  }: {
    request: FastifyRequest;
    action: string;
    severity: 'INFO' | 'WARNING';
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await recordScopedAuditEvent({
      request,
      input: {
        ...buildAuditActorFields(requirePrincipal(request)),
        action,
        resource_type: SEGMENT_AUDIT_RESOURCE_TYPE,
        organizationPublicId: requireOrganizationScope(request).organizationPublicId,
        severity,
        metadata,
      },
    });
  }

  return {
    listSegments: async (request: FastifyRequest, _reply: FastifyReply) => {
      const page = await service.listSegments({
        scope: requireOrganizationScope(request),
        query: validateListSegmentsQuery(request.query),
      });
      return paginatedResponse({
        data: page.items,
        request_id: getRequestIdentifier(request),
        pagination: {
          per_page: page.limit,
          next: page.next_cursor,
          has_more: page.has_more,
          ...(page.total === null ? {} : { estimated_total: page.total }),
        },
      });
    },
    getSegment: async (request: SegmentRequest, _reply: FastifyReply) => {
      const data = await service.getSegment({
        scope: requireOrganizationScope(request),
        segmentPublicId: segmentPublicIdOf(request),
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    createSegment: async (request: FastifyRequest, _reply: FastifyReply) => {
      const data = await service.createSegment({
        caller: segmentCallerOf(request),
        input: validateCreateSegmentBody(request.body),
      });
      await recordSegmentAudit({
        request,
        action: 'app.segment.create',
        severity: 'INFO',
        metadata: {
          segment_public_id: data.id,
          channel_account_public_id: data.channel_account_id,
        },
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    updateSegment: async (request: SegmentRequest, _reply: FastifyReply) => {
      const result = await service.updateSegment({
        caller: segmentCallerOf(request),
        segmentPublicId: segmentPublicIdOf(request),
        input: validateUpdateSegmentBody(request.body),
      });
      if (result.changedFields.length > 0) {
        await recordSegmentAudit({
          request,
          action: 'app.segment.update',
          severity: 'INFO',
          metadata: { segment_public_id: result.segment.id, changed_fields: result.changedFields },
        });
      }
      return successResponse({ data: result.segment, request_id: getRequestIdentifier(request) });
    },
    deleteSegment: async (request: SegmentRequest, reply: FastifyReply) => {
      const { segmentPublicId } = await service.deleteSegment({
        caller: segmentCallerOf(request),
        segmentPublicId: segmentPublicIdOf(request),
      });
      await recordSegmentAudit({
        request,
        action: 'app.segment.delete',
        severity: 'WARNING',
        metadata: { segment_public_id: segmentPublicId },
      });
      return reply.code(204).send();
    },
    countSegmentAudience: async (request: FastifyRequest, _reply: FastifyReply) => {
      const data = await service.countAudience({
        caller: segmentCallerOf(request),
        input: validateSegmentAudienceCountBody(request.body),
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
  };
}
