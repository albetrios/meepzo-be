import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from '@/shared/errors/index.js';
import { createInstagramAccountSettingsController } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.controller.js';
import type { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

/**
 * Route 12's handler (feat-instagram-dm-sending routes-final § 2.B, IA7, IA12) with the service
 * faked: what it relays (the path's account, the switch apart from the settings), the answer's
 * shape, and the one audit entry — the changed fields with their old and new values (AC-3.11).
 */

const ORGANIZATION_PUBLIC_ID = generatePublicId('organization');
const USER_PUBLIC_ID = generatePublicId('user');
const API_KEY_PUBLIC_ID = generatePublicId('organizationApiKey');
const ACCOUNT_PUBLIC_ID = generatePublicId('channelAccount');
const READ_AT = '2026-11-21T09:00:00.000Z';

const savedSettings = {
  is_automation_enabled: false,
  opening_hour_limit: 300,
  updated_by_user_id: USER_PUBLIC_ID,
  updated_at: '2026-11-21T10:00:00.000Z',
};

const reply = {} as FastifyReply;

/** Route 12's request — the `{channel_account_id}` path parameter. */
type SettingsRequest = FastifyRequest<{ Params: { channel_account_id: string } }>;

describe('createInstagramAccountSettingsController', () => {
  const service = { updateSettings: vi.fn() };
  const recordAudit = vi.fn();
  const logWarn = vi.fn();
  const controller = createInstagramAccountSettingsController(
    service as unknown as InstagramAccountSettingsService,
  );

  function mockRequest(overrides: Partial<FastifyRequest> = {}): SettingsRequest {
    return attachPrincipalScope({
      auth: {
        kind: 'user',
        userId: USER_PUBLIC_ID,
        role: 'user',
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
      },
      params: { channel_account_id: ACCOUNT_PUBLIC_ID },
      query: {},
      body: { is_automation_enabled: false },
      headers: { 'user-agent': 'vitest' },
      ip: '203.0.113.7',
      id: 'request-id',
      server: { auditDomain: { auditService: { record: recordAudit } } },
      log: { warn: logWarn, error: vi.fn() },
      ...overrides,
    } as unknown as FastifyRequest) as SettingsRequest;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    recordAudit.mockReset();
    recordAudit.mockResolvedValue(undefined);
    service.updateSettings.mockReset();
    service.updateSettings.mockResolvedValue({
      settings: savedSettings,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      changes: {
        opening_hour_limit: { old_value: null, new_value: 300 },
        is_automation_enabled: { old_value: true, new_value: false },
      },
    });
  });

  it('relays the organization scope, the change, the version read and the caller, and answers the settings as saved', async () => {
    const response = await controller.updateInstagramAccountSettings(
      mockRequest({
        body: {
          is_automation_enabled: false,
          opening_hour_limit: 300,
          expected_updated_at: READ_AT,
        },
      }),
      reply,
    );

    expect(service.updateSettings).toHaveBeenCalledWith({
      scope: expect.objectContaining({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        source: 'request',
      }),
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      changes: { opening_hour_limit: 300 },
      isAutomationEnabled: false,
      expectedUpdatedAt: READ_AT,
      updatedByUserPublicId: USER_PUBLIC_ID,
    });
    expect(response).toEqual({ data: savedSettings, meta: { request_id: 'request-id' } });
  });

  it('asks for no stale-save check when the body names no version', async () => {
    await controller.updateInstagramAccountSettings(mockRequest(), reply);

    expect(service.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: {},
        isAutomationEnabled: false,
        expectedUpdatedAt: undefined,
      }),
    );
  });

  it('records one INFO entry after the write: the account, the changed fields, their old and new values (AC-3.11)', async () => {
    await controller.updateInstagramAccountSettings(
      mockRequest({
        body: {
          opening_hour_limit: 300,
          is_automation_enabled: false,
          expected_updated_at: READ_AT,
        },
      }),
      reply,
    );

    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserPublicId: USER_PUBLIC_ID,
      action: 'app.instagram_account_settings.update',
      resource_type: 'instagram_account',
      organization_public_id: ORGANIZATION_PUBLIC_ID,
      severity: 'INFO',
      metadata: {
        channel_account_public_id: ACCOUNT_PUBLIC_ID,
        changed_fields: ['opening_hour_limit', 'is_automation_enabled'],
        old_value: { opening_hour_limit: null, is_automation_enabled: true },
        new_value: { opening_hour_limit: 300, is_automation_enabled: false },
      },
      ip_address: '203.0.113.7',
      user_agent: 'vitest',
    });
    expect(service.updateSettings.mock.invocationCallOrder[0]).toBeLessThan(
      recordAudit.mock.invocationCallOrder[0] as number,
    );
  });

  it('names an API key as the actor and passes no user', async () => {
    await controller.updateInstagramAccountSettings(
      mockRequest({
        auth: {
          kind: 'apiKey',
          apiKeyPublicId: API_KEY_PUBLIC_ID,
          apiKeyScopes: [],
          organizationPublicId: ORGANIZATION_PUBLIC_ID,
        },
      } as never),
      reply,
    );

    expect(service.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ updatedByUserPublicId: undefined }),
    );
    const entry = recordAudit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry.actorApiKeyPublicId).toBe(API_KEY_PUBLIC_ID);
    expect(entry).not.toHaveProperty('actorUserPublicId');
  });

  it('answers even when the audit entry cannot be recorded (D36)', async () => {
    recordAudit.mockRejectedValue(new Error('audit outbox unavailable'));

    const response = await controller.updateInstagramAccountSettings(mockRequest(), reply);

    expect(response.data).toEqual(savedSettings);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'app.instagram_account_settings.update' }),
      'audit.record.failed',
    );
  });

  it.each([
    ['no setting at all', {}],
    ['a version and no setting', { expected_updated_at: READ_AT }],
    ['an unknown field', { is_automation_enabled: true, reply_text: 'Thanks!' }],
    ['a value out of range', { opening_hour_limit: 701 }],
    ['a removed public-reply field', { public_reply_chance_percent: 50 }],
    ['no body', undefined],
  ])('refuses a body with %s before the service and records nothing', async (_case, body) => {
    await expect(
      controller.updateInstagramAccountSettings(mockRequest({ body }), reply),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(service.updateSettings).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("passes the service's refusal through and records nothing", async () => {
    const stale = new ConflictError('errors:recordChangedSinceOpened').withReason('record_changed');
    service.updateSettings.mockRejectedValue(stale);

    await expect(controller.updateInstagramAccountSettings(mockRequest(), reply)).rejects.toBe(
      stale,
    );
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('refuses a malformed account id before the service', async () => {
    await expect(
      controller.updateInstagramAccountSettings(
        mockRequest({ params: { channel_account_id: 'iga_nope' } } as never),
        reply,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(service.updateSettings).not.toHaveBeenCalled();
  });

  it('refuses a request without a principal, and a token without an organization', async () => {
    await expect(
      controller.updateInstagramAccountSettings(mockRequest({ auth: undefined as never }), reply),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      controller.updateInstagramAccountSettings(
        mockRequest({ auth: { kind: 'user', userId: USER_PUBLIC_ID, role: 'user' } as never }),
        reply,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(service.updateSettings).not.toHaveBeenCalled();
  });
});
