import { and, eq, sql } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { instagram_send_day_counts } from './instagram-send-day-count.schema.js';

/** One account's counters of one day (S8). */
export interface InstagramSendDayCounts {
  sent: number;
  unknown: number;
  skipped: number;
  skippedWindowClosed: number;
  expired: number;
}

/** Today in the organization's time zone, as a `date`. */
function organizationToday(organizationId: number) {
  return sql`(SELECT (now() AT TIME ZONE ${organizations.timezone})::date
    FROM ${organizations} WHERE ${organizations.id} = ${organizationId})`;
}

/**
 * Drizzle access to `app.instagram_send_day_counts` (feat-instagram-dm-sending scale review S8,
 * P97): route 63's "today" line, and the add the one shared result save makes (ROUTE row R42).
 *
 * @remarks
 * - **Algorithm:** the day is the organization's (`now()` in `tenancy.organizations.timezone`, read
 *   in the same statement); every statement names `organization_id` and `channel_account_id`.
 * - **Failure modes:** none of its own; a day with no row reads all zeros.
 * - **Side effects:** the add upserts one row.
 * - **Notes:** rows are deleted by age with the month counts (the hourly clean-up, ROUTE row R47).
 */
export class InstagramSendDayCountRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Today's counters of the account (all zeros when nothing happened yet). */
  async readToday(key: ChannelAccountKey): Promise<InstagramSendDayCounts> {
    const rows = await this.db()
      .select()
      .from(instagram_send_day_counts)
      .where(
        and(
          eq(instagram_send_day_counts.organization_id, key.organizationId),
          eq(instagram_send_day_counts.channel_account_id, key.channelAccountId),
          sql`${instagram_send_day_counts.day_date} = ${organizationToday(key.organizationId)}`,
        ),
      )
      .limit(1);
    const row = rows[0];
    return {
      sent: row?.sent_count ?? 0,
      unknown: row?.unknown_count ?? 0,
      skipped: row?.skipped_count ?? 0,
      skippedWindowClosed: row?.skipped_window_closed_count ?? 0,
      expired: row?.expired_count ?? 0,
    };
  }

  /** Adds results to today's row of the account (the result save's commit, S8). */
  async addToToday({
    counts,
    ...key
  }: ChannelAccountKey & { counts: Partial<InstagramSendDayCounts> }): Promise<void> {
    const values = {
      sent_count: counts.sent ?? 0,
      unknown_count: counts.unknown ?? 0,
      skipped_count: counts.skipped ?? 0,
      skipped_window_closed_count: counts.skippedWindowClosed ?? 0,
      expired_count: counts.expired ?? 0,
    };
    await this.db()
      .insert(instagram_send_day_counts)
      .values({
        organization_id: key.organizationId,
        channel_account_id: key.channelAccountId,
        day_date: sql`${organizationToday(key.organizationId)}`,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          instagram_send_day_counts.organization_id,
          instagram_send_day_counts.channel_account_id,
          instagram_send_day_counts.day_date,
        ],
        set: {
          sent_count: sql`${instagram_send_day_counts.sent_count} + excluded.sent_count`,
          unknown_count: sql`${instagram_send_day_counts.unknown_count} + excluded.unknown_count`,
          skipped_count: sql`${instagram_send_day_counts.skipped_count} + excluded.skipped_count`,
          skipped_window_closed_count: sql`${instagram_send_day_counts.skipped_window_closed_count} + excluded.skipped_window_closed_count`,
          expired_count: sql`${instagram_send_day_counts.expired_count} + excluded.expired_count`,
          updated_at: sql`greatest(${instagram_send_day_counts.updated_at}, now())`,
        },
      });
  }
}
