import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  type AppPartitionUpkeepTableReport,
  runAppPartitionUpkeepJob,
} from '@/domains/app/workers/app-partition-upkeep.processor.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  type AutomationRunFixtureRow,
  insertAutomationRun,
  insertAutomationRunEvent,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { insertInstagramOutgoingMessage } from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/__tests__/factories/instagram-outgoing-message.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  getOperatorPool,
  operatorQuery,
  withOperatorTransaction,
} from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The shared partition upkeep against the real tables (feat-instagram-dm-sending WC-55, WC-48–WC-52;
 * routes-final § 5.B WHC13, § 4.B AUC14, § 6.B SNC13; P92, P96, S17, P410). Old parts are made the
 * way the code makes them — through `app.fn_create_daily_partitions` / `_weekly_` / `_monthly_` on
 * the operator (an owner member) — and the upkeep runs as the maintenance role, through
 * `app.fn_manage_time_partitions`.
 */

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/** A UTC day `offsetDays` from today, as `YYYY-MM-DD`. */
function utcDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MILLISECONDS).toISOString().slice(0, 10);
}

/** The first day (UTC) of the month `offsetMonths` from this one. */
function monthStart(offsetMonths: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
}

/** `<table>_pYYYYMM` of a month start. */
function monthPart(table: string, start: Date): string {
  return `${table}_p${start.toISOString().slice(0, 7).replace('-', '')}`;
}

async function partExists(name: string): Promise<boolean> {
  const [row] = await operatorQuery<{ exists: boolean }[]>`
    SELECT to_regclass(${`app.${name}`}) IS NOT NULL AS exists
  `;
  return row?.exists === true;
}

/** The week part's name of a day, as `app.fn_create_weekly_partitions` names it. */
async function weekPart(table: string, day: string): Promise<string> {
  const [row] = await operatorQuery<{ name: string }[]>`
    SELECT ${table}::text || '_p' || to_char(date_trunc('week', ${day}::date), 'IYYY') || 'w'
      || to_char(date_trunc('week', ${day}::date), 'IW') AS name
  `;
  return row?.name ?? '';
}

/** One call of the upkeep function as the maintenance role, as the worker makes it. */
async function manage({
  table,
  keepDays,
  makeAheadDays = 14,
  drop,
}: {
  table: string;
  keepDays: number;
  makeAheadDays?: number;
  drop: boolean;
}): Promise<AppPartitionUpkeepTableReport> {
  return withMaintenanceDatabaseContext({
    scope: MAINTENANCE_SCOPE.APP_PARTITION_UPKEEP,
    options: { useMaintenanceDatabaseRole: true },
    callback: async (databaseHandle) => {
      const result = await databaseHandle.execute(sql`
        SELECT app.fn_manage_time_partitions(${table}::regclass, ${makeAheadDays}::integer,
          ${keepDays}::integer, ${drop}::boolean) AS report
      `);
      const rows = (
        Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      ) as { report: AppPartitionUpkeepTableReport }[];
      return rows[0]?.report as AppPartitionUpkeepTableReport;
    },
  });
}

/** The database's refusal text of a failed call (Drizzle wraps it as the error's cause). */
async function refusalOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : (error as Error).message;
  }
  throw new Error('the call was not refused');
}

function reportOf(
  reports: readonly AppPartitionUpkeepTableReport[],
  table: string,
): AppPartitionUpkeepTableReport | undefined {
  return reports.find((report) => report.table === table);
}

type Fixture = {
  organizationId: number;
  channelAccountId: number;
  automationId: number;
  contactId: number;
};

async function createFixture(): Promise<Fixture> {
  const organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
  const account = await insertInstagramAccount({ organizationId: organization.id });
  const automation = await insertAutomation({
    organizationId: organization.id,
    instagramAccountId: account.id,
    status: 'live',
  });
  const contact = await insertContact({
    organizationId: organization.id,
    instagramAccountId: account.id,
  });
  return {
    organizationId: organization.id,
    channelAccountId: account.channel_account_id,
    automationId: automation.id,
    contactId: contact.id,
  };
}

/** Makes the month parts of runs and run events for `start` (the way R14's migration does). */
async function makeRunMonthParts(start: Date): Promise<void> {
  const day = start.toISOString().slice(0, 10);
  await operatorQuery`SELECT app.fn_create_monthly_partitions('app.automation_runs'::regclass, ${day}::date, ${day}::date)`;
  await operatorQuery`SELECT app.fn_create_monthly_partitions('app.automation_run_events'::regclass, ${day}::date, ${day}::date)`;
}

