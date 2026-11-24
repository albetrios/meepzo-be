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
import { validateChannelAccountIdParam } from '@/domains/app/sub-domains/channel-account/channel-account.validator.js';
import type { InstagramAccountSettingsService } from './instagram-account-settings.service.js';
import { validateUpdateInstagramAccountSettings } from './instagram-account-settings.validator.js';

/** A request with the `{channel_account_id}` path parameter (route 12). */
type SettingsRequest = FastifyRequest<{ Params: { channel_account_id: string } }>;

/**
 * Builds the handler map for the Instagram account settings route (feat-instagram-dm-sending
 * routes-final § 2.B — route 12): reads the organization scope and the actor, validates the path
 * and the body, calls {@link InstagramAccountSettingsService.updateSettings} and answers the
 * settings as saved.
 *
 * @remarks
 * Audit (IA7, AC-3.11): `app.instagram_account_settings.update` at INFO, resource type
 * `instagram_account`, with the account's `cha_…` id, the changed fields' names and their old and
 * new values (`metadata.changed_fields`, `old_value`, `new_value` — settings, never secrets;
 * `expected_updated_at` is not a change). Recorded after the write commits, best-effort — an audit
 * failure never fails the request (`src/PATTERNS.md` audit-emission, D36).
 */
export function createInstagramAccountSettingsController(service: InstagramAccountSettingsService) {
  return {
    updateInstagramAccountSettings: async (request: SettingsRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const scope = requireOrganizationScope(request);
      const channelAccountPublicId = validateChannelAccountIdParam(
        request.params.channel_account_id,
      );
      const {
        expected_updated_at: expectedUpdatedAt,
        is_automation_enabled: isAutomationEnabled,
        ...changes
      } = validateUpdateInstagramAccountSettings(request.body);
      const result = await service.updateSettings({
        scope,
        channelAccountPublicId,
        changes,
        isAutomationEnabled,
        expectedUpdatedAt,
        updatedByUserPublicId: getActingUserPublicId(auth),
      });
      const changedFields = Object.keys(result.changes);
      await recordScopedAuditEvent({
        request,
        input: {
          ...buildAuditActorFields(auth),
          action: 'app.instagram_account_settings.update',
          resource_type: INSTAGRAM_ACCOUNT_AUDIT_RESOURCE_TYPE,
          organizationPublicId: scope.organizationPublicId,
          severity: 'INFO',
          metadata: {
            channel_account_public_id: result.channelAccountPublicId,
            changed_fields: changedFields,
            old_value: Object.fromEntries(
              changedFields.map((field) => [field, result.changes[field]?.old_value]),
            ),
            new_value: Object.fromEntries(
              changedFields.map((field) => [field, result.changes[field]?.new_value]),
            ),
          },
        },
      });
      return successResponse({ data: result.settings, request_id: getRequestIdentifier(request) });
    },
  };
}
