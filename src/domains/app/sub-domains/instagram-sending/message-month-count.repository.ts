import { and, eq, sql } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type BatchDeleteResult,
  readOldestOverdueSeconds,
} from '@/infrastructure/database/utils/batch-delete.util.js';
import { DEFAULT_BATCH_DELETE_ROW_COUNT } from '@/shared/constants/limits.constants.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { message_month_counts } from './message-month-count.schema.js';
import { MESSAGE_MONTH_COUNT_SLOTS } from './instagram-sending.constants.js';

/** One organization's month as Postgres reads it in the organization's time zone (SN15). */
export interface MessageMonthCountRead {
  /** The 1st of this month, `YYYY-MM-DD`. */
  monthStart: string;
  /** The 1st of next month, `YYYY-MM-DD` — when the count starts again. */
  resetsOn: string;
  /** The sum of the month's 16 slots. */
  used: number;
}

/** The month's 1st in the organization's time zone, as a `date` (`tenancy.organizations.timezone`). */
function organizationMonthStart(organizationId: number) {
  return sql`(SELECT date_trunc('month', now() AT TIME ZONE ${organizations.timezone})::date
    FROM ${organizations} WHERE ${organizations.id} = ${organizationId})`;
}

/**
 * Drizzle access to `app.message_month_counts` (feat-instagram-dm-sending routes-final § 6.A.3, SN8,
 * D34): the month's read for the meter and the plan stop, and the add the send's claim makes.
 *
 * @remarks
 * - **Algorithm:** the month is the organization's (`now()` in `tenancy.organizations.timezone`,
 *   read in the same statement — the organization arm lets the scope read its own row); the slot is
 *   the channel account's internal id modulo {@link MESSAGE_MONTH_COUNT_SLOTS}, so accounts never
 *   wait on each other's row lock. Every statement names `organization_id`.
 * - **Failure modes:** none of its own; an organization the scope cannot see reads a zero month.
 * - **Side effects:** the add upserts one slot row.
 * - **Notes:** the 13-month delete (WC-54) is the hourly clean-up's (ROUTE row R50, {@link MessageMonthCountRepository.deleteMonthsBefore}).
 */
export class MessageMonthCountRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** This month's used count (the sum of its slots), its 1st and the 1st of next month. */
  async readMonth(organizationId: number): Promise<MessageMonthCountRead | null> {
    const monthStart = organizationMonthStart(organizationId);
    const result = await this.db().execute(sql`
      SELECT month.month_start::text AS month_start,
             (month.month_start + interval '1 month')::date::text AS resets_on,
             COALESCE((
               SELECT sum(${message_month_counts.count})
               FROM ${message_month_counts}
               WHERE ${message_month_counts.organization_id} = ${organizationId}
                 AND ${message_month_counts.month_start} = month.month_start
             ), 0)::int AS used
      FROM (SELECT ${monthStart} AS month_start) AS month
      WHERE month.month_start IS NOT NULL
    `);
    const [row] = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as { month_start: string; resets_on: string; used: number }[];
    return row === undefined
      ? null
      : { monthStart: row.month_start, resetsOn: row.resets_on, used: Number(row.used) };
  }

  /** Adds `count` messages to this month's slot of the channel account (the send's claim, SN3). */
  async addToMonth({
    organizationId,
    channelAccountId,
    count,
  }: {
    organizationId: number;
    channelAccountId: number;
    count: number;
  }): Promise<void> {
    await this.db()
      .insert(message_month_counts)
      .values({
        organization_id: organizationId,
        month_start: sql`${organizationMonthStart(organizationId)}`,
        slot: channelAccountId % MESSAGE_MONTH_COUNT_SLOTS,
        count,
      })
      .onConflictDoUpdate({
        target: [
          message_month_counts.organization_id,
          message_month_counts.month_start,
          message_month_counts.slot,
        ],
        set: {
          count: sql`${message_month_counts.count} + excluded.count`,
          updated_at: sql`greatest(${message_month_counts.updated_at}, now())`,
        },
      });
  }

  /**
   * Gives `count` messages back to this month's slot of the channel account (SN4: a claimed DM went
   * back to `waiting`), never below zero.
   */
  async subtractFromMonth({
    organizationId,
    channelAccountId,
    count,
  }: {
    organizationId: number;
    channelAccountId: number;
    count: number;
  }): Promise<void> {
    await this.db()
      .update(message_month_counts)
      .set({
        count: sql`greatest(${message_month_counts.count} - ${count}, 0)`,
        updated_at: sql`greatest(${message_month_counts.updated_at}, now())`,
      })
      .where(
        and(
          eq(message_month_counts.organization_id, organizationId),
          eq(message_month_counts.month_start, sql`${organizationMonthStart(organizationId)}`),
          eq(message_month_counts.slot, channelAccountId % MESSAGE_MONTH_COUNT_SLOTS),
        ),
      );
  }

  /**
   * The month counts' clean-up (WC-54): deletes the months that began before `cutoff` (13 months
   * back), at most `maxBatches` batches of {@link DEFAULT_BATCH_DELETE_ROW_COUNT} rows in this
   * unit of work (`idx_message_month_counts_month`). The table has no single id (its key is
   * organization, month and slot), so each batch deletes by `ctid` from a capped pick. Needs the
   * retention context ({@link createRetentionMessageMonthCountRepository}).
   */
  async deleteMonthsBefore({
    cutoff,
    maxBatches,
  }: {
    cutoff: Date;
    maxBatches: number;
  }): Promise<BatchDeleteResult> {
    let deletedCount = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await this.db().execute(sql`
        DELETE FROM app.message_month_counts
        WHERE ctid IN (
          SELECT ctid FROM app.message_month_counts
          WHERE month_start < ${cutoff.toISOString()}::timestamptz::date
          LIMIT ${DEFAULT_BATCH_DELETE_ROW_COUNT}
        )`);
      const deleted = result.rowCount ?? 0;
      deletedCount += deleted;
      if (deleted < DEFAULT_BATCH_DELETE_ROW_COUNT) {
        return { deletedCount, blockedCount: 0, hasMore: false };
      }
    }
    return { deletedCount, blockedCount: 0, hasMore: true };
  }

  /** Seconds the oldest month that began before `cutoff` is past it — the clean-up's gauge (P92). */
  async readMonthsOverdueSeconds(cutoff: Date): Promise<number> {
    return readOldestOverdueSeconds({
      databaseHandle: this.db(),
      table: message_month_counts,
      column: message_month_counts.month_start,
      cutoff,
      whereCondition: sql`${message_month_counts.month_start} < ${cutoff.toISOString()}::timestamptz::date`,
    });
  }
}

/**
 * {@link MessageMonthCountRepository} bound to a retention handle (`runGlobalRetentionWorkerJob`) — the month counts' 13-month clean-up (WC-54), which only
 * deletes (the policy's sweep arm is in `USING`).
 */
export function createRetentionMessageMonthCountRepository(
  databaseHandle: WorkerDatabaseHandle,
): MessageMonthCountRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new MessageMonthCountRepository(databaseHandle);
}
