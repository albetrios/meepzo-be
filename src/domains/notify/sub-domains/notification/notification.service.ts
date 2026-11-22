import { NotFoundError, UnauthorizedError } from '@/shared/errors/index.js';
import { runEnqueueAfterCommit } from '@/core/events/event-bus.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
  type OrganizationPrincipalDatabaseScope,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { withSavepoint } from '@/infrastructure/database/transaction.js';
import type { SupportedLanguage } from '@/shared/constants/i18n.constants.js';
import type { NotificationType } from '@/shared/constants/notification.constants.js';
import { PAGINATION } from '@/shared/constants/pagination.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { NotificationRepository } from './notification.repository.js';
import type { UserService } from '@/domains/user/user.service.js';
import { createAndDispatchNotification } from './notification-dispatch.service.js';
import {
  getCachedUnreadNotificationCount,
  invalidateCachedUnreadNotificationCount,
  invalidateCachedUnreadNotificationCounts,
  setCachedUnreadNotificationCount,
} from './notification-unread-count.cache.js';

/**
 * One notification an organization's members are sent by
 * {@link NotificationService.createOrganizationNotifications} — already in the organization's
 * language.
 *
 * @remarks
 * - **Algorithm:** stored as each recipient's row; `channels` and `locale` ride in `data`, where
 *   the notification worker reads them (in-app is the row itself; `email` goes through the mail
 *   outbox in `locale`).
 * - **Failure modes:** none — a value shape.
 * - **Side effects:** none.
 * - **Notes:** `title` and `message` are plain text; the inbox and the email escape them.
 */
export interface OrganizationNotificationContent {
  type: NotificationType;
  title: string;
  message: string;
  /** Where the notification links; an absolute `http(s)` URL also becomes the email's button. */
  actionUrl: string;
  channels: readonly ('in_app' | 'email')[];
  locale: SupportedLanguage;
}

/**
 * What {@link NotificationService.createOrganizationNotifications} did.
 *
 * @remarks
 * - **Algorithm:** `createdCount` rows were written; `deduplicated` is `true` when an earlier call
 *   with the same key had already sent them, and nothing was written.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** a recipient whose row failed is logged and counted in `failedCount`.
 */
export interface OrganizationNotificationsResult {
  createdCount: number;
  failedCount: number;
  deduplicated: boolean;
}

/**
 * Options forwarded from controllers/event handlers into {@link NotificationService.listForUser}.
 *
 * @remarks
 * - **Algorithm:** consumed verbatim by the repository keyset-pagination layer.
 * - **Failure modes:** invalid `after` cursors raise inside the repository.
 * - **Side effects:** none (read-only).
 * - **Notes:** `include_total` is opt-in because the inbox stays keyset-only by default.
 */
export interface NotificationListServiceOptions {
  after?: string;
  limit?: number;
  include_total?: boolean;
}

/**
 * The owning user's in-app notification inbox: list, read state, unread count and delete.
 *
 * @remarks
 * - **Algorithm:** controller-facing methods take the token-minted
 *   {@link UserPrincipalDatabaseScope}, resolve the user public id to an internal id via
 *   {@link UserService}, then run the repository call inside `withAppDatabaseContext` so
 *   Postgres RLS sees the correct identity GUCs; the data-export path
 *   (`listForUserDataExport`, a worker caller) stays on `withAppDatabaseContext (user scope)`.
 *   Creating and dispatching a notification is `createAndDispatchNotification`
 *   (`notification-dispatch.service.ts`); another domain notifies an organization's members
 *   through {@link NotificationService.createOrganizationNotifications}, which wraps it.
 * - **Failure modes:** `UnauthorizedError` for unknown user public ids; repository errors
 *   propagate.
 * - **Side effects:** Postgres reads/writes against `notify.notifications` (mark-read,
 *   mark-all-read, delete).
 * - **Notes:** `listForUser` takes a {@link NotificationListServiceOptions} object.
 */
