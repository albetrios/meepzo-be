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
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
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
 * `app.instagram_account_settings` through its repository (feat-instagram-dm-sending routes-final
 * § 2.B.3, IA12, IA13): the pick's race, the row lock route 12 takes, the table's checks, one row
 * per channel account, and what happens to the row when its editor or its account goes. Every statement runs inside the
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

/** The channel account key of an Instagram account fixture (the settings' key since R7, P47). */
async function channelAccountKeyOf({
  organizationId,
  instagramAccountId,
}: {
  organizationId: number;
  instagramAccountId: number;
}): Promise<ChannelAccountKey> {
  const [row] = await getOperatorDatabase()
    .select({ channelAccountId: instagram_accounts.channel_account_id })
    .from(instagram_accounts)
    .where(eq(instagram_accounts.id, instagramAccountId));
  if (row === undefined) throw new Error('no Instagram account fixture');
  return { organizationId, channelAccountId: row.channelAccountId };
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
  let channelAccount: ChannelAccountKey;

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    const account = await insertInstagramAccount({ organizationId: organization.id });
    channelAccount = await channelAccountKeyOf({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
  });

  function insertDefaults(
    key: ChannelAccountKey = channelAccount,
  ): Promise<InstagramAccountSettingsRow | null> {
    return inOrganization(organization, () => repository.insertDefaults(key));
  }

  function find(
    key: ChannelAccountKey = channelAccount,
  ): Promise<InstagramAccountSettingsRow | null> {
    return inOrganization(organization, () => repository.findByChannelAccount(key));
  }

  function update({
    changes,
    updatedByUserId = null,
    key = channelAccount,
  }: {
    changes: InstagramAccountSettingsChanges;
    updatedByUserId?: number | null;
    key?: ChannelAccountKey;
  }): Promise<InstagramAccountSettingsRow | null> {
    return inOrganization(organization, () =>
      repository.update({ ...key, changes, updatedByUserId }),
    );
  }

  it('creates one row when two picks of the same account race', async () => {
    const results = await Promise.all([insertDefaults(), insertDefaults()]);

    const created = results.filter((row) => row !== null);
    expect(created).toHaveLength(1);
    await expect(find()).resolves.toMatchObject({ id: created[0]?.id });
  });

  it('a second change waits for the locked row and then reads what the first one saved (IA13)', async () => {
    await insertDefaults();
    const locked = signal();
    const release = signal();
    const firstChange = inOrganization(organization, async () => {
      await repository.findByChannelAccountForUpdate(channelAccount);
      locked.send();
      await release.promise;
      return repository.update({
        ...channelAccount,
        changes: { fast_hour_limit: 10 },
        updatedByUserId: null,
      });
    });
    await locked.promise;
    let hasSecondRead = false;
    const secondRead = inOrganization(organization, async () => {
      const row = await repository.findByChannelAccountForUpdate(channelAccount);
      hasSecondRead = true;
      return row;
    });
    await vi.waitFor(async () => expect(await countBlockedSessions()).toBeGreaterThan(0), {
      timeout: 5_000,
    });

    expect(hasSecondRead).toBe(false);
    // A plain read is never held back by the lock, and still shows the saved value.
    await expect(find()).resolves.toMatchObject({ fast_hour_limit: null });

    release.send();
    await firstChange;
    await expect(secondRead).resolves.toMatchObject({ fast_hour_limit: 10 });
  });

  it('a change belongs to its unit of work: a failure after it keeps the saved settings', async () => {
    await insertDefaults();

    await expect(
      inOrganization(organization, async () => {
        await repository.update({
          ...channelAccount,
          changes: { is_automatic_notice_enabled: true },
          updatedByUserId: null,
        });
        throw new Error('the rest of the save failed');
      }),
    ).rejects.toThrow('the rest of the save failed');

    await expect(find()).resolves.toMatchObject({ is_automatic_notice_enabled: false });
  });

  it('the default row belongs to its unit of work too: a pick that fails leaves none', async () => {
    await expect(
      inOrganization(organization, async () => {
        await repository.insertDefaults(channelAccount);
        throw new Error('the rest of the pick failed');
      }),
    ).rejects.toThrow('the rest of the pick failed');

    await expect(find()).resolves.toBeNull();
  });

  it('locks and changes nothing for an account without its row', async () => {
    await expect(
      inOrganization(organization, () => repository.findByChannelAccountForUpdate(channelAccount)),
    ).resolves.toBeNull();
    await expect(update({ changes: { is_automatic_notice_enabled: true } })).resolves.toBeNull();
  });

  it('keeps one row per account: a change on one leaves the other account of the organization alone', async () => {
    const revokedAccount = await insertInstagramAccount({
      organizationId: organization.id,
      connectionStatus: 'revoked',
    });
    const revokedKey = await channelAccountKeyOf({
      organizationId: organization.id,
      instagramAccountId: revokedAccount.id,
    });
    await insertDefaults();
    await insertDefaults(revokedKey);

    await update({ changes: { person_hour_limit: 25 }, key: revokedKey });

    await expect(find(revokedKey)).resolves.toMatchObject({ person_hour_limit: 25 });
    await expect(find()).resolves.toMatchObject({ person_hour_limit: null });
  });

  it.each([
    [
      'lowest',
      {
        opening_hour_limit: 1,
        opening_day_limit: 1,
        fast_hour_limit: 1,
        person_hour_limit: 1,
        broadcast_hour_limit: 1,
        extra_stop_words: [],
        extra_delay_seconds_min: 1,
        extra_delay_seconds_max: 1,
      },
    ],
    [
      'highest',
      {
        opening_hour_limit: 750,
        broadcast_hour_limit: 2000,
        extra_stop_words: Array.from({ length: 50 }, (_, index) => `word ${index}`),
        extra_delay_seconds_min: 20,
        extra_delay_seconds_max: 20,
      },
    ],
  ])('takes the %s value of every range', async (_case, changes) => {
    await insertDefaults();

    await expect(update({ changes })).resolves.toMatchObject(changes);
  });

  it.each([
    ['chk_instagram_account_settings_opening_hour_limit', { opening_hour_limit: 0 }],
    ['chk_instagram_account_settings_opening_hour_limit', { opening_hour_limit: 751 }],
    ['chk_instagram_account_settings_opening_day_limit', { opening_day_limit: 0 }],
    ['chk_instagram_account_settings_fast_hour_limit', { fast_hour_limit: 0 }],
    ['chk_instagram_account_settings_person_hour_limit', { person_hour_limit: 0 }],
    ['chk_instagram_account_settings_broadcast_hour_limit', { broadcast_hour_limit: 2001 }],
    [
      'chk_instagram_account_settings_extra_stop_words',
      { extra_stop_words: Array.from({ length: 51 }, (_, index) => `word ${index}`) },
    ],
    ['chk_instagram_account_settings_extra_delay', { extra_delay_seconds_min: 3 }],
    [
      'chk_instagram_account_settings_extra_delay',
      { extra_delay_seconds_min: 5, extra_delay_seconds_max: 4 },
    ],
    [
      'chk_instagram_account_settings_extra_delay',
      { extra_delay_seconds_min: 21, extra_delay_seconds_max: 21 },
    ],
  ])('holds %s against %o, keeping the saved row', async (constraintName, changes) => {
    await insertDefaults();

    const error = await captureError(() => update({ changes }));

    expect(getPostgresErrorCode(error)).toBe('23514');
    expect(getPostgresConstraintName(error)).toBe(constraintName);
    await expect(find()).resolves.toMatchObject({
      opening_hour_limit: null,
      opening_day_limit: null,
      fast_hour_limit: null,
      person_hour_limit: null,
      broadcast_hour_limit: null,
      extra_stop_words: [],
      extra_delay_seconds_min: null,
      extra_delay_seconds_max: null,
    });
  });

  it('names the last editor, then none once an API key changed the settings', async () => {
    await insertDefaults();
    const editor = await createTestUser();

    const byUser = await update({
      changes: { fast_hour_limit: 30 },
      updatedByUserId: editor.id,
    });
    const byApiKey = await update({ changes: { fast_hour_limit: 31 } });

    expect(byUser?.updated_by_user_id).toBe(editor.id);
    expect(byApiKey?.updated_by_user_id).toBeNull();
  });

  it('keeps the settings when the user who changed them is deleted, without the editor (K6)', async () => {
    await insertDefaults();
    const editor = await createTestUser();
    await update({ changes: { is_automatic_notice_enabled: true }, updatedByUserId: editor.id });

    await getOperatorDatabase().delete(users).where(eq(users.id, editor.id));

    await expect(find()).resolves.toMatchObject({
      is_automatic_notice_enabled: true,
      updated_by_user_id: null,
    });
  });

  it('holds its channel account: the account cannot be deleted under its settings (RESTRICT, 2.3)', async () => {
    await insertDefaults();
    await getOperatorDatabase()
      .delete(instagram_accounts)
      .where(eq(instagram_accounts.channel_account_id, channelAccount.channelAccountId));

    const error = await captureError(() =>
      getOperatorDatabase()
        .delete(channel_accounts)
        .where(eq(channel_accounts.id, channelAccount.channelAccountId)),
    );

    expect(getPostgresErrorCode(error)).toBe('23503');
    expect(getPostgresConstraintName(error)).toBe('instagram_account_settings_channel_account_fk');
    await expect(find()).resolves.not.toBeNull();
  });

  it("reads on a job's own handle for event processing", async () => {
    const created = await insertDefaults();

    const read = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id }),
      callback: (databaseHandle) =>
        createWorkerInstagramAccountSettingsRepository(databaseHandle).findByChannelAccount(
          channelAccount,
        ),
    });

    expect(read?.id).toBe(created?.id);
  });
});
