import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared partition upkeep's processor (feat-instagram-dm-sending WC-55, WHC13; P92, S17): the
 * eight tables in order under the upkeep's maintenance scope, the gauges, and the alerts.
 */

const state = vi.hoisted(() => ({
  calls: [] as { scope: unknown; table: string; keepDays: number; drop: boolean }[],
  reports: new Map<string, Record<string, unknown>>(),
  failingTable: undefined as string | undefined,
}));

const captureMessageMock = vi.hoisted(() => vi.fn());
const setGaugesMock = vi.hoisted(() => vi.fn());

function baseReport(table: string): Record<string, unknown> {
  return {
    table: table.replace('app.', ''),
    created_parts: 0,
    moved_rows: 0,
    blocked_parts: [],
    dropped_parts: 0,
    held_parts: [],
    failed_drops: [],
    lock_timeouts: 0,
    ready_days: 15,
    default_rows: 0,
    oldest_overdue_seconds: 0,
  };
}

vi.mock('@/infrastructure/database/contexts/database-context.js', () => ({
  MAINTENANCE_SCOPE: { APP_PARTITION_UPKEEP: { kind: 'APP_PARTITION_UPKEEP' } },
  withMaintenanceDatabaseContext: async ({
    scope,
    callback,
  }: {
    scope: unknown;
    callback: (handle: unknown) => Promise<unknown>;
  }) =>
    callback({
      execute: async (query: { queryChunks: unknown[] }) => {
        const values = query.queryChunks.filter(
          (chunk) => typeof chunk !== 'object' || chunk === null,
        ) as unknown[];
        const [table, , keepDays, drop] = values as [string, number, number, boolean];
        state.calls.push({ scope, table, keepDays, drop });
        if (table === state.failingTable) throw new Error('lock not available');
        return [{ report: state.reports.get(table) ?? baseReport(table) }];
      },
    }),
}));

vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
}));

vi.mock('@/infrastructure/observability/metrics/prometheus-metrics.js', () => ({
  setAppPartitionUpkeepGauges: (...args: unknown[]) => setGaugesMock(...args),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runAppPartitionUpkeepJob } = await import(
  '@/domains/app/workers/app-partition-upkeep.processor.js'
);

describe('runAppPartitionUpkeepJob', () => {
  beforeEach(() => {
    state.calls = [];
    state.reports = new Map();
    state.failingTable = undefined;
    captureMessageMock.mockReset();
    setGaugesMock.mockReset();
  });

  it('visits the eight tables in order — messages and run events before runs — with their keep times', async () => {
    const reports = await runAppPartitionUpkeepJob({ mode: 'drop' });

    expect(reports).toHaveLength(8);
    expect(state.calls.map(({ table, keepDays, drop }) => [table, keepDays, drop])).toEqual([
      ['app.instagram_webhook_events', 8, true],
      ['app.instagram_webhook_event_keys', 8, true],
      ['app.instagram_send_attempts', 8, true],
      ['app.instagram_outgoing_messages', 30, true],
      ['app.automation_comment_logs', 90, true],
      ['app.instagram_conversation_messages', 365, true],
      ['app.automation_run_events', 98, true],
      ['app.automation_runs', 98, true],
    ]);
    expect(new Set(state.calls.map((call) => call.scope))).toEqual(
      new Set([{ kind: 'APP_PARTITION_UPKEEP' }]),
    );
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('only makes parts in make mode', async () => {
    await runAppPartitionUpkeepJob({ mode: 'make' });

    expect(state.calls.every((call) => call.drop === false)).toBe(true);
  });

  it('sets the three gauges per table', async () => {
    state.reports.set('app.instagram_outgoing_messages', {
      ...baseReport('app.instagram_outgoing_messages'),
      ready_days: 26,
      default_rows: 2,
      oldest_overdue_seconds: 40,
    });

    await runAppPartitionUpkeepJob({ mode: 'drop' });

    expect(setGaugesMock).toHaveBeenCalledTimes(8);
    expect(setGaugesMock).toHaveBeenCalledWith({
      table: 'app.instagram_outgoing_messages',
      readyDays: 26,
      defaultRows: 2,
      oldestOverdueSeconds: 40,
    });
  });

  it('alerts on fewer than 7 ready days, DEFAULT rows, moved rows, an open-run hold and a part over a day late', async () => {
    state.reports.set('app.instagram_webhook_events', {
      ...baseReport('app.instagram_webhook_events'),
      ready_days: 6,
    });
    state.reports.set('app.instagram_webhook_event_keys', {
      ...baseReport('app.instagram_webhook_event_keys'),
      default_rows: 1,
    });
    state.reports.set('app.instagram_send_attempts', {
      ...baseReport('app.instagram_send_attempts'),
      moved_rows: 3,
    });
    state.reports.set('app.automation_runs', {
      ...baseReport('app.automation_runs'),
      held_parts: ['automation_runs_p202608'],
      oldest_overdue_seconds: 2 * 24 * 60 * 60,
    });

    await runAppPartitionUpkeepJob({ mode: 'drop' });

    const alerts = captureMessageMock.mock.calls.map(
      ([argument]) => (argument as { message: string }).message,
    );
    expect(alerts).toEqual([
      'app.partition_upkeep.parts_not_ready',
      'app.partition_upkeep.default_part_rows',
      'app.partition_upkeep.default_rows_moved',
      'app.partition_upkeep.part_held_open_run',
      'app.partition_upkeep.part_overdue',
    ]);
  });

  it('does not alert on a part less than a day late', async () => {
    state.reports.set('app.automation_runs', {
      ...baseReport('app.automation_runs'),
      oldest_overdue_seconds: 60 * 60,
      failed_drops: ['automation_runs_p202608'],
    });

    await runAppPartitionUpkeepJob({ mode: 'drop' });

    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('runs the other tables when one fails, then throws naming it', async () => {
    state.failingTable = 'app.instagram_outgoing_messages';

    await expect(runAppPartitionUpkeepJob({ mode: 'drop' })).rejects.toThrow(
      'app partition upkeep failed for app.instagram_outgoing_messages',
    );
    expect(state.calls).toHaveLength(8);
  });
});
