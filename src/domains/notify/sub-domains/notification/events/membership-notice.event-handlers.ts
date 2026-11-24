import i18next from 'i18next';
import { eventBus, runEnqueueAfterCommit, type DomainEvent } from '@/core/events/event-bus.js';
import { createAndDispatchNotification } from '@/domains/notify/sub-domains/notification/notification-dispatch.service.js';
import { invalidateCachedUnreadNotificationCounts } from '@/domains/notify/sub-domains/notification/notification-unread-count.cache.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  MEMBERSHIP_NOTICE_EVENT,
  type MembershipNoticePayload,
  type MembershipRemovedPayload,
  type MembershipRoleChangedPayload,
} from '@/domains/tenancy/sub-domains/membership/events/membership-notice.events.js';

/** FE deep link both membership notices open: the members list. */
const MEMBERSHIP_NOTICE_ACTION_URL = '/settings/members';

/**
 * Sends one membership notice (in-app + email, as the team-change kind allows) to the recipients
 * tenancy resolved, after the check before send (UN11), once per change (the payload's
 * `dedupe_key`).
 *
 * @remarks Runs synchronously inside the membership write's organization context (the event is
 * awaited there); the dispatch keeps its reads and writes in savepoints and any error is logged
 * here, so the notice never fails the write. The inbox recipients' cached unread counts are
 * dropped after the commit.
 */
async function sendMembershipNotice(options: {
  event: DomainEvent;
  payload: MembershipNoticePayload;
  type: 'membership.role_changed' | 'membership.removed';
  title: string;
  message: string;
}): Promise<void> {
  try {
    const dispatched = await createAndDispatchNotification({
      input: {
        recipientUserIds: options.payload.recipient_user_ids,
        organization_id: options.payload.organization_id,
        type: options.type,
        title: options.title,
        message: options.message,
        action_url: MEMBERSHIP_NOTICE_ACTION_URL,
        channels: ['in_app', 'email'],
        locale: options.payload.locale,
        dedupe_key: options.payload.dedupe_key,
      },
    });
    await runEnqueueAfterCommit(async () => {
      await invalidateCachedUnreadNotificationCounts(dispatched.inAppUserPublicIds);
    });
  } catch (error) {
    logger.error(
      { err: error, eventType: options.event.type },
      'notify.membership_notice.dispatch.failed',
    );
  }
}

/** Plain-text i18next options in the organization's language (the inbox and email escape it). */
function plainText(locale: string) {
  return { lng: locale, interpolation: { escapeValue: false } };
}

/** `membership.role_changed` — a live member's main role changed (UN8). */
async function onMembershipRoleChangedEvent(event: DomainEvent): Promise<void> {
  const payload = event.payload as MembershipRoleChangedPayload;
  await sendMembershipNotice({
    event,
    payload,
    type: 'membership.role_changed',
    title: i18next.t('common:notifications.membershipRoleChangedTitle', plainText(payload.locale)),
    message: i18next.t('common:notifications.membershipRoleChangedMessage', {
      ...plainText(payload.locale),
      memberName: payload.member_name,
      roleName: payload.role_name,
      previousRoleName: payload.previous_role_name,
      organizationName: payload.organization_name,
    }),
  });
}

/** `membership.removed` — a manager removed a member (UN8). */
async function onMembershipRemovedEvent(event: DomainEvent): Promise<void> {
  const payload = event.payload as MembershipRemovedPayload;
  await sendMembershipNotice({
    event,
    payload,
    type: 'membership.removed',
    title: i18next.t('common:notifications.membershipRemovedTitle', plainText(payload.locale)),
    message: i18next.t('common:notifications.membershipRemovedMessage', {
      ...plainText(payload.locale),
      memberName: payload.member_name,
      organizationName: payload.organization_name,
    }),
  });
}

let membershipNoticeHandlersRegistered = false;

/**
 * Idempotent registrar subscribing the in-process listeners for
 * {@link MEMBERSHIP_NOTICE_EVENT.ROLE_CHANGED} and `REMOVED`, so a main-role change or a removal
 * notifies the team (`membership.role_changed` / `membership.removed`, feat-instagram-dm-sending UN8).
 */
export function registerMembershipNoticeNotificationHandlers(): void {
  if (membershipNoticeHandlersRegistered) return;
  membershipNoticeHandlersRegistered = true;
  eventBus.on({
    eventType: MEMBERSHIP_NOTICE_EVENT.ROLE_CHANGED,
    handler: onMembershipRoleChangedEvent,
  });
  eventBus.on({ eventType: MEMBERSHIP_NOTICE_EVENT.REMOVED, handler: onMembershipRemovedEvent });
}
