import { sql } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
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
 * - **Notes:** the 13-month delete (WC-54) is the hourly clean-up's (ROUTE row R47).
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
}
