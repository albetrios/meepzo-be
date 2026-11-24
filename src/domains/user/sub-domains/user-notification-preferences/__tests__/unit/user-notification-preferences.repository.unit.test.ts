import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserNotificationPreferencesRepository } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.repository.js';

function createMockDatabase() {
  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const mockValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  // audit #36: listByUserId chains `.where().limit()` (limit+1 + capListWithWarning).
  const mockLimit = vi.fn().mockResolvedValue([]);
  const mockWhereSelect = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhereSelect });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  return {
    select: mockSelect,
    insert: mockInsert,
    mockOnConflictDoUpdate,
    mockValues,
    mockLimit,
    mockInsert,
    mockSelect,
  };
}

const mockDatabase = createMockDatabase();

vi.mock(
  '@/infrastructure/database/contexts/database-context-runtime.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      getRequestDatabase: () => mockDatabase,
    };
  },
);

describe('UserNotificationPreferencesRepository', () => {
  const repository = new UserNotificationPreferencesRepository();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDatabase.mockLimit.mockResolvedValue([]);
  });

  it('listByUserId queries preferences for user', async () => {
    mockDatabase.mockLimit.mockResolvedValueOnce([{ id: 1, notification_type: 'broadcast.done' }]);
    const rows = await repository.listByUserId(10);
    expect(rows).toHaveLength(1);
    expect(mockDatabase.mockSelect).toHaveBeenCalled();
  });

  it('upsertMany inserts every row with the actor and updates on the natural key', async () => {
    await repository.upsertMany(
      10,
      [{ notification_type: 'broadcast.done', channel: 'EMAIL', is_enabled: true }],
      10,
    );
    expect(mockDatabase.mockValues).toHaveBeenCalledWith([
      expect.objectContaining({
        user_id: 10,
        notification_type: 'broadcast.done',
        channel: 'EMAIL',
        is_enabled: true,
        updated_by_user_id: 10,
      }),
    ]);
    expect(mockDatabase.mockOnConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it('upsertMany writes nothing for an empty list', async () => {
    await repository.upsertMany(10, [], 10);
    expect(mockDatabase.mockInsert).not.toHaveBeenCalled();
  });
});
