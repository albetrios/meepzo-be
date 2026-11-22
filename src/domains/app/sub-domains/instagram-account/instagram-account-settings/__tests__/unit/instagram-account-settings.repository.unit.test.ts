import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkerDatabaseContextError,
  runWithWorkerDatabaseContext,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  InstagramAccountSettingsRepository,
  createWorkerInstagramAccountSettingsRepository,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { instagram_account_settings } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.schema.js';

/**
 * The statements the settings repository builds (routes-final § 1.B.3), read off a recording Drizzle
 * handle — no Postgres: every one names both keys, the connect insert leaves the values to the
 * column defaults, the locked read locks, and the change sets only what it was given. What they do
 * to a row is in `instagram-account-settings.repository.db.unit.test.ts`.
 */

const key = { organizationId: 7, instagramAccountId: 3 };

/** One statement as it reached the driver. */
interface RecordedStatement {
  text: string;
  parameters: unknown[];
}

/** A Drizzle handle that records each statement and answers the rows queued for it. */
function recordingDatabase() {
  const statements: RecordedStatement[] = [];
  const answers: unknown[][][] = [];
  const handle = drizzle(async (text, parameters) => {
    statements.push({ text, parameters });
    return { rows: answers.shift() ?? [] };
  });
  return {
    handle: handle as unknown as WorkerDatabaseHandle,
    statements,
    /** Queues one settings row as the next statement's answer. */
    answerRow(overrides: Record<string, unknown> = {}) {
      const row: Record<string, unknown> = {
        id: 91,
        organization_id: key.organizationId,
        instagram_account_id: key.instagramAccountId,
        is_automation_enabled: true,
        is_public_reply_safety_enabled: false,
        public_reply_chance_percent: 80,
        public_reply_hour_limit: 60,
        public_reply_gap_min_seconds: 20,
        public_reply_gap_max_seconds: 60,
        updated_by_user_id: null,
        created_at: '2026-11-21 08:00:00+00',
        updated_at: '2026-11-21 08:30:00+00',
        ...overrides,
      };
      const columnNames = Object.keys(getTableColumns(instagram_account_settings));
      answers.push([columnNames.map((columnName) => row[columnName])]);
    },
  };
}

