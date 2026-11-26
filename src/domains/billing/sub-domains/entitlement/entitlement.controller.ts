import type { FastifyReply, FastifyRequest } from 'fastify';
import { successResponse } from '@/shared/utils/http/response.util.js';
import {
  getRequestIdentifier,
  requireAuth,
  requireOrganizationScope,
} from '@/shared/utils/http/request.util.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import {
  buildAuditActorFields,
  recordScopedAuditEvent,
} from '@/shared/utils/infrastructure/audit-request-context.util.js';
import type { UserAuthContext } from '@/shared/types/index.js';
import type { EntitlementOverrideChange, EntitlementService } from './entitlement.service.js';
import {
  validateListEntitlementOverridesQuery,
  validateSetEntitlementOverride,
} from './entitlement.validator.js';

/** A request with the `{entitlement_override_id}` path parameter (the admin remove). */
type EntitlementOverrideRequest = FastifyRequest<{ Params: { entitlement_override_id: string } }>;

/**
 * Records an override set or remove in the TARGET organization's audit log (P270, WARNING): the
 * acting global admin, the key, the value before and after, the end and the reason.
 */
async function recordEntitlementOverrideAuditEvent({
  request,
  auth,
  action,
  change,
}: {
  request: FastifyRequest;
  auth: UserAuthContext;
  action: 'billing.entitlement_override.set' | 'billing.entitlement_override.remove';
  change: EntitlementOverrideChange;
}): Promise<void> {
  const { override, previous } = change;
  await recordScopedAuditEvent({
    request,
    input: {
      ...buildAuditActorFields(auth),
      action,
      resource_type: 'entitlement_override',
      organizationPublicId: override.organization_id,
      severity: 'WARNING',
      metadata: {
        entitlement_override_public_id: override.id,
        key: override.key,
        value: action === 'billing.entitlement_override.remove' ? null : override.value,
        previous_value: previous?.value ?? null,
        expires_at: override.expires_at,
        reason: override.reason,
      },
    },
  });
}

/**
 * Handlers of the billing entitlement routes: the organization's entitlements read (P271), and the
 * global admin's per-organization overrides (P270) — list, set and remove; each set and remove is
 * audited after the service returns (K9).
 */
export function createEntitlementController(service: EntitlementService) {
  return {
    getEntitlements: async (request: FastifyRequest, _reply: FastifyReply) => {
      const entitlements = await service.getEntitlements({
        scope: requireOrganizationScope(request),
      });
      return successResponse({ data: entitlements, request_id: getRequestIdentifier(request) });
    },
    listOverrides: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const query = validateListEntitlementOverridesQuery(request.query);
      const overrides = await service.listOverrides({
        organizationPublicId: query.organization_id,
        actorUserPublicId: auth.userId,
      });
      return successResponse({ data: overrides, request_id: getRequestIdentifier(request) });
    },
    setOverride: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const change = await service.setOverride({
        input: validateSetEntitlementOverride(request.body),
        actorUserPublicId: auth.userId,
      });
      await recordEntitlementOverrideAuditEvent({
        request,
        auth,
        action: 'billing.entitlement_override.set',
        change,
      });
      return successResponse({ data: change.override, request_id: getRequestIdentifier(request) });
    },
    removeOverride: async (request: EntitlementOverrideRequest, reply: FastifyReply) => {
      const auth = requireAuth(request);
      const change = await service.removeOverride({
        entitlementOverridePublicId: validatePublicIdParam({
          value: request.params.entitlement_override_id,
          fieldName: 'entitlement_override_id',
        }),
        actorUserPublicId: auth.userId,
      });
      await recordEntitlementOverrideAuditEvent({
        request,
        auth,
        action: 'billing.entitlement_override.remove',
        change,
      });
      return reply.code(204).send();
    },
  };
}
