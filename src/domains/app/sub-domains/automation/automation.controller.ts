import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginatedResponse, successResponse } from '@/shared/utils/http/response.util.js';
import {
  getActingUserPublicId,
  getRequestIdentifier,
  requireOrganizationScope,
  requirePrincipal,
} from '@/shared/utils/http/request.util.js';
import { translateRequestMessage } from '@/shared/utils/i18n/translate-request.util.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import {
  buildAuditActorFields,
  listBodyFieldNames,
  recordScopedAuditEvent,
} from '@/shared/utils/infrastructure/audit-request-context.util.js';
import {
  FAILED_MESSAGES_RETRY_AUDIT_ACTION,
  failedMessagesRetryAuditMetadata,
} from '@/domains/app/app.failed-messages.serializer.js';
import { AUTOMATION_AUDIT_RESOURCE_TYPE } from './automation.constants.js';
import type { AutomationService } from './automation.service.js';
import type { AutomationWarning } from './automation.types.js';
import {
  validateCreateAutomation,
  validateDeleteAutomationQuery,
  validateEmptyAutomationAction,
  validateKeywordTestAutomation,
  validateListAutomationsQuery,
  validatePauseAutomation,
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

/** `meta.warnings` of routes 30 and 32 (`[{ reason, field, detail }]`, AU13), translated. */
function renderWarnings({
  request,
  warnings,
}: {
  request: FastifyRequest;
  warnings: readonly AutomationWarning[];
}): { reason: string; field: string; detail: string }[] {
  return warnings.map((warning) => ({
    reason: warning.reason,
    field: warning.field,
    detail: translateRequestMessage({
      request,
      messageKey: warning.messageKey,
      fallback: warning.reason,
      params: warning.messageParams,
    }),
  }));
}

/** The audit entry of one automation action, after its commit (AU7, K9). */
async function recordAutomationAudit({
  request,
  action,
  severity = 'INFO',
  metadata,
}: {
  request: FastifyRequest;
  action: string;
  severity?: 'INFO' | 'WARNING';
  metadata: Record<string, unknown>;
}): Promise<void> {
  await recordScopedAuditEvent({
    request,
    input: {
      ...buildAuditActorFields(requirePrincipal(request)),
      action,
      resource_type: AUTOMATION_AUDIT_RESOURCE_TYPE,
      organizationPublicId: requireOrganizationScope(request).organizationPublicId,
      severity,
      metadata,
    },
  });
}

/**
 * Builds the handler map for the automation routes (feat-instagram-dm-sending routes-final § 4.A —
 * routes 27–35): reads the organization scope and the actor, validates the query, path id or body,
 * calls {@link AutomationService} and shapes the answer.
 *
 * @remarks
 * Audit (AU7, K9), resource type `automation`, each after the write commits, best-effort:
 * `app.automation.create`, `.update` (`changed_fields` — names, never values), `.delete`
 * (`delete_reason`, `cancelled_run_count`), `.go_live`, `.pause` (`mode`), `.duplicate`
 * (`source_automation_public_id`). A go-live or pause that changed nothing (a repeat, AU3) writes
 * none. The reads and the keyword test write no audit entry.
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
        pagination: { per_page: page.limit, next: page.next_cursor, has_more: page.has_more },
        extraMeta: { totals: page.totals },
      });
    },
    createAutomation: async (request: FastifyRequest, _reply: FastifyReply) => {
      const automation = await service.createAutomation({
        scope: requireOrganizationScope(request),
        changes: validateCreateAutomation(request.body),
        createdByUserPublicId: getActingUserPublicId(requirePrincipal(request)),
      });
      await recordAutomationAudit({
        request,
        action: 'app.automation.create',
        metadata: { automation_public_id: automation.id },
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
      const { changes, expectedUpdatedAt } = validateUpdateAutomation(request.body);
      const { automation, warnings } = await service.updateAutomation({
        scope: requireOrganizationScope(request),
        automationPublicId: readAutomationPublicId(request),
        changes,
        expectedUpdatedAt,
        updatedByUserPublicId: getActingUserPublicId(requirePrincipal(request)),
      });
      await recordAutomationAudit({
        request,
        action: 'app.automation.update',
        metadata: {
          automation_public_id: automation.id,
          changed_fields: listBodyFieldNames(request.body).filter(
            (field) => field !== 'expected_updated_at',
          ),
        },
      });
      return successResponse({
        data: automation,
        request_id: getRequestIdentifier(request),
        extraMeta: { warnings: renderWarnings({ request, warnings }) },
      });
    },
    deleteAutomation: async (
      request: FastifyRequest<{ Params: { automation_id: string } }>,
      reply: FastifyReply,
    ) => {
      const automationPublicId = readAutomationPublicId(request);
      const removal = validateDeleteAutomationQuery(request.query);
      const { cancelledRunCount } = await service.deleteAutomation({
        scope: requireOrganizationScope(request),
        automationPublicId,
        removal,
        deletedByUserPublicId: getActingUserPublicId(requirePrincipal(request)),
      });
      await recordAutomationAudit({
        request,
        action: 'app.automation.delete',
        severity: 'WARNING',
        metadata: {
          automation_public_id: automationPublicId,
          delete_reason: removal.reason,
          cancelled_run_count: cancelledRunCount,
        },
      });
      return reply.code(204).send();
    },
    ...createAutomationActionHandlers(service),
  };
}

/**
 * The action handlers of routes 32–35 (go live, pause, duplicate, keyword test), split out of
 * {@link createAutomationController} to keep each map short; the same audit rules.
 */
function createAutomationActionHandlers(service: AutomationService) {
  return {
    goLiveAutomation: async (
      request: FastifyRequest<{ Params: { automation_id: string } }>,
      _reply: FastifyReply,
    ) => {
      validateEmptyAutomationAction(request.body);
      const { automation, warnings, isChanged } = await service.goLiveAutomation({
        scope: requireOrganizationScope(request),
        automationPublicId: readAutomationPublicId(request),
        actingUserPublicId: getActingUserPublicId(requirePrincipal(request)),
        // The plan guard's snapshot (change-plan-gates RG5): go-live reads the plan no second time.
        entitlement: request.entitlementSnapshot ?? undefined,
      });
      if (isChanged) {
        await recordAutomationAudit({
          request,
          action: 'app.automation.go_live',
          metadata: { automation_public_id: automation.id },
        });
      }
      return successResponse({
        data: automation,
        request_id: getRequestIdentifier(request),
        extraMeta: { warnings: renderWarnings({ request, warnings }) },
      });
    },
    pauseAutomation: async (
      request: FastifyRequest<{ Params: { automation_id: string } }>,
      _reply: FastifyReply,
    ) => {
      const mode = validatePauseAutomation(request.body);
      const { automation, isChanged } = await service.pauseAutomation({
        scope: requireOrganizationScope(request),
        automationPublicId: readAutomationPublicId(request),
        mode,
        actingUserPublicId: getActingUserPublicId(requirePrincipal(request)),
      });
      if (isChanged) {
        await recordAutomationAudit({
          request,
          action: 'app.automation.pause',
          metadata: { automation_public_id: automation.id, mode },
        });
      }
      return successResponse({ data: automation, request_id: getRequestIdentifier(request) });
    },
    duplicateAutomation: async (
      request: FastifyRequest<{ Params: { automation_id: string } }>,
      _reply: FastifyReply,
    ) => {
      validateEmptyAutomationAction(request.body);
      const sourcePublicId = readAutomationPublicId(request);
      const automation = await service.duplicateAutomation({
        scope: requireOrganizationScope(request),
        automationPublicId: sourcePublicId,
        actingUserPublicId: getActingUserPublicId(requirePrincipal(request)),
      });
      await recordAutomationAudit({
        request,
        action: 'app.automation.duplicate',
        metadata: {
          automation_public_id: automation.id,
          source_automation_public_id: sourcePublicId,
        },
      });
      return successResponse({ data: automation, request_id: getRequestIdentifier(request) });
    },
    summarizeAutomationFailedMessages: async (
      request: FastifyRequest<{ Params: { automation_id: string } }>,
      _reply: FastifyReply,
    ) => {
      const data = await service.summarizeAutomationFailedMessages({
        scope: requireOrganizationScope(request),
        automationPublicId: readAutomationPublicId(request),
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    retryAutomationFailedMessages: async (
      request: FastifyRequest<{ Params: { automation_id: string } }>,
      _reply: FastifyReply,
    ) => {
      validateEmptyAutomationAction(request.body);
      const automationPublicId = readAutomationPublicId(request);
      const { data, retry } = await service.retryAutomationFailedMessages({
        scope: requireOrganizationScope(request),
        automationPublicId,
      });
      await recordAutomationAudit({
        request,
        action: FAILED_MESSAGES_RETRY_AUDIT_ACTION,
        metadata: {
          automation_public_id: automationPublicId,
          ...failedMessagesRetryAuditMetadata(retry),
        },
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    testAutomationKeyword: async (
      request: FastifyRequest<{ Params: { automation_id: string } }>,
      _reply: FastifyReply,
    ) => {
      const { text, source } = validateKeywordTestAutomation(request.body);
      const result = await service.testAutomationKeyword({
        scope: requireOrganizationScope(request),
        automationPublicId: readAutomationPublicId(request),
        text,
        source,
      });
      return successResponse({ data: result, request_id: getRequestIdentifier(request) });
    },
  };
}
