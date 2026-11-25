import type { BatchDeleteResult } from '@/infrastructure/database/utils/batch-delete.util.js';
import { DEFAULT_BATCH_DELETE_ROW_COUNT } from '@/shared/constants/limits.constants.js';
import { setRetentionCleanupGauges } from '@/infrastructure/observability/metrics/prometheus-metrics.js';
import { captureMessage } from '@/infrastructure/observability/sentry/sentry.js';
import { hasShutdownStarted } from '@/infrastructure/queue/worker-runtime/shutdown-timing.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * The time budget of one hourly batch clean-up run (feat-instagram-dm-sending P92: "until a time
 * budget (about 10 minutes) is spent"), in milliseconds — shared by the run's tables.
 */
export const TIME_BUDGETED_CLEAN_UP_BUDGET_MS = 10 * 60 * 1000;

/**
 * Batches one unit of work deletes before the run checks its budget and cap again — 50,000 rows
 * at the default batch size, so no clean-up transaction holds its locks for long.
 */
export const TIME_BUDGETED_CLEAN_UP_BATCHES_PER_UNIT = 10;

/** The oldest due row waiting longer than this alerts the team (P92: "alerts after 1 day"), in seconds. */
export const TIME_BUDGETED_CLEAN_UP_OVERDUE_ALERT_SECONDS = 24 * 60 * 60;

/** One plain table a time-budgeted clean-up empties: its label, its cap, and its two steps. */
export interface TimeBudgetedCleanUpTable {
  /** Schema-qualified table, the gauges' `table` label (`app.broadcast_recipients`). */
  readonly table: string;
  /** Most rows one run deletes from it — the plan's rows a day × 2 (P92). */
  readonly maxRowsPerRun: number;
  /**
   * Deletes at most `maxBatches` batches of due rows in **its own** unit of work and reports what
   * it did (`hasMore` when it stopped at `maxBatches` with rows left).
   */
  readonly deleteUnit: (options: { maxBatches: number }) => Promise<BatchDeleteResult>;
  /** Reads the oldest due row's overdue seconds, in its own unit of work (`0` when none is due). */
  readonly readOldestOverdueSeconds: () => Promise<number>;
}

/** Why a table's run ended. */
export type TimeBudgetedCleanUpStop = 'done' | 'cap' | 'budget' | 'shutdown' | 'blocked';

/** One table's outcome — counts only, never a row. */
export interface TimeBudgetedCleanUpReport {
  readonly table: string;
  readonly deletedCount: number;
  readonly blockedCount: number;
  readonly stoppedBy: TimeBudgetedCleanUpStop;
  readonly oldestOverdueSeconds: number;
}

/** Deletes one table's due rows unit by unit until done, its cap, its share of the budget or shutdown. */
async function cleanUpTable({
  spec,
  deadlineAt,
  clock,
}: {
  spec: TimeBudgetedCleanUpTable;
  deadlineAt: number;
  clock: () => number;
}): Promise<Omit<TimeBudgetedCleanUpReport, 'oldestOverdueSeconds' | 'table'>> {
  let deletedCount = 0;
  let blockedCount = 0;
  for (;;) {
    if (hasShutdownStarted()) return { deletedCount, blockedCount, stoppedBy: 'shutdown' };
    if (clock() >= deadlineAt) return { deletedCount, blockedCount, stoppedBy: 'budget' };
    const rowsLeft = spec.maxRowsPerRun - deletedCount;
    if (rowsLeft <= 0) return { deletedCount, blockedCount, stoppedBy: 'cap' };
    const maxBatches = Math.min(
      TIME_BUDGETED_CLEAN_UP_BATCHES_PER_UNIT,
      Math.ceil(rowsLeft / DEFAULT_BATCH_DELETE_ROW_COUNT),
    );
    const result = await spec.deleteUnit({ maxBatches });
    deletedCount += result.deletedCount;
    blockedCount += result.blockedCount;
    if (!result.hasMore) return { deletedCount, blockedCount, stoppedBy: 'done' };
    // A whole unit of blocked rows: the next unit would scan the same rows again.
    if (result.deletedCount === 0) return { deletedCount, blockedCount, stoppedBy: 'blocked' };
  }
}

