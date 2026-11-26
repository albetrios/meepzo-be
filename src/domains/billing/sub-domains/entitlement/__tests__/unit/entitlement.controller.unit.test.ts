import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

// The set and remove handlers audit after the service returns (K9); stub the audit util so the unit
// test (a minimal request without `server.auditDomain`) can assert the audit input it is handed.
vi.mock('@/shared/utils/infrastructure/audit-request-context.util.js', () => ({
  recordScopedAuditEvent: vi.fn().mockResolvedValue(undefined),
  buildAuditActorFields: vi.fn((auth: { userId: string }) => ({ actorUserPublicId: auth.userId })),
}));

import { createEntitlementController } from '@/domains/billing/sub-domains/entitlement/entitlement.controller.js';
import type {
  EntitlementOverrideChange,
  EntitlementService,
} from '@/domains/billing/sub-domains/entitlement/entitlement.service.js';
import type { EntitlementOverrideOutput } from '@/domains/billing/sub-domains/entitlement/entitlement.types.js';
import { ForbiddenError, UnauthorizedError, ValidationError } from '@/shared/errors/index.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { recordScopedAuditEvent } from '@/shared/utils/infrastructure/audit-request-context.util.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

const ACTIVE_ORGANIZATION_PUBLIC_ID = generatePublicId('organization');
const TARGET_ORGANIZATION_PUBLIC_ID = generatePublicId('organization');
const ADMIN_USER_PUBLIC_ID = generatePublicId('user');
const OVERRIDE_PUBLIC_ID = generatePublicId('organizationEntitlementOverride');

function override(values: Partial<EntitlementOverrideOutput> = {}): EntitlementOverrideOutput {
  return {
    id: OVERRIDE_PUBLIC_ID,
    organization_id: TARGET_ORGANIZATION_PUBLIC_ID,
    key: 'channel_accounts_max',
    value: 7,
    expires_at: null,
    is_active: true,
    reason: 'Support deal',
    created_at: '2026-11-20T00:00:00.000Z',
    updated_at: '2026-11-21T00:00:00.000Z',
    ...values,
  };
}

function mockRequest(overrides: Partial<FastifyRequest> = {}): never {
  return attachPrincipalScope({
    auth: {
      kind: 'user',
      userId: ADMIN_USER_PUBLIC_ID,
      role: 'user',
      organizationPublicId: ACTIVE_ORGANIZATION_PUBLIC_ID,
    },
    params: {},
    query: {},
    body: {},
    headers: {},
    id: 'request-id',
    ...overrides,
  }) as never;
}

function mockReply() {
  const reply = {
    code: vi.fn(() => reply),
    send: vi.fn(() => reply),
  };
  return reply;
}

