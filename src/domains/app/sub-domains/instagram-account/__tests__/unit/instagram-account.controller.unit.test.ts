import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableEntityError,
  ValidationError,
} from '@/shared/errors/index.js';
import { createInstagramAccountController } from '@/domains/app/sub-domains/instagram-account/instagram-account.controller.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

/**
 * The handlers of routes 1, 2 and 4 (routes-final § 1.A, IA7) with the service faked: what they
 * relay, the answers' shape, and the audit entries — the account's public id only, never the code.
 */

const ORGANIZATION_PUBLIC_ID = generatePublicId('organization');
const USER_PUBLIC_ID = generatePublicId('user');
const API_KEY_PUBLIC_ID = generatePublicId('organizationApiKey');
const ACCOUNT_PUBLIC_ID = generatePublicId('instagramAccount');
const CODE = 'AQB-test-authorization-code#_';

const account = { id: ACCOUNT_PUBLIC_ID, username: 'acme.shop', connection_status: 'connected' };
const userAuth = {
  kind: 'user',
  userId: USER_PUBLIC_ID,
  role: 'user',
  organizationPublicId: ORGANIZATION_PUBLIC_ID,
};
const apiKeyAuth = {
  kind: 'apiKey',
  apiKeyPublicId: API_KEY_PUBLIC_ID,
  apiKeyScopes: [],
  organizationPublicId: ORGANIZATION_PUBLIC_ID,
};
const organizationScope = expect.objectContaining({
  organizationPublicId: ORGANIZATION_PUBLIC_ID,
  source: 'request',
});

