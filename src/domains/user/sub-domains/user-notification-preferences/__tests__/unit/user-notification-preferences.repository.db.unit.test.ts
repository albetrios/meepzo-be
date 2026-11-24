import { describe, it, expect, beforeEach } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { UserNotificationPreferencesRepository } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.repository.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

describe('UserNotificationPreferencesRepository (database)', () => {
  const repository = new UserNotificationPreferencesRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  /** Runs `callback` in the person's own RLS scope, as the routes do. */
  function asUser(userPublicId: string, callback: () => Promise<unknown>) {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId }),
      callback,
    });
  }

  it('upserts on (user, type, channel): a second save of the same pair updates the row', async () => {
    const user = await createTestUser();

    await asUser(user.public_id, () =>
      repository.upsertMany(
        user.id,
        [
          { notification_type: 'broadcast.done', channel: 'EMAIL', is_enabled: true },
          { notification_type: 'automation.backfill_done', channel: 'EMAIL', is_enabled: true },
        ],
        user.id,
      ),
    );
    await asUser(user.public_id, () =>
      repository.upsertMany(
        user.id,
        [{ notification_type: 'broadcast.done', channel: 'EMAIL', is_enabled: false }],
        user.id,
      ),
    );

    const listed = (await asUser(user.public_id, () =>
      repository.listByUserId(user.id),
    )) as Awaited<ReturnType<UserNotificationPreferencesRepository['listByUserId']>>;
    expect(listed).toHaveLength(2);
    const byType = new Map(listed.map((row) => [row.notification_type, row.is_enabled]));
    expect(byType.get('broadcast.done')).toBe(false);
    expect(byType.get('automation.backfill_done')).toBe(true);
  });

  it('concurrent saves for one person all succeed on the natural key — no 23505', async () => {
    const user = await createTestUser();
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        asUser(user.public_id, () =>
          repository.upsertMany(
            user.id,
            [
              {
                notification_type: 'broadcast.done',
                channel: 'IN_APP',
                is_enabled: index % 2 === 0,
              },
              {
                notification_type: 'automation.backfill_done',
                channel: 'IN_APP',
                is_enabled: index % 2 === 0,
              },
            ],
            user.id,
          ),
        ),
      ),
    );
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(0);
    const listed = (await asUser(user.public_id, () =>
      repository.listByUserId(user.id),
    )) as unknown[];
    expect(listed).toHaveLength(2);
  });
});
