import type { FastifyReply, FastifyRequest } from 'fastify';
import { successResponse } from '@/shared/utils/http/response.util.js';
import {
  getActingUserPublicId,
  getRequestIdentifier,
  requireOrganizationScope,
  requirePrincipal,
} from '@/shared/utils/http/request.util.js';
import {
  buildAuditActorFields,
  recordScopedAuditEvent,
} from '@/shared/utils/infrastructure/audit-request-context.util.js';
import type { InstagramAccountService } from './instagram-account.service.js';
import { validateConnectInstagramAccount } from './instagram-account.validator.js';

/** The audit resource type of every Instagram account action (IA7). */
const INSTAGRAM_ACCOUNT_AUDIT_RESOURCE_TYPE = 'instagram_account';

/**
 * Builds the handler map for the Instagram account routes (routes-final § 1.A — routes 1, 2, 4):
 * reads the organization scope and the actor, validates the connect body, calls
 * {@link InstagramAccountService} and shapes the answer.
 *
 * @remarks
 * Audit (IA7, WARNING, the account's public id only — never the token or the code):
 * `app.instagram_account.connect` and `app.instagram_account.disconnect` are recorded after the
 * write commits, best-effort — an audit failure never fails the request — as every other audited
 * write records its entry (`src/PATTERNS.md` audit-emission, D36).
 */
export function createInstagramAccountController(service: InstagramAccountService) {
  return {
    connectInstagramAccount: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const scope = requireOrganizationScope(request);
      const { code } = validateConnectInstagramAccount(request.body);
      const data = await service.connect({
        scope,
        code,
        connectedByUserPublicId: getActingUserPublicId(auth),
        requestId: getRequestIdentifier(request),
      });
      await recordScopedAuditEvent({
        request,
        input: {
          ...buildAuditActorFields(auth),
          action: 'app.instagram_account.connect',
          resource_type: INSTAGRAM_ACCOUNT_AUDIT_RESOURCE_TYPE,
          organizationPublicId: scope.organizationPublicId,
          severity: 'WARNING',
          metadata: {
            instagram_account_public_id: data.instagram_account.id,
            is_new_connection: data.is_new_connection,
          },
        },
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    getInstagramAccount: async (request: FastifyRequest, _reply: FastifyReply) => {
      const data = await service.getAccount({ scope: requireOrganizationScope(request) });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    disconnectInstagramAccount: async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const scope = requireOrganizationScope(request);
      const { instagramAccountPublicId } = await service.disconnect({
        scope,
        requestId: getRequestIdentifier(request),
      });
      await recordScopedAuditEvent({
        request,
        input: {
          ...buildAuditActorFields(auth),
          action: 'app.instagram_account.disconnect',
          resource_type: INSTAGRAM_ACCOUNT_AUDIT_RESOURCE_TYPE,
          organizationPublicId: scope.organizationPublicId,
          severity: 'WARNING',
          metadata: { instagram_account_public_id: instagramAccountPublicId },
        },
      });
      return reply.code(204).send();
    },
  };
}
