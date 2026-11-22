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
import { INSTAGRAM_ACCOUNT_AUDIT_RESOURCE_TYPE } from '@/domains/app/sub-domains/instagram-account/instagram-account.constants.js';
import type { InstagramAccountSettingsService } from './instagram-account-settings.service.js';
import { validateUpdateInstagramAccountSettings } from './instagram-account-settings.validator.js';

/**
 * Builds the handler map for the Instagram account settings route (routes-final § 1.B — route 3):
 * reads the organization scope and the actor, validates the body, calls
 * {@link InstagramAccountSettingsService.updateSettings} and answers the settings as saved.
 *
 * @remarks
 * Audit (IA7): `app.instagram_account_settings.update` at INFO, resource type `instagram_account`,
 * with the account's public id and the names of the settings the body changed
 * (`metadata.changed_fields` — names only, never values; `expected_updated_at` is not a change).
 * Recorded after the write commits, best-effort — an audit failure never fails the request
 * (`src/PATTERNS.md` audit-emission, D36).
 */
export function createInstagramAccountSettingsController(service: InstagramAccountSettingsService) {
  return {
    updateInstagramAccountSettings: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const scope = requireOrganizationScope(request);
      const { expected_updated_at: expectedUpdatedAt, ...changes } =
        validateUpdateInstagramAccountSettings(request.body);
      const { settings, instagramAccountPublicId } = await service.updateSettings({
        scope,
        changes,
        expectedUpdatedAt,
        updatedByUserPublicId: getActingUserPublicId(auth),
      });
      await recordScopedAuditEvent({
        request,
        input: {
          ...buildAuditActorFields(auth),
          action: 'app.instagram_account_settings.update',
          resource_type: INSTAGRAM_ACCOUNT_AUDIT_RESOURCE_TYPE,
          organizationPublicId: scope.organizationPublicId,
          severity: 'INFO',
          metadata: {
            instagram_account_public_id: instagramAccountPublicId,
            changed_fields: Object.keys(changes),
          },
        },
      });
      return successResponse({ data: settings, request_id: getRequestIdentifier(request) });
    },
  };
}
