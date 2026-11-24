import type {
  NotificationKind,
  NotificationPreferenceChannel,
  NotificationType,
} from '@/shared/constants/notification.constants.js';

/**
 * One channel of a notification kind as the person sees it (route 135–136, UN10).
 *
 * @remarks
 * `is_enabled` is the effective value; `is_default` is `true` while the person never chose one (no
 * stored row); `is_locked` marks a channel always on (billing email) that a save cannot turn off.
 */
export interface NotificationPreferenceChannelOutput {
  channel: NotificationPreferenceChannel;
  is_enabled: boolean;
  is_default: boolean;
  is_locked: boolean;
}

/**
 * One notification kind with the types inside it and its channels (UN9, UN10).
 *
 * @remarks
 * `types` lists the notification types the kind's switch covers, so a client can tell which
 * inbox items a switch silences.
 */
export interface NotificationPreferenceKindOutput {
  kind: NotificationKind;
  types: NotificationType[];
  channels: NotificationPreferenceChannelOutput[];
}

/**
 * The Notification preferences object (routes-final § 11.C.6): the seven kinds in the screen's order.
 *
 * @remarks
 * Stored as one row per type × channel (`auth.user_notification_preferences`); this shape folds the
 * rows into kinds, so the stored form never leaks (no row id — sec-T finding #17).
 */
export interface NotificationPreferencesOutput {
  kinds: NotificationPreferenceKindOutput[];
}
