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
  listBodyFieldNames,
  recordScopedAuditEvent,
} from '@/shared/utils/infrastructure/audit-request-context.util.js';
import { AUTOMATION_AUDIT_RESOURCE_TYPE } from './automation.constants.js';
import type { AutomationService } from './automation.service.js';
import {
  validateCreateAutomation,
  validateDeleteAutomationQuery,
  validateListAutomationsQuery,
  validateUpdateAutomation,
} from './automation.validator.js';

/** The `{automation_id}` path parameter, checked as an `aut_…` id. */
function readAutomationPublicId(
  request: FastifyRequest<{ Params: { automation_id: string } }>,
): string {
  return validatePublicIdParam({
    value: request.params.automation_id,
    fieldName: 'automation_id',
  });
}

/**
 * Builds the handler map for the automation routes (routes-final § 3.A — routes 11–15): reads the
 * organization scope and the actor, validates the query, path id or body, calls
 * {@link AutomationService} and shapes the answer.
 *
 * @remarks
 * Audit (AU4, K9): `app.automation.create` (metadata `automation_public_id`),
 * `app.automation.update` (`automation_public_id`, `changed_fields` — the body's field names, never
 * values; `expected_updated_at` is not a change) and `app.automation.delete` (`automation_public_id`,
 * `delete_reason`, `cancelled_run_count`), resource type `automation` — each recorded after the
 * write commits, best-effort: an audit failure never fails the request (D36). The reads write no
 * audit entry.
 */
export function createAutomationController(service: AutomationService) {
  return {
    listAutomations: async (request: FastifyRequest, _reply: FastifyReply) => {
      const page = await service.listAutomations({
        scope: requireOrganizationScope(request),
        query: validateListAutomationsQuery(request.query),
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
    createAutomation: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const scope = requireOrganizationScope(request);
      const automation = await service.createAutomation({
        scope,
        changes: validateCreateAutomation(request.body),
        createdByUserPublicId: getActingUserPublicId(auth),
      });
      await recordScopedAuditEvent({
        request,
        input: {
          ...buildAuditActorFields(auth),
          action: 'app.automation.create',
          resource_type: AUTOMATION_AUDIT_RESOURCE_TYPE,
          organizationPublicId: scope.organizationPublicId,
          severity: 'INFO',
          metadata: { automation_public_id: automation.id },
        },
      });
      return successResponse({ data: automation, request_id: getRequestIdentifier(request) });
    },
    getAutomation: async (
      request: FastifyRequest<{ Params: { automation_id: string } }>,
      _reply: FastifyReply,
    ) => {
      const automation = await service.getAutomation({
        scope: requireOrganizationScope(request),
        automationPublicId: readAutomationPublicId(request),
      });
      return successResponse({ data: automation, request_id: getRequestIdentifier(request) });
    },
    updateAutomation: async (
      request: FastifyRequest<{ Params: { automation_id: string } }>,
      _reply: FastifyReply,
    ) => {
      const auth = requirePrincipal(request);
      const scope = requireOrganizationScope(request);
      const automationPublicId = readAutomationPublicId(request);
      const { changes, expectedUpdatedAt } = validateUpdateAutomation(request.body);
      const automation = await service.updateAutomation({
        scope,
        automationPublicId,
        changes,
        expectedUpdatedAt,
        updatedByUserPublicId: getActingUserPublicId(auth),
      });
      await recordScopedAuditEvent({
        request,
        input: {
          ...buildAuditActorFields(auth),
          action: 'app.automation.update',
          resource_type: AUTOMATION_AUDIT_RESOURCE_TYPE,
          organizationPublicId: scope.organizationPublicId,
          severity: 'INFO',
          metadata: {
            automation_public_id: automation.id,
            changed_fields: listBodyFieldNames(request.body).filter(
              (field) => field !== 'expected_updated_at',
            ),
          },
        },
      });
      return successResponse({ data: automation, request_id: getRequestIdentifier(request) });
    },
    deleteAutomation: async (
      request: FastifyRequest<{ Params: { automation_id: string } }>,
      reply: FastifyReply,
    ) => {
      const auth = requirePrincipal(request);
      const scope = requireOrganizationScope(request);
      const automationPublicId = readAutomationPublicId(request);
      const removal = validateDeleteAutomationQuery(request.query);
      const { cancelledRunCount } = await service.deleteAutomation({
        scope,
        automationPublicId,
        removal,
        deletedByUserPublicId: getActingUserPublicId(auth),
      });
      await recordScopedAuditEvent({
        request,
        input: {
          ...buildAuditActorFields(auth),
          action: 'app.automation.delete',
          resource_type: AUTOMATION_AUDIT_RESOURCE_TYPE,
          organizationPublicId: scope.organizationPublicId,
          severity: 'WARNING',
          metadata: {
            automation_public_id: automationPublicId,
            delete_reason: removal.reason,
            cancelled_run_count: cancelledRunCount,
          },
        },
      });
      return reply.code(204).send();
    },
  };
}