describe('createInstagramAccountController', () => {
  const service = { connect: vi.fn(), getAccount: vi.fn(), disconnect: vi.fn() };
  const recordAudit = vi.fn();
  const logWarn = vi.fn();
  const controller = createInstagramAccountController(
    service as unknown as InstagramAccountService,
  );

  function mockRequest(overrides: Record<string, unknown> = {}): FastifyRequest {
    return attachPrincipalScope({
      auth: userAuth,
      params: {},
      query: {},
      body: undefined,
      headers: { 'user-agent': 'vitest' },
      ip: '203.0.113.7',
      id: 'request-id',
      server: { auditDomain: { auditService: { record: recordAudit } } },
      log: { warn: logWarn, error: vi.fn() },
      ...overrides,
    } as unknown as FastifyRequest);
  }

  function mockReply(): FastifyReply {
    return {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as unknown as FastifyReply;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    recordAudit.mockReset();
    recordAudit.mockResolvedValue(undefined);
    service.connect.mockReset();
    service.connect.mockResolvedValue({ is_new_connection: true, instagram_account: account });
    service.getAccount.mockReset();
    service.getAccount.mockResolvedValue(account);
    service.disconnect.mockReset();
    service.disconnect.mockResolvedValue({ instagramAccountPublicId: ACCOUNT_PUBLIC_ID });
  });

  describe('connectInstagramAccount (route 1)', () => {
    it('relays the scope, the code, the caller and the request id, and answers the connect result', async () => {
      const reply = mockReply();
      const response = await controller.connectInstagramAccount(
        mockRequest({ body: { code: CODE } }),
        reply,
      );

      expect(service.connect).toHaveBeenCalledWith({
        scope: organizationScope,
        code: CODE,
        connectedByUserPublicId: USER_PUBLIC_ID,
        requestId: 'request-id',
      });
      expect(response).toEqual({
        data: { is_new_connection: true, instagram_account: account },
        meta: { request_id: 'request-id' },
      });
      // The status stays with the method policy (POST → 200).
      expect(reply.code).not.toHaveBeenCalled();
    });

    it('trims the code, keeping the #_ the Instagram client strips (IA12)', async () => {
      await controller.connectInstagramAccount(
        mockRequest({ body: { code: `  ${CODE}  ` } }),
        mockReply(),
      );

      expect(service.connect).toHaveBeenCalledWith(expect.objectContaining({ code: CODE }));
    });

    it('records one WARNING entry after the connect: the public id and whether it is new, never the code (IA7)', async () => {
      await controller.connectInstagramAccount(mockRequest({ body: { code: CODE } }), mockReply());

      expect(recordAudit).toHaveBeenCalledTimes(1);
      expect(recordAudit).toHaveBeenCalledWith({
        actorUserPublicId: USER_PUBLIC_ID,
        action: 'app.instagram_account.connect',
        resource_type: 'instagram_account',
        organization_public_id: ORGANIZATION_PUBLIC_ID,
        severity: 'WARNING',
        metadata: { instagram_account_public_id: ACCOUNT_PUBLIC_ID, is_new_connection: true },
        ip_address: '203.0.113.7',
        user_agent: 'vitest',
      });
      expect(service.connect.mock.invocationCallOrder[0]).toBeLessThan(
        recordAudit.mock.invocationCallOrder[0] as number,
      );
      expect(JSON.stringify(recordAudit.mock.calls)).not.toContain('AQB-test');
    });

    it('names an API key as the actor and connects for no user', async () => {
      await controller.connectInstagramAccount(
        mockRequest({ auth: apiKeyAuth, body: { code: CODE } }),
        mockReply(),
      );

      expect(service.connect).toHaveBeenCalledWith(
        expect.objectContaining({ connectedByUserPublicId: undefined }),
      );
      const entry = recordAudit.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(entry.actorApiKeyPublicId).toBe(API_KEY_PUBLIC_ID);
      expect(entry).not.toHaveProperty('actorUserPublicId');
    });

    it('answers even when the audit entry cannot be recorded (D36)', async () => {
      recordAudit.mockRejectedValue(new Error('audit outbox unavailable'));

      const response = await controller.connectInstagramAccount(
        mockRequest({ body: { code: CODE } }),
        mockReply(),
      );

      expect(response.data.instagram_account).toEqual(account);
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'app.instagram_account.connect' }),
        'audit.record.failed',
      );
    });

    it.each([
      ['no body', undefined],
      ['no code', {}],
      ['a blank code', { code: '   ' }],
      ['a code over 2000 characters', { code: 'a'.repeat(2001) }],
      ['a code that is not text', { code: 12 }],
      ['an unknown field', { code: CODE, redirect_uri: 'https://example.com' }],
    ])('refuses a body with %s before the service and records nothing', async (_case, body) => {
      await expect(
        controller.connectInstagramAccount(mockRequest({ body }), mockReply()),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(service.connect).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it("passes the service's refusal through and records nothing", async () => {
      const refusal = new UnprocessableEntityError('errors:instagramCodeInvalid').withReason(
        'instagram_code_invalid',
      );
      service.connect.mockRejectedValue(refusal);

      await expect(
        controller.connectInstagramAccount(mockRequest({ body: { code: CODE } }), mockReply()),
      ).rejects.toBe(refusal);
      expect(recordAudit).not.toHaveBeenCalled();
    });
  });

  describe('getInstagramAccount (route 2)', () => {
    it('relays the scope only, answers the account and records nothing', async () => {
      const response = await controller.getInstagramAccount(mockRequest(), mockReply());

      expect(service.getAccount).toHaveBeenCalledWith({ scope: organizationScope });
      expect(response).toEqual({ data: account, meta: { request_id: 'request-id' } });
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('reads for an API key too', async () => {
      await controller.getInstagramAccount(mockRequest({ auth: apiKeyAuth }), mockReply());

      expect(service.getAccount).toHaveBeenCalledWith({
        scope: expect.objectContaining({ organizationPublicId: ORGANIZATION_PUBLIC_ID }),
      });
    });

    it("passes the service's 404 through", async () => {
      const notConnected = new NotFoundError('Instagram account').withReason(
        'instagram_not_connected',
      );
      service.getAccount.mockRejectedValue(notConnected);

      await expect(controller.getInstagramAccount(mockRequest(), mockReply())).rejects.toBe(
        notConnected,
      );
    });
  });

  describe('disconnectInstagramAccount (route 4)', () => {
    it('relays the scope and the request id, and answers 204 without a body', async () => {
      const reply = mockReply();

      await controller.disconnectInstagramAccount(mockRequest(), reply);

      expect(service.disconnect).toHaveBeenCalledWith({
        scope: organizationScope,
        requestId: 'request-id',
      });
      expect(reply.code).toHaveBeenCalledWith(204);
      expect(reply.send).toHaveBeenCalledWith();
    });

    it('records one WARNING entry naming the disconnected account, before it answers (IA7)', async () => {
      const reply = mockReply();

      await controller.disconnectInstagramAccount(mockRequest({ auth: apiKeyAuth }), reply);

      expect(recordAudit).toHaveBeenCalledTimes(1);
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          actorApiKeyPublicId: API_KEY_PUBLIC_ID,
          action: 'app.instagram_account.disconnect',
          resource_type: 'instagram_account',
          organization_public_id: ORGANIZATION_PUBLIC_ID,
          severity: 'WARNING',
          metadata: { instagram_account_public_id: ACCOUNT_PUBLIC_ID },
        }),
      );
      expect(recordAudit.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(reply.send).mock.invocationCallOrder[0] as number,
      );
    });

    it('still answers 204 when the audit entry cannot be recorded (D36)', async () => {
      recordAudit.mockRejectedValue(new Error('audit outbox unavailable'));
      const reply = mockReply();

      await controller.disconnectInstagramAccount(mockRequest(), reply);

      expect(reply.code).toHaveBeenCalledWith(204);
    });

    it('answers and records nothing when the service refuses', async () => {
      const notConnected = new NotFoundError('Instagram account').withReason(
        'instagram_not_connected',
      );
      service.disconnect.mockRejectedValue(notConnected);
      const reply = mockReply();

      await expect(controller.disconnectInstagramAccount(mockRequest(), reply)).rejects.toBe(
        notConnected,
      );
      expect(recordAudit).not.toHaveBeenCalled();
      expect(reply.code).not.toHaveBeenCalled();
    });
  });

  describe('every route', () => {
    const calls = {
      connect: (request: FastifyRequest) =>
        controller.connectInstagramAccount(request, mockReply()),
      read: (request: FastifyRequest) => controller.getInstagramAccount(request, mockReply()),
      disconnect: (request: FastifyRequest) =>
        controller.disconnectInstagramAccount(request, mockReply()),
    };

    it.each(['connect', 'read', 'disconnect'] as const)(
      '%s refuses a request without a principal, and a token without an organization',
      async (call) => {
        const body = { code: CODE };

        await expect(calls[call](mockRequest({ auth: undefined, body }))).rejects.toBeInstanceOf(
          UnauthorizedError,
        );
        await expect(
          calls[call](
            mockRequest({ auth: { kind: 'user', userId: USER_PUBLIC_ID, role: 'user' }, body }),
          ),
        ).rejects.toBeInstanceOf(ForbiddenError);
        expect(service.connect).not.toHaveBeenCalled();
        expect(service.getAccount).not.toHaveBeenCalled();
        expect(service.disconnect).not.toHaveBeenCalled();
      },
    );
  });
});
