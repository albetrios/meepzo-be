import { NotFoundError, UnprocessableEntityError } from '@/shared/errors/index.js';
import type { UserService } from '@/domains/user/user.service.js';
import {
  NOTIFICATION_KINDS,
  type NotificationKindDefinition,
} from '@/shared/constants/notification.constants.js';
import type {
  PreferenceRow,
  UserNotificationPreferencesRepository,
} from './user-notification-preferences.repository.js';
import { serializeNotificationPreferences } from './user-notification-preferences.serializer.js';
import type { NotificationPreferencesOutput } from './user-notification-preferences.types.js';
import type { PutNotificationPreferencesInput } from './user-notification-preferences.dto.js';
import { validatePutUserNotificationPreferences } from './user-notification-preferences.validator.js';
import {
  withAppDatabaseContext,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * The `reason` of a save that turns an always-on channel (billing email) off.
 *
 * @remarks
 * Answered with `422` by route 136 (UN10); documented in `docs/reference/api/response-codes.md`.
 */
export const NOTIFICATION_PREFERENCE_LOCKED_REASON = 'notification_preference_locked';

function requireKindDefinition(kind: string): NotificationKindDefinition {
  const definition = NOTIFICATION_KINDS.find((candidate) => candidate.kind === kind);
  // The DTO's enum already refused an unknown kind; this keeps the lookup total.
  if (definition === undefined) throw new NotFoundError('Notification kind');
  return definition;
}

/**
 * Expands a per-kind save into the stored rows — one per type of the kind (UN10, P87) — and
 * refuses turning a locked channel off. A locked channel set on writes nothing: it is always on.
 */
function expandKindItemsToRows(items: PutNotificationPreferencesInput['kinds']): PreferenceRow[] {
  const rows: PreferenceRow[] = [];
  for (const item of items) {
    const definition = requireKindDefinition(item.kind);
    if ((definition.lockedChannels as readonly string[]).includes(item.channel)) {
      if (!item.is_enabled) {
        throw new UnprocessableEntityError('errors:notificationPreferenceLocked').withReason(
          NOTIFICATION_PREFERENCE_LOCKED_REASON,
        );
      }
      continue;
    }
    for (const type of definition.types) {
      rows.push({ notification_type: type, channel: item.channel, is_enabled: item.is_enabled });
    }
  }
  return rows;
}

/**
 * Reads and saves the authenticated person's notification choices per kind × channel
 * (feat-instagram-dm-sending UN9, UN10 — routes 135–136).
 *
 * @remarks
 * - **Algorithm:** `get` reads the person's stored rows inside `withAppDatabaseContext` (user
 *   scope, so RLS limits them to the owner) and folds them into the seven kinds with their
 *   defaults. `put` validates, refuses a locked channel set off, expands each kind × channel to one
 *   row per type of the kind, and upserts them in the one transaction of the context, then answers
 *   the whole preferences object.
 * - **Failure modes:** unknown / soft-deleted user → {@link NotFoundError}; invalid body →
 *   `ValidationError` (400); billing email set off → {@link UnprocessableEntityError} with reason
 *   `notification_preference_locked` (422), and nothing is written.
 * - **Side effects:** upserts `auth.user_notification_preferences` rows; no event — the dispatch
 *   reads the rows before each send.
 * - **Notes:** only the items sent change (the screen saves each switch as it is flipped); a
 *   missing row means the kind's default.
 */
export class UserNotificationPreferencesService {
  constructor(
    private readonly userService: UserService,
    private readonly repository: UserNotificationPreferencesRepository,
  ) {}

  /**
   * Resolves the owner's internal id. MUST be called inside the caller's database context — it
   * joins that transaction rather than opening a second one just to turn a public id the request
   * already carries into the internal id (see {@link UserService.resolveInternalIdByPublicId}).
   */
  private async requireUserIdInContext(user_public_id: string): Promise<number> {
    const userId = await this.userService.resolveInternalIdByPublicId(user_public_id);
    if (userId === null) throw new NotFoundError('User');
    return userId;
  }

  async get(scope: UserPrincipalDatabaseScope): Promise<NotificationPreferencesOutput> {
    const rows = await withAppDatabaseContext({
      scope,
      callback: async () =>
        this.repository.listByUserId(await this.requireUserIdInContext(scope.userPublicId)),
    });
    return serializeNotificationPreferences(rows);
  }

  async put({
    scope,
    body,
  }: {
    scope: UserPrincipalDatabaseScope;
    body: unknown;
  }): Promise<NotificationPreferencesOutput> {
    const parsed = validatePutUserNotificationPreferences(body);
    const rowsToWrite = expandKindItemsToRows(parsed.kinds);
    const rows = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const userId = await this.requireUserIdInContext(scope.userPublicId);
        await this.repository.upsertMany(userId, rowsToWrite, userId);
        return this.repository.listByUserId(userId);
      },
    });
    return serializeNotificationPreferences(rows);
  }
}
