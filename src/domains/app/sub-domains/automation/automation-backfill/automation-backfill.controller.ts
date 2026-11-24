import type { FastifyReply, FastifyRequest } from 'fastify';
import { successResponse } from '@/shared/utils/http/response.util.js';
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
import { AUTOMATION_BACKFILL_AUDIT_RESOURCE_TYPE } from './automation-backfill.constants.js';
import type { AutomationBackfillService } from './automation-backfill.service.js';
import { validateStartAutomationBackfill } from './automation-backfill.validator.js';

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
 * Builds the handler map for the past-comments routes (feat-instagram-dm-sending routes-final § 4.C —
 * routes 38–39): reads the organization scope and the actor, validates the path ids and the body,
 * calls {@link AutomationBackfillService} and shapes the answer.
 *
 * @remarks
 * Audit (AU7, K9): `app.automation_backfill.start` (resource type `automation_backfill`, metadata
 * `automation_public_id` and `days`) after route 38 commits, best-effort. Route 39 writes none.
 */
export function createAutomationBackfillController(service: AutomationBackfillService) {
  return {
    startAutomationBackfill: async (
      request: FastifyRequest<{ Params: { automation_id: string } }>,
      _reply: FastifyReply,
    ) => {
      const { days } = validateStartAutomationBackfill(request.body);
      const automationPublicId = readAutomationPublicId(request);
      const scope = requireOrganizationScope(request);
      const principal = requirePrincipal(request);
      const backfill = await service.startAutomationBackfill({
        scope,
        automationPublicId,
        days,
        requestedByUserPublicId: getActingUserPublicId(principal),
      });
      await recordScopedAuditEvent({
        request,
        input: {
          ...buildAuditActorFields(principal),
          action: 'app.automation_backfill.start',
          resource_type: AUTOMATION_BACKFILL_AUDIT_RESOURCE_TYPE,
          organizationPublicId: scope.organizationPublicId,
          severity: 'INFO',
          metadata: {
            automation_backfill_public_id: backfill.id,
            automation_public_id: automationPublicId,
            days,
          },
        },
      });
      return successResponse({ data: backfill, request_id: getRequestIdentifier(request) });
    },
    getAutomationBackfill: async (
      request: FastifyRequest<{
        Params: { automation_id: string; automation_backfill_id: string };
      }>,
      _reply: FastifyReply,
    ) => {
      const backfill = await service.getAutomationBackfill({
        scope: requireOrganizationScope(request),
        automationPublicId: readAutomationPublicId(request),
        automationBackfillPublicId: validatePublicIdParam({
          value: request.params.automation_backfill_id,
          fieldName: 'automation_backfill_id',
        }),
      });
      return successResponse({ data: backfill, request_id: getRequestIdentifier(request) });
    },
  };
}
