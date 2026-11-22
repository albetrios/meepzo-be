import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  getPostgresConstraintName,
  getPostgresErrorCode,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import { users } from '@/domains/user/user.schema.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import type { InstagramAccountKey } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import {
  InstagramAccountSettingsRepository,
  type InstagramAccountSettingsRow,
  createWorkerInstagramAccountSettingsRepository,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import type { InstagramAccountSettingsChanges } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase, operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

/**
 * `app.instagram_account_settings` through its repository (routes-final § 1.B.3, IA12, IA15): the
 * connect's race, the row lock route 3 takes, the table's range checks, one row per account, and
 * what happens to the row when its editor or its account goes. Every statement runs inside the
 * organization's own database context, so the suite also holds under `pnpm test:rls-role`. The
 * defaults, the kept row and the composite key are in
 * `instagram-account-settings.service.db.unit.test.ts`.
 */

type TestOrganization = { id: number; public_id: string };

/** Runs `callback` inside the organization's own unit of work, as the settings service does. */
function inOrganization<T>(organization: TestOrganization, callback: () => Promise<T>): Promise<T> {
  return withAppDatabaseContext({
    scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id }),
    callback,
  });
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

/** A promise one unit of work settles and another waits for. */
function signal(): { promise: Promise<void>; send: () => void } {
  let send: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    send = resolve;
  });
  return { promise, send };
}

