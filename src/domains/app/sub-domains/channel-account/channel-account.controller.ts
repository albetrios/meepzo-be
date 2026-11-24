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
import { CHANNEL_ACCOUNT_AUDIT_RESOURCE_TYPE } from './channel-account.constants.js';
import type { ChannelAccountService } from './channel-account.service.js';
import type { ChannelAccountChange } from './channel-account.types.js';
import {
  validateActivateChannelAccount,
  validateChannelAccountIdParam,
  validateEmptyChannelAccountBody,
  validateListChannelAccountsQuery,
} from './channel-account.validator.js';

/** A request with the `{channel_account_id}` path parameter (routes 7–11). */
type AccountRequest = FastifyRequest<{ Params: { channel_account_id: string } }>;

/** One audit entry of routes 8–11 (CA10, AC-2.11): the account, the old and the new value. */
async function recordChannelAccountAudit({
  request,
  action,
  severity,
  change,
  extraMetadata,
}: {
  request: FastifyRequest;
  action: string;
  severity: 'INFO' | 'WARNING';
  change: ChannelAccountChange;
  extraMetadata?: Record<string, unknown>;
}): Promise<void> {
  const auth = requirePrincipal(request);
  await recordScopedAuditEvent({
    request,
    input: {
      ...buildAuditActorFields(auth),
      action,
      resource_type: CHANNEL_ACCOUNT_AUDIT_RESOURCE_TYPE,
      organizationPublicId: requireOrganizationScope(request).organizationPublicId,
      severity,
      metadata: {
        channel_account_public_id: change.channelAccountPublicId,
        old_value: change.oldValue,
        new_value: change.newValue,
        ...extraMetadata,
      },
    },
  });
}

/**
 * Builds the handler map for the channel account routes (routes-final § 1B — routes 6–11): reads
 * the organization scope and the actor, validates the path, query and body, calls
 * {@link ChannelAccountService} and shapes the answer.
 *
 * @remarks
 * Audit (CA10, AC-2.11 — the account's public id, the old and the new value), recorded after the
 * write commits, best-effort (D36): `app.channel_account.disconnect` (WARNING), `.pause`, `.resume`
 * (INFO), `.activate` (WARNING, `stopped_channel_account_public_id`).
 */
export function createChannelAccountController(service: ChannelAccountService) {
  return {
    listChannelAccounts: async (request: FastifyRequest, _reply: FastifyReply) => {
      const { channels } = validateListChannelAccountsQuery(request.query);
      const data = await service.listAccounts({
        scope: requireOrganizationScope(request),
        channels,
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    getChannelAccount: async (request: AccountRequest, _reply: FastifyReply) => {
      const data = await service.getAccount({
        scope: requireOrganizationScope(request),
        channelAccountPublicId: validateChannelAccountIdParam(request.params.channel_account_id),
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    disconnectChannelAccount: async (request: AccountRequest, reply: FastifyReply) => {
      const change = await service.disconnectAccount({
        scope: requireOrganizationScope(request),
        requestId: getRequestIdentifier(request),
        channelAccountPublicId: validateChannelAccountIdParam(request.params.channel_account_id),
      });
      await recordChannelAccountAudit({
        request,
        action: 'app.channel_account.disconnect',
        severity: 'WARNING',
        change,
      });
      return reply.code(204).send();
    },
    pauseChannelAccount: async (request: AccountRequest, _reply: FastifyReply) => {
      validateEmptyChannelAccountBody(request.body);
      const { data, change } = await service.pauseAccount({
        scope: requireOrganizationScope(request),
        userPublicId: getActingUserPublicId(requirePrincipal(request)) ?? '',
        channelAccountPublicId: validateChannelAccountIdParam(request.params.channel_account_id),
      });
      await recordChannelAccountAudit({
        request,
        action: 'app.channel_account.pause',
        severity: 'INFO',
        change,
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    resumeChannelAccount: async (request: AccountRequest, _reply: FastifyReply) => {
      validateEmptyChannelAccountBody(request.body);
      const { data, change } = await service.resumeAccount({
        scope: requireOrganizationScope(request),
        channelAccountPublicId: validateChannelAccountIdParam(request.params.channel_account_id),
      });
      await recordChannelAccountAudit({
        request,
        action: 'app.channel_account.resume',
        severity: 'INFO',
        change,
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    activateChannelAccount: async (request: AccountRequest, _reply: FastifyReply) => {
      const channelAccountPublicId = validateChannelAccountIdParam(
        request.params.channel_account_id,
      );
      const { stopChannelAccountPublicId } = validateActivateChannelAccount(request.body);
      const { data, change, stoppedChannelAccountPublicId } = await service.activateAccount({
        scope: requireOrganizationScope(request),
        channelAccountPublicId,
        stopChannelAccountPublicId,
      });
      await recordChannelAccountAudit({
        request,
        action: 'app.channel_account.activate',
        severity: 'WARNING',
        change,
        extraMetadata: { stopped_channel_account_public_id: stoppedChannelAccountPublicId },
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
  };
}
