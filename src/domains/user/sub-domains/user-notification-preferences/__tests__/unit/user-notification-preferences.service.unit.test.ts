import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError, UnprocessableEntityError, ValidationError } from '@/shared/errors/index.js';
import { UserNotificationPreferencesService } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { UserNotificationPreferencesRepository } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.repository.js';
import {
  PRINCIPAL_SCOPE,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

vi.mock(
  '@/infrastructure/database/contexts/database-context-runtime.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      getOrganizationRequestDatabaseSession: vi.fn().mockReturnValue(undefined),
    };
  },
);

vi.mock('@/infrastructure/database/transaction.js', () => ({
  withAtomicWrite: vi.fn((_callback: (databaseHandle: unknown) => Promise<unknown>) =>
    _callback({}),
  ),
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Blanket maintenance passthrough: services this suite touches (directly or via
    // cross-domain imports) may enter maintenance contexts (tombstoning, admin reads) —
    // the real wrapper opens a database.transaction() and CI's unit lane has no Postgres.
    withMaintenanceDatabaseContext: vi.fn(
      async ({ scope: _scope, callback }: { scope: unknown; callback: () => Promise<unknown> }) =>
        callback(),
    ),
    withAppDatabaseContext: vi.fn(
      async ({ scope: _scope, callback }: { scope: unknown; callback: () => Promise<unknown> }) =>
        callback(),
    ),
  };
});

const user = { id: 1, public_id: 'user_public', email: 'user@example.com' };
const preferenceRow = {
  id: 2,
  notification_type: 'contact.details_left',
  channel: 'EMAIL',
  is_enabled: true,
};

const asUserScope = (userPublicId: string) =>
  PRINCIPAL_SCOPE.REQUEST({
    userPublicId,
    organizationPublicId: 'org_scope_test',
  }) as UserPrincipalDatabaseScope;

describe('UserNotificationPreferencesService', () => {
  const userService = {
    findUserRecordByPublicId: vi.fn().mockResolvedValue(user),
    // Hot read paths resolve the id inside their own context (no second transaction).
    resolveInternalIdByPublicId: vi.fn().mockResolvedValue(user.id),
  } as unknown as UserService;

  const preferencesRepository = {
    listByUserId: vi.fn().mockResolvedValue([preferenceRow]),
    upsertMany: vi.fn().mockResolvedValue(undefined),
  } as unknown as UserNotificationPreferencesRepository;

  const service = new UserNotificationPreferencesService(userService, preferencesRepository);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userService.resolveInternalIdByPublicId).mockResolvedValue(user.id);
    vi.mocked(preferencesRepository.listByUserId).mockResolvedValue([preferenceRow] as never);
  });

  it('get folds the stored rows into the seven kinds', async () => {
    const result = await service.get(asUserScope('user_public'));
    expect(result.kinds).toHaveLength(7);
    const contactDetails = result.kinds.find((entry) => entry.kind === 'contact_details_left');
    expect(contactDetails?.channels[0]).toEqual({
      channel: 'EMAIL',
      is_enabled: true,
      is_default: false,
      is_locked: false,
    });
  });

  it('get throws when user missing', async () => {
    vi.mocked(userService.resolveInternalIdByPublicId).mockResolvedValue(null);
    await expect(service.get(asUserScope('missing'))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('put throws when user missing', async () => {
    vi.mocked(userService.resolveInternalIdByPublicId).mockResolvedValue(null);
    await expect(
      service.put({
        scope: asUserScope('missing'),
        body: { kinds: [{ kind: 'weekly_summary', channel: 'EMAIL', is_enabled: true }] },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('put writes one row per type of the kind (AC-14.5, P87)', async () => {
    await service.put({
      scope: asUserScope('user_public'),
      body: { kinds: [{ kind: 'team_change', channel: 'EMAIL', is_enabled: false }] },
    });
    expect(preferencesRepository.upsertMany).toHaveBeenCalledWith(
      user.id,
      [
        'membership.invite_accepted',
        'membership.invite_declined',
        'membership.role_changed',
        'membership.removed',
      ].map((notification_type) => ({ notification_type, channel: 'EMAIL', is_enabled: false })),
      user.id,
    );
  });

  it('put refuses billing email off with 422 notification_preference_locked and writes nothing (AC-14.6)', async () => {
    const attempt = service.put({
      scope: asUserScope('user_public'),
      body: {
        kinds: [
          { kind: 'weekly_summary', channel: 'EMAIL', is_enabled: false },
          { kind: 'billing', channel: 'EMAIL', is_enabled: false },
        ],
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(UnprocessableEntityError);
    await expect(attempt).rejects.toMatchObject({ reason: 'notification_preference_locked' });
    expect(preferencesRepository.upsertMany).not.toHaveBeenCalled();
  });

  it('put accepts billing email on as a no-op (it is always on) and billing in-app off', async () => {
    await service.put({
      scope: asUserScope('user_public'),
      body: {
        kinds: [
          { kind: 'billing', channel: 'EMAIL', is_enabled: true },
          { kind: 'billing', channel: 'IN_APP', is_enabled: false },
        ],
      },
    });
    const rows = vi.mocked(preferencesRepository.upsertMany).mock.calls[0]?.[1] ?? [];
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.channel === 'IN_APP' && !row.is_enabled)).toBe(true);
  });

  it('put refuses the old per-type body before the repository is reached', async () => {
    await expect(
      service.put({
        scope: asUserScope('user_public'),
        body: {
          preferences: [
            { notification_type: 'subscription.updated', channel: 'EMAIL', is_enabled: true },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(preferencesRepository.upsertMany).not.toHaveBeenCalled();
  });
});
