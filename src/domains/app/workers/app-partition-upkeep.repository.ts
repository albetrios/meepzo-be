import { sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type { AppPartitionUpkeepTableReport } from './app-partition-upkeep.processor.js';

/**
 * The partition upkeep's one statement (feat-instagram-dm-sending WC-55, P410): a call of
 * `app.fn_manage_time_partitions`, bound to the handle of a `MAINTENANCE_SCOPE.APP_PARTITION_UPKEEP`
 * unit of work.
 *
 * @remarks
 * - **Algorithm:** `SELECT app.fn_manage_time_partitions(table, makeAheadDays, keepDays, dropParts)`
 *   and the `jsonb` report it returns (parsed when the driver hands back text).
 * - **Failure modes:** the function's refusals (another table, a day count below its floor) and
 *   permission errors (a role other than the maintenance role) propagate; a report-less answer throws.
 * - **Side effects:** the function's DDL on the table's parts (made, detached, dropped).
 * - **Notes:** no table is read or written from here — the function is the only path (it runs as its
 *   owner and only the maintenance role may call it).
 */
export function createAppPartitionUpkeepRepository(databaseHandle: WorkerDatabaseHandle) {
  return {
    /** One table's upkeep call — see {@link createAppPartitionUpkeepRepository}. */
    async manageTimePartitions({
      table,
      makeAheadDays,
      keepDays,
      dropParts,
    }: {
      table: string;
      makeAheadDays: number;
      keepDays: number;
      dropParts: boolean;
    }): Promise<AppPartitionUpkeepTableReport> {
      const result = await databaseHandle.execute(sql`
        SELECT app.fn_manage_time_partitions(
          ${table}::regclass,
          ${makeAheadDays}::integer,
          ${keepDays}::integer,
          ${dropParts}::boolean
        ) AS report
      `);
      const [row] = (
        Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      ) as { report: AppPartitionUpkeepTableReport | string }[];
      if (row === undefined) {
        throw new Error(`app.fn_manage_time_partitions returned no report for ${table}`);
      }
      return typeof row.report === 'string'
        ? (JSON.parse(row.report) as AppPartitionUpkeepTableReport)
        : row.report;
    },
  };
}