export class NotificationService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly userService: UserService,
  ) {}

  /**
   * Resolves the caller's internal id from **inside** the caller's database context.
   *
   * @remarks
   * Every method here needs `user.id` to scope its query, and each used to fetch the whole user
   * row through `UserService.findUserRecordByPublicId` BEFORE opening its own context. That opened
   * a second transaction and held a second pooled checkout for a value the request already had the
   * public id for: `GET /notify/notifications/unread-count` spent eight round trips and two
   * checkouts to return one integer. Called inside the context, this joins the transaction that is
   * already open — the same reuse `AuthMeContextService.getContext` documents. The DB pool is what
   * runs out first under load, so halving the checkouts per request is the point.
   */
  private async resolveUserIdInContext(user_public_id: string): Promise<number> {
    const userId = await this.userService.resolveInternalIdByPublicId(user_public_id);
    if (userId === null) throw new UnauthorizedError();
    return userId;
  }

  /**
   * List notifications for a user using keyset pagination. Takes a
   * {@link NotificationListServiceOptions} object so HTTP controllers can pass parsed
   * pagination input forward unchanged.
   */
  async listForUser({
    scope,
    options = {},
  }: {
    scope: UserPrincipalDatabaseScope;
    options?: NotificationListServiceOptions | undefined;
  }) {
    const limit = options.limit ?? PAGINATION.DEFAULT_LIMIT;
    return withAppDatabaseContext({
      scope,
      callback: async () =>
        this.repository.findByUser(
          await this.resolveUserIdInContext(scope.userPublicId),
          omitUndefined({
            after: options.after,
            limit,
            include_total: options.include_total,
          }),
        ),
    });
  }

  /** Lists notification metadata for a GDPR data-export bundle (capped by caller). */
  async listForUserDataExport(options: { userPublicId: string; limit: number }) {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: options.userPublicId }),
      callback: async () =>
        this.repository.listForUserDataExport(
          await this.resolveUserIdInContext(options.userPublicId),
          options.limit,
        ),
    });
  }

  async get({ public_id, scope }: { public_id: string; scope: UserPrincipalDatabaseScope }) {
    return withAppDatabaseContext({
      scope,
      callback: async () =>
        this.repository.findByPublicIdForUser(
          public_id,
          await this.resolveUserIdInContext(scope.userPublicId),
        ),
    });
  }

  async markRead({ public_id, scope }: { public_id: string; scope: UserPrincipalDatabaseScope }) {
    const result = await withAppDatabaseContext({
      scope,
      callback: async () =>
        this.repository.markRead(public_id, await this.resolveUserIdInContext(scope.userPublicId)),
    });
    // After the commit: invalidating first would let a concurrent read repopulate the pre-write
    // count, which is the race the tombstone exists to close.
    await invalidateCachedUnreadNotificationCount(scope.userPublicId);
    return result;
  }

  async markAllRead(scope: UserPrincipalDatabaseScope) {
    const result = await withAppDatabaseContext({
      scope,
      callback: async () =>
        this.repository.markAllReadForUser(await this.resolveUserIdInContext(scope.userPublicId)),
    });
    await invalidateCachedUnreadNotificationCount(scope.userPublicId);
    return result;
  }

  /**
   * The unread badge — polled by every open tab, and the reason this cache exists.
   *
   * @remarks
   * - **Algorithm:** Redis first; on a miss, count in Postgres and populate. The cache is read
   *   only here, after the route's `authenticate` has produced the scope, because Redis sits
   *   outside RLS — reading it earlier would hand one user another's count.
   * - **Failure modes:** a Redis outage reads as a miss and the count comes from Postgres.
   * - **Side effects:** one Redis read, and a write on a miss.
   * - **Notes:** a hit skips the whole database round trip, which for this route was the entire
   *   request: a transaction, a `set_config`, an id resolve and a `COUNT`, to return one integer.
   */
  async getUnreadCount(scope: UserPrincipalDatabaseScope) {
    const cached = await getCachedUnreadNotificationCount(scope.userPublicId);
    if (cached !== null) return cached;

    const count = await withAppDatabaseContext({
      scope,
      callback: async () =>
        this.repository.countUnreadForUser(await this.resolveUserIdInContext(scope.userPublicId)),
    });
    await setCachedUnreadNotificationCount({ userPublicId: scope.userPublicId, count });
    return count;
  }

  async deleteNotification({
    public_id,
    scope,
  }: {
    public_id: string;
    scope: UserPrincipalDatabaseScope;
  }) {
    const result = await withAppDatabaseContext({
      scope,
      callback: async () =>
        this.repository.deleteByPublicIdForUser(
          public_id,
          await this.resolveUserIdInContext(scope.userPublicId),
        ),
    });
    // Only when a row actually went. A miss here is a 404, and tombstoning on one would let a
    // caller cold-start their own cache at will by deleting ids that do not exist. Deleting an
    // already-READ notification does not change the count either, but the row's read state is not
    // in hand at this point and that redundant invalidation costs one Postgres count at worst.
    if (result) await invalidateCachedUnreadNotificationCount(scope.userPublicId);
    return result;
  }

  /**
   * Sends one notification to each of the organization's recipients — once per `dedupeKey` — and
   * queues each for dispatch (in-app, email) after the commit. The cross-domain SERVICE entry point
   * other domains' background work uses to notify an organization's members (the app domain's
   * reconnect notice, launch IA9), in the API and the worker process alike.
   *
   * @remarks
   * - **Algorithm:** one unit of work in the caller's organization scope (joining the caller's open
   *   unit for the same organization): resolve the organization; when a notification of this type
   *   already carries `dedupeKey` in the organization, stop; else, per recipient in its own
   *   savepoint, `createAndDispatchNotification` (the row with `data.channels`, `data.locale` and
   *   `data.dedupe_key`; its dispatch job enqueued after the commit). The recipients' public ids are
   *   resolved in the same unit, and their cached unread counts are dropped after the commit.
   * - **Failure modes:** `NotFoundError('Organization')` when the scope's organization does not
   *   resolve. One recipient's failed row is logged (`notify.organization_notification.failed`) and
   *   skipped; when every recipient failed, the first error is rethrown, so a retry sends them all.
   *   The cache invalidation is best-effort.
   * - **Side effects:** `notify.notifications` rows; one `notification` job per row after the
   *   commit; one unread-count tombstone per recipient after the commit.
   * - **Notes:** the worker process builds this container too (`createDomainContainers`), so the
   *   dispatch `createAndDispatchNotification` relies on is configured there as in the API. The
   *   once-only check makes a re-run of the caller's job — a stalled job run again after its commit
   *   — send nothing twice; recipients are internal user ids resolved by the caller through the
   *   membership service.
   */
  async createOrganizationNotifications({
    scope,
    recipientUserIds,
    notification,
    dedupeKey,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    recipientUserIds: readonly number[];
    notification: OrganizationNotificationContent;
    dedupeKey: string;
  }): Promise<OrganizationNotificationsResult> {
    const outcome = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organizationId = await this.repository.findOrganizationIdByPublicId(
          scope.organizationPublicId,
        );
        if (organizationId === null) throw new NotFoundError('Organization');
        const alreadySent = await this.repository.existsOrganizationNotificationWithDedupeKey({
          organization_id: organizationId,
          type: notification.type,
          dedupe_key: dedupeKey,
        });
        if (alreadySent) return { createdUserIds: [], failedCount: 0, deduplicated: true };

        const createdUserIds: number[] = [];
        let firstError: unknown;
        for (const recipientUserId of recipientUserIds) {
          try {
            // A savepoint per recipient: a failed INSERT would otherwise abort the whole unit.
            await withSavepoint(() =>
              createAndDispatchNotification({
                input: {
                  user_id: recipientUserId,
                  organization_id: organizationId,
                  type: notification.type,
                  title: notification.title,
                  message: notification.message,
                  action_url: notification.actionUrl,
                  data: {
                    channels: [...notification.channels],
                    locale: notification.locale,
                    dedupe_key: dedupeKey,
                  },
                },
              }),
            );
            createdUserIds.push(recipientUserId);
          } catch (error) {
            firstError ??= error;
            logger.error(
              {
                err: error,
                recipientUserId,
                notificationType: notification.type,
                organizationPublicId: scope.organizationPublicId,
              },
              'notify.organization_notification.failed',
            );
          }
        }
        if (createdUserIds.length === 0 && firstError !== undefined) throw firstError;
        await this.invalidateUnreadCountsAfterCommit(createdUserIds);
        return {
          createdUserIds,
          failedCount: recipientUserIds.length - createdUserIds.length,
          deduplicated: false,
        };
      },
    });
    return {
      createdCount: outcome.createdUserIds.length,
      failedCount: outcome.failedCount,
      deduplicated: outcome.deduplicated,
    };
  }

  /**
   * Resolves the recipients' public ids inside the open unit (no handle after the commit) and drops
   * their cached unread counts once it commits — best-effort, never failing the notifications.
   */
  private async invalidateUnreadCountsAfterCommit(
    recipientUserIds: readonly number[],
  ): Promise<void> {
    if (recipientUserIds.length === 0) return;
    try {
      const recipientPublicIds = await withSavepoint(() =>
        this.repository.resolveUserPublicIdsByInternalIds(recipientUserIds),
      );
      await runEnqueueAfterCommit(async () => {
        await invalidateCachedUnreadNotificationCounts(recipientPublicIds);
      });
    } catch (error) {
      logger.warn(
        { err: error },
        'notify.organization_notification.unread_cache_invalidate.failed',
      );
    }
  }
}
