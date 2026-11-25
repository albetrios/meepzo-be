import { sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { InstagramSendLane } from './instagram-sending.constants.js';
import type { InstagramMessageType } from './instagram-message/instagram-message.constants.js';

/** The rows of a raw `execute` — postgres-js answers an array, node-postgres `{ rows }`. */
function rowsOf<Row>(result: unknown): Row[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Row[];
}

/** One lane a repair read found, with the public ids its ticket names (K8). */
export interface InstagramRepairLaneRow {
  lane_id: number;
  organization_id: number;
  organization_public_id: string;
  channel_account_id: number;
  channel_account_public_id: string;
  lane: InstagramSendLane;
  turn_number: number;
  working_turn: number | null;
}

/** One message a repair read found: its key, its account's public ids and what the settle needs. */
export interface InstagramRepairMessageRow {
  id: number;
  public_id: string;
  organization_id: number;
  organization_public_id: string;
  channel_account_id: number;
  channel_account_public_id: string;
  automation_run_started_at: Date;
  message_type: InstagramMessageType;
  tries: number;
  instagram_message_id: string | null;
  /** The account's plan stop, when the read asks for it (the 7-day expiry's `plan_limit`). */
  plan_stop_reason: string | null;
  /** The fast lane's stop end, when the read asks for it (the spread after a stop, WC-13). */
  stop_until: Date | null;
}

/** One automation a repair read found (the reply trim, the paused cancel). */
export interface InstagramRepairAutomationRow {
  automation_id: number;
  organization_id: number;
  organization_public_id: string;
  /** The reply trim: the reply state's `waiting_count`; the paused cancel: 0. */
  waiting_count: number;
  /** The paused cancel: the pause's `cancelled_before_at`. */
  cancelled_before_at: Date | null;
}

/** One account's gate-1 hour as the minute counts hold it (WC-20's quick-count comparison). */
export interface InstagramRepairMinuteTotalRow {
  organization_public_id: string;
  channel_account_id: number;
  channel_account_public_id: string;
  count_group: string;
  total: number;
}

/** One organization's month: the count's slots against the counted DMs tried (WC-20, daily). */
export interface InstagramRepairMonthCheckRow {
  organization_id: number;
  organization_public_id: string;
  month_start: string;
  counted: number;
  tried: number;
}

/** The account columns every repair read that adds a ticket needs, and the held-account filter. */
const ACCOUNT_JOIN = sql`
  JOIN app.channel_accounts a ON a.organization_id = l.organization_id AND a.id = l.channel_account_id
  JOIN tenancy.organizations o ON o.id = l.organization_id`;
const LANE_COLUMNS = sql`
  l.id AS lane_id, l.organization_id, o.public_id AS organization_public_id, l.channel_account_id,
  a.public_id AS channel_account_public_id, l.lane, l.turn_number, l.working_turn`;
const ACCOUNT_FREE = sql`a.paused_at IS NULL AND a.suspended_at IS NULL AND o.deleted_at IS NULL`;
const MESSAGE_COLUMNS = sql`
  m.id, m.public_id, m.organization_id, o.public_id AS organization_public_id, m.channel_account_id,
  a.public_id AS channel_account_public_id, m.automation_run_started_at, m.message_type, m.tries,
  m.instagram_message_id`;

/**
 * The repair duties' reads and writes over the send tables (feat-instagram-dm-sending § 6 SN6,
 * SNC5; WC-13–WC-15, WC-17–WC-20; P94): the cross-organization reads by ids under the
 * `app.global_retention_cleanup` arm, and each organization's change in its own job scope.
 *
 * @remarks
 * - **Algorithm:** raw statements over `app.instagram_send_lanes`, `app.instagram_messages`,
 *   `app.channel_accounts`, `app.contact_activities`, `app.automations`,
 *   `app.automation_reply_states` and the count tables; every read is keyset-ordered by its id and
 *   capped by `limit`, on the partial indexes the send tables carry for them
 *   (`idx_instagram_send_lanes_next_run`, `_lease`, `idx_instagram_messages_pick`, `_sending`,
 *   `_expiry`, `_automation_waiting`, `idx_instagram_send_minute_counts_minute`).
 * - **Failure modes:** a database error propagates to the duty (the next minute tries again).
 * - **Side effects:** the writes named on each method.
 * - **Notes:** bound by {@link createRetentionInstagramSendingRepairRepository} (reads, and the
 *   minute-count delete — the sweep arm is in `USING`, which a delete reads) or
 *   {@link createWorkerInstagramSendingRepairRepository} (an organization's writes, which the
 *   policies' `WITH CHECK` needs).
 */
export class InstagramSendingRepairRepository {
  constructor(private readonly databaseHandle: RequestScopedPostgresDatabase) {}

  private async rows<Row>(statement: ReturnType<typeof sql>): Promise<Row[]> {
    return rowsOf<Row>(await this.databaseHandle.execute(statement));
  }

  // ── Cross-organization reads (the retention handle) ──────────────────────────────────────────

  /**
   * Slow, reply and broadcast lanes whose turn is over a minute late (WC-13): free and due, or
   * stopped with a stop that ended — of an account neither paused nor suspended.
   */
  async listLateLanes({
    lateBefore,
    afterLaneId,
    limit,
  }: {
    lateBefore: Date;
    afterLaneId: number;
    limit: number;
  }): Promise<InstagramRepairLaneRow[]> {
    return this.rows<InstagramRepairLaneRow>(sql`
      SELECT ${LANE_COLUMNS}
      FROM app.instagram_send_lanes l ${ACCOUNT_JOIN}
      WHERE l.lane <> 'fast' AND l.id > ${afterLaneId} AND ${ACCOUNT_FREE}
        AND ((l.state IN ('ready', 'sleeping') AND l.stop_reason IS NULL
              AND l.next_run_at <= ${lateBefore.toISOString()}::timestamptz)
          OR (l.state = 'stopped' AND l.stop_reason IS NOT NULL
              AND l.stop_until <= ${lateBefore.toISOString()}::timestamptz))
      ORDER BY l.id
      LIMIT ${limit}`);
  }

  /**
   * Slow, reply and broadcast lanes asleep with no next run while a message waits for them that may
   * go now (WC-13: "a ready lane with a message that can go and no turn") — free accounts only.
   */
  async listIdleLanesWithWork({
    now,
    afterLaneId,
    limit,
  }: {
    now: Date;
    afterLaneId: number;
    limit: number;
  }): Promise<InstagramRepairLaneRow[]> {
    return this.rows<InstagramRepairLaneRow>(sql`
      SELECT ${LANE_COLUMNS}
      FROM app.instagram_send_lanes l ${ACCOUNT_JOIN}
      WHERE l.lane <> 'fast' AND l.id > ${afterLaneId} AND ${ACCOUNT_FREE}
        AND l.state IN ('ready', 'sleeping') AND l.next_run_at IS NULL AND l.stop_reason IS NULL
        AND (a.plan_stop_reason IS NULL OR (a.plan_stop_reason = 'plan_limit' AND l.lane = 'reply'))
        AND EXISTS (
          SELECT 1 FROM app.instagram_messages m
          WHERE m.channel_account_id = l.channel_account_id AND m.lane = l.lane
            AND m.status = 'waiting'
            AND (m.not_before IS NULL OR m.not_before <= ${now.toISOString()}::timestamptz))
      ORDER BY l.id
      LIMIT ${limit}`);
  }

  /**
   * Waiting fast messages over a minute late (WC-13), of a free account whose fast lane holds no
   * running stop and whose plan stop does not hold it; `stop_until` is the fast lane's ended stop
   * (the spread over 5 minutes).
   */
  async listLateFastMessages({
    lateBefore,
    now,
    afterId,
    limit,
  }: {
    lateBefore: Date;
    now: Date;
    afterId: number;
    limit: number;
  }): Promise<InstagramRepairMessageRow[]> {
    return this.rows<InstagramRepairMessageRow>(sql`
      SELECT ${MESSAGE_COLUMNS}, NULL::varchar AS plan_stop_reason, l.stop_until
      FROM app.instagram_messages m
      JOIN app.instagram_send_lanes l
        ON l.organization_id = m.organization_id AND l.channel_account_id = m.channel_account_id
       AND l.lane = 'fast'
      ${ACCOUNT_JOIN}
      WHERE m.status = 'waiting' AND m.lane = 'fast' AND m.id > ${afterId}
        AND coalesce(m.not_before, m.created_at) <= ${lateBefore.toISOString()}::timestamptz
        AND ${ACCOUNT_FREE} AND a.plan_stop_reason IS NULL
        AND (l.stop_reason IS NULL OR l.stop_until <= ${now.toISOString()}::timestamptz)
      ORDER BY m.id
      LIMIT ${limit}`);
  }

  /** Fast lanes whose count of messages on their way differs from the messages `sending` (WC-13). */
  async listFastCountDrift({
    afterLaneId,
    limit,
  }: {
    afterLaneId: number;
    limit: number;
  }): Promise<InstagramRepairLaneRow[]> {
    return this.rows<InstagramRepairLaneRow>(sql`
      SELECT ${LANE_COLUMNS}
      FROM app.instagram_send_lanes l ${ACCOUNT_JOIN}
      WHERE l.lane = 'fast' AND l.id > ${afterLaneId}
        AND l.sending_count <> (
          SELECT count(*) FROM app.instagram_messages m
          WHERE m.channel_account_id = l.channel_account_id AND m.lane = 'fast'
            AND m.status = 'sending')
      ORDER BY l.id
      LIMIT ${limit}`);
  }

  /** Messages `sending` past the lease (WC-14): the worker died or its result save never landed. */
  async listStuckSendingMessages({
    sendingBefore,
    afterId,
    limit,
  }: {
    sendingBefore: Date;
    afterId: number;
    limit: number;
  }): Promise<InstagramRepairMessageRow[]> {
    return this.rows<InstagramRepairMessageRow>(sql`
      SELECT ${MESSAGE_COLUMNS}, NULL::varchar AS plan_stop_reason, NULL::timestamptz AS stop_until
      FROM app.instagram_messages m
      JOIN app.channel_accounts a ON a.organization_id = m.organization_id AND a.id = m.channel_account_id
      JOIN tenancy.organizations o ON o.id = m.organization_id
      WHERE m.status = 'sending' AND m.sending_at < ${sendingBefore.toISOString()}::timestamptz
        AND m.id > ${afterId}
      ORDER BY m.id
      LIMIT ${limit}`);
  }

  /** Lanes `working` whose turn lease ran out (WC-14: the worker died mid-turn). */
  async listExpiredLeaseLanes({
    now,
    afterLaneId,
    limit,
  }: {
    now: Date;
    afterLaneId: number;
    limit: number;
  }): Promise<InstagramRepairLaneRow[]> {
    return this.rows<InstagramRepairLaneRow>(sql`
      SELECT ${LANE_COLUMNS}
      FROM app.instagram_send_lanes l ${ACCOUNT_JOIN}
      WHERE l.state = 'working' AND l.lease_until < ${now.toISOString()}::timestamptz
        AND l.id > ${afterLaneId}
      ORDER BY l.id
      LIMIT ${limit}`);
  }

  /** Slow rows whose account test claim ran out unanswered (WC-14: the test ends "not clear"). */
  async listExpiredTests({
    now,
    afterLaneId,
    limit,
  }: {
    now: Date;
    afterLaneId: number;
    limit: number;
  }): Promise<InstagramRepairLaneRow[]> {
    return this.rows<InstagramRepairLaneRow>(sql`
      SELECT ${LANE_COLUMNS}
      FROM app.instagram_send_lanes l ${ACCOUNT_JOIN}
      WHERE l.lane = 'slow' AND l.testing_until < ${now.toISOString()}::timestamptz
        AND l.id > ${afterLaneId}
      ORDER BY l.id
      LIMIT ${limit}`);
  }

  /**
   * Waiting opening DMs, public replies and hides whose comment time is before `triggerBefore`
   * (WC-15, `idx_instagram_messages_expiry`); `plan_stop_reason` is the account's.
   */
  async listExpiredWaitingMessages({
    triggerBefore,
    afterId,
    limit,
  }: {
    triggerBefore: Date;
    afterId: number;
    limit: number;
  }): Promise<InstagramRepairMessageRow[]> {
    return this.rows<InstagramRepairMessageRow>(sql`
      SELECT ${MESSAGE_COLUMNS}, a.plan_stop_reason, NULL::timestamptz AS stop_until
      FROM app.instagram_messages m
      JOIN app.channel_accounts a ON a.organization_id = m.organization_id AND a.id = m.channel_account_id
      JOIN tenancy.organizations o ON o.id = m.organization_id
      WHERE m.status = 'waiting' AND m.lane IN ('slow', 'reply')
        AND m.trigger_occurred_at < ${triggerBefore.toISOString()}::timestamptz
        AND m.id > ${afterId}
      ORDER BY m.id
      LIMIT ${limit}`);
  }

  /**
   * Waiting DMs into her chat (the fast lane's `direct` messages: answers, list messages, nudges)
   * whose 24-hour window closed before `windowOpenSince` (WC-17).
   */
  async listClosedWindowMessages({
    windowOpenSince,
    afterId,
    limit,
  }: {
    windowOpenSince: Date;
    afterId: number;
    limit: number;
  }): Promise<InstagramRepairMessageRow[]> {
    return this.rows<InstagramRepairMessageRow>(sql`
      SELECT ${MESSAGE_COLUMNS}, NULL::varchar AS plan_stop_reason, NULL::timestamptz AS stop_until
      FROM app.instagram_messages m
      JOIN app.channel_accounts a ON a.organization_id = m.organization_id AND a.id = m.channel_account_id
      JOIN tenancy.organizations o ON o.id = m.organization_id
      LEFT JOIN app.contact_activities c
        ON c.organization_id = m.organization_id AND c.contact_id = m.contact_id
      WHERE m.status = 'waiting' AND m.lane = 'fast' AND m.channel = 'direct'
        AND (c.last_direct_message_received_at IS NULL
          OR c.last_direct_message_received_at < ${windowOpenSince.toISOString()}::timestamptz)
        AND m.id > ${afterId}
      ORDER BY m.id
      LIMIT ${limit}`);
  }

  /** "Reply like a person" automations holding over `maxWaiting` waiting replies (WC-18). */
  async listReplyBacklogs({
    maxWaiting,
    afterAutomationId,
    limit,
  }: {
    maxWaiting: number;
    afterAutomationId: number;
    limit: number;
  }): Promise<InstagramRepairAutomationRow[]> {
    return this.rows<InstagramRepairAutomationRow>(sql`
      SELECT s.automation_id, s.organization_id, o.public_id AS organization_public_id,
        s.waiting_count, NULL::timestamptz AS cancelled_before_at
      FROM app.automation_reply_states s
      JOIN app.automations au ON au.organization_id = s.organization_id AND au.id = s.automation_id
      JOIN tenancy.organizations o ON o.id = s.organization_id
      WHERE s.waiting_count > ${maxWaiting} AND au.is_reply_like_person_enabled
        AND s.automation_id > ${afterAutomationId}
      ORDER BY s.automation_id
      LIMIT ${limit}`);
  }

  /** Automations paused with Cancel that still hold waiting messages made before the pause (WC-19). */
  async listPausedCancelAutomations({
    afterAutomationId,
    limit,
  }: {
    afterAutomationId: number;
    limit: number;
  }): Promise<InstagramRepairAutomationRow[]> {
    return this.rows<InstagramRepairAutomationRow>(sql`
      SELECT au.id AS automation_id, au.organization_id, o.public_id AS organization_public_id,
        0 AS waiting_count, au.cancelled_before_at
      FROM app.automations au
      JOIN tenancy.organizations o ON o.id = au.organization_id
      WHERE au.cancelled_before_at IS NOT NULL AND au.id > ${afterAutomationId}
        AND EXISTS (
          SELECT 1 FROM app.instagram_messages m
          WHERE m.organization_id = au.organization_id AND m.automation_id = au.id
            AND m.status = 'waiting' AND m.created_at < au.cancelled_before_at)
      ORDER BY au.id
      LIMIT ${limit}`);
  }

  /** Deletes up to `limit` minute counts older than `before` (WC-20, the 2-hour keep). Answers how many. */
  async deleteOldMinuteCounts({ before, limit }: { before: Date; limit: number }): Promise<number> {
    const deleted = await this.rows<{ minute_start: Date }>(sql`
      DELETE FROM app.instagram_send_minute_counts
      WHERE ctid IN (
        SELECT ctid FROM app.instagram_send_minute_counts
        WHERE minute_start < ${before.toISOString()}::timestamptz
        ORDER BY minute_start
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING minute_start`);
    return deleted.length;
  }

  /** Each account's and count group's minute counts since `since` (WC-20's gate-1 comparison). */
  async listRecentMinuteTotals({
    since,
    limit,
  }: {
    since: Date;
    limit: number;
  }): Promise<InstagramRepairMinuteTotalRow[]> {
    return this.rows<InstagramRepairMinuteTotalRow>(sql`
      SELECT o.public_id AS organization_public_id, c.channel_account_id,
        a.public_id AS channel_account_public_id, c.count_group, sum(c.count)::int AS total
      FROM app.instagram_send_minute_counts c
      JOIN app.channel_accounts a ON a.organization_id = c.organization_id AND a.id = c.channel_account_id
      JOIN tenancy.organizations o ON o.id = c.organization_id
      WHERE c.minute_start >= ${since.toISOString()}::timestamptz
      GROUP BY o.public_id, c.channel_account_id, a.public_id, c.count_group
      ORDER BY c.channel_account_id, c.count_group
      LIMIT ${limit}`);
  }

  /**
   * Each organization's current month (WC-20, daily): the month count's slots against the counted
   * DMs tried since the month began in its time zone (sent, unknown or on their way).
   */
  async listMonthChecks({
    afterOrganizationId,
    limit,
  }: {
    afterOrganizationId: number;
    limit: number;
  }): Promise<InstagramRepairMonthCheckRow[]> {
    return this.rows<InstagramRepairMonthCheckRow>(sql`
      SELECT k.organization_id, o.public_id AS organization_public_id, k.month_start::text AS month_start,
        k.counted,
        (SELECT count(*)::int FROM app.instagram_messages m
          WHERE m.organization_id = k.organization_id AND m.is_counted_as_direct_message
            AND m.status IN ('sent', 'unknown', 'sending')
            AND coalesce(m.sent_at, m.sending_at, m.updated_at)
              >= (k.month_start::timestamp AT TIME ZONE o.timezone)) AS tried
      FROM (
        SELECT organization_id, month_start, sum(count)::int AS counted
        FROM app.message_month_counts
        WHERE organization_id > ${afterOrganizationId}
          AND month_start = (SELECT max(month_start) FROM app.message_month_counts x
                             WHERE x.organization_id = message_month_counts.organization_id)
        GROUP BY organization_id, month_start) k
      JOIN tenancy.organizations o ON o.id = k.organization_id
      ORDER BY k.organization_id
      LIMIT ${limit}`);
  }

  // ── One organization's writes (its job handle) ───────────────────────────────────────────────

  /**
   * Wakes one idle lane (WC-13): `ready` with a new turn now, only while it is still asleep with no
   * next run and no stop. Answers its new turn, or `null` when it moved meanwhile.
   */
  async wakeIdleLane({
    organizationId,
    laneId,
  }: {
    organizationId: number;
    laneId: number;
  }): Promise<number | null> {
    const [row] = await this.rows<{ turn_number: number }>(sql`
      UPDATE app.instagram_send_lanes
      SET state = 'ready', next_run_at = now(), wait_reason = NULL,
        turn_number = turn_number + 1, updated_at = greatest(now(), created_at)
      WHERE organization_id = ${organizationId} AND id = ${laneId}
        AND state IN ('ready', 'sleeping') AND next_run_at IS NULL AND stop_reason IS NULL
      RETURNING turn_number`);
    return row === undefined ? null : Number(row.turn_number);
  }

  /** Sets a fast lane's count of messages on their way to the messages `sending` (WC-13). */
  async fixFastSendingCount({
    organizationId,
    laneId,
  }: {
    organizationId: number;
    laneId: number;
  }): Promise<boolean> {
    const changed = await this.rows<{ id: number }>(sql`
      UPDATE app.instagram_send_lanes l
      SET sending_count = least(20, (
            SELECT count(*) FROM app.instagram_messages m
            WHERE m.organization_id = l.organization_id
              AND m.channel_account_id = l.channel_account_id
              AND m.lane = 'fast' AND m.status = 'sending')),
        updated_at = greatest(now(), l.created_at)
      WHERE l.organization_id = ${organizationId} AND l.id = ${laneId} AND l.lane = 'fast'
        AND l.sending_count <> (
            SELECT count(*) FROM app.instagram_messages m
            WHERE m.organization_id = l.organization_id
              AND m.channel_account_id = l.channel_account_id
              AND m.lane = 'fast' AND m.status = 'sending')
      RETURNING l.id`);
    return changed.length > 0;
  }

  /**
   * The oldest waiting public replies of one automation beyond its first `keep` (WC-18), oldest
   * first — their keys for the result save.
   */
  async listRepliesOverLimit({
    organizationId,
    automationId,
    keep,
    limit,
  }: {
    organizationId: number;
    automationId: number;
    keep: number;
    limit: number;
  }): Promise<{ public_id: string; automation_run_started_at: Date; id: number }[]> {
    return this.rows(sql`
      SELECT m.public_id, m.automation_run_started_at, m.id
      FROM app.instagram_messages m
      WHERE m.organization_id = ${organizationId} AND m.automation_id = ${automationId}
        AND m.status = 'waiting' AND m.message_type = 'public_reply'
      ORDER BY m.created_at, m.id
      LIMIT greatest(0, least(${limit}, (
        SELECT count(*) FROM app.instagram_messages w
        WHERE w.organization_id = ${organizationId} AND w.automation_id = ${automationId}
          AND w.status = 'waiting' AND w.message_type = 'public_reply') - ${keep}))`);
  }

  /**
   * Cancels up to `limit` waiting messages of one automation made before its pause with Cancel
   * (WC-19, `cancelled` · `cancelled_by_owner`). Answers how many.
   */
  async cancelWaitingBeforePause({
    organizationId,
    automationId,
    createdBefore,
    limit,
  }: {
    organizationId: number;
    automationId: number;
    createdBefore: Date;
    limit: number;
  }): Promise<number> {
    const cancelled = await this.rows<{ id: number }>(sql`
      UPDATE app.instagram_messages m
      SET status = 'cancelled', reason = 'cancelled_by_owner', updated_at = now()
      WHERE m.organization_id = ${organizationId} AND m.status = 'waiting'
        AND (m.id, m.automation_run_started_at) IN (
          SELECT w.id, w.automation_run_started_at FROM app.instagram_messages w
          WHERE w.organization_id = ${organizationId} AND w.automation_id = ${automationId}
            AND w.status = 'waiting' AND w.created_at < ${createdBefore.toISOString()}::timestamptz
          ORDER BY w.id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
      RETURNING m.id`);
    return cancelled.length;
  }
}

/**
 * {@link InstagramSendingRepairRepository} on a retention handle (`runGlobalRetentionWorkerJob`) —
 * the duties' cross-organization reads by ids and the minute-count delete.
 */
export function createRetentionInstagramSendingRepairRepository(
  databaseHandle: WorkerDatabaseHandle,
): InstagramSendingRepairRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new InstagramSendingRepairRepository(databaseHandle);
}

/** {@link InstagramSendingRepairRepository} on one organization's job handle — the duties' writes. */
export function createWorkerInstagramSendingRepairRepository(
  databaseHandle: WorkerDatabaseHandle,
): InstagramSendingRepairRepository {
  assertWorkerDatabaseContext(['organization']);
  return new InstagramSendingRepairRepository(databaseHandle);
}
