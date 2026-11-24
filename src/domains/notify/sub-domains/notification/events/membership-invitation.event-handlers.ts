import { eventBus, runEnqueueAfterCommit, type DomainEvent } from '@/core/events/event-bus.js';
import i18next from 'i18next';
import { invalidateCachedUnreadNotificationCounts } from '@/domains/notify/sub-domains/notification/notification-unread-count.cache.js';
import {
  createAndDispatchNotification,
  type NotificationDeliveryChannel,
} from '@/domains/notify/sub-domains/notification/notification-dispatch.service.js';
import type { SupportedLanguage } from '@/shared/constants/i18n.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  MEMBERSHIP_INVITATION_EVENT,
  type MembershipInvitationAcceptedPayload,
  type MembershipInvitationDeclinedPayload,
} from '@/domains/tenancy/sub-domains/membership/membership-invitation/events/membership-invitation.events.js';

/** FE deep link both invitation notifications open: the members list. */
const INVITATION_NOTIFICATION_ACTION_URL = '/settings/members';

/** One invitation notification: its type (from the #964 vocabulary), copy, language and channels. */
interface InvitationNotification {
  type: 'membership.invite_accepted' | 'membership.invite_declined';
  title: string;
  message: string;
  /** The organization's language — the copy's, and the email's around it (`data.locale`). */
  locale: SupportedLanguage;
  channels: readonly NotificationDeliveryChannel[];
}

/**
 * The notification's title and message in the organization's language: plain text (the inbox and
 * the email escape it where it lands in HTML).
 */
function translateInvitationNotification(options: {
  titleKey: string;
  messageKey: string;
  payload: { locale: SupportedLanguage; invitee_name: string; organization_name: string };
}): { title: string; message: string } {
  const plainText = { lng: options.payload.locale, interpolation: { escapeValue: false } };
  return {
    title: i18next.t(options.titleKey, plainText),
    message: i18next.t(options.messageKey, {
      ...plainText,
      inviteeName: options.payload.invitee_name,
      organizationName: options.payload.organization_name,
    }),
  };
}

/**
 * Sends one invitation notification to the recipients the tenancy path resolved, after the check
 * before send (UN11), once per invitation (`dedupe_key` = the invitation's public id).
 *
 * @remarks Runs synchronously inside the tenancy write's `withAppDatabaseContext` (the event is
 * awaited there), so each insert sees the organization GUC and satisfies the notification
 * write-RLS. `requestId` is intentionally omitted so the commit-dispatch uses the in-memory
 * `onCommit` path — no Redis write inside the caller's RLS-context transaction. The dispatch keeps
 * its reads and each recipient's writes in savepoints, and any error is logged here, so the
 * notification never fails the accept or decline. The recipients that got an inbox row have their
 * cached unread count dropped after the commit.
 */
async function sendInvitationNotification(options: {
  event: DomainEvent;
  recipientUserIds: readonly number[];
  organizationId: number;
  invitationPublicId: string;
  notification: InvitationNotification;
}): Promise<void> {
  try {
    const dispatched = await createAndDispatchNotification({
      input: {
        recipientUserIds: options.recipientUserIds,
        organization_id: options.organizationId,
        type: options.notification.type,
        title: options.notification.title,
        message: options.notification.message,
        action_url: INVITATION_NOTIFICATION_ACTION_URL,
        channels: options.notification.channels,
        locale: options.notification.locale,
        dedupe_key: options.invitationPublicId,
      },
    });
    await runEnqueueAfterCommit(async () => {
      await invalidateCachedUnreadNotificationCounts(dispatched.inAppUserPublicIds);
    });
  } catch (error) {
    logger.error(
      { err: error, eventType: options.event.type },
      'notify.membership_invitation.dispatch.failed',
    );
  }
}

/**
 * A `membership.invite_accepted` notification (in-app + email) to each organization
 * `membership:create` holder resolved by the tenancy accept path.
 */
async function onMembershipInvitationAcceptedEvent(event: DomainEvent): Promise<void> {
  const payload = event.payload as MembershipInvitationAcceptedPayload;
  await sendInvitationNotification({
    event,
    recipientUserIds: payload.recipient_user_ids,
    organizationId: payload.organization_id,
    invitationPublicId: payload.invitation_public_id,
    notification: {
      type: 'membership.invite_accepted',
      ...translateInvitationNotification({
        titleKey: 'common:notifications.invitationAcceptedTitle',
        messageKey: 'common:notifications.invitationAcceptedMessage',
        payload,
      }),
      locale: payload.locale,
      // An inbox item + an email to the manager.
      channels: ['in_app', 'email'],
    },
  });
}

/**
 * A `membership.invite_declined` notification, in the app only (launch D84 (3)), to the inviter —
 * or the `membership:create` holders when the inviter is gone — as the tenancy decline path
 * resolved them.
 */
async function onMembershipInvitationDeclinedEvent(event: DomainEvent): Promise<void> {
  const payload = event.payload as MembershipInvitationDeclinedPayload;
  await sendInvitationNotification({
    event,
    recipientUserIds: payload.recipient_user_ids,
    organizationId: payload.organization_id,
    invitationPublicId: payload.invitation_public_id,
    notification: {
      type: 'membership.invite_declined',
      ...translateInvitationNotification({
        titleKey: 'common:notifications.invitationDeclinedTitle',
        messageKey: 'common:notifications.invitationDeclinedMessage',
        payload,
      }),
      locale: payload.locale,
      channels: ['in_app'],
    },
  });
}

let membershipInvitationHandlersRegistered = false;

/**
 * Idempotent registrar subscribing the in-process listeners for
 * {@link MEMBERSHIP_INVITATION_EVENT.ACCEPTED} and `DECLINED`, so an accepted or declined
 * invitation fans out its notification (`membership.invite_accepted` / `membership.invite_declined`).
 */
export function registerMembershipInvitationNotificationHandlers(): void {
  if (membershipInvitationHandlersRegistered) return;
  membershipInvitationHandlersRegistered = true;
  eventBus.on({
    eventType: MEMBERSHIP_INVITATION_EVENT.ACCEPTED,
    handler: onMembershipInvitationAcceptedEvent,
  });
  eventBus.on({
    eventType: MEMBERSHIP_INVITATION_EVENT.DECLINED,
    handler: onMembershipInvitationDeclinedEvent,
  });
}
