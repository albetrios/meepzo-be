import type { FastifyReply, FastifyRequest } from 'fastify';
import { successResponse } from '@/shared/utils/http/response.util.js';
import {
  getRequestIdentifier,
  requireOrganizationScope,
} from '@/shared/utils/http/request.util.js';
import { validateChannelAccountIdParam } from '@/domains/app/sub-domains/channel-account/channel-account.validator.js';
import type { InstagramAccountMessageAccessService } from './instagram-account-message-access.service.js';

/** A request with the `{channel_account_id}` path parameter (route 154). */
type AccountRequest = FastifyRequest<{ Params: { channel_account_id: string } }>;

/**
 * Builds the handler map of the Instagram account's own route (feat-meta-connect-flow routes-final
 * § 3 — route 154): validates the path, calls
 * {@link InstagramAccountMessageAccessService.checkMessageAccess} and answers its result.
 *
 * @remarks
 * No audit entry: the check reads Meta and stores its answer — the owner changes nothing (3.10).
 */
export function createInstagramAccountController(service: InstagramAccountMessageAccessService) {
  return {
    checkInstagramMessageAccess: async (request: AccountRequest, _reply: FastifyReply) => {
      const data = await service.checkMessageAccess({
        scope: requireOrganizationScope(request),
        channelAccountPublicId: validateChannelAccountIdParam(request.params.channel_account_id),
        requestId: getRequestIdentifier(request),
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
  };
}
