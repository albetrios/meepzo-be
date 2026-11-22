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

/** The recipients `createAndDispatchNotification` was called for, in order. */
function dispatchedRecipients(): number[] {
  return createAndDispatchNotification.mock.calls.map(
    ([call]) => (call as { input: { user_id: number } }).input.user_id,
  );
}

/**
 * {@link NotificationService.createOrganizationNotifications} without a database: one row — and one
 * dispatch, which carries the email channel — per recipient, the once-only check, and the two failure
 * branches (some recipients fail: logged and skipped; all fail: the first error reaches the caller).
 */
describe('NotificationService.createOrganizationNotifications', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createAndDispatchNotification.mockResolvedValue(undefined);
    invalidateCounts.mockResolvedValue(undefined);
  });

  it('creates and dispatches one notification per recipient, in the app and by email', async () => {
    const { repository, send } = setup();

    await expect(send([11, 12, 13])).resolves.toEqual({
      createdCount: 3,
      failedCount: 0,
      deduplicated: false,
    });

    expect(createAndDispatchNotification).toHaveBeenCalledTimes(3);
    expect(dispatchedRecipients()).toEqual([11, 12, 13]);
    expect(createAndDispatchNotification).toHaveBeenNthCalledWith(1, {
      input: {
        user_id: 11,
        organization_id: ORGANIZATION_ID,
        type: 'instagram.reconnect_required',
        title: notification.title,
        message: notification.message,
        action_url: notification.actionUrl,
        // The dispatch job reads the channels from the row: the email goes out from there.
        data: { channels: ['in_app', 'email'], locale: 'en', dedupe_key: DEDUPE_KEY },
      },
    });
    expect(repository.existsOrganizationNotificationWithDedupeKey).toHaveBeenCalledWith({
      organization_id: ORGANIZATION_ID,
      type: 'instagram.reconnect_required',
      dedupe_key: DEDUPE_KEY,
    });
    expect(invalidateCounts).toHaveBeenCalledWith([
      'usr_recipient_11',
      'usr_recipient_12',
      'usr_recipient_13',
    ]);
  });

  it('sends nothing a second time for one key', async () => {
    const { send } = setup({ alreadySent: true });

    await expect(send([11, 12])).resolves.toEqual({
      createdCount: 0,
      failedCount: 0,
      deduplicated: true,
    });
    expect(createAndDispatchNotification).not.toHaveBeenCalled();
    expect(invalidateCounts).not.toHaveBeenCalled();
  });

  it('logs and skips a recipient whose notification fails, and tells the others', async () => {
    const { send } = setup();
    const failure = new Error('the insert failed');
    createAndDispatchNotification
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);

    await expect(send([11, 12, 13])).resolves.toEqual({
      createdCount: 2,
      failedCount: 1,
      deduplicated: false,
    });

    expect(dispatchedRecipients()).toEqual([11, 12, 13]);
    expect(loggerError).toHaveBeenCalledWith(
      {
        err: failure,
        recipientUserId: 12,
        notificationType: 'instagram.reconnect_required',
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
      },
      'notify.organization_notification.failed',
    );
    // Only the recipients who were told have a new unread notification.
    expect(invalidateCounts).toHaveBeenCalledWith(['usr_recipient_11', 'usr_recipient_13']);
  });

  it('rethrows the first error when every recipient fails, so a retry tells them all', async () => {
    const { send } = setup();
    const firstFailure = new Error('the first failure');
    createAndDispatchNotification
      .mockRejectedValueOnce(firstFailure)
      .mockRejectedValueOnce(new Error('the second failure'));

    await expect(send([11, 12])).rejects.toBe(firstFailure);

    expect(loggerError).toHaveBeenCalledTimes(2);
    expect(invalidateCounts).not.toHaveBeenCalled();
  });

  it('answers none created for no recipients, throwing nothing', async () => {
    const { send } = setup();

    await expect(send([])).resolves.toEqual({
      createdCount: 0,
      failedCount: 0,
      deduplicated: false,
    });
    expect(invalidateCounts).not.toHaveBeenCalled();
  });

  it('answers NotFoundError when the organization is gone, sending nothing', async () => {
    const { send } = setup({ organizationId: null });

    await expect(send([11])).rejects.toBeInstanceOf(NotFoundError);
    expect(createAndDispatchNotification).not.toHaveBeenCalled();
  });

  it('never fails the notifications over the cached unread counts', async () => {
    const { repository, send } = setup();
    repository.resolveUserPublicIdsByInternalIds.mockRejectedValueOnce(
      new Error('the read failed'),
    );

    await expect(send([11])).resolves.toMatchObject({ createdCount: 1, failedCount: 0 });

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'notify.organization_notification.unread_cache_invalidate.failed',
    );
  });
});
