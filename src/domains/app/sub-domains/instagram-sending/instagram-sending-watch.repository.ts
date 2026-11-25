import { type SQL, sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { automation_runs } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { instagram_messages } from './instagram-message/instagram-message.schema.js';
import { instagram_send_attempts } from './instagram-message/instagram-send-attempt.schema.js';
import { instagram_send_lanes } from './instagram-send-lane.schema.js';
import { instagram_send_minute_counts } from './instagram-send-minute-count.schema.js';

/**
 * One account a watch visits (its organization's public id mints the job scope it changes it in).
 *
 * @remarks
 * Notes: ids only — the watch reads across organizations, then works each in its own scope.
 */
export interface InstagramSendingWatchAccount {
  organizationId: number;
  organizationPublicId: string;
  channelAccountId: number;
  channelAccountPublicId: string;
  /** When the organization's month turns (its time zone) — a `plan_limit` stop's end (plan §12.3). */
  monthEndsAt: Date;
}

/** The Meta-side result groups the outage watch counts as bad (plan §33.5: no answer, try later). */
const BAD_RESULT_GROUPS = ['no_answer', 'try_later'] as const;

/**
 * The watches' cross-organization reads (feat-instagram-dm-sending WC-16, WC-22, WC-24, SNC9 —
 * ROUTE row R48): the last seconds' calls, the share of accounts in a down stop, the late lanes,
 * and the accounts with waiting Live replies or opening DMs.
 *
 * @remarks
 * - **Algorithm:** reads only, under the retention maintenance context (the sweep arm every table
 *   here carries in `USING`): counts, or pages of account ids by `channel_accounts.id`. Each
 *   account's change happens in its own organization scope (the watch processor).
 * - **Failure modes:** database errors propagate (the duty run fails, the next one runs).
 * - **Side effects:** none.
 */
export class InstagramSendingWatchRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Finished calls since `since` and how many were bad (no answer, try later) — WC-22's 30 % rule. */
  async summarizeRecentAttempts({
    since,
  }: {
    since: Date;
  }): Promise<{ callCount: number; badCount: number }> {
    const result = await this.db().execute<{ call_count: string; bad_count: string }>(sql`
      SELECT count(*)::text AS call_count,
             count(*) FILTER (WHERE ${instagram_send_attempts.result_group} IN (${sql.join(
               BAD_RESULT_GROUPS.map((group) => sql`${group}`),
               sql`, `,
             )}))::text AS bad_count
      FROM ${instagram_send_attempts}
      WHERE ${instagram_send_attempts.started_at} >= ${since.toISOString()}::timestamptz
        AND ${instagram_send_attempts.result_group} IS NOT NULL`);
    const row = result.rows[0];
    return { callCount: Number(row?.call_count ?? 0), badCount: Number(row?.bad_count ?? 0) };
  }

  /**
   * The active accounts (connected, not paused or suspended) and how many hold an `instagram_down`
   * stop on any lane now — WC-22's "30 % of accounts down" rule.
   */
  async countAccountsDown({
    now,
  }: {
    now: Date;
  }): Promise<{ activeCount: number; downCount: number }> {
    const result = await this.db().execute<{ active_count: string; down_count: string }>(sql`
      SELECT count(*)::text AS active_count,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM ${instagram_send_lanes}
               WHERE ${instagram_send_lanes.organization_id} = ${channel_accounts.organization_id}
                 AND ${instagram_send_lanes.channel_account_id} = ${channel_accounts.id}
                 AND ${instagram_send_lanes.stop_reason} = 'instagram_down'
                 AND ${instagram_send_lanes.stop_until} > ${now.toISOString()}::timestamptz
             ))::text AS down_count
      FROM ${channel_accounts}
      WHERE ${channel_accounts.channel} = 'instagram'
        AND ${channel_accounts.connection_status} = 'connected'
        AND ${channel_accounts.paused_at} IS NULL
        AND ${channel_accounts.suspended_at} IS NULL`);
    const row = result.rows[0];
    return {
      activeCount: Number(row?.active_count ?? 0),
      downCount: Number(row?.down_count ?? 0),
    };
  }

  /**
   * Lanes `ready` or `sleeping` whose turn is over `lateMinutes` late — the readiness body's "late
   * tickets" (SNC9; plan §40.1).
   */
  async countLateLanes({ now, lateMinutes }: { now: Date; lateMinutes: number }): Promise<number> {
    const result = await this.db().execute<{ late_count: string }>(sql`
      SELECT count(*)::text AS late_count
      FROM ${instagram_send_lanes}
      WHERE ${instagram_send_lanes.state} IN ('ready', 'sleeping')
        AND ${instagram_send_lanes.next_run_at} <
            ${now.toISOString()}::timestamptz - make_interval(mins => ${lateMinutes})`);
    return Number(result.rows[0]?.late_count ?? 0);
  }

  /**
   * One page of live accounts with at least one waiting Live private reply (a run started by a
   * `live_comment`) — WC-16's accounts, after `afterChannelAccountId`.
   */
  async listAccountsWithWaitingLiveReplies({
    afterChannelAccountId,
    limit,
  }: {
    afterChannelAccountId: number;
    limit: number;
  }): Promise<InstagramSendingWatchAccount[]> {
    return this.listAccounts({
      afterChannelAccountId,
      limit,
      waitingCondition: sql`EXISTS (
        SELECT 1 FROM ${instagram_messages}
        JOIN ${automation_runs}
          ON ${automation_runs.organization_id} = ${instagram_messages.organization_id}
         AND ${automation_runs.id} = ${instagram_messages.automation_run_id}
         AND ${automation_runs.started_at} = ${instagram_messages.automation_run_started_at}
        WHERE ${instagram_messages.organization_id} = ${channel_accounts.organization_id}
          AND ${instagram_messages.channel_account_id} = ${channel_accounts.id}
          AND ${instagram_messages.status} = 'waiting'
          AND ${instagram_messages.channel} = 'private_reply'
          AND ${automation_runs.trigger_type} = 'live_comment')`,
    });
  }

  /**
   * One page of live accounts with waiting opening DMs, or whose slow lane still shows an estimate
   * of waiting ones (so it is set back to 0) — WC-24's accounts, after `afterChannelAccountId`.
   */
  async listAccountsForWaitingEstimate({
    afterChannelAccountId,
    limit,
  }: {
    afterChannelAccountId: number;
    limit: number;
  }): Promise<InstagramSendingWatchAccount[]> {
    return this.listAccounts({
      afterChannelAccountId,
      limit,
      waitingCondition: sql`(EXISTS (
        SELECT 1 FROM ${instagram_messages}
        WHERE ${instagram_messages.organization_id} = ${channel_accounts.organization_id}
          AND ${instagram_messages.channel_account_id} = ${channel_accounts.id}
          AND ${instagram_messages.lane} = 'slow'
          AND ${instagram_messages.status} = 'waiting'
          AND ${instagram_messages.message_type} = 'opening_message')
        OR EXISTS (
        SELECT 1 FROM ${instagram_send_lanes}
        WHERE ${instagram_send_lanes.organization_id} = ${channel_accounts.organization_id}
          AND ${instagram_send_lanes.channel_account_id} = ${channel_accounts.id}
          AND ${instagram_send_lanes.lane} = 'slow'
          AND ${instagram_send_lanes.estimate_waiting_count} > 0))`,
    });
  }

  /**
   * The minute counts since `since` with their organization's and account's public ids — the "Redis
   * lost" rebuild of gate 1 from Postgres (WC-21, SN10).
   */
  async listRecentMinuteCounts({ since }: { since: Date }): Promise<
    {
      organizationPublicId: string;
      channelAccountPublicId: string;
      countGroup: string;
      minuteStart: Date;
      count: number;
    }[]
  > {
    const result = await this.db().execute<{
      organization_public_id: string;
      channel_account_public_id: string;
      count_group: string;
      minute_start: Date | string;
      count: number;
    }>(sql`
      SELECT ${organizations.public_id} AS organization_public_id,
             ${channel_accounts.public_id} AS channel_account_public_id,
             ${instagram_send_minute_counts.count_group} AS count_group,
             ${instagram_send_minute_counts.minute_start} AS minute_start,
             ${instagram_send_minute_counts.count} AS count
      FROM ${instagram_send_minute_counts}
      JOIN ${channel_accounts}
        ON ${channel_accounts.organization_id} = ${instagram_send_minute_counts.organization_id}
       AND ${channel_accounts.id} = ${instagram_send_minute_counts.channel_account_id}
      JOIN ${organizations} ON ${organizations.id} = ${instagram_send_minute_counts.organization_id}
      WHERE ${instagram_send_minute_counts.minute_start} >= ${since.toISOString()}::timestamptz
        AND ${instagram_send_minute_counts.count} > 0`);
    return result.rows.map((row) => ({
      organizationPublicId: row.organization_public_id,
      channelAccountPublicId: row.channel_account_public_id,
      countGroup: row.count_group,
      minuteStart: new Date(row.minute_start),
      count: Number(row.count),
    }));
  }

  /** A page of not-revoked Instagram accounts of live organizations matching `waitingCondition`. */
  private async listAccounts({
    afterChannelAccountId,
    limit,
    waitingCondition,
  }: {
    afterChannelAccountId: number;
    limit: number;
    waitingCondition: SQL;
  }): Promise<InstagramSendingWatchAccount[]> {
    const result = await this.db().execute<{
      organization_id: string;
      organization_public_id: string;
      channel_account_id: string;
      channel_account_public_id: string;
      month_ends_at: Date | string;
    }>(sql`
      SELECT ${channel_accounts.organization_id}::text AS organization_id,
             ${organizations.public_id} AS organization_public_id,
             ${channel_accounts.id}::text AS channel_account_id,
             ${channel_accounts.public_id} AS channel_account_public_id,
             ((date_trunc('month', now() AT TIME ZONE ${organizations.timezone}) + interval '1 month')
               AT TIME ZONE ${organizations.timezone}) AS month_ends_at
      FROM ${channel_accounts}
      JOIN ${organizations} ON ${organizations.id} = ${channel_accounts.organization_id}
      WHERE ${channel_accounts.id} > ${afterChannelAccountId}
        AND ${channel_accounts.channel} = 'instagram'
        AND ${channel_accounts.connection_status} <> 'revoked'
        AND ${organizations.deleted_at} IS NULL
        AND ${waitingCondition}
      ORDER BY ${channel_accounts.id}
      LIMIT ${limit}`);
    return result.rows.map((row) => ({
      organizationId: Number(row.organization_id),
      organizationPublicId: row.organization_public_id,
      channelAccountId: Number(row.channel_account_id),
      channelAccountPublicId: row.channel_account_public_id,
      monthEndsAt: new Date(row.month_ends_at),
    }));
  }
}

/**
 * {@link InstagramSendingWatchRepository} bound to a retention maintenance handle — the watches'
 * cross-organization reads (ROUTE row R48), through the sweep arm each table carries in `USING`
 * only (it reads every organization's rows and can write none).
 */
export function createRetentionInstagramSendingWatchRepository(
  databaseHandle: WorkerDatabaseHandle,
): InstagramSendingWatchRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new InstagramSendingWatchRepository(databaseHandle);
}