/** The gauges of one table, and the team's alert when its oldest due row waits over a day. */
function reportTable({
  logLabel,
  report,
}: {
  logLabel: string;
  report: TimeBudgetedCleanUpReport;
}): void {
  setRetentionCleanupGauges({
    table: report.table,
    oldestOverdueSeconds: report.oldestOverdueSeconds,
    deletedRows: report.deletedCount,
  });
  if (report.oldestOverdueSeconds > TIME_BUDGETED_CLEAN_UP_OVERDUE_ALERT_SECONDS) {
    const message = `${logLabel}.row_overdue`;
    const extra = {
      table: report.table,
      oldestOverdueSeconds: report.oldestOverdueSeconds,
      deletedCount: report.deletedCount,
      blockedCount: report.blockedCount,
      stoppedBy: report.stoppedBy,
    };
    logger.warn(extra, message);
    captureMessage({ message, options: { level: 'warning', extra } });
  }
}

/**
 * Runs one hourly batch clean-up over its plain tables within one time budget (feat-instagram-dm-
 * sending P92; WC-47, WC-53, WC-54, WC-62, WC-64): each table until it is empty of due rows, its
 * per-table cap is reached or its share of the budget is spent, then the "oldest row past its keep
 * time" gauge per table, alerting after 1 day.
 *
 * @remarks
 * - **Algorithm:** the tables in order; each gets the budget left divided by the tables left, so
 *   a long backlog in the first cannot starve the others (a table that finishes early leaves its
 *   time to the rest). Per table: units of at most {@link TIME_BUDGETED_CLEAN_UP_BATCHES_PER_UNIT}
 *   batches (fewer near the cap), each its own unit of work, while the last one stopped with rows
 *   left; a unit that deleted nothing but was all blocked ends the table (`blocked`). Then the
 *   oldest due row's overdue seconds is read and both gauges set.
 * - **Failure modes:** a table whose delete or gauge read fails is logged and the others still
 *   run; then the run throws naming the failed tables, so BullMQ retries it (then the DLQ).
 * - **Side effects:** the tables' deletes (through the specs); the two `retention_cleanup_*`
 *   gauges; `info` logs at start and end with counts; a warn log and a Sentry message
 *   (`<logLabel>.row_overdue`) for a table more than a day behind.
 * - **Notes:** the cap may be passed by less than one batch (whole batches). Safe to skip and to
 *   repeat — the next hour carries on. Stops between units once shutdown begins. `clock` is
 *   injectable for tests.
 */
export async function runTimeBudgetedCleanUp({
  logLabel,
  tables,
  budgetMilliseconds = TIME_BUDGETED_CLEAN_UP_BUDGET_MS,
  clock = Date.now,
}: {
  logLabel: string;
  tables: readonly TimeBudgetedCleanUpTable[];
  budgetMilliseconds?: number;
  clock?: () => number;
}): Promise<TimeBudgetedCleanUpReport[]> {
  const startedAt = clock();
  const runDeadlineAt = startedAt + budgetMilliseconds;
  logger.info({ tables: tables.length, budgetMilliseconds }, `${logLabel}.starting`);

  const reports: TimeBudgetedCleanUpReport[] = [];
  const failedTables: string[] = [];
  for (const [index, spec] of tables.entries()) {
    const tablesLeft = tables.length - index;
    const share = Math.max(0, runDeadlineAt - clock()) / tablesLeft;
    try {
      const outcome = await cleanUpTable({ spec, deadlineAt: clock() + share, clock });
      const oldestOverdueSeconds = await spec.readOldestOverdueSeconds();
      const report = { table: spec.table, ...outcome, oldestOverdueSeconds };
      reports.push(report);
      reportTable({ logLabel, report });
    } catch (error) {
      failedTables.push(spec.table);
      logger.error(
        { table: spec.table, error: error instanceof Error ? error.message : String(error) },
        `${logLabel}.table_failed`,
      );
    }
  }

  logger.info(
    {
      elapsedMilliseconds: clock() - startedAt,
      tables: reports.map(({ table, deletedCount, blockedCount, stoppedBy }) => ({
        table,
        deletedCount,
        blockedCount,
        stoppedBy,
      })),
      failedTables,
    },
    `${logLabel}.completed`,
  );
  if (failedTables.length > 0) {
    throw new Error(`${logLabel}: failed for ${failedTables.join(', ')}`);
  }
  return reports;
}
