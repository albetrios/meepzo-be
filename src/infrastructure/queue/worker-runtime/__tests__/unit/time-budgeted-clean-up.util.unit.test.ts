import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchDeleteResult } from '@/infrastructure/database/utils/batch-delete.util.js';
import type { TimeBudgetedCleanUpTable } from '@/infrastructure/queue/worker-runtime/time-budgeted-clean-up.util.js';

/**
 * The hourly batch clean-ups' shared loop (feat-instagram-dm-sending P92; WC-47, WC-53, WC-54,
 * WC-62, WC-64): units until done, the per-table cap, the time budget shared by the tables,
 * shutdown, a blocked unit; the gauges per table and the alert after a day behind (AC-18.7).
 */

const captureMessageMock = vi.hoisted(() => vi.fn());
const setGaugesMock = vi.hoisted(() => vi.fn());
const shutdownState = vi.hoisted(() => ({ started: false }));

vi.mock('@/infrastructure/observability/metrics/prometheus-metrics.js', () => ({
  setRetentionCleanupGauges: setGaugesMock,
}));
vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({
  captureMessage: captureMessageMock,
}));
vi.mock('@/infrastructure/queue/worker-runtime/shutdown-timing.util.js', () => ({
  hasShutdownStarted: () => shutdownState.started,
}));
vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runTimeBudgetedCleanUp, TIME_BUDGETED_CLEAN_UP_OVERDUE_ALERT_SECONDS } = await import(
  '@/infrastructure/queue/worker-runtime/time-budgeted-clean-up.util.js'
);

/** A table whose units each delete `perUnit` rows of `backlog`, 5,000 rows a batch. */
function fakeTable({
  table,
  backlog,
  maxRowsPerRun = 1_000_000,
  overdueSeconds = 0,
  onUnit,
}: {
  table: string;
  backlog: number;
  maxRowsPerRun?: number;
  overdueSeconds?: number;
  onUnit?: () => void;
}): TimeBudgetedCleanUpTable & { units: number[] } {
  let left = backlog;
  const units: number[] = [];
  return {
    table,
    maxRowsPerRun,
    units,
    deleteUnit: async ({ maxBatches }): Promise<BatchDeleteResult> => {
      onUnit?.();
      units.push(maxBatches);
      const deleted = Math.min(left, maxBatches * 5_000);
      left -= deleted;
      return { deletedCount: deleted, blockedCount: 0, hasMore: left > 0 };
    },
    readOldestOverdueSeconds: async () => overdueSeconds,
  };
}

