import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginatedResponse } from '@/shared/utils/http/response.util.js';
import {
  getRequestIdentifier,
  requireOrganizationScope,
} from '@/shared/utils/http/request.util.js';
import type { InstagramWebhookEventService } from './instagram-webhook-event.service.js';
import { validateListInstagramWebhookEventsQuery } from './instagram-webhook-event.validator.js';

/**
 * Builds the handler map for route 18 (`GET /app/social/instagram/webhook-events`, routes-final
 * § 4.B): reads the organization scope, validates the query, calls
 * {@link InstagramWebhookEventService.listEvents} and shapes the keyset page.
 *
 * @remarks
 * No audit entry — a read (and events are not team actions, WH6). `meta.pagination` carries
 * `estimated_total` only when `include_total=true` asked for it.
 */
export function createInstagramWebhookEventController(service: InstagramWebhookEventService) {
  return {
    listInstagramWebhookEvents: async (request: FastifyRequest, _reply: FastifyReply) => {
      const scope = requireOrganizationScope(request);
      const filters = validateListInstagramWebhookEventsQuery(request.query);
      const page = await service.listEvents({ scope, filters });
      return paginatedResponse({
        data: page.items,
        request_id: getRequestIdentifier(request),
        pagination: {
          per_page: page.limit,
          next: page.next_cursor,
          has_more: page.has_more,
          ...(page.total !== null ? { estimated_total: page.total } : {}),
        },
      });
    },
  };
}
