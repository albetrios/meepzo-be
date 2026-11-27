import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { setAppPartitionUpkeepGauges } from '@/infrastructure/observability/metrics/prometheus-metrics.js';
import { captureMessage } from '@/infrastructure/observability/sentry/sentry.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  APP_PARTITION_MAKE_AHEAD_DAYS,
  APP_PARTITION_OVERDUE_ALERT_SECONDS,
  APP_PARTITION_READY_ALERT_DAYS,
  APP_PARTITION_UPKEEP_SPECS,
  type AppPartitionUpkeepSpec,
} from './app-partition-upkeep.constants.js';
import { createAppPartitionUpkeepRepository } from './app-partition-upkeep.repository.js';

/**
 * How far one upkeep run goes.
 *
 * @remarks
 * - **Notes:** `make` — the coming parts only (the daily job and the pass at worker start); `drop` —
 *   make, then drop the expired parts (the hourly job, WC-48–WC-52).
 */
export type AppPartitionUpkeepMode = 'make' | 'drop';

/**
 * What `app.fn_manage_time_partitions` reports for one table — counts and part names, never a row.
 *
 * @remarks
 * - **Notes:** snake_case because it is the function's `jsonb` as returned; `default_rows` is capped
 *   at 1,000 and `oldest_overdue_seconds` is measured per part (the oldest part holding rows, from its
 *   drop time — P92's gauge at part granularity).
 */
export type AppPartitionUpkeepTableReport = {
  readonly table: string;
  readonly created_parts: number;
  readonly moved_rows: number;
  readonly blocked_parts: readonly string[];
  readonly dropped_parts: number;
  readonly held_parts: readonly string[];
  readonly failed_drops: readonly string[];
  readonly lock_timeouts: number;
  readonly ready_days: number;
  readonly default_rows: number;
  readonly oldest_overdue_seconds: number;
};

/** One table's call, in its own maintenance unit of work — its part locks end with its commit. */
async function manageTablePartitions({
  spec,
  mode,
}: {
  spec: AppPartitionUpkeepSpec;
  mode: AppPartitionUpkeepMode;
}): Promise<AppPartitionUpkeepTableReport> {
  return withMaintenanceDatabaseContext({
    scope: MAINTENANCE_SCOPE.APP_PARTITION_UPKEEP,
    callback: async (databaseHandle) =>
      createAppPartitionUpkeepRepository(databaseHandle).manageTimePartitions({
        table: spec.table,
        makeAheadDays: APP_PARTITION_MAKE_AHEAD_DAYS,
        keepDays: spec.keepDays,
        dropParts: mode === 'drop',
      }),
  });
}

/** Sends one upkeep alert to the team: an error or warn log and a Sentry message with counts only. */
function alertTeam({
  message,
  level,
  extra,
}: {
  message: string;
  level: 'error' | 'warning';
  extra: Record<string, unknown>;
}): void {
  if (level === 'error') {
    logger.error(extra, message);
  } else {
    logger.warn(extra, message);
  }
  captureMessage({ message, options: { level, extra } });
}

/** The gauges and the alerts of one table's report (S17, P92, AU36 (5)). */
function reportTable(report: AppPartitionUpkeepTableReport): void {
  const table = `app.${report.table}`;
  setAppPartitionUpkeepGauges({
    table,
    readyDays: report.ready_days,
    defaultRows: report.default_rows,
    oldestOverdueSeconds: report.oldest_overdue_seconds,
  });
  if (report.ready_days < APP_PARTITION_READY_ALERT_DAYS) {
    alertTeam({
      message: 'app.partition_upkeep.parts_not_ready',
      level: 'error',
      extra: {
        table,
        readyDays: report.ready_days,
        alertBelowDays: APP_PARTITION_READY_ALERT_DAYS,
      },
    });
  }
  if (report.default_rows > 0 || report.blocked_parts.length > 0) {
    alertTeam({
      message: 'app.partition_upkeep.default_part_rows',
      level: 'error',
      extra: {
        table,
        defaultRows: report.default_rows,
        blockedParts: report.blocked_parts,
      },
    });
  }
  if (report.moved_rows > 0) {
    alertTeam({
      message: 'app.partition_upkeep.default_rows_moved',
      level: 'warning',
      extra: { table, movedRows: report.moved_rows },
    });
  }
  if (report.held_parts.length > 0) {
    alertTeam({
      message: 'app.partition_upkeep.part_held_open_run',
      level: 'warning',
      extra: { table, heldParts: report.held_parts },
    });
  }
  if (report.oldest_overdue_seconds > APP_PARTITION_OVERDUE_ALERT_SECONDS) {
    alertTeam({
      message: 'app.partition_upkeep.part_overdue',
      level: 'warning',
      extra: {
        table,
        oldestOverdueSeconds: report.oldest_overdue_seconds,
        failedDrops: report.failed_drops,
      },
    });
  }
  if (report.failed_drops.length > 0) {
    logger.warn(
      { table, failedDrops: report.failed_drops, lockTimeouts: report.lock_timeouts },
      'app.partition_upkeep.drop_retry_next_hour',
    );
  }
}