describe('runTimeBudgetedCleanUp', () => {
  beforeEach(() => {
    captureMessageMock.mockReset();
    setGaugesMock.mockReset();
    shutdownState.started = false;
  });

  it('deletes unit by unit until no due row is left and sets both gauges', async () => {
    const recipients = fakeTable({ table: 'app.broadcast_recipients', backlog: 120_000 });

    const [report] = await runTimeBudgetedCleanUp({ logLabel: 'test', tables: [recipients] });

    expect(report).toEqual({
      table: 'app.broadcast_recipients',
      deletedCount: 120_000,
      blockedCount: 0,
      stoppedBy: 'done',
      oldestOverdueSeconds: 0,
    });
    // 50,000 rows a unit (10 batches), the last one short.
    expect(recipients.units).toEqual([10, 10, 10]);
    expect(setGaugesMock).toHaveBeenCalledWith({
      table: 'app.broadcast_recipients',
      oldestOverdueSeconds: 0,
      deletedRows: 120_000,
    });
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("stops at the per-table cap — the plan's rows a day × 2 — with fewer batches near it (P92)", async () => {
    const tagEvents = fakeTable({
      table: 'app.contact_tag_events',
      backlog: 1_000_000,
      maxRowsPerRun: 65_000,
    });

    const [report] = await runTimeBudgetedCleanUp({ logLabel: 'test', tables: [tagEvents] });

    expect(report).toMatchObject({ deletedCount: 65_000, stoppedBy: 'cap' });
    expect(tagEvents.units).toEqual([10, 3]);
  });

  it('stops at the time budget, sharing it between the tables so the first cannot starve the rest', async () => {
    let clock = 0;
    const tick = () => {
      clock += 100;
    };
    const first = fakeTable({ table: 'app.first', backlog: 10_000_000, onUnit: tick });
    const second = fakeTable({ table: 'app.second', backlog: 10_000_000, onUnit: tick });

    const reports = await runTimeBudgetedCleanUp({
      logLabel: 'test',
      tables: [first, second],
      budgetMilliseconds: 1_000,
      clock: () => clock,
    });

    expect(reports.map((report) => report.stoppedBy)).toEqual(['budget', 'budget']);
    // Half the budget each: 5 units of 100 ms.
    expect(first.units).toHaveLength(5);
    expect(second.units).toHaveLength(5);
  });

  it('stops between units once shutdown begins', async () => {
    const stops = fakeTable({
      table: 'app.instagram_send_stops',
      backlog: 1_000_000,
      onUnit: () => {
        shutdownState.started = true;
      },
    });

    const [report] = await runTimeBudgetedCleanUp({ logLabel: 'test', tables: [stops] });

    expect(report).toMatchObject({ deletedCount: 50_000, stoppedBy: 'shutdown' });
  });

  it('ends a table whose whole unit was blocked by references instead of scanning it again', async () => {
    const units: number[] = [];
    const automations: TimeBudgetedCleanUpTable = {
      table: 'app.automations',
      maxRowsPerRun: 50_000,
      deleteUnit: async ({ maxBatches }) => {
        units.push(maxBatches);
        return { deletedCount: 0, blockedCount: 50_000, hasMore: true };
      },
      readOldestOverdueSeconds: async () => 10,
    };

    const [report] = await runTimeBudgetedCleanUp({ logLabel: 'test', tables: [automations] });

    expect(report).toMatchObject({ deletedCount: 0, blockedCount: 50_000, stoppedBy: 'blocked' });
    expect(units).toHaveLength(1);
  });

  it("alerts the team when a table's oldest due row waits more than a day (AC-18.7)", async () => {
    const late = fakeTable({
      table: 'app.broadcast_recipients',
      backlog: 0,
      overdueSeconds: TIME_BUDGETED_CLEAN_UP_OVERDUE_ALERT_SECONDS + 1,
    });
    const onTime = fakeTable({
      table: 'app.contact_tag_events',
      backlog: 0,
      overdueSeconds: TIME_BUDGETED_CLEAN_UP_OVERDUE_ALERT_SECONDS,
    });

    await runTimeBudgetedCleanUp({ logLabel: 'app-table-clean-up', tables: [late, onTime] });

    expect(captureMessageMock).toHaveBeenCalledOnce();
    expect(captureMessageMock).toHaveBeenCalledWith({
      message: 'app-table-clean-up.row_overdue',
      options: {
        level: 'warning',
        extra: expect.objectContaining({
          table: 'app.broadcast_recipients',
          oldestOverdueSeconds: TIME_BUDGETED_CLEAN_UP_OVERDUE_ALERT_SECONDS + 1,
        }),
      },
    });
  });

  it('runs the other tables when one fails, then throws naming it', async () => {
    const failing: TimeBudgetedCleanUpTable = {
      table: 'app.broken',
      maxRowsPerRun: 5_000,
      deleteUnit: async () => {
        throw new Error('connection terminated');
      },
      readOldestOverdueSeconds: async () => 0,
    };
    const healthy = fakeTable({ table: 'app.healthy', backlog: 3 });

    await expect(
      runTimeBudgetedCleanUp({ logLabel: 'test', tables: [failing, healthy] }),
    ).rejects.toThrow('test: failed for app.broken');
    expect(setGaugesMock).toHaveBeenCalledWith({
      table: 'app.healthy',
      oldestOverdueSeconds: 0,
      deletedRows: 3,
    });
  });
});
