import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type BatchDeleteResult,
  deleteInBatchesByCondition,
  readOldestOverdueSeconds,
} from '@/infrastructure/database/utils/batch-delete.util.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import type { ChannelAccountPlanStopReason } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { instagram_send_stops } from './instagram-send-stop.schema.js';
import type {
  InstagramSendStopEndedBy,
  InstagramSendStopLane,
  InstagramSendStopReason,
} from './instagram-sending.constants.js';

/** One `app.instagram_send_stops` row as Drizzle reads it. */
export type InstagramSendStopRow = typeof instagram_send_stops.$inferSelect;

/** The reasons a stop history row may carry: a stop group (SN5) or a plan stop (CA3). */
export type InstagramSendStopHistoryReason = InstagramSendStopReason | ChannelAccountPlanStopReason;

/** The plan stops' reasons — recorded with lane `all` (SN13). */
const PLAN_STOP_REASONS: readonly ChannelAccountPlanStopReason[] = [
  'plan_limit',
  'plan_ended',
  'plan_downgrade',
];

/**
 * Drizzle access to `app.instagram_send_stops` (feat-instagram-dm-sending routes-final § 6.A.3,
 * SN13): a row per stop that starts, its end stamped once.
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id` and `channel_account_id`. An end only
 *   touches rows still open (`ended_at IS NULL`), so ending twice changes nothing.
 * - **Failure modes:** none of its own.
 * - **Side effects:** writes `app.instagram_send_stops` only.
 * - **Notes:** the 90-day delete (WC-53) is the hourly clean-up's (ROUTE row R47).
 */
