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
import { BROADCAST_AUDIT_RESOURCE_TYPE } from './broadcast.constants.js';
import type { BroadcastService } from './broadcast.service.js';
import type { BroadcastCaller } from './broadcast.types.js';
import {
  validateCreateBroadcastBody,
  validateEmptyBroadcastAction,
  validateListBroadcastsQuery,
  validateSendBroadcastBody,
  validateUpdateBroadcastBody,
} from './broadcast.validator.js';

/** A request on one broadcast (routes 72–76). */
type BroadcastRequest = FastifyRequest<{ Params: { broadcast_id: string } }>;

/** The `{broadcast_id}` path id, validated. */
function broadcastPublicIdOf(request: BroadcastRequest): string {
  return validatePublicIdParam({ value: request.params.broadcast_id, fieldName: 'broadcast_id' });
}

/** The caller of a write route: the verified organization scope and the acting user (`usr_…`). */
function broadcastCallerOf(request: FastifyRequest): BroadcastCaller {
  return {
    scope: requireOrganizationScope(request),
    userPublicId: getActingUserPublicId(requirePrincipal(request)) ?? '',
  };
}

/**
 * Builds the handler map for the broadcast routes (routes-final § 7.A — routes 70–76): reads the
 * organization scope, validates the query, path id or body, calls {@link BroadcastService} and
 * shapes the answer.
 *
 * @remarks
 * Audit (BC6, K9), each after the commit, best-effort, public ids and field names only:
 * `app.broadcast.create` (INFO), `app.broadcast.update` (INFO, `changed_fields`, only when something
 * changed), `app.broadcast.delete` (WARNING), `app.broadcast.send` (INFO, `mode`) and
 * `app.broadcast.cancel` (WARNING, `previous_status`). The reads write none.
 */
export function createBroadcastController(service: BroadcastService) {
  /** One audit entry of a broadcast route (resource `broadcast`). */
  async function recordBroadcastAudit({
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
        resource_type: BROADCAST_AUDIT_RESOURCE_TYPE,
        organizationPublicId: requireOrganizationScope(request).organizationPublicId,
        severity,
        metadata,
      },
    });
  }

  return {
    listBroadcasts: async (request: FastifyRequest, _reply: FastifyReply) => {
      const page = await service.listBroadcasts({
        scope: requireOrganizationScope(request),
        query: validateListBroadcastsQuery(request.query),
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
    getBroadcast: async (request: BroadcastRequest, _reply: FastifyReply) => {
      const data = await service.getBroadcast({
        scope: requireOrganizationScope(request),
        broadcastPublicId: broadcastPublicIdOf(request),
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    createBroadcast: async (request: FastifyRequest, _reply: FastifyReply) => {
      const data = await service.createBroadcast({
        caller: broadcastCallerOf(request),
        input: validateCreateBroadcastBody(request.body),
      });
      await recordBroadcastAudit({
        request,
        action: 'app.broadcast.create',
        severity: 'INFO',
        metadata: {
          broadcast_public_id: data.id,
          channel_account_public_id: data.channel_account_id,
        },
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    updateBroadcast: async (request: BroadcastRequest, _reply: FastifyReply) => {
      const result = await service.updateBroadcast({
        caller: broadcastCallerOf(request),
        broadcastPublicId: broadcastPublicIdOf(request),
        input: validateUpdateBroadcastBody(request.body),
      });
      if (result.changedFields.length > 0) {
        await recordBroadcastAudit({
          request,
          action: 'app.broadcast.update',
          severity: 'INFO',
          metadata: {
            broadcast_public_id: result.broadcast.id,
            changed_fields: result.changedFields,
          },
        });
      }
      return successResponse({ data: result.broadcast, request_id: getRequestIdentifier(request) });
    },
    deleteBroadcast: async (request: BroadcastRequest, reply: FastifyReply) => {
      const { broadcastPublicId, status } = await service.deleteBroadcast({
        caller: broadcastCallerOf(request),
        broadcastPublicId: broadcastPublicIdOf(request),
      });
      await recordBroadcastAudit({
        request,
        action: 'app.broadcast.delete',
        severity: 'WARNING',
        metadata: { broadcast_public_id: broadcastPublicId, status },
      });
      return reply.code(204).send();
    },
    sendBroadcast: async (request: BroadcastRequest, _reply: FastifyReply) => {
      const data = await service.sendBroadcast({
        caller: broadcastCallerOf(request),
        broadcastPublicId: broadcastPublicIdOf(request),
        input: validateSendBroadcastBody(request.body),
      });
      await recordBroadcastAudit({
        request,
        action: 'app.broadcast.send',
        severity: 'INFO',
        metadata: { broadcast_public_id: data.id, mode: data.mode },
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    cancelBroadcast: async (request: BroadcastRequest, _reply: FastifyReply) => {
      validateEmptyBroadcastAction(request.body);
      const { broadcast, previousStatus } = await service.cancelBroadcast({
        caller: broadcastCallerOf(request),
        broadcastPublicId: broadcastPublicIdOf(request),
      });
      await recordBroadcastAudit({
        request,
        action: 'app.broadcast.cancel',
        severity: 'WARNING',
        metadata: { broadcast_public_id: broadcast.id, previous_status: previousStatus },
      });
      return successResponse({ data: broadcast, request_id: getRequestIdentifier(request) });
    },
  };
}
