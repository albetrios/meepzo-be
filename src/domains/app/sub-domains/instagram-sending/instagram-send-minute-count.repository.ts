import { and, eq, gte, sql } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_MINUTE,
} from '@/shared/constants/ttl.constants.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { instagram_send_minute_counts } from './instagram-send-minute-count.schema.js';
import type { InstagramSendCountGroup } from './instagram-sending.constants.js';

/** Gate 2 sums the minute in progress and this many whole minutes before it (SN3): 61 rows in all. */
const GATE_TWO_PAST_MINUTES = MILLISECONDS_PER_HOUR / MILLISECONDS_PER_MINUTE;

/**
 * Drizzle access to `app.instagram_send_minute_counts` (feat-instagram-dm-sending routes-final
 * § 6.A.3, SN3): gate 2's add and its 61-minute sum.
 *
 * @remarks
 * - **Algorithm:** `minute_start` is Postgres's clock to the minute (never a server's); every
 *   statement names `organization_id` and `channel_account_id`.
 * - **Failure modes:** none of its own.
 * - **Side effects:** the add upserts one row.
 * - **Notes:** the claim's one commit (gate 2, the month, `sending`) is ROUTE row R42's; the 2-hour
 *   delete (WC-20) is the repair's (R47).
 */
export class InstagramSendMinuteCountRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Adds `count` to this minute's row of the account's group. */
  async addToMinute({
    countGroup,
    count,
    ...key
  }: ChannelAccountKey & { countGroup: InstagramSendCountGroup; count: number }): Promise<void> {
    await this.db()
      .insert(instagram_send_minute_counts)
      .values({
        organization_id: key.organizationId,
        channel_account_id: key.channelAccountId,
        count_group: countGroup,
        minute_start: sql`date_trunc('minute', now())`,
        count,
      })
      .onConflictDoUpdate({
        target: [
          instagram_send_minute_counts.organization_id,
          instagram_send_minute_counts.channel_account_id,
          instagram_send_minute_counts.count_group,
          instagram_send_minute_counts.minute_start,
        ],
        set: { count: sql`${instagram_send_minute_counts.count} + excluded.count` },
      });
  }

  /** The group's messages of the last 61 minutes (gate 2). */
  async sumLastHour({
    countGroup,
    ...key
  }: ChannelAccountKey & { countGroup: InstagramSendCountGroup }): Promise<number> {
    const rows = await this.db()
      .select({ total: sql<number>`COALESCE(sum(${instagram_send_minute_counts.count}), 0)::int` })
      .from(instagram_send_minute_counts)
      .where(
        and(
          eq(instagram_send_minute_counts.organization_id, key.organizationId),
          eq(instagram_send_minute_counts.channel_account_id, key.channelAccountId),
          eq(instagram_send_minute_counts.count_group, countGroup),
          gte(
            instagram_send_minute_counts.minute_start,
            sql`date_trunc('minute', now()) - make_interval(mins => ${GATE_TWO_PAST_MINUTES})`,
          ),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }
}
