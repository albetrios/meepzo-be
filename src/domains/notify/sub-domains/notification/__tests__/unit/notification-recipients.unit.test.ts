import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureNotificationRecipients,
  resolveNotificationRecipients,
  type NotificationRecipientsMembershipPort,
} from '@/domains/notify/sub-domains/notification/notification-dispatch.service.js';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_RECIPIENTS_RULE,
} from '@/shared/constants/notification.constants.js';

/**
 * feat-instagram-dm-sending UN2 (ROUTE R34, UNC2): who a kind's notifications go to is decided by
 * permission codes — one test per rule.
 */
describe('resolveNotificationRecipients (UN2)', () => {
  const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: 'org_aaaaaaaaaaaaaaaaaaaaa' });
  const holdersByCode: Record<string, number[]> = {
    'automation:update': [1, 2, 3],
    'membership:update': [1, 2],
    'subscription:manage': [1, 2],
  };
  let membership: {
    findActiveUserIdsWithPermission: ReturnType<typeof vi.fn>;
    findActiveUserIds: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    membership = {
      findActiveUserIdsWithPermission: vi.fn(
        async ({ permissionCode }: { permissionCode: string }) =>
          holdersByCode[permissionCode] ?? [],
      ),
      findActiveUserIds: vi.fn(async () => [1, 2, 3, 4]),
    };
    configureNotificationRecipients(membership as unknown as NotificationRecipientsMembershipPort);
  });

  it('automation_editors → the automation:update holders (Owner, Admin, Editor)', async () => {
    await expect(
      resolveNotificationRecipients({
        scope,
        rule: NOTIFICATION_RECIPIENTS_RULE.AUTOMATION_EDITORS,
      }),
    ).resolves.toEqual([1, 2, 3]);
    expect(membership.findActiveUserIdsWithPermission).toHaveBeenCalledWith({
      scope,
      permissionCode: 'automation:update',
    });
  });

  it('billing_managers → the subscription:manage holders (Owner, Admin)', async () => {
    await expect(
      resolveNotificationRecipients({ scope, rule: NOTIFICATION_RECIPIENTS_RULE.BILLING_MANAGERS }),
    ).resolves.toEqual([1, 2]);
    expect(membership.findActiveUserIdsWithPermission).toHaveBeenCalledWith({
      scope,
      permissionCode: 'subscription:manage',
    });
  });

  it('membership_managers_and_member → the membership:update holders plus the member it is about', async () => {
    await expect(
      resolveNotificationRecipients({
        scope,
        rule: NOTIFICATION_RECIPIENTS_RULE.MEMBERSHIP_MANAGERS_AND_MEMBER,
        subjectUserId: 9,
      }),
    ).resolves.toEqual([1, 2, 9]);
    // A manager who is also the subject is listed once.
    await expect(
      resolveNotificationRecipients({
        scope,
        rule: NOTIFICATION_RECIPIENTS_RULE.MEMBERSHIP_MANAGERS_AND_MEMBER,
        subjectUserId: 2,
      }),
    ).resolves.toEqual([1, 2]);
  });

  it('starter_and_billing_managers → who started it plus the subscription:manage holders', async () => {
    await expect(
      resolveNotificationRecipients({
        scope,
        rule: NOTIFICATION_RECIPIENTS_RULE.STARTER_AND_BILLING_MANAGERS,
        subjectUserId: 3,
      }),
    ).resolves.toEqual([1, 2, 3]);
    // No starter known (gone): the billing holders alone.
    await expect(
      resolveNotificationRecipients({
        scope,
        rule: NOTIFICATION_RECIPIENTS_RULE.STARTER_AND_BILLING_MANAGERS,
        subjectUserId: null,
      }),
    ).resolves.toEqual([1, 2]);
  });

  it('every_member → every active member, and a subject is never added', async () => {
    await expect(
      resolveNotificationRecipients({
        scope,
        rule: NOTIFICATION_RECIPIENTS_RULE.EVERY_MEMBER,
        subjectUserId: 9,
      }),
    ).resolves.toEqual([1, 2, 3, 4]);
    expect(membership.findActiveUserIdsWithPermission).not.toHaveBeenCalled();
  });

  it('a rule without a subject ignores one (automation_editors)', async () => {
    await expect(
      resolveNotificationRecipients({
        scope,
        rule: NOTIFICATION_RECIPIENTS_RULE.AUTOMATION_EDITORS,
        subjectUserId: 9,
      }),
    ).resolves.toEqual([1, 2, 3]);
  });

  it('answers every kind of NOTIFICATION_KINDS', async () => {
    for (const definition of NOTIFICATION_KINDS) {
      const recipients = await resolveNotificationRecipients({
        scope,
        rule: definition.recipientsRule,
      });
      expect(recipients.length, definition.kind).toBeGreaterThan(0);
    }
  });
});
