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

// Email copy comes from the locale files, as in the API and the worker.
beforeAll(async () => {
  await initializeI18nextForBackgroundWork();
});

/** A dispatch result where these recipients got an inbox row. */
function dispatched(inAppUserPublicIds: string[]) {
  return {
    inAppUserIds: inAppUserPublicIds.map((_, index) => index + 1),
    inAppUserPublicIds,
    emailOnlyUserIds: [],
    skippedCount: 0,
    failedCount: 0,
  };
}

describe('membership-invitation notification handlers (item #10, launch D84, UN11)', () => {
  let emitAccepted: (payload: unknown) => Promise<void>;
  let emitDeclined: (payload: unknown) => Promise<void>;

  beforeAll(async () => {
    // One cold import + handler registration for the file — avoids per-test
    // `vi.resetModules()` + event-bus re-import that flakes under parallel fork load.
    const { eventBus } = await import('@/core/events/event-bus.js');
    const { MEMBERSHIP_INVITATION_EVENT } = await import(
      '@/domains/tenancy/sub-domains/membership/membership-invitation/events/membership-invitation.events.js'
    );
    const { registerMembershipInvitationNotificationHandlers } = await import(
      '@/domains/notify/sub-domains/notification/events/membership-invitation.event-handlers.js'
    );
    registerMembershipInvitationNotificationHandlers();
    emitAccepted = async (payload: unknown) => {
      await eventBus.emit({
        type: MEMBERSHIP_INVITATION_EVENT.ACCEPTED,
        payload,
        timestamp: new Date(),
      });
    };
    emitDeclined = async (payload: unknown) => {
      await eventBus.emit({
        type: MEMBERSHIP_INVITATION_EVENT.DECLINED,
        payload,
        timestamp: new Date(),
      });
    };
  }, 60_000);

  beforeEach(() => {
    createAndDispatchNotificationMock.mockReset();
    createAndDispatchNotificationMock.mockResolvedValue(dispatched([]));
    invalidateUnreadCountsMock.mockReset();
    invalidateUnreadCountsMock.mockResolvedValue(undefined);
  });

  it('sends one in-app+email notification to every manager, once per invitation', async () => {
    await emitAccepted({
      recipient_user_ids: [11, 22],
      invitation_public_id: 'inv_accepted000000000001',
      organization_id: 7,
      organization_name: 'Acme',
      invitee_name: 'Dana Scully',
      locale: 'en',
    });

    expect(createAndDispatchNotificationMock).toHaveBeenCalledExactlyOnceWith({
      input: {
        recipientUserIds: [11, 22],
        organization_id: 7,
        type: 'membership.invite_accepted',
        title: 'Invitation accepted',
        message: 'Dana Scully accepted your invitation to join Acme.',
        action_url: '/settings/members',
        channels: ['in_app', 'email'],
        locale: 'en',
        dedupe_key: 'inv_accepted000000000001',
      },
    });
  });

  it("writes the notification in the organization's language", async () => {
    await emitAccepted({
      recipient_user_ids: [11],
      invitation_public_id: 'inv_accepted000000000002',
      organization_id: 7,
      organization_name: 'Acme & Co',
      invitee_name: 'Dana Scully',
      locale: 'es',
    });

    expect(createAndDispatchNotificationMock).toHaveBeenCalledWith({
      input: expect.objectContaining({
        title: 'Invitación aceptada',
        message: 'Dana Scully aceptó tu invitación para unirse a Acme & Co.',
        locale: 'es',
      }),
    });
  });

  it('tells the inviter in the app only when an invitation is declined (D84)', async () => {
    createAndDispatchNotificationMock.mockResolvedValue(dispatched(['usr_inviter']));

    await emitDeclined({
      recipient_user_ids: [11],
      invitation_public_id: 'inv_declined000000000001',
      organization_id: 7,
      organization_name: 'Acme',
      invitee_name: 'Dana Scully',
      locale: 'en',
    });

    expect(createAndDispatchNotificationMock).toHaveBeenCalledExactlyOnceWith({
      input: expect.objectContaining({
        recipientUserIds: [11],
        type: 'membership.invite_declined',
        title: 'Invitation declined',
        message: 'Dana Scully declined your invitation to join Acme.',
        channels: ['in_app'],
        dedupe_key: 'inv_declined000000000001',
      }),
    });
    expect(invalidateUnreadCountsMock).toHaveBeenCalledWith(['usr_inviter']);
  });

  it('drops the cached unread count of each recipient that got an inbox row', async () => {
    createAndDispatchNotificationMock.mockResolvedValue(dispatched(['usr_first', 'usr_second']));

    await emitAccepted({
      recipient_user_ids: [11, 22, 33],
      invitation_public_id: 'inv_accepted000000000003',
      organization_id: 7,
      organization_name: 'Acme',
      invitee_name: 'Dana Scully',
      locale: 'en',
    });

    expect(invalidateUnreadCountsMock).toHaveBeenCalledWith(['usr_first', 'usr_second']);
  });

  it('a failed dispatch never throws out of the handler (the accept stands)', async () => {
    createAndDispatchNotificationMock.mockRejectedValue(new Error('boom'));

    await expect(
      emitAccepted({
        recipient_user_ids: [1, 2],
        invitation_public_id: 'inv_accepted000000000004',
        organization_id: 7,
        organization_name: 'Acme',
        invitee_name: 'X',
        locale: 'en',
      }),
    ).resolves.not.toThrow();
    expect(invalidateUnreadCountsMock).not.toHaveBeenCalled();
  });
});