/** A run that started two days into `start`'s month and ended a minute later. */
async function insertEndedRun(fixture: Fixture, start: Date): Promise<AutomationRunFixtureRow> {
  const startedAt = new Date(start.getTime() + 2 * DAY_MILLISECONDS);
  return insertAutomationRun({
    organizationId: fixture.organizationId,
    automationId: fixture.automationId,
    contactId: fixture.contactId,
    started_at: startedAt,
    trigger_occurred_at: startedAt,
    status: 'completed',
    current_step: 'messages',
    waiting_for: null,
    waiting_since_at: null,
    completed_at: new Date(startedAt.getTime() + 60_000),
  });
}

describe('app.fn_manage_time_partitions — the shared partition upkeep (WC-55)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await cleanupDatabase();
    // The old parts a test left are expired: the upkeep drops them.
    await runAppPartitionUpkeepJob({ mode: 'drop' });
  });

  it('makes every table’s parts at least 14 days ahead and reports them ready (S17)', async () => {
    const reports = await runAppPartitionUpkeepJob({ mode: 'make' });

    expect(reports.map((report) => report.table)).toEqual([
      'instagram_webhook_events',
      'instagram_webhook_event_keys',
      'instagram_send_attempts',
      'instagram_outgoing_messages',
      'automation_comment_logs',
      'automation_run_events',
      'automation_runs',
    ]);
    for (const report of reports) {
      expect(report.ready_days, report.table).toBeGreaterThanOrEqual(15);
      expect(report.default_rows, report.table).toBe(0);
      expect(report.dropped_parts, report.table).toBe(0);
    }
    const fourteenDaysAhead = utcDay(14).replaceAll('-', '');
    expect(await partExists(`instagram_webhook_events_p${fourteenDaysAhead}`)).toBe(true);
    expect(await partExists(`instagram_webhook_event_keys_p${fourteenDaysAhead}`)).toBe(true);
    expect(await partExists(`instagram_send_attempts_p${fourteenDaysAhead}`)).toBe(true);
    expect(await partExists(await weekPart('instagram_outgoing_messages', utcDay(14)))).toBe(true);
    expect(await partExists(monthPart('automation_runs', monthStart(0)))).toBe(true);
  });

  it('drops the day, week and month parts past their keep time — and only those (WC-48–WC-52)', async () => {
    const oldDay = utcDay(-20);
    const oldWeekDay = utcDay(-60);
    const oldMonth = monthStart(-6);
    const oldMonthDay = oldMonth.toISOString().slice(0, 10);
    for (const table of [
      'app.instagram_webhook_events',
      'app.instagram_webhook_event_keys',
      'app.instagram_send_attempts',
    ]) {
      await operatorQuery`SELECT app.fn_create_daily_partitions(${table}::regclass, ${oldDay}::date, ${oldDay}::date)`;
    }
    await operatorQuery`SELECT app.fn_create_weekly_partitions('app.instagram_outgoing_messages'::regclass, ${oldWeekDay}::date, ${oldWeekDay}::date)`;
    await operatorQuery`SELECT app.fn_create_monthly_partitions('app.automation_comment_logs'::regclass, ${oldMonthDay}::date, ${oldMonthDay}::date)`;
    await makeRunMonthParts(oldMonth);
    const oldDayParts = [
      'instagram_webhook_events',
      'instagram_webhook_event_keys',
      'instagram_send_attempts',
    ].map((table) => `${table}_p${oldDay.replaceAll('-', '')}`);
    const oldParts = [
      ...oldDayParts,
      await weekPart('instagram_outgoing_messages', oldWeekDay),
      monthPart('automation_comment_logs', oldMonth),
      monthPart('automation_run_events', oldMonth),
      monthPart('automation_runs', oldMonth),
    ];
    for (const part of oldParts) expect(await partExists(part), part).toBe(true);

    // A make-only pass never drops.
    await runAppPartitionUpkeepJob({ mode: 'make' });
    for (const part of oldParts) expect(await partExists(part), part).toBe(true);

    const reports = await runAppPartitionUpkeepJob({ mode: 'drop' });

    for (const part of oldParts) expect(await partExists(part), part).toBe(false);
    for (const report of reports) {
      expect(report.dropped_parts, report.table).toBeGreaterThanOrEqual(1);
      expect(report.failed_drops, report.table).toEqual([]);
    }
    // Today's parts, and the ones inside the keep time, stay.
    const today = utcDay(0).replaceAll('-', '');
    expect(await partExists(`instagram_webhook_events_p${today}`)).toBe(true);
    expect(
      await partExists(`instagram_webhook_event_keys_p${utcDay(-7).replaceAll('-', '')}`),
    ).toBe(true);
    expect(await partExists(monthPart('automation_runs', monthStart(-2)))).toBe(true);
  });

  it('keeps a runs part and its run-events part while a run in it is still open, and reports it (AU36 (5))', async () => {
    const fixture = await createFixture();
    const oldMonth = monthStart(-7);
    await makeRunMonthParts(oldMonth);
    const startedAt = new Date(oldMonth.getTime() + 2 * DAY_MILLISECONDS);
    const openRun = await insertAutomationRun({
      organizationId: fixture.organizationId,
      automationId: fixture.automationId,
      contactId: fixture.contactId,
      started_at: startedAt,
      trigger_occurred_at: startedAt,
    });
    await insertAutomationRunEvent({
      organizationId: fixture.organizationId,
      run: openRun,
      status: 'waiting',
    });

    const reports = await runAppPartitionUpkeepJob({ mode: 'drop' });

    const runsPart = monthPart('automation_runs', oldMonth);
    const runEventsPart = monthPart('automation_run_events', oldMonth);
    expect(reportOf(reports, 'automation_runs')?.held_parts).toEqual([runsPart]);
    expect(reportOf(reports, 'automation_run_events')?.held_parts).toEqual([runEventsPart]);
    expect(reportOf(reports, 'automation_runs')?.oldest_overdue_seconds).toBeGreaterThan(
      24 * 60 * 60,
    );
    expect(await partExists(runsPart)).toBe(true);
    expect(await partExists(runEventsPart)).toBe(true);

    // Once the run is gone, the next hour drops both.
    await operatorQuery`DELETE FROM app.automation_runs WHERE id = ${openRun.id}`;
    const after = await runAppPartitionUpkeepJob({ mode: 'drop' });

    expect(await partExists(runsPart)).toBe(false);
    expect(await partExists(runEventsPart)).toBe(false);
    expect(reportOf(after, 'automation_runs')?.oldest_overdue_seconds).toBe(0);
  });

  it('drops the messages’ and run events’ parts before the runs part they point into', async () => {
    const fixture = await createFixture();
    const oldMonth = monthStart(-6);
    await makeRunMonthParts(oldMonth);
    const run = await insertEndedRun(fixture, oldMonth);
    const runDay = run.started_at.toISOString().slice(0, 10);
    await operatorQuery`SELECT app.fn_create_weekly_partitions('app.instagram_outgoing_messages'::regclass, ${runDay}::date, ${runDay}::date)`;
    await insertInstagramOutgoingMessage({ run, channelAccountId: fixture.channelAccountId });
    await insertAutomationRunEvent({
      organizationId: fixture.organizationId,
      run,
      status: 'completed',
    });
    const runsPart = monthPart('automation_runs', oldMonth);
    const messagesPart = await weekPart('instagram_outgoing_messages', runDay);

    // The runs part first: its message and run event still point into it, so it stays.
    const runsFirst = await manage({ table: 'app.automation_runs', keepDays: 98, drop: true });
    expect(runsFirst.failed_drops).toEqual([runsPart]);
    expect(await partExists(runsPart)).toBe(true);

    // The upkeep's order — messages, run events, then runs — drops all three.
    await runAppPartitionUpkeepJob({ mode: 'drop' });

    expect(await partExists(messagesPart)).toBe(false);
    expect(await partExists(monthPart('automation_run_events', oldMonth))).toBe(false);
    expect(await partExists(runsPart)).toBe(false);
    const [left] = await operatorQuery<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.automation_runs WHERE id = ${run.id}
    `;
    expect(left?.count).toBe(0);
  });

  it('gives up on a busy part after a short lock wait and drops it on a later hour (AC-18.6)', async () => {
    const oldDay = utcDay(-25);
    await operatorQuery`SELECT app.fn_create_daily_partitions('app.instagram_send_attempts'::regclass, ${oldDay}::date, ${oldDay}::date)`;
    const part = `instagram_send_attempts_p${oldDay.replaceAll('-', '')}`;
    const reader = await getOperatorPool().connect();
    try {
      // A long read holds the part, as a busy query would.
      await reader.query('BEGIN');
      await reader.query(`LOCK TABLE app.${part} IN ACCESS SHARE MODE`);

      const startedAt = Date.now();
      const busy = await manage({ table: 'app.instagram_send_attempts', keepDays: 8, drop: true });

      expect(busy.failed_drops).toEqual([part]);
      expect(busy.lock_timeouts).toBe(3);
      // Three 2 s waits and two short pauses — never longer.
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect(await partExists(part)).toBe(true);
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
    }

    const later = await manage({ table: 'app.instagram_send_attempts', keepDays: 8, drop: true });

    expect(later.failed_drops).toEqual([]);
    expect(await partExists(part)).toBe(false);
  });

  it('moves the DEFAULT part’s rows into a new part when their day had none (S17)', async () => {
    const fixture = await createFixture();
    const futureDay = utcDay(16);
    await operatorQuery`
      INSERT INTO app.instagram_webhook_event_keys (organization_id, channel_account_id, event_key, event_day)
      VALUES (${fixture.organizationId}, ${fixture.channelAccountId}, 'comment:upkeep-default', ${futureDay}::date)
    `;
    const before = await manage({
      table: 'app.instagram_webhook_event_keys',
      keepDays: 8,
      drop: false,
    });
    expect(before.default_rows).toBe(1);

    const report = await manage({
      table: 'app.instagram_webhook_event_keys',
      keepDays: 8,
      makeAheadDays: 16,
      drop: false,
    });

    expect(report).toMatchObject({ moved_rows: 1, default_rows: 0, blocked_parts: [] });
    const [row] = await operatorQuery<{ part: string }[]>`
      SELECT tableoid::regclass::text AS part FROM app.instagram_webhook_event_keys
       WHERE event_key = 'comment:upkeep-default'
    `;
    expect(row?.part).toBe(`app.instagram_webhook_event_keys_p${futureDay.replaceAll('-', '')}`);
  });

  it('leaves the DEFAULT rows of a table others point into, and reports the part it blocks', async () => {
    const fixture = await createFixture();
    // The first month with no part (the migration made 3 ahead), reached with the fewest new parts.
    const farMonth = monthStart(4);
    const makeAheadDays = Math.ceil((farMonth.getTime() - Date.now()) / DAY_MILLISECONDS) + 1;
    const startedAt = new Date(farMonth.getTime() + 2 * DAY_MILLISECONDS);
    await insertAutomationRun({
      organizationId: fixture.organizationId,
      automationId: fixture.automationId,
      contactId: fixture.contactId,
      started_at: startedAt,
      trigger_occurred_at: startedAt,
    });

    const report = await manage({
      table: 'app.automation_runs',
      keepDays: 98,
      makeAheadDays,
      drop: false,
    });

    expect(report.blocked_parts).toContain(monthPart('automation_runs', farMonth));
    expect(report.default_rows).toBe(1);
    expect(report.moved_rows).toBe(0);
    expect(await partExists(monthPart('automation_runs', farMonth))).toBe(false);
  });

  it('runs for the maintenance role only, on the seven tables only, with the S17 floors', async () => {
    await withOperatorTransaction(async (transaction) => {
      await transaction`SET LOCAL ROLE meepzo_be_app`;
      await expect(
        transaction`SELECT app.fn_manage_time_partitions('app.automation_runs'::regclass, 14, 98, true)`,
      ).rejects.toThrow(/permission denied/);
    });
    expect(await refusalOf(manage({ table: 'app.contacts', keepDays: 90, drop: true }))).toMatch(
      /not one of the time-split app tables/,
    );
    expect(
      await refusalOf(manage({ table: 'app.instagram_webhook_events', keepDays: 7, drop: true })),
    ).toMatch(/keep_days 7 refused/);
    expect(
      await refusalOf(
        manage({
          table: 'app.instagram_webhook_events',
          keepDays: 8,
          makeAheadDays: 13,
          drop: false,
        }),
      ),
    ).toMatch(/make_ahead_days 13 refused/);
  });
});
