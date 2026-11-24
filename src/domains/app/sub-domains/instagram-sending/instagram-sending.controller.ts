import type { FastifyReply, FastifyRequest } from 'fastify';
import { successResponse } from '@/shared/utils/http/response.util.js';
import {
  getRequestIdentifier,
  requireOrganizationScope,
} from '@/shared/utils/http/request.util.js';
import { validateChannelAccountIdParam } from '@/domains/app/sub-domains/channel-account/channel-account.validator.js';
import type { InstagramSendingService } from './instagram-sending.service.js';

/** A request with the `{channel_account_id}` path parameter (route 63). */
type SendingStatusRequest = FastifyRequest<{ Params: { channel_account_id: string } }>;

/**
 * Builds the handler map for the sending sub-domain's two reads (feat-instagram-dm-sending
 * routes-final § 6.A — routes 63–64): reads the organization scope, validates the path and answers
 * the service's object.
 *
 * @remarks
 * Reads only — no audit entry (D36 audits writes).
 */
export function createInstagramSendingController(service: InstagramSendingService) {
  return {
    getInstagramSendingStatus: async (request: SendingStatusRequest, _reply: FastifyReply) => {
      const scope = requireOrganizationScope(request);
      const channelAccountPublicId = validateChannelAccountIdParam(
        request.params.channel_account_id,
      );
      const data = await service.getSendingStatus({ scope, channelAccountPublicId });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    getAppUsage: async (request: FastifyRequest, _reply: FastifyReply) => {
      const scope = requireOrganizationScope(request);
      const data = await service.getUsage({ scope });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
  };
}