/**
 * Keeps the eight time-split `app` tables' parts ready and drops the expired ones (feat-instagram-dm-
 * sending WC-55, WC-48–WC-52; routes-final § 5.B WHC13, § 4.B AUC14, § 6.B SNC13; P92, P96, S17).
 *
 * @remarks
 * - **Algorithm:** for each table of {@link APP_PARTITION_UPKEEP_SPECS}, in its order (messages and
 *   run events before runs), one `MAINTENANCE_SCOPE.APP_PARTITION_UPKEEP` unit of work calls
 *   `app.fn_manage_time_partitions(table, 14, keepDays, mode = 'drop')`: the missing parts up to 14
 *   days ahead are made (the DEFAULT part's rows of a new part's range moved into it, for a table
 *   nothing points into); in `drop` mode every part whose range ended more than `keepDays` ago is
 *   detached and dropped with a 2 s lock timeout and up to 3 tries, a runs or run-events part
 *   still holding an open run kept. Then the table's gauges are set and the alerts sent.
 * - **Failure modes:** a table whose call fails is logged and the others still run; the run then
 *   throws (naming the failed tables) so BullMQ retries it (then the DLQ). A drop that times
 *   out on its lock is not a failure — it is reported and tried again the next hour.
 * - **Side effects:** DDL on the `app` parts (CREATE … PARTITION OF, DETACH, DROP); the three
 *   `app_partition_*` gauges per table; error / warn logs and Sentry messages for: fewer than 7
 *   ready days, rows in a DEFAULT part (or a part it blocks), rows moved out of a DEFAULT part, a
 *   part held by an open run, the oldest kept part more than a day past its drop time. Counts and
 *   part names only — never a row.
 * - **Notes:** idempotent and safe to skip — the next run catches up; two workers racing to make
 *   one part leave one part. The function is the only path: it runs as its owner and only the
 *   maintenance role may call it (P410).
 */
export async function runAppPartitionUpkeepJob({
  mode,
}: {
  mode: AppPartitionUpkeepMode;
}): Promise<AppPartitionUpkeepTableReport[]> {
  logger.info({ mode, tables: APP_PARTITION_UPKEEP_SPECS.length }, 'app-partition-upkeep.starting');

  const reports: AppPartitionUpkeepTableReport[] = [];
  const failedTables: string[] = [];
  for (const spec of APP_PARTITION_UPKEEP_SPECS) {
    try {
      const report = await manageTablePartitions({ spec, mode });
      reportTable(report);
      reports.push(report);
    } catch (error) {
      failedTables.push(spec.table);
      logger.error(
        { table: spec.table, mode, error: error instanceof Error ? error.message : String(error) },
        'app.partition_upkeep.table_failed',
      );
    }
  }

  logger.info(
    {
      mode,
      createdParts: reports.reduce((total, report) => total + report.created_parts, 0),
      droppedParts: reports.reduce((total, report) => total + report.dropped_parts, 0),
      movedRows: reports.reduce((total, report) => total + report.moved_rows, 0),
      failedTables,
    },
    'app-partition-upkeep.completed',
  );

  if (failedTables.length > 0) {
    throw new Error(`app partition upkeep failed for ${failedTables.join(', ')}`);
  }
  return reports;
}