export class InstagramSendStopRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  private keyOf({ organizationId, channelAccountId }: ChannelAccountKey) {
    return and(
      eq(instagram_send_stops.organization_id, organizationId),
      eq(instagram_send_stops.channel_account_id, channelAccountId),
    );
  }

  /** Records one stop that started. */
  async insertStop({
    lane,
    reason,
    stopUntil,
    errorCode,
    errorSubcode,
    ...key
  }: ChannelAccountKey & {
    lane: InstagramSendStopLane;
    reason: InstagramSendStopHistoryReason;
    stopUntil: Date | null;
    errorCode: number | null;
    errorSubcode: number | null;
  }): Promise<InstagramSendStopRow> {
    const [row] = await this.db()
      .insert(instagram_send_stops)
      .values({
        organization_id: key.organizationId,
        channel_account_id: key.channelAccountId,
        lane,
        reason,
        stop_until: stopUntil,
        error_code: errorCode,
        error_subcode: errorSubcode,
      })
      .returning();
    if (row === undefined) throw new Error('instagram send stop was not recorded');
    return row;
  }

  /** Ends the account's open stops of these reasons; returns how many it ended. */
  async endOpenStops({
    reasons,
    endedBy,
    ...key
  }: ChannelAccountKey & {
    reasons: readonly InstagramSendStopHistoryReason[];
    endedBy: InstagramSendStopEndedBy;
  }): Promise<number> {
    if (reasons.length === 0) return 0;
    const rows = await this.db()
      .update(instagram_send_stops)
      .set({
        ended_at: sql`greatest(${instagram_send_stops.started_at}, now())`,
        ended_by: endedBy,
      })
      .where(
        and(
          this.keyOf(key),
          isNull(instagram_send_stops.ended_at),
          inArray(instagram_send_stops.reason, [...reasons]),
        ),
      )
      .returning({ id: instagram_send_stops.id });
    return rows.length;
  }

  /**
   * Ends the account's open plan-stop rows whose reason the account no longer holds (a choose-active
   * account, a month wake): its `plan_stop_reason` is read in the same statement. Returns how many.
   */
  async endPlanStopsNoLongerHeld({
    endedBy,
    ...key
  }: ChannelAccountKey & { endedBy: InstagramSendStopEndedBy }): Promise<number> {
    const held = this.db()
      .select({ reason: channel_accounts.plan_stop_reason })
      .from(channel_accounts)
      .where(
        and(
          eq(channel_accounts.organization_id, key.organizationId),
          eq(channel_accounts.id, key.channelAccountId),
        ),
      );
    const rows = await this.db()
      .update(instagram_send_stops)
      .set({
        ended_at: sql`greatest(${instagram_send_stops.started_at}, now())`,
        ended_by: endedBy,
      })
      .where(
        and(
          this.keyOf(key),
          isNull(instagram_send_stops.ended_at),
          eq(instagram_send_stops.lane, 'all'),
          inArray(instagram_send_stops.reason, [...PLAN_STOP_REASONS]),
          sql`${instagram_send_stops.reason} IS DISTINCT FROM (${held})`,
        ),
      )
      .returning({ id: instagram_send_stops.id });
    return rows.length;
  }

  /** Whether the account has an open stop row of this lane and reason. */
  async hasOpenStop({
    lane,
    reason,
    ...key
  }: ChannelAccountKey & {
    lane: InstagramSendStopLane;
    reason: InstagramSendStopHistoryReason;
  }): Promise<boolean> {
    const rows = await this.db()
      .select({ id: instagram_send_stops.id })
      .from(instagram_send_stops)
      .where(
        and(
          this.keyOf(key),
          isNull(instagram_send_stops.ended_at),
          eq(instagram_send_stops.lane, lane),
          eq(instagram_send_stops.reason, reason),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The account's stops still open, oldest first (route 63's `started_at` per lane). */
  async listOpenByAccount(key: ChannelAccountKey): Promise<InstagramSendStopRow[]> {
    return this.db()
      .select()
      .from(instagram_send_stops)
      .where(and(this.keyOf(key), isNull(instagram_send_stops.ended_at)))
      .orderBy(instagram_send_stops.started_at, instagram_send_stops.id);
  }

  /** The account's newest stops, newest first (the team's history read). */
  async listRecentByAccount({
    limit,
    ...key
  }: ChannelAccountKey & { limit: number }): Promise<InstagramSendStopRow[]> {
    return this.db()
      .select()
      .from(instagram_send_stops)
      .where(this.keyOf(key))
      .orderBy(desc(instagram_send_stops.started_at), desc(instagram_send_stops.id))
      .limit(limit);
  }

  /**
   * Every account stop that started since `since`, across organizations, oldest first — the owners'
   * problem emails' one read (feat-instagram-dm-sending WC-57) over `idx_instagram_send_stops_started`.
   * Runs under the retention sweep arm (the policy's `USING` arm — read only).
   */
  async listStartedSinceAcrossOrganizations({
    since,
  }: {
    since: Date;
  }): Promise<InstagramSendStopAcrossRow[]> {
    const result = await this.db().execute(sql`
      SELECT o.public_id AS organization_public_id, ca.public_id AS channel_account_public_id,
             ca.display_name, s.reason, s.started_at, s.ended_at
      FROM ${instagram_send_stops} s
      JOIN ${channel_accounts} ca
        ON ca.organization_id = s.organization_id AND ca.id = s.channel_account_id
      JOIN tenancy.organizations o ON o.id = s.organization_id
      WHERE s.started_at >= ${since.toISOString()}::timestamptz
        AND o.deleted_at IS NULL
      ORDER BY s.started_at, s.id
    `);
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      organizationPublicId: String(row.organization_public_id),
      channelAccountPublicId: String(row.channel_account_public_id),
      displayName: String(row.display_name),
      reason: String(row.reason),
      startedAt: new Date(String(row.started_at)),
      endedAt: row.ended_at === null ? null : new Date(row.ended_at as string),
    }));
  }

  /**
   * The stop history's clean-up (WC-53): deletes ENDED stops that started before `cutoff`, at most
   * `maxBatches` batches in this unit of work (`idx_instagram_send_stops_started`). A stop still
   * open is kept whatever its age — it is the account's current state. Needs the retention context
   * ({@link createRetentionInstagramSendStopRepository}).
   */
  async deleteEndedStartedBefore({
    cutoff,
    maxBatches,
  }: {
    cutoff: Date;
    maxBatches: number;
  }): Promise<BatchDeleteResult> {
    return deleteInBatchesByCondition({
      databaseHandle: this.db(),
      table: instagram_send_stops,
      idColumn: instagram_send_stops.id,
      whereCondition: this.endedStartedBefore(cutoff),
      maxBatches,
      logContext: 'instagram-send-stop-retention',
      tableLabel: 'app.instagram_send_stops',
    });
  }

  /** Seconds the oldest ended stop started before `cutoff` is past it — the clean-up's gauge (P92). */
  async readEndedStartedOverdueSeconds(cutoff: Date): Promise<number> {
    return readOldestOverdueSeconds({
      databaseHandle: this.db(),
      table: instagram_send_stops,
      column: instagram_send_stops.started_at,
      cutoff,
      whereCondition: this.endedStartedBefore(cutoff),
    });
  }

  private endedStartedBefore(cutoff: Date) {
    return sql`${instagram_send_stops.started_at} < ${cutoff.toISOString()}::timestamptz AND ${instagram_send_stops.ended_at} IS NOT NULL`;
  }
}

/** One stop as {@link InstagramSendStopRepository.listStartedSinceAcrossOrganizations} reads it. */
export interface InstagramSendStopAcrossRow {
  organizationPublicId: string;
  channelAccountPublicId: string;
  displayName: string;
  reason: string;
  startedAt: Date;
  endedAt: Date | null;
}

/**
 * {@link InstagramSendStopRepository} bound to a retention handle (`runGlobalRetentionWorkerJob`) — the owners'
 * problem emails' cross-organization read (WC-57) and the stop history's 90-day clean-up (WC-53), which
 * only reads and deletes (the policy's sweep arm is in `USING`).
 *
 * @remarks
 * Asserts the worker context kind, as the other retention repositories do.
 */
export function createRetentionInstagramSendStopRepository(
  databaseHandle: WorkerDatabaseHandle,
): InstagramSendStopRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new InstagramSendStopRepository(databaseHandle);
}
