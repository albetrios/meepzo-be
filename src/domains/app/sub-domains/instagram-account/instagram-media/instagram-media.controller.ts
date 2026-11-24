import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginatedResponse } from '@/shared/utils/http/response.util.js';
import {
  getRequestIdentifier,
  requireOrganizationScope,
} from '@/shared/utils/http/request.util.js';
import { validateChannelAccountIdParam } from '@/domains/app/sub-domains/channel-account/channel-account.validator.js';
import type { InstagramMediaService } from './instagram-media.service.js';
import type { InstagramMediaPage } from './instagram-media.types.js';
import { validateListInstagramMediaQuery } from './instagram-media.validator.js';

/**
 * A picker page as the list envelope: `meta.pagination` = `{ per_page, next, has_more }` —
 * Meta's cursor, no `estimated_total` (IA16).
 */
function toPickerResponse<TItem>({
  page,
  request,
}: {
  page: InstagramMediaPage<TItem>;
  request: FastifyRequest;
}) {
  return paginatedResponse({
    data: page.items,
    request_id: getRequestIdentifier(request),
    pagination: {
      per_page: page.limit,
      next: page.nextCursor,
      has_more: page.nextCursor !== null,
    },
  });
}

/** A request with the `{channel_account_id}` path parameter (routes 13–14). */
type AccountMediaRequest = FastifyRequest<{ Params: { channel_account_id: string } }>;

/**
 * Builds the handler map for the post and story pickers (routes-final § 2.C — routes 13–14): reads
 * the organization scope and the account's id, validates the query, calls
 * {@link InstagramMediaService} and shapes the page. Reads only — no audit entry.
 */
export function createInstagramMediaController(service: InstagramMediaService) {
  return {
    listInstagramMedia: async (request: AccountMediaRequest, _reply: FastifyReply) => {
      const channelAccountPublicId = validateChannelAccountIdParam(
        request.params.channel_account_id,
      );
      const { limit, after } = validateListInstagramMediaQuery(request.query);
      const page = await service.listMedia({
        scope: requireOrganizationScope(request),
        channelAccountPublicId,
        limit,
        after,
        requestId: getRequestIdentifier(request),
      });
      return toPickerResponse({ page, request });
    },
    listInstagramStories: async (request: AccountMediaRequest, _reply: FastifyReply) => {
      const channelAccountPublicId = validateChannelAccountIdParam(
        request.params.channel_account_id,
      );
      const { limit, after } = validateListInstagramMediaQuery(request.query);
      const page = await service.listStories({
        scope: requireOrganizationScope(request),
        channelAccountPublicId,
        limit,
        after,
        requestId: getRequestIdentifier(request),
      });
      return toPickerResponse({ page, request });
    },
  };
}
