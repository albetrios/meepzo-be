import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createInstagramWebhookEventController } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.controller.js';
import type { InstagramWebhookEventService } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { UnauthorizedError, ValidationError } from '@/shared/errors/index.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

/** Route 18's handler (routes-final § 4.B): validates the query, relays the scope, shapes the page. */

const ORGANIZATION_PUBLIC_ID = generatePublicId('organization');

function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return attachPrincipalScope({
    auth: {
      kind: 'user',
      userId: generatePublicId('user'),
      role: 'user',
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
    },
    params: {},
    query: {},
    body: {},
    headers: {},
    id: 'request-id',
    ...overrides,
  }) as FastifyRequest;
}

const reply = {} as FastifyReply;

describe('createInstagramWebhookEventController', () => {
  const service = { listEvents: vi.fn() };
  const controller = createInstagramWebhookEventController(
    service as unknown as InstagramWebhookEventService,
  );
  const item = { id: 'iwe_k3m9p2q7r5t1v8w4x6y0z', status: 'processed' };

  beforeEach(() => {
    service.listEvents.mockReset();
    service.listEvents.mockResolvedValue({
      items: [item],
      total: null,
      limit: 25,
      has_more: true,
      next_cursor: 'cursor-2',
    });
  });

  it('relays the organization scope and the parsed filters, and shapes the keyset page', async () => {
    const response = await controller.listInstagramWebhookEvents(
      mockRequest({ query: { status: 'processed', include_total: 'false' } }),
      reply,
    );

    expect(service.listEvents).toHaveBeenCalledWith({
      scope: expect.objectContaining({ organizationPublicId: ORGANIZATION_PUBLIC_ID }),
      filters: expect.objectContaining({ status: 'processed', limit: 25, includeTotal: false }),
    });
    expect(response).toEqual({
      data: [item],
      meta: {
        request_id: 'request-id',
        pagination: { per_page: 25, next: 'cursor-2', has_more: true },
      },
    });
  });

  it('adds estimated_total only when the service counted', async () => {
    service.listEvents.mockResolvedValue({
      items: [],
      total: 12,
      limit: 25,
      has_more: false,
      next_cursor: null,
    });

    const response = await controller.listInstagramWebhookEvents(
      mockRequest({ query: { include_total: 'true' } }),
      reply,
    );

    expect(response.meta.pagination).toEqual({
      per_page: 25,
      next: null,
      has_more: false,
      estimated_total: 12,
    });
  });

  it('refuses a bad query before the service', async () => {
    await expect(
      controller.listInstagramWebhookEvents(mockRequest({ query: { status: 'done' } }), reply),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(service.listEvents).not.toHaveBeenCalled();
  });

  it('refuses a request without a principal', async () => {
    await expect(
      controller.listInstagramWebhookEvents(mockRequest({ auth: undefined as never }), reply),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
