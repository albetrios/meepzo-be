import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';

const createAndDispatchNotificationMock = vi.fn();
vi.mock('@/domains/notify/sub-domains/notification/notification-dispatch.service.js', () => ({
  createAndDispatchNotification: (...arguments_: unknown[]) =>
    createAndDispatchNotificationMock(...arguments_),
}));

const invalidateUnreadCountsMock = vi.fn();
vi.mock('@/domains/notify/sub-domains/notification/notification-unread-count.cache.js', () => ({
  invalidateCachedUnreadNotificationCounts: (...arguments_: unknown[]) =>
    invalidateUnreadCountsMock(...arguments_),
}));

beforeAll(async () => {
  await initializeI18nextForBackgroundWork();
});

const basePayload = {
  recipient_user_ids: [11, 22],
  organization_id: 7,
  organization_name: 'Acme',
  membership_public_id: 'mem_member000000000000001',
  member_name: 'Dana Scully',
  locale: 'en',
};

describe('membership notice handlers (feat-instagram-dm-sending UN8)', () => {
  let emit: (type: string, payload: unknown) => Promise<void>;
  let EVENT: { ROLE_CHANGED: string; REMOVED: string };

  beforeAll(async () => {
    const { eventBus } = await import('@/core/events/event-bus.js');
    const { MEMBERSHIP_NOTICE_EVENT } = await import(
      '@/domains/tenancy/sub-domains/membership/events/membership-notice.events.js'
    );
    const { registerMembershipNoticeNotificationHandlers } = await import(
      '@/domains/notify/sub-domains/notification/events/membership-notice.event-handlers.js'
    );
    registerMembershipNoticeNotificationHandlers();
    EVENT = MEMBERSHIP_NOTICE_EVENT;
    emit = async (type, payload) => {
      await eventBus.emit({ type, payload, timestamp: new Date() });
    };
  }, 60_000);

  beforeEach(() => {
    createAndDispatchNotificationMock.mockReset();
    createAndDispatchNotificationMock.mockResolvedValue({
      inAppUserIds: [11],
      inAppUserPublicIds: ['usr_first'],
      emailOnlyUserIds: [],
      skippedCount: 0,
      failedCount: 0,
    });
    invalidateUnreadCountsMock.mockReset();
  });

  it('sends membership.role_changed with both role names, once per change', async () => {
    await emit(EVENT.ROLE_CHANGED, {
      ...basePayload,
      role_name: 'Editor',
      previous_role_name: 'Viewer',
      dedupe_key: 'mem_member000000000000001:2026-11-24T10:00:00.000Z',
    });

    expect(createAndDispatchNotificationMock).toHaveBeenCalledExactlyOnceWith({
      input: {
        recipientUserIds: [11, 22],
        organization_id: 7,
        type: 'membership.role_changed',
        title: 'Role changed',
        message: 'Dana Scully is now Editor in Acme (was Viewer).',
        action_url: '/settings/members',
        channels: ['in_app', 'email'],
        locale: 'en',
        dedupe_key: 'mem_member000000000000001:2026-11-24T10:00:00.000Z',
      },
    });
    expect(invalidateUnreadCountsMock).toHaveBeenCalledWith(['usr_first']);
  });

  it('sends membership.removed', async () => {
    await emit(EVENT.REMOVED, { ...basePayload, dedupe_key: 'mem_member000000000000001:removed' });

    expect(createAndDispatchNotificationMock).toHaveBeenCalledWith({
      input: expect.objectContaining({
        type: 'membership.removed',
        message: 'Dana Scully was removed from Acme.',
        dedupe_key: 'mem_member000000000000001:removed',
      }),
    });
  });

  it('a failed dispatch never throws out of the handler', async () => {
    createAndDispatchNotificationMock.mockRejectedValue(new Error('boom'));
    await expect(
      emit(EVENT.REMOVED, { ...basePayload, dedupe_key: 'x:removed' }),
    ).resolves.not.toThrow();
  });
});
