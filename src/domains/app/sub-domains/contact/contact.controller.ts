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
import {
  FAILED_MESSAGES_RETRY_AUDIT_ACTION,
  failedMessagesRetryAuditMetadata,
} from '@/domains/app/app.failed-messages.serializer.js';
import { CONTACT_AUDIT_RESOURCE_TYPE } from './contact.constants.js';
import type { ContactCaller, ContactService } from './contact.service.js';
import {
  validateContactActivityQuery,
  validateContactBulkActionBody,
  validateListContactTagsQuery,
  validateListContactsQuery,
  validateUpdateContactBody,
} from './contact.validator.js';

/** A request on one contact (routes 19, 20, 23–26). */
type ContactRequest = FastifyRequest<{ Params: { contact_id: string } }>;

/** The `{contact_id}` path id, validated. */
function contactPublicIdOf(request: ContactRequest): string {
  return validatePublicIdParam({ value: request.params.contact_id, fieldName: 'contact_id' });
}

/** The caller of a write route: the verified organization scope and the acting user (`usr_…`). */
function contactCallerOf(request: FastifyRequest): ContactCaller {
  return {
    scope: requireOrganizationScope(request),
    userPublicId: getActingUserPublicId(requirePrincipal(request)) ?? '',
  };
}

/** One audit entry of a contact route (resource `contact`). */
async function recordContactAudit({
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
      resource_type: CONTACT_AUDIT_RESOURCE_TYPE,
      organizationPublicId: requireOrganizationScope(request).organizationPublicId,
      severity,
      metadata,
    },
  });
}

/**
 * The handlers of routes 24–26 (routes-final § 3.A, CTC9): "what happened" and her failed messages'
 * summary and retry, over her channel's sending port (6.B).
 */
function createContactMessageHandlers(service: ContactService) {
  return {
    listContactActivity: async (request: ContactRequest, _reply: FastifyReply) => {
      const page = await service.listContactActivity({
        scope: requireOrganizationScope(request),
        contactPublicId: contactPublicIdOf(request),
        query: validateContactActivityQuery(request.query),
      });
      return paginatedResponse({
        data: page.items,
        request_id: getRequestIdentifier(request),
        pagination: { per_page: page.limit, next: page.next_cursor, has_more: page.has_more },
        extraMeta: { message_horizon_days: page.messageHorizonDays },
      });
    },
    summarizeContactFailedMessages: async (request: ContactRequest, _reply: FastifyReply) => {
      const data = await service.summarizeContactFailedMessages({
        scope: requireOrganizationScope(request),
        contactPublicId: contactPublicIdOf(request),
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    retryContactFailedMessages: async (request: ContactRequest, _reply: FastifyReply) => {
      const contactPublicId = contactPublicIdOf(request);
      const { data, retry } = await service.retryContactFailedMessages({
        caller: contactCallerOf(request),
        contactPublicId,
      });
      await recordContactAudit({
        request,
        action: FAILED_MESSAGES_RETRY_AUDIT_ACTION,
        severity: 'INFO',
        metadata: {
          contact_public_id: contactPublicId,
          ...failedMessagesRetryAuditMetadata(retry),
        },
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
  };
}

/**
 * Builds the handler map for the contact routes (routes-final § 3.A — routes 18–26): reads the
 * organization scope, validates the query, path id or body, calls {@link ContactService} and shapes
 * the answer.
 *
 * @remarks
 * Audit (CT10, K9), each after the commit, best-effort — an audit failure never fails the request —
 * with public ids and field names only, never a value (CT4): route 20 records `app.contact.update`
 * (INFO, `changed_fields`) when the note or tags changed, and `app.contact.automations_pause` /
 * `.automations_resume` (WARNING) when the pause flipped; route 21 `app.contact.bulk_action` (INFO,
 * the action and `matched_count`); route 23 `app.contact.delete` (WARNING); route 26
 * `app.instagram_message.retry` (INFO, the counts — SN18). The reads write none.
 */
export function createContactController(service: ContactService) {
  return {
    ...createContactMessageHandlers(service),
    listContacts: async (request: FastifyRequest, _reply: FastifyReply) => {
      const page = await service.listContacts({
        scope: requireOrganizationScope(request),
        query: validateListContactsQuery(request.query),
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
    getContact: async (request: ContactRequest, _reply: FastifyReply) => {
      const data = await service.getContact({
        scope: requireOrganizationScope(request),
        contactPublicId: contactPublicIdOf(request),
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    updateContact: async (request: ContactRequest, _reply: FastifyReply) => {
      const result = await service.updateContact({
        caller: contactCallerOf(request),
        contactPublicId: contactPublicIdOf(request),
        input: validateUpdateContactBody(request.body),
      });
      const contactPublicId = result.contact.id;
      const fieldChanges = result.changedFields.filter(
        (field) => field !== 'is_automations_paused',
      );
      if (fieldChanges.length > 0) {
        await recordContactAudit({
          request,
          action: 'app.contact.update',
          severity: 'INFO',
          metadata: { contact_public_id: contactPublicId, changed_fields: fieldChanges },
        });
      }
      if (result.pauseChange !== null) {
        await recordContactAudit({
          request,
          action:
            result.pauseChange === 'pause'
              ? 'app.contact.automations_pause'
              : 'app.contact.automations_resume',
          severity: 'WARNING',
          metadata: { contact_public_id: contactPublicId },
        });
      }
      return successResponse({ data: result.contact, request_id: getRequestIdentifier(request) });
    },
    startContactBulkAction: async (request: FastifyRequest, _reply: FastifyReply) => {
      const input = validateContactBulkActionBody(request.body);
      const data = await service.startBulkAction({ caller: contactCallerOf(request), input });
      await recordContactAudit({
        request,
        action: 'app.contact.bulk_action',
        severity: 'INFO',
        metadata: {
          channel_account_public_id: input.channelAccountPublicId,
          action: data.action,
          matched_count: data.matched_count,
        },
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    listContactTags: async (request: FastifyRequest, _reply: FastifyReply) => {
      const query = validateListContactTagsQuery(request.query);
      const data = await service.listContactTags({
        scope: requireOrganizationScope(request),
        ...query,
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    deleteContact: async (request: ContactRequest, reply: FastifyReply) => {
      const { contactPublicId } = await service.deleteContact({
        scope: requireOrganizationScope(request),
        contactPublicId: contactPublicIdOf(request),
      });
      await recordContactAudit({
        request,
        action: 'app.contact.delete',
        severity: 'WARNING',
        metadata: { contact_public_id: contactPublicId },
      });
      return reply.code(204).send();
    },
  };
}
