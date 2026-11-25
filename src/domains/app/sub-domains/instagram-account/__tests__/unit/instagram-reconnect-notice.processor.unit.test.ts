import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { accountRepository } = vi.hoisted(() => ({
  accountRepository: { findByPublicIdInOrganization: vi.fn() },
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', () => ({
  PRINCIPAL_SCOPE: {
    JOB: (identity: Record<string, string>) => ({ ...identity, source: 'job' }),
  },
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-processor.util.js', () => ({
  runOrganizationScopedWorkerJob: ({
    processor,
  }: {
    processor: (databaseHandle: unknown) => Promise<unknown>;
  }) => processor({}),
}));

vi.mock('@/domains/app/sub-domains/instagram-account/instagram-account.repository.js', () => ({
  createWorkerInstagramAccountRepository: () => accountRepository,
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import {
  buildInstagramReconnectNoticeActionUrl,
  isSameConnectionBreak,
  processInstagramReconnectNoticeJob,
  translateInstagramReconnectNotice,
} from '@/domains/app/sub-domains/instagram-account/workers/instagram-reconnect-notice.processor.js';

/**
 * The reconnect notice (launch IA9, IAC9) with its database step and the three cross-domain
 * services stubbed: who is told, in which language, once per break, and when nobody is.
 * Against Postgres: `__tests__/integration/instagram-reconnect-notice.integration.test.ts`.
 */

const ORGANIZATION_PUBLIC_ID = 'org_acmeshop00000000000001';
const ACCOUNT_PUBLIC_ID = 'iga_acmeshop00000000000001';
const BROKE_AT = new Date('2026-11-21T04:00:01.250Z');

function brokenAccount(overrides: Record<string, unknown> = {}) {
  return {
    public_id: ACCOUNT_PUBLIC_ID,
    connection_status: 'error',
    connection_status_changed_at: BROKE_AT,
    username: 'acme.shop',
    ...overrides,
  };
}

const membershipService = { findActiveUserIdsWithPermission: vi.fn() };
const organizationSettingsService = { resolveDefaultLocaleForOrganization: vi.fn() };
const notificationService = { createOrganizationNotifications: vi.fn() };

function runNotice() {
  return processInstagramReconnectNoticeJob({
    jobData: {
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
      connectionStatusChangedAt: BROKE_AT.toISOString(),
    },
    services: { membershipService, organizationSettingsService, notificationService },
  });
}

beforeAll(async () => {
  await initializeI18nextForBackgroundWork();
});

beforeEach(() => {
  vi.clearAllMocks();
  accountRepository.findByPublicIdInOrganization.mockResolvedValue(brokenAccount());
  membershipService.findActiveUserIdsWithPermission.mockResolvedValue([11, 12]);
  organizationSettingsService.resolveDefaultLocaleForOrganization.mockResolvedValue('es');
  notificationService.createOrganizationNotifications.mockResolvedValue({
    createdCount: 2,
    failedCount: 0,
    deduplicated: false,
  });
});

describe('isSameConnectionBreak', () => {
  it('holds only while the channel account is still broken (`error`, CA4)', () => {
    expect(isSameConnectionBreak({ account: brokenAccount() as never })).toBe(true);
    for (const connection_status of ['connected', 'revoked']) {
      expect(
        isSameConnectionBreak({ account: brokenAccount({ connection_status }) as never }),
      ).toBe(false);
    }
    expect(isSameConnectionBreak({ account: null })).toBe(false);
  });
});

describe('buildInstagramReconnectNoticeActionUrl', () => {
  it("joins the frontend's address and its Instagram page without a doubled slash", () => {
    expect(buildInstagramReconnectNoticeActionUrl('https://app.example.com')).toBe(
      'https://app.example.com/instagram',
    );
    expect(buildInstagramReconnectNoticeActionUrl('https://app.example.com/')).toBe(
      'https://app.example.com/instagram',
    );
  });
});

describe('translateInstagramReconnectNotice', () => {
  it("writes the title and message in the organization's language, naming the account", () => {
    const english = translateInstagramReconnectNotice({ locale: 'en', username: 'acme.shop' });
    expect(english.title).toBe('Reconnect Instagram');
    expect(english.message).toContain('@acme.shop');
    const spanish = translateInstagramReconnectNotice({ locale: 'es', username: 'acme.shop' });
    expect(spanish.title).toBe('Vuelve a conectar Instagram');
    expect(spanish.message).toContain('@acme.shop');
  });

  it('keeps a username with HTML characters as plain text (the inbox and email escape it)', () => {
    const { message } = translateInstagramReconnectNotice({ locale: 'en', username: 'a<b>&c' });
    expect(message).toContain('@a<b>&c');
  });
});

describe('processInstagramReconnectNoticeJob', () => {
  it('sends the channel-account:manage holders an in-app and email notice, keyed by the break', async () => {
    await expect(runNotice()).resolves.toEqual({ outcome: 'sent', recipientCount: 2 });

    expect(membershipService.findActiveUserIdsWithPermission).toHaveBeenCalledWith({
      scope: { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'job' },
      permissionCode: APP_PERMISSIONS.CHANNEL_ACCOUNT_MANAGE,
    });
    expect(organizationSettingsService.resolveDefaultLocaleForOrganization).toHaveBeenCalledWith(
      ORGANIZATION_PUBLIC_ID,
    );
    expect(notificationService.createOrganizationNotifications).toHaveBeenCalledWith({
      scope: { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'job' },
      recipientUserIds: [11, 12],
      notification: {
        type: 'instagram.reconnect_required',
        title: 'Vuelve a conectar Instagram',
        message: expect.stringContaining('@acme.shop'),
        actionUrl: expect.stringMatching(/^https?:\/\/.+\/instagram$/),
        channels: ['in_app', 'email'],
        locale: 'es',
      },
      dedupeKey: `instagram-reconnect-notice-${ACCOUNT_PUBLIC_ID}-${BROKE_AT.getTime()}`,
    });
  });

  it('tells nobody about a break that is over (reconnected, or broken again later)', async () => {
    accountRepository.findByPublicIdInOrganization.mockResolvedValue(
      brokenAccount({ connection_status: 'connected' }),
    );

    await expect(runNotice()).resolves.toEqual({ outcome: 'skipped', reason: 'break_over' });
    expect(notificationService.createOrganizationNotifications).not.toHaveBeenCalled();
  });

  it('completes without a notice when nobody holds channel-account:manage', async () => {
    membershipService.findActiveUserIdsWithPermission.mockResolvedValue([]);

    await expect(runNotice()).resolves.toEqual({ outcome: 'skipped', reason: 'no_recipients' });
    expect(notificationService.createOrganizationNotifications).not.toHaveBeenCalled();
  });

  it('reports a break already told — a job run again after its commit sends nothing', async () => {
    notificationService.createOrganizationNotifications.mockResolvedValue({
      createdCount: 0,
      failedCount: 0,
      deduplicated: true,
    });

    await expect(runNotice()).resolves.toEqual({ outcome: 'deduplicated' });
  });
});
