import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginatedResponse } from '@/shared/utils/http/response.util.js';
import {
  getRequestIdentifier,
  requireOrganizationScope,
  requirePrincipal,
} from '@/shared/utils/http/request.util.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import {
  buildAuditActorFields,
  recordScopedAuditEvent,
} from '@/shared/utils/infrastructure/audit-request-context.util.js';
import { CONTACT_AUDIT_RESOURCE_TYPE } from './contact.constants.js';
import type { ContactService } from './contact.service.js';
import { validateListContactsQuery } from './contact.validator.js';

/**
 * Builds the handler map for the contact routes (routes-final § 2 — routes 9 and 10): reads the
 * organization scope, validates the query or the path id, calls {@link ContactService} and shapes
 * the answer.
 *
 * @remarks
 * Audit (CT12, K9): route 10 records `app.contact.delete` (resource `contact`, WARNING) after the
 * erase commits, best-effort — an audit failure never fails the request — with the contact's
 * public id only, never an erased value. The list writes no audit entry.
 */
export function createContactController(service: ContactService) {
  return {
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
    deleteContact: async (
      request: FastifyRequest<{ Params: { contact_id: string } }>,
      reply: FastifyReply,
    ) => {
      const auth = requirePrincipal(request);
      const scope = requireOrganizationScope(request);
      const { contactPublicId } = await service.deleteContact({
        scope,
        contactPublicId: validatePublicIdParam({
          value: request.params.contact_id,
          fieldName: 'contact_id',
        }),
      });
      await recordScopedAuditEvent({
        request,
        input: {
          ...buildAuditActorFields(auth),
          action: 'app.contact.delete',
          resource_type: CONTACT_AUDIT_RESOURCE_TYPE,
          organizationPublicId: scope.organizationPublicId,
          severity: 'WARNING',
          metadata: { contact_public_id: contactPublicId },
        },
      });
      return reply.code(204).send();
    },
  };
}
