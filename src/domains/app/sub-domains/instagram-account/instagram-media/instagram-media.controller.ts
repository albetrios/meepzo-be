import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginatedResponse } from '@/shared/utils/http/response.util.js';
import {
  getRequestIdentifier,
  requireOrganizationScope,
} from '@/shared/utils/http/request.util.js';
import type { InstagramMediaService } from './instagram-media.service.js';
import type { InstagramMediaPage } from './instagram-media.types.js';
import { validateListInstagramMediaQuery } from './instagram-media.validator.js';

/**
 * A picker page as the list envelope: `meta.pagination` = `{ per_page, next, has_more }` —
 * Instagram's cursor, no `estimated_total` (IA16).
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

/**
 * Builds the handler map for the post and story pickers (routes-final § 1.C — routes 5–6): reads
 * the organization scope, validates the query, calls {@link InstagramMediaService} and shapes the
 * page. Reads only — no audit entry.
 */
export function createInstagramMediaController(service: InstagramMediaService) {
  return {
    listInstagramMedia: async (request: FastifyRequest, _reply: FastifyReply) => {
      const { limit, after } = validateListInstagramMediaQuery(request.query);
      const page = await service.listMedia({
        scope: requireOrganizationScope(request),
        limit,
        after,
        requestId: getRequestIdentifier(request),
      });
      return toPickerResponse({ page, request });
    },
    listInstagramStories: async (request: FastifyRequest, _reply: FastifyReply) => {
      const { limit, after } = validateListInstagramMediaQuery(request.query);
      const page = await service.listStories({
        scope: requireOrganizationScope(request),
        limit,
        after,
        requestId: getRequestIdentifier(request),
      });
      return toPickerResponse({ page, request });
    },
  };
}
