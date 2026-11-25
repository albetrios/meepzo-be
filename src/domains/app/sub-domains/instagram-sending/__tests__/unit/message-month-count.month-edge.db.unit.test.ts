import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { ChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { CHANNEL_ACCOUNT_PLAN_STOP_REASON } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { MessageMonthCountRepository } from '@/domains/app/sub-domains/instagram-sending/message-month-count.repository.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { buildPostgresOptions, createDatabasePool } from '@/infrastructure/database/connection.js';
import { getOperatorDatabase, operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

/** The last second of November in Asia/Kolkata (UTC+05:30) — 23:59:59 local. */
const LAST_SECOND = '2026-11-30T18:29:59Z';
/** The first second of December in Asia/Kolkata — 00:00:00 local. */
const FIRST_SECOND = '2026-11-30T18:30:00Z';
/** Free's month limit (the stop holds while the month's count reaches it). */
const MONTH_LIMIT = 1000;

/**
 * The month edge in the organization's time zone (feat-instagram-dm-sending § 6 SN8, SN15, D34,
 * WC-37; AC-22.6): with the clock pinned to the last second of a month and the next one, in
 * Asia/Kolkata the month count turns at 18:30 UTC — not at UTC midnight — and the plan-limit stop's
 * wake (the month-wake repair's pick) comes due only then.
 *
 * The clock is Postgres's own `now()`, which the repositories read in the same statement: each
 * pinned call runs in one operator transaction whose `search_path` puts a test schema's `now()`
 * (returning a transaction-local setting) ahead of `pg_catalog` — the tables are schema-qualified,
 * so nothing else resolves differently.
 */
describe('the month count at the Asia/Kolkata month edge (database)', () => {
  let organization: { id: number; public_id: string };
  let account: Awaited<ReturnType<typeof insertInstagramAccount>>;

  /** Runs `callback` with Postgres's `now()` pinned to `at`. */
  async function at<T>(
    moment: string,
    callback: (databaseHandle: RequestScopedPostgresDatabase) => Promise<T>,
  ): Promise<T> {
    return getOperatorDatabase().transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL search_path = test_clock, pg_catalog, public`);
      await transaction.execute(sql`SELECT set_config('test_clock.now', ${moment}, true)`);
      return callback(transaction as unknown as RequestScopedPostgresDatabase);
    });
  }

  const readMonth = (moment: string) =>
    at(moment, (databaseHandle) =>
      new MessageMonthCountRepository(databaseHandle).readMonth(organization.id),
    );

  const monthWakeDue = (moment: string) =>
    at(moment, (databaseHandle) =>
      new ChannelAccountRepository(databaseHandle).listOrganizationsHoldingPlanStop({
        reason: CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_LIMIT,
        isMonthTurned: true,
        afterOrganizationId: 0,
        limit: 10,
      }),
    );

  /**
   * Runs DDL as the migration login: the schema owner, which may create a schema on the worker's
   * database (the harness's operator login may not — it is a data login, `CREATE` not granted).
   */
  async function asMigrationLogin(statements: readonly string[]): Promise<void> {
    const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
    if (!migrationUrl) throw new Error('no database URL for the test clock');
    const migrationPool = createDatabasePool({
      config: buildPostgresOptions(migrationUrl),
      poolName: 'test-clock',
    });
    try {
      for (const statement of statements) await migrationPool.query(statement);
    } finally {
      await migrationPool.end();
    }
  }

  beforeAll(async () => {
    await asMigrationLogin([
      'CREATE SCHEMA IF NOT EXISTS test_clock',
      `CREATE OR REPLACE FUNCTION test_clock.now() RETURNS timestamptz
        LANGUAGE sql STABLE AS $$ SELECT current_setting('test_clock.now')::timestamptz $$`,
      'GRANT USAGE ON SCHEMA test_clock TO PUBLIC',
      'GRANT EXECUTE ON FUNCTION test_clock.now() TO PUBLIC',
    ]);
  });

  afterAll(async () => {
    await asMigrationLogin(['DROP SCHEMA IF EXISTS test_clock CASCADE']);
  });

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    await operatorQuery`
      UPDATE tenancy.organizations SET timezone = 'Asia/Kolkata' WHERE id = ${organization.id}`;
    account = await insertInstagramAccount({ organizationId: organization.id });
  });

  it('the pinned clock is the one the statements read', async () => {
    const [row] = await at(LAST_SECOND, async (databaseHandle) => {
      const result = await databaseHandle.execute(sql`SELECT now()::text AS now`);
      return (result as unknown as { rows: { now: string }[] }).rows;
    });
    expect(new Date(row!.now).toISOString()).toBe('2026-11-30T18:29:59.000Z');
  });

  it('a DM counted at 18:29:59 UTC on the 30th is November’s; one at 18:30:00 UTC is December’s', async () => {
    await at(LAST_SECOND, (databaseHandle) =>
      new MessageMonthCountRepository(databaseHandle).addToMonth({
        organizationId: organization.id,
        channelAccountId: account.channel_account_id,
        count: MONTH_LIMIT,
      }),
    );
    await at(FIRST_SECOND, (databaseHandle) =>
      new MessageMonthCountRepository(databaseHandle).addToMonth({
        organizationId: organization.id,
        channelAccountId: account.channel_account_id,
        count: 1,
      }),
    );
    const rows = await operatorQuery<{ month_start: string; count: number }[]>`
      SELECT month_start::text, sum(count)::int AS count FROM app.message_month_counts
      WHERE organization_id = ${organization.id} GROUP BY month_start ORDER BY month_start`;
    expect(rows).toEqual([
      { month_start: '2026-11-01', count: MONTH_LIMIT },
      { month_start: '2026-12-01', count: 1 },
    ]);
  });

  it('the month count turns at 18:30 UTC — not at UTC midnight — and the plan-limit stop’s wake comes due only then (AC-22.6)', async () => {
    // November is full: 1,000 of 1,000, the stop began on the 30th in the afternoon (local).
    await operatorQuery`
      INSERT INTO app.message_month_counts (organization_id, month_start, slot, count)
      VALUES (${organization.id}, '2026-11-01', 0, ${MONTH_LIMIT})`;
    await operatorQuery`
      UPDATE app.channel_accounts
      SET plan_stop_reason = 'plan_limit', plan_stopped_at = '2026-11-30T09:00:00Z'
      WHERE id = ${account.channel_account_id}`;

    // 23:59:59 in Kolkata: still November — the count is at the limit, the stop holds, no wake.
    expect(await readMonth(LAST_SECOND)).toEqual({
      monthStart: '2026-11-01',
      resetsOn: '2026-12-01',
      used: MONTH_LIMIT,
    });
    expect(await monthWakeDue(LAST_SECOND)).toEqual([]);

    // 00:00:00 in Kolkata: December — the count starts again and the wake is due.
    expect(await readMonth(FIRST_SECOND)).toEqual({
      monthStart: '2026-12-01',
      resetsOn: '2027-01-01',
      used: 0,
    });
    expect(await monthWakeDue(FIRST_SECOND)).toEqual([
      {
        organizationId: organization.id,
        organizationPublicId: organization.public_id,
        month: '2026-12',
      },
    ]);

    // UTC midnight would be 5 h 30 min later — a UTC month would still read November at 18:30Z.
    const [utcMonth] = await operatorQuery<{ month: string }[]>`
      SELECT to_char(${FIRST_SECOND}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM') AS month`;
    expect(utcMonth?.month).toBe('2026-11');
  });

  it('a stop that began after 18:30 UTC on the 30th is already December’s: no wake that night', async () => {
    await operatorQuery`
      UPDATE app.channel_accounts
      SET plan_stop_reason = 'plan_limit', plan_stopped_at = ${FIRST_SECOND}::timestamptz
      WHERE id = ${account.channel_account_id}`;
    expect(await monthWakeDue('2026-11-30T23:59:59Z')).toEqual([]);
    expect(await monthWakeDue('2026-12-31T18:30:00Z')).toHaveLength(1);
  });
});