describe('InstagramAccountSettingsRepository', () => {
  let recording: ReturnType<typeof recordingDatabase>;
  let repository: InstagramAccountSettingsRepository;

  beforeEach(() => {
    recording = recordingDatabase();
    repository = new InstagramAccountSettingsRepository(recording.handle);
  });

  /** The one statement the call under test made. */
  function onlyStatement(): RecordedStatement {
    expect(recording.statements).toHaveLength(1);
    return recording.statements[0] as RecordedStatement;
  }

  const keyCondition = (first: number): string =>
    `("app"."instagram_account_settings"."organization_id" = $${first} and ` +
    `"app"."instagram_account_settings"."instagram_account_id" = $${first + 1})`;

  describe('findByInstagramAccount', () => {
    it('reads one row by the organization and the account, without a lock', async () => {
      recording.answerRow();

      const row = await repository.findByInstagramAccount(key);

      expect(row).toMatchObject({
        id: 91,
        is_automation_enabled: true,
        public_reply_chance_percent: 80,
        updated_at: new Date('2026-11-21T08:30:00.000Z'),
      });
      const { text, parameters } = onlyStatement();
      expect(text).toContain(`where ${keyCondition(1)} limit $3`);
      expect(text).not.toContain('for update');
      expect(parameters).toEqual([key.organizationId, key.instagramAccountId, 1]);
    });

    it('answers null when the account has no row', async () => {
      await expect(repository.findByInstagramAccount(key)).resolves.toBeNull();
    });
  });

  describe('findByInstagramAccountForUpdate', () => {
    it('reads the same row and locks it', async () => {
      recording.answerRow({ public_reply_gap_min_seconds: 5 });

      const row = await repository.findByInstagramAccountForUpdate(key);

      expect(row?.public_reply_gap_min_seconds).toBe(5);
      const { text, parameters } = onlyStatement();
      expect(text).toContain(`where ${keyCondition(1)} limit $3 for update`);
      expect(parameters).toEqual([key.organizationId, key.instagramAccountId, 1]);
    });

    it('answers null when the account has no row', async () => {
      await expect(repository.findByInstagramAccountForUpdate(key)).resolves.toBeNull();
    });
  });

  describe('insertDefaults', () => {
    it('inserts the two keys only, leaving every setting to its column default', async () => {
      recording.answerRow();

      const row = await repository.insertDefaults(key);

      expect(row?.id).toBe(91);
      const { text, parameters } = onlyStatement();
      expect(text).toMatch(/^insert into "app"\."instagram_account_settings"/);
      expect(parameters).toEqual([key.organizationId, key.instagramAccountId]);
      expect(text).toContain(
        'on conflict ("organization_id","instagram_account_id") do nothing returning',
      );
    });

    it('answers null when the account already had its row', async () => {
      await expect(repository.insertDefaults(key)).resolves.toBeNull();
    });
  });

  describe('update', () => {
    it('sets only the settings sent, the editor and the database clock, on this account only', async () => {
      recording.answerRow({ is_automation_enabled: false, updated_by_user_id: 12 });

      const row = await repository.update({
        ...key,
        changes: { is_automation_enabled: false, public_reply_gap_max_seconds: 90 },
        updatedByUserId: 12,
      });

      expect(row).toMatchObject({ is_automation_enabled: false, updated_by_user_id: 12 });
      const { text, parameters } = onlyStatement();
      expect(text).toMatch(
        /^update "app"\."instagram_account_settings" set "is_automation_enabled" = \$1, "public_reply_gap_max_seconds" = \$2, "updated_by_user_id" = \$3, "updated_at" = greatest\("app"\."instagram_account_settings"\."created_at", now\(\)\) where /,
      );
      expect(text).toContain(`where ${keyCondition(4)} returning`);
      expect(parameters).toEqual([false, 90, 12, key.organizationId, key.instagramAccountId]);
    });

    it('leaves out a setting the body did not send', async () => {
      await repository.update({
        ...key,
        changes: { public_reply_hour_limit: 10, is_public_reply_safety_enabled: undefined },
        updatedByUserId: 12,
      });

      const setClause = onlyStatement().text.split(' where ')[0];
      expect(setClause).toContain('"public_reply_hour_limit" = $1');
      expect(setClause).not.toContain('is_public_reply_safety_enabled');
    });

    it('clears the editor for an API key', async () => {
      await repository.update({
        ...key,
        changes: { public_reply_chance_percent: 0 },
        updatedByUserId: null,
      });

      const { text, parameters } = onlyStatement();
      expect(text).toContain('"updated_by_user_id" = $2');
      expect(parameters.slice(0, 2)).toEqual([0, null]);
    });

    it('answers null when the account has no row', async () => {
      await expect(
        repository.update({
          ...key,
          changes: { is_automation_enabled: true },
          updatedByUserId: null,
        }),
      ).resolves.toBeNull();
    });
  });
});

describe('createWorkerInstagramAccountSettingsRepository', () => {
  beforeEach(() => {
    vi.stubEnv('MEEPZO_BE_RUNTIME', 'worker');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads on the job's own handle inside an organization context", async () => {
    const recording = recordingDatabase();

    await runWithWorkerDatabaseContext({
      context: { kind: 'organization', organizationPublicId: 'org_a1b2c3d4e5f6g7h8i9j0k' },
      callback: () =>
        createWorkerInstagramAccountSettingsRepository(recording.handle).findByInstagramAccount(
          key,
        ),
    });

    expect(recording.statements).toHaveLength(1);
  });

  it('refuses a worker without a context, and one in another kind of context', async () => {
    const { handle } = recordingDatabase();

    expect(() => createWorkerInstagramAccountSettingsRepository(handle)).toThrow(
      WorkerDatabaseContextError,
    );
    await expect(
      runWithWorkerDatabaseContext({
        context: { kind: 'global_retention_cleanup' },
        callback: async () => createWorkerInstagramAccountSettingsRepository(handle),
      }),
    ).rejects.toBeInstanceOf(WorkerDatabaseContextError);
  });
});