/** How many sessions of this database wait for another session's lock. */
async function countBlockedSessions(): Promise<number> {
  const rows = await operatorQuery<Array<{ blocked: number }>>`
    SELECT count(*)::int AS blocked FROM pg_stat_activity
    WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
  return rows[0]?.blocked ?? 0;
}

describe('InstagramAccountSettingsRepository (database)', () => {
  const repository = new InstagramAccountSettingsRepository();
  let organization: TestOrganization;
  let instagramAccount: InstagramAccountKey;

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    const account = await insertInstagramAccount({ organizationId: organization.id });
    instagramAccount = { organizationId: organization.id, instagramAccountId: account.id };
  });

  function insertDefaults(
    key: InstagramAccountKey = instagramAccount,
  ): Promise<InstagramAccountSettingsRow | null> {
    return inOrganization(organization, () => repository.insertDefaults(key));
  }

  function find(
    key: InstagramAccountKey = instagramAccount,
  ): Promise<InstagramAccountSettingsRow | null> {
    return inOrganization(organization, () => repository.findByInstagramAccount(key));
  }

  function update({
    changes,
    updatedByUserId = null,
    key = instagramAccount,
  }: {
    changes: InstagramAccountSettingsChanges;
    updatedByUserId?: number | null;
    key?: InstagramAccountKey;
  }): Promise<InstagramAccountSettingsRow | null> {
    return inOrganization(organization, () =>
      repository.update({ ...key, changes, updatedByUserId }),
    );
  }

  it('creates one row when two connects of the same account race', async () => {
    const results = await Promise.all([insertDefaults(), insertDefaults()]);

    const created = results.filter((row) => row !== null);
    expect(created).toHaveLength(1);
    await expect(find()).resolves.toMatchObject({ id: created[0]?.id });
  });

  it('a second change waits for the locked row and then reads what the first one saved (IA15)', async () => {
    await insertDefaults();
    const locked = signal();
    const release = signal();
    const firstChange = inOrganization(organization, async () => {
      await repository.findByInstagramAccountForUpdate(instagramAccount);
      locked.send();
      await release.promise;
      return repository.update({
        ...instagramAccount,
        changes: { public_reply_hour_limit: 10 },
        updatedByUserId: null,
      });
    });
    await locked.promise;
    let hasSecondRead = false;
    const secondRead = inOrganization(organization, async () => {
      const row = await repository.findByInstagramAccountForUpdate(instagramAccount);
      hasSecondRead = true;
      return row;
    });
    await vi.waitFor(async () => expect(await countBlockedSessions()).toBeGreaterThan(0), {
      timeout: 5_000,
    });

    expect(hasSecondRead).toBe(false);
    // A plain read is never held back by the lock, and still shows the saved value.
    await expect(find()).resolves.toMatchObject({ public_reply_hour_limit: 60 });

    release.send();
    await firstChange;
    await expect(secondRead).resolves.toMatchObject({ public_reply_hour_limit: 10 });
  });

  it('a change belongs to its unit of work: a failure after it keeps the saved settings', async () => {
    await insertDefaults();

    await expect(
      inOrganization(organization, async () => {
        await repository.update({
          ...instagramAccount,
          changes: { is_automation_enabled: false },
          updatedByUserId: null,
        });
        throw new Error('the rest of the save failed');
      }),
    ).rejects.toThrow('the rest of the save failed');

    await expect(find()).resolves.toMatchObject({ is_automation_enabled: true });
  });

  it('the default row belongs to its unit of work too: a connect that fails leaves none', async () => {
    await expect(
      inOrganization(organization, async () => {
        await repository.insertDefaults(instagramAccount);
        throw new Error('the rest of the connect failed');
      }),
    ).rejects.toThrow('the rest of the connect failed');

    await expect(find()).resolves.toBeNull();
  });

  it('locks and changes nothing for an account without its row', async () => {
    await expect(
      inOrganization(organization, () =>
        repository.findByInstagramAccountForUpdate(instagramAccount),
      ),
    ).resolves.toBeNull();
    await expect(update({ changes: { is_automation_enabled: false } })).resolves.toBeNull();
  });

  it('keeps one row per account: a change on one leaves the other account of the organization alone', async () => {
    const revokedAccount = await insertInstagramAccount({
      organizationId: organization.id,
      connectionStatus: 'revoked',
    });
    const revokedKey = { organizationId: organization.id, instagramAccountId: revokedAccount.id };
    await insertDefaults();
    await insertDefaults(revokedKey);

    await update({ changes: { public_reply_chance_percent: 25 }, key: revokedKey });

    await expect(find(revokedKey)).resolves.toMatchObject({ public_reply_chance_percent: 25 });
    await expect(find()).resolves.toMatchObject({ public_reply_chance_percent: 80 });
  });

  it.each([
    [
      'lowest',
      {
        public_reply_chance_percent: 0,
        public_reply_hour_limit: 1,
        public_reply_gap_min_seconds: 5,
        public_reply_gap_max_seconds: 5,
      },
    ],
    [
      'highest',
      {
        public_reply_chance_percent: 100,
        public_reply_hour_limit: 1000,
        public_reply_gap_min_seconds: 3600,
        public_reply_gap_max_seconds: 3600,
      },
    ],
  ])('takes the %s value of every range', async (_case, changes) => {
    await insertDefaults();

    await expect(update({ changes })).resolves.toMatchObject(changes);
  });

  it.each([
    ['chk_instagram_account_settings_chance', { public_reply_chance_percent: -1 }],
    ['chk_instagram_account_settings_chance', { public_reply_chance_percent: 101 }],
    ['chk_instagram_account_settings_hour_limit', { public_reply_hour_limit: 0 }],
    ['chk_instagram_account_settings_hour_limit', { public_reply_hour_limit: 1001 }],
    ['chk_instagram_account_settings_gap_min', { public_reply_gap_min_seconds: 4 }],
    ['chk_instagram_account_settings_gap_max', { public_reply_gap_max_seconds: 3601 }],
    ['chk_instagram_account_settings_gap_order', { public_reply_gap_max_seconds: 19 }],
  ])('holds %s against %o, keeping the saved row', async (constraintName, changes) => {
    await insertDefaults();

    const error = await captureError(() => update({ changes }));

    expect(getPostgresErrorCode(error)).toBe('23514');
    expect(getPostgresConstraintName(error)).toBe(constraintName);
    await expect(find()).resolves.toMatchObject({
      public_reply_chance_percent: 80,
      public_reply_hour_limit: 60,
      public_reply_gap_min_seconds: 20,
      public_reply_gap_max_seconds: 60,
    });
  });

  it('names the last editor, then none once an API key changed the settings', async () => {
    await insertDefaults();
    const editor = await createTestUser();

    const byUser = await update({
      changes: { public_reply_hour_limit: 30 },
      updatedByUserId: editor.id,
    });
    const byApiKey = await update({ changes: { public_reply_hour_limit: 31 } });

    expect(byUser?.updated_by_user_id).toBe(editor.id);
    expect(byApiKey?.updated_by_user_id).toBeNull();
  });

  it('keeps the settings when the user who changed them is deleted, without the editor (K6)', async () => {
    await insertDefaults();
    const editor = await createTestUser();
    await update({ changes: { is_automation_enabled: false }, updatedByUserId: editor.id });

    await getOperatorDatabase().delete(users).where(eq(users.id, editor.id));

    await expect(find()).resolves.toMatchObject({
      is_automation_enabled: false,
      updated_by_user_id: null,
    });
  });

  it('goes with its account', async () => {
    await insertDefaults();

    await getOperatorDatabase()
      .delete(instagram_accounts)
      .where(eq(instagram_accounts.id, instagramAccount.instagramAccountId));

    await expect(find()).resolves.toBeNull();
  });

  it("reads on a job's own handle for event processing", async () => {
    const created = await insertDefaults();

    const read = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id }),
      callback: (databaseHandle) =>
        createWorkerInstagramAccountSettingsRepository(databaseHandle).findByInstagramAccount(
          instagramAccount,
        ),
    });

    expect(read?.id).toBe(created?.id);
  });
});
