import {
  NOTIFICATION_KINDS,
  NOTIFICATION_PREFERENCE_CHANNELS,
  resolveNotificationKindChannel,
} from '@/shared/constants/notification.constants.js';
import type { NotificationPreferencesOutput } from './user-notification-preferences.types.js';

/** Minimal row projection accepted by the preference serializer (database row → API output). */
export interface UserNotificationPreferenceRow {
  notification_type: string;
  channel: string;
  is_enabled: boolean;
}

/**
 * Folds a person's stored preference rows into the seven kinds × channels (UN10).
 *
 * @remarks
 * Every kind and every channel of {@link NOTIFICATION_PREFERENCE_CHANNELS} is answered, a missing
 * row reading as the kind's default; rows of a type in no kind, or of `SMS`, are ignored. The
 * effective value follows {@link resolveNotificationKindChannel} — the rule the check before each
 * send uses too — so the screen shows exactly what the dispatch will do.
 */
export function serializeNotificationPreferences(
  rows: readonly UserNotificationPreferenceRow[],
): NotificationPreferencesOutput {
  return {
    kinds: NOTIFICATION_KINDS.map((definition) => ({
      kind: definition.kind,
      types: [...definition.types],
      channels: NOTIFICATION_PREFERENCE_CHANNELS.map((channel) => {
        const storedValues = rows
          .filter(
            (row) =>
              row.channel === channel &&
              (definition.types as readonly string[]).includes(row.notification_type),
          )
          .map((row) => row.is_enabled);
        const value = resolveNotificationKindChannel({ definition, channel, storedValues });
        return {
          channel,
          is_enabled: value.isEnabled,
          is_default: value.isDefault,
          is_locked: value.isLocked,
        };
      }),
    })),
  };
}
