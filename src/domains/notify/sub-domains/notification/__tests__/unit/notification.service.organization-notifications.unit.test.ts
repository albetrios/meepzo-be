import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { NotFoundError } from '@/shared/errors/index.js';

const { createAndDispatchNotification, invalidateCounts, loggerError, loggerWarn } = vi.hoisted(
  () => ({
    createAndDispatchNotification: vi.fn(),
    invalidateCounts: vi.fn(),
    loggerError: vi.fn(),
    loggerWarn: vi.fn(),
  }),
);

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The unit lane has no Postgres: the unit of work runs the callback directly.
    withAppDatabaseContext: vi.fn(async ({ callback }: { callback: () => Promise<unknown> }) =>
      callback(),
    ),
  };
});

vi.mock('@/infrastructure/database/transaction.js', () => ({
  withSavepoint: async (callback: () => Promise<unknown>) => callback(),
}));

vi.mock('@/core/events/event-bus.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runEnqueueAfterCommit: async (callback: () => Promise<void>) => callback() };
});

vi.mock(
  '@/domains/notify/sub-domains/notification/notification-dispatch.service.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, createAndDispatchNotification };
  },
);

vi.mock(
  '@/domains/notify/sub-domains/notification/notification-unread-count.cache.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, invalidateCachedUnreadNotificationCounts: invalidateCounts };
  },
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { error: loggerError, warn: loggerWarn, info: vi.fn(), debug: vi.fn() },
}));

import { NotificationService } from '@/domains/notify/sub-domains/notification/notification.service.js';
import type { NotificationRepository } from '@/domains/notify/sub-domains/notification/notification.repository.js';
import type { UserService } from '@/domains/user/user.service.js';

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const ORGANIZATION_ID = 7;
const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId: ORGANIZATION_PUBLIC_ID });
/** The app domain's reconnect notice (launch IA9): in the app and by email. */
const notification = {
  type: 'instagram.reconnect_required' as const,
  title: 'Reconnect Instagram',
  message: 'Instagram stopped accepting the connection.',
  actionUrl: 'https://app.example.com/instagram',
  channels: ['in_app', 'email'] as const,
  locale: 'en' as const,
};
const DEDUPE_KEY = 'instagram-reconnect:iga_k7x9m2pqr4w8n1v3a1b2c:2026-11-21T09:00:00.000Z';

function setup({
  organizationId = ORGANIZATION_ID as number | null,
  alreadySent = false,
}: {
  organizationId?: number | null;
  alreadySent?: boolean;
} = {}) {
  const repository = {
    findOrganizationIdByPublicId: vi.fn(async () => organizationId),
    lockOrganizationNotificationKey: vi.fn(async () => undefined),
    existsOrganizationNotificationWithDedupeKey: vi.fn(async () => alreadySent),
    resolveUserPublicIdsByInternalIds: vi.fn(async (userIds: readonly number[]) =>
      userIds.map((userId) => `usr_recipient_${userId}`),
    ),
  };
  const service = new NotificationService(
    repository as unknown as NotificationRepository,
    {} as UserService,
  );
  const send = (recipientUserIds: readonly number[]) =>
    service.createOrganizationNotifications({
      scope,
      recipientUserIds,
      notification,
      dedupeKey: DEDUPE_KEY,
    });
  return { repository, send };
}

/**
 * {@link NotificationService.createOrganizationNotifications} without a database: one dispatch for
 * every recipient (the check before send lives in the dispatch — UN11), the once-only check, the
 * cache drop for the inbox recipients, and a dispatch failure reaching the caller.
 */
describe('NotificationService.createOrganizationNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAndDispatchNotification.mockResolvedValue({
      inAppUserIds: [1, 2],
      inAppUserPublicIds: ['usr_recipient_1', 'usr_recipient_2'],
      emailOnlyUserIds: [3],
      skippedCount: 0,
      failedCount: 0,
    });
  });

  it('dispatches once for all the recipients with the dedupe key and counts every notified one', async () => {
    const { send } = setup();

    const result = await send([1, 2, 3]);

    expect(createAndDispatchNotification).toHaveBeenCalledExactlyOnceWith({
      input: {
        recipientUserIds: [1, 2, 3],
        organization_id: ORGANIZATION_ID,
        type: 'instagram.reconnect_required',
        title: notification.title,
        message: notification.message,
        action_url: notification.actionUrl,
        channels: notification.channels,
        locale: 'en',
        dedupe_key: DEDUPE_KEY,
      },
    });
    expect(result).toEqual({ createdCount: 3, failedCount: 0, deduplicated: false });
    expect(invalidateCounts).toHaveBeenCalledWith(['usr_recipient_1', 'usr_recipient_2']);
  });

  it('sends nothing when a notification with the key already exists (a replay)', async () => {
    const { send } = setup({ alreadySent: true });

    const result = await send([1, 2]);

    expect(result).toEqual({ createdCount: 0, failedCount: 0, deduplicated: true });
    expect(createAndDispatchNotification).not.toHaveBeenCalled();
  });

  it('refuses an organization that does not resolve', async () => {
    const { send } = setup({ organizationId: null });
    await expect(send([1])).rejects.toBeInstanceOf(NotFoundError);
    expect(createAndDispatchNotification).not.toHaveBeenCalled();
  });

  it('passes on the failed count and rethrows a dispatch where every recipient failed', async () => {
    const { send } = setup();
    createAndDispatchNotification.mockResolvedValueOnce({
      inAppUserIds: [1],
      inAppUserPublicIds: ['usr_recipient_1'],
      emailOnlyUserIds: [],
      skippedCount: 0,
      failedCount: 1,
    });
    expect(await send([1, 2])).toEqual({ createdCount: 1, failedCount: 1, deduplicated: false });

    createAndDispatchNotification.mockRejectedValueOnce(new Error('insert failed'));
    await expect(send([1, 2])).rejects.toThrow('insert failed');
  });
});
