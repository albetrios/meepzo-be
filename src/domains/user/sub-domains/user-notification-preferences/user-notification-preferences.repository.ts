import { eq, sql as drizzleSql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { DEFAULT_REPOSITORY_LIST_LIMIT } from '@/shared/constants/query-limits.constants.js';
import { capListWithWarning } from '@/shared/utils/infrastructure/list-cap.util.js';
import { user_notification_preferences } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.schema.js';

/** One row {@link UserNotificationPreferencesRepository.upsertMany} writes. */
export type PreferenceRow = {
  notification_type: string;
  channel: string;
  is_enabled: boolean;
};

/**
 * Drizzle data-access for `auth.user_notification_preferences`, inside the request's RLS-bound
 * user scope so a person reads and writes only their own rows. `upsertMany` writes the rows of a
 * per-kind save (one per type of the kind, UN10) on the natural key
 * `(user_id, notification_type, channel)` — concurrent saves for one person converge, last wins.
 */
export class UserNotificationPreferencesRepository {
  async listByUserId(user_id: number) {
    // audit #36: bound this user-self-scoped read with limit+1 + capListWithWarning (the preference
    // matrix is small, but this enforces a hard ceiling and surfaces an alert if it is ever hit).
    const rows = await getRequestDatabase()
      .select()
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, user_id))
      .limit(DEFAULT_REPOSITORY_LIST_LIMIT + 1);
    return capListWithWarning({
      rows,
      limit: DEFAULT_REPOSITORY_LIST_LIMIT,
      resource: 'user.user_notification_preferences',
      context: { userId: user_id },
    });
  }

  async upsertMany(user_id: number, preferences: PreferenceRow[], acting_user_id: number) {
    if (preferences.length === 0) return;
    await getRequestDatabase()
      .insert(user_notification_preferences)
      .values(
        preferences.map((preference) => ({
          user_id,
          notification_type: preference.notification_type,
          channel: preference.channel,
          is_enabled: preference.is_enabled,
          created_by_user_id: acting_user_id,
          updated_by_user_id: acting_user_id,
        })),
      )
      .onConflictDoUpdate({
        target: [
          user_notification_preferences.user_id,
          user_notification_preferences.notification_type,
          user_notification_preferences.channel,
        ],
        set: {
          is_enabled: drizzleSql`excluded.is_enabled`,
          updated_at: drizzleSql`now()`,
          updated_by_user_id: drizzleSql`excluded.updated_by_user_id`,
        },
      });
  }
}