describe('createEntitlementController', () => {
  const entitlements = { state: 'active', plan: { id: 'pln_creator', name: 'Creator' } };
  const service = {
    getEntitlements: vi.fn(),
    listOverrides: vi.fn(),
    setOverride: vi.fn(),
    removeOverride: vi.fn(),
  };
  const controller = createEntitlementController(service as unknown as EntitlementService);

  beforeEach(() => {
    vi.clearAllMocks();
    service.getEntitlements.mockResolvedValue(entitlements);
    service.listOverrides.mockResolvedValue([override()]);
  });

  describe('getEntitlements', () => {
    it('relays the request principal scope and wraps the entitlements in the success envelope', async () => {
      const response = await controller.getEntitlements(mockRequest(), mockReply() as never);

      expect(service.getEntitlements).toHaveBeenCalledExactlyOnceWith({
        scope: expect.objectContaining({ organizationPublicId: ACTIVE_ORGANIZATION_PUBLIC_ID }),
      });
      expect(response).toEqual({ data: entitlements, meta: { request_id: 'request-id' } });
    });

    it('is 403 without an active organization in the token', async () => {
      await expect(
        controller.getEntitlements(
          mockRequest({ auth: { kind: 'user', userId: ADMIN_USER_PUBLIC_ID, role: 'user' } }),
          mockReply() as never,
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(service.getEntitlements).not.toHaveBeenCalled();
    });

    it('is 401 without a principal', async () => {
      await expect(
        controller.getEntitlements(mockRequest({ auth: null as never }), mockReply() as never),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  describe('listOverrides', () => {
    it('passes the queried organization and the acting admin to the service', async () => {
      const response = await controller.listOverrides(
        mockRequest({ query: { organization_id: TARGET_ORGANIZATION_PUBLIC_ID } }),
        mockReply() as never,
      );

      expect(service.listOverrides).toHaveBeenCalledExactlyOnceWith({
        organizationPublicId: TARGET_ORGANIZATION_PUBLIC_ID,
        actorUserPublicId: ADMIN_USER_PUBLIC_ID,
      });
      expect(response).toEqual({ data: [override()], meta: { request_id: 'request-id' } });
    });

    it('is 400 for a query without a valid organization id', async () => {
      await expect(
        controller.listOverrides(
          mockRequest({ query: { organization_id: 'not-an-id' } }),
          mockReply() as never,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(service.listOverrides).not.toHaveBeenCalled();
    });

    it('is 401 for an API-key principal', async () => {
      await expect(
        controller.listOverrides(
          mockRequest({
            auth: {
              kind: 'apiKey',
              apiKeyPublicId: generatePublicId('organizationApiKey'),
              apiKeyScopes: [],
              organizationPublicId: ACTIVE_ORGANIZATION_PUBLIC_ID,
            } as never,
            query: { organization_id: TARGET_ORGANIZATION_PUBLIC_ID },
          }),
          mockReply() as never,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedError);
      expect(service.listOverrides).not.toHaveBeenCalled();
    });
  });

  describe('setOverride', () => {
    const body = {
      organization_id: TARGET_ORGANIZATION_PUBLIC_ID,
      key: 'channel_accounts_max',
      value: 7,
      reason: 'Support deal',
    };

    it('validates the body, sets the override, audits the change and answers the override', async () => {
      const change: EntitlementOverrideChange = {
        override: override(),
        previous: override({ value: 5 }),
      };
      service.setOverride.mockResolvedValue(change);

      const response = await controller.setOverride(mockRequest({ body }), mockReply() as never);

      expect(service.setOverride).toHaveBeenCalledExactlyOnceWith({
        input: body,
        actorUserPublicId: ADMIN_USER_PUBLIC_ID,
      });
      expect(recordScopedAuditEvent).toHaveBeenCalledExactlyOnceWith({
        request: expect.anything(),
        input: {
          actorUserPublicId: ADMIN_USER_PUBLIC_ID,
          action: 'billing.entitlement_override.set',
          resource_type: 'entitlement_override',
          organizationPublicId: TARGET_ORGANIZATION_PUBLIC_ID,
          severity: 'WARNING',
          metadata: {
            entitlement_override_public_id: OVERRIDE_PUBLIC_ID,
            key: 'channel_accounts_max',
            value: 7,
            previous_value: 5,
            expires_at: null,
            reason: 'Support deal',
          },
        },
      });
      expect(response).toEqual({ data: change.override, meta: { request_id: 'request-id' } });
    });

    it('audits a new key with a null previous value', async () => {
      service.setOverride.mockResolvedValue({ override: override(), previous: null });

      await controller.setOverride(mockRequest({ body }), mockReply() as never);

      expect(vi.mocked(recordScopedAuditEvent).mock.calls[0]?.[0].input.metadata).toMatchObject({
        value: 7,
        previous_value: null,
      });
    });

    it('is 400 for a value outside the key bounds — neither the service nor the audit runs', async () => {
      await expect(
        controller.setOverride(
          mockRequest({ body: { ...body, value: true } }),
          mockReply() as never,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(service.setOverride).not.toHaveBeenCalled();
      expect(recordScopedAuditEvent).not.toHaveBeenCalled();
    });

    it('does not audit when the service fails', async () => {
      service.setOverride.mockRejectedValue(new Error('boom'));

      await expect(
        controller.setOverride(mockRequest({ body }), mockReply() as never),
      ).rejects.toThrow('boom');
      expect(recordScopedAuditEvent).not.toHaveBeenCalled();
    });
  });

  describe('removeOverride', () => {
    it('removes the override, audits it with a null value and answers 204', async () => {
      const removed = override({ is_active: false });
      service.removeOverride.mockResolvedValue({ override: removed, previous: removed });
      const reply = mockReply();

      await controller.removeOverride(
        mockRequest({ params: { entitlement_override_id: OVERRIDE_PUBLIC_ID } }),
        reply as never,
      );

      expect(service.removeOverride).toHaveBeenCalledExactlyOnceWith({
        entitlementOverridePublicId: OVERRIDE_PUBLIC_ID,
        actorUserPublicId: ADMIN_USER_PUBLIC_ID,
      });
      expect(recordScopedAuditEvent).toHaveBeenCalledExactlyOnceWith({
        request: expect.anything(),
        input: expect.objectContaining({
          action: 'billing.entitlement_override.remove',
          organizationPublicId: TARGET_ORGANIZATION_PUBLIC_ID,
          severity: 'WARNING',
          metadata: expect.objectContaining({
            entitlement_override_public_id: OVERRIDE_PUBLIC_ID,
            value: null,
            previous_value: 7,
          }),
        }),
      });
      expect(reply.code).toHaveBeenCalledWith(204);
      expect(reply.send).toHaveBeenCalledWith();
    });

    it('is 400 for a malformed override id', async () => {
      await expect(
        controller.removeOverride(
          mockRequest({ params: { entitlement_override_id: 'nope' } }),
          mockReply() as never,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(service.removeOverride).not.toHaveBeenCalled();
      expect(recordScopedAuditEvent).not.toHaveBeenCalled();
    });
  });
});
