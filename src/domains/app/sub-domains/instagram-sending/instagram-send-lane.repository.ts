import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { databaseUpdatedAtTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { instagram_send_lanes } from './instagram-send-lane.schema.js';
import type { InstagramSendLanePaceUpdate } from './instagram-sending.types.js';
import {
  INSTAGRAM_SEND_LANE_STATE,
  INSTAGRAM_SEND_LANES,
  INSTAGRAM_SEND_STOP_REASONS,
  type InstagramSendLane,
  type InstagramSendStopReason,
  type InstagramSendWaitReason,
} from './instagram-sending.constants.js';

/** One `app.instagram_send_lanes` row as Drizzle reads it. */
export type InstagramSendLaneRow = typeof instagram_send_lanes.$inferSelect;

/** `updated_at` for every change of a lane — never before the row's `created_at`. */
const laneUpdatedAtTimestamp = databaseUpdatedAtTimestamp(instagram_send_lanes.created_at);

/** The release's pace columns (box, last send, mix place) — only the ones a send moved. */
function paceColumnsOf(
  paceUpdate: InstagramSendLanePaceUpdate | undefined,
): Partial<Pick<InstagramSendLaneRow, 'box_start' | 'last_sent_at' | 'pick_count'>> {
  if (paceUpdate === undefined) return {};
  return {
    ...(paceUpdate.boxStart === undefined ? {} : { box_start: paceUpdate.boxStart }),
    ...(paceUpdate.lastSentAt === undefined ? {} : { last_sent_at: paceUpdate.lastSentAt }),
    ...(paceUpdate.pickCount === undefined ? {} : { pick_count: paceUpdate.pickCount }),
  };
}

/** One stop group as a quoted Postgres text literal (the groups are fixed constants, never input). */
function quotedStopReason(reason: InstagramSendStopReason): string {
  return `'${reason}'`;
}

/** The stop groups weakest first, as a Postgres array for `array_position` (SN5). */
const STOP_STRENGTH_ARRAY = sql.raw(
  `ARRAY[${INSTAGRAM_SEND_STOP_REASONS.map(quotedStopReason).join(', ')}]::varchar[]`,
);

/** What a new error stop writes (SN5, SN12). */
export interface InstagramSendLaneStopValues {
  lanes: readonly InstagramSendLane[];
  reason: InstagramSendStopReason;
  /** `null` = until the owner acts (a reconnect). */
  stopUntil: Date | null;
  errorCode: number | null;
  errorSubcode: number | null;
}

/**
 * Drizzle access to `app.instagram_send_lanes` (feat-instagram-dm-sending routes-final § 6.A.3,
 * SNC10): the four rows of an account made at the pick, and the guarded updates of the turn, the
 * lease and the error stop.
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id` and `channel_account_id`, so isolation does
 *   not rest on RLS alone. Every change is guarded in its `WHERE` — a turn is claimed only while the
 *   lane is not `working` and the ticket's turn is the lane's (a lane is never worked by two turns);
 *   a stop replaces the current one only when at least as strong ({@link STOP_STRENGTH_ARRAY});
 *   a release only while `working_turn` is the caller's.
 * - **Failure modes:** none of its own — a guard that matches nothing returns no rows.
 * - **Side effects:** writes `app.instagram_send_lanes` only.
 * - **Notes:** the pause, the suspend and the plan stop are the channel account's (P99) — no
 *   statement here reads or writes them.
 */
export class InstagramSendLaneRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  private keyOf({ organizationId, channelAccountId }: ChannelAccountKey) {
    return and(
      eq(instagram_send_lanes.organization_id, organizationId),
      eq(instagram_send_lanes.channel_account_id, channelAccountId),
    );
  }

  /** The account's four `ready` lanes, kept when they already exist (a reconnect, MC6). */
  async insertLanes(key: ChannelAccountKey): Promise<number> {
    const rows = await this.db()
      .insert(instagram_send_lanes)
      .values(
        INSTAGRAM_SEND_LANES.map((lane) => ({
          organization_id: key.organizationId,
          channel_account_id: key.channelAccountId,
          lane,
        })),
      )
      .onConflictDoNothing({
        target: [
          instagram_send_lanes.organization_id,
          instagram_send_lanes.channel_account_id,
          instagram_send_lanes.lane,
        ],
      })
      .returning({ id: instagram_send_lanes.id });
    return rows.length;
  }

  /** The account's lanes in the order slow, reply, fast, broadcast. */
  async listByAccount(key: ChannelAccountKey): Promise<InstagramSendLaneRow[]> {
    const rows = await this.db()
      .select()
      .from(instagram_send_lanes)
      .where(this.keyOf(key))
      .orderBy(asc(instagram_send_lanes.id));
    return [...rows].sort(
      (left, right) =>
        INSTAGRAM_SEND_LANES.indexOf(left.lane as InstagramSendLane) -
        INSTAGRAM_SEND_LANES.indexOf(right.lane as InstagramSendLane),
    );
  }

  /**
   * Every lane stopped with no turn (MC8, CA8, CA9): `stopped`, no lease, no next run. The error
   * stop stays as it is.
   */
  async stopTurns(key: ChannelAccountKey): Promise<number> {
    const rows = await this.db()
      .update(instagram_send_lanes)
      .set({
        state: INSTAGRAM_SEND_LANE_STATE.STOPPED,
        working_turn: null,
        lease_until: null,
        next_run_at: null,
        wait_reason: 'stop',
        updated_at: laneUpdatedAtTimestamp,
      })
      .where(this.keyOf(key))
      .returning({ id: instagram_send_lanes.id });
    return rows.length;
  }

  /**
   * Each `stopped` or `sleeping` lane without an error stop gets a new turn now (route 10's resume,
   * route 11's activated account, route 12's limit change, MC6's reconnect). A `working` lane keeps
   * its turn; a lane with an error stop stays stopped (AC-2.3).
   */
  async wake(key: ChannelAccountKey): Promise<InstagramSendLane[]> {
    const rows = await this.db()
      .update(instagram_send_lanes)
      .set({
        state: INSTAGRAM_SEND_LANE_STATE.READY,
        next_run_at: sql`now()`,
        wait_reason: null,
        turn_number: sql`${instagram_send_lanes.turn_number} + 1`,
        updated_at: laneUpdatedAtTimestamp,
      })
      .where(
        and(
          this.keyOf(key),
          isNull(instagram_send_lanes.stop_reason),
          inArray(instagram_send_lanes.state, [
            INSTAGRAM_SEND_LANE_STATE.STOPPED,
            INSTAGRAM_SEND_LANE_STATE.SLEEPING,
          ]),
        ),
      )
      .returning({ lane: instagram_send_lanes.lane });
    return rows.map((row) => row.lane as InstagramSendLane);
  }

  /**
   * Starts an error stop on these lanes (SN5, SN12): only where the lane has no stop or a stop no
   * stronger than this one (a stronger stop wins). A lane mid-turn keeps its lease — the stop holds
   * from its next turn; any other lane is `stopped` with no next run. The same group again counts
   * up `stop_count`; another group starts it at 1. Returns the lanes it changed.
   */
  async startStop({
    lanes,
    reason,
    stopUntil,
    errorCode,
    errorSubcode,
    ...key
  }: ChannelAccountKey & InstagramSendLaneStopValues): Promise<InstagramSendLane[]> {
    if (lanes.length === 0) return [];
    const rows = await this.db()
      .update(instagram_send_lanes)
      .set({
        state: sql`CASE WHEN ${instagram_send_lanes.state} = 'working' THEN 'working' ELSE 'stopped' END`,
        next_run_at: sql`CASE WHEN ${instagram_send_lanes.state} = 'working' THEN ${instagram_send_lanes.next_run_at} ELSE NULL END`,
        wait_reason: 'stop',
        stop_count: sql`CASE WHEN ${instagram_send_lanes.stop_reason} = ${reason} THEN ${instagram_send_lanes.stop_count} + 1 ELSE 1 END`,
        stop_reason: reason,
        stop_until: stopUntil,
        stop_error_code: errorCode,
        stop_error_subcode: errorSubcode,
        updated_at: laneUpdatedAtTimestamp,
      })
      .where(
        and(
          this.keyOf(key),
          inArray(instagram_send_lanes.lane, [...lanes]),
          sql`(${instagram_send_lanes.stop_reason} IS NULL
            OR array_position(${STOP_STRENGTH_ARRAY}, ${instagram_send_lanes.stop_reason})
              <= array_position(${STOP_STRENGTH_ARRAY}, ${reason}::varchar))`,
        ),
      )
      .returning({ lane: instagram_send_lanes.lane });
    return rows.map((row) => row.lane as InstagramSendLane);
  }

  /**
   * Ends the error stops of these groups (a reconnect, a test that passed, the stop's time): the
   * stop cleared, and a lane not mid-turn `ready` with a new turn now. Returns the lanes it changed.
   */
  async endStops({
    reasons,
    ...key
  }: ChannelAccountKey & {
    reasons: readonly InstagramSendStopReason[];
  }): Promise<InstagramSendLane[]> {
    if (reasons.length === 0) return [];
    const isWorking = sql`${instagram_send_lanes.state} = 'working'`;
    const rows = await this.db()
      .update(instagram_send_lanes)
      .set({
        state: sql`CASE WHEN ${isWorking} THEN 'working' ELSE 'ready' END`,
        next_run_at: sql`CASE WHEN ${isWorking} THEN ${instagram_send_lanes.next_run_at} ELSE now() END`,
        wait_reason: sql`CASE WHEN ${isWorking} THEN ${instagram_send_lanes.wait_reason} ELSE NULL END`,
        turn_number: sql`CASE WHEN ${isWorking} THEN ${instagram_send_lanes.turn_number} ELSE ${instagram_send_lanes.turn_number} + 1 END`,
        stop_reason: null,
        stop_until: null,
        stop_count: 0,
        stop_error_code: null,
        stop_error_subcode: null,
        stop_cleared_at: sql`now()`,
        updated_at: laneUpdatedAtTimestamp,
      })
      .where(
        and(
          this.keyOf(key),
          isNotNull(instagram_send_lanes.stop_reason),
          inArray(instagram_send_lanes.stop_reason, [...reasons]),
        ),
      )
      .returning({ lane: instagram_send_lanes.lane });
    return rows.map((row) => row.lane as InstagramSendLane);
  }

  /**
   * Claims one turn of a lane (plan §28.1): only while the ticket's turn is the lane's, the lane is
   * not `working` and holds no error stop — so a lane is never worked by two turns. Sets the lease.
   * Returns the claimed row, or `null` when the guard did not match.
   */
  async claimTurn({
    lane,
    turnNumber,
    leaseSeconds,
    ...key
  }: ChannelAccountKey & {
    lane: InstagramSendLane;
    turnNumber: number;
    leaseSeconds: number;
  }): Promise<InstagramSendLaneRow | null> {
    const rows = await this.db()
      .update(instagram_send_lanes)
      .set({
        state: INSTAGRAM_SEND_LANE_STATE.WORKING,
        working_turn: turnNumber,
        lease_until: sql`now() + make_interval(secs => ${leaseSeconds})`,
        wait_reason: null,
        updated_at: laneUpdatedAtTimestamp,
      })
      .where(
        and(
          this.keyOf(key),
          eq(instagram_send_lanes.lane, lane),
          eq(instagram_send_lanes.turn_number, turnNumber),
          inArray(instagram_send_lanes.state, [
            INSTAGRAM_SEND_LANE_STATE.READY,
            INSTAGRAM_SEND_LANE_STATE.SLEEPING,
          ]),
          isNull(instagram_send_lanes.stop_reason),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Releases a worked turn (plan §28.1): only while `working_turn` is the caller's. The lane sleeps
   * until `nextRunAt` with the next turn number (the fast lane is `ready` again) — or is `stopped`
   * when a stop started meanwhile.
   */
  async releaseTurn({
    lane,
    workingTurn,
    nextRunAt,
    isHeld = false,
    waitReason = null,
    paceUpdate,
    ...key
  }: ChannelAccountKey & {
    lane: InstagramSendLane;
    workingTurn: number;
    /** `null` = no next run: the lane waits for a wake (new work, a resume, a stop's end). */
    nextRunAt: Date | null;
    /** The account holds this lane (pause, suspend, plan stop): `stopped` until its wake. */
    isHeld?: boolean;
    waitReason?: InstagramSendWaitReason | null;
    /** The pace columns a send moved (plan §28.3 rule 6: in the release's commit); absent = kept. */
    paceUpdate?: InstagramSendLanePaceUpdate | undefined;
  }): Promise<InstagramSendLaneRow | null> {
    const isStopped = isHeld ? sql`true` : sql`${instagram_send_lanes.stop_reason} IS NOT NULL`;
    const nextRun =
      nextRunAt === null ? sql`NULL::timestamptz` : sql`${nextRunAt.toISOString()}::timestamptz`;
    // The fast lane is only ever `ready` or `stopped` (6.A.3).
    const idleState =
      lane === 'fast' ? INSTAGRAM_SEND_LANE_STATE.READY : INSTAGRAM_SEND_LANE_STATE.SLEEPING;
    const rows = await this.db()
      .update(instagram_send_lanes)
      .set({
        state: sql`CASE WHEN ${isStopped} THEN 'stopped' ELSE ${idleState} END`,
        working_turn: null,
        lease_until: null,
        turn_number: sql`${instagram_send_lanes.turn_number} + 1`,
        next_run_at: sql`CASE WHEN ${isStopped} THEN NULL::timestamptz ELSE ${nextRun} END`,
        wait_reason: sql`CASE WHEN ${isStopped} THEN 'stop' ELSE ${waitReason}::varchar END`,
        ...paceColumnsOf(paceUpdate),
        updated_at: laneUpdatedAtTimestamp,
      })
      .where(
        and(
          this.keyOf(key),
          eq(instagram_send_lanes.lane, lane),
          eq(instagram_send_lanes.state, INSTAGRAM_SEND_LANE_STATE.WORKING),
          eq(instagram_send_lanes.working_turn, workingTurn),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Locks one lane row until the unit of work ends (the claim's commit, SN3): two claims of one
   * account and group never check and add gate 2 at the same time.
   */
  async lockLane({
    lane,
    ...key
  }: ChannelAccountKey & { lane: InstagramSendLane }): Promise<InstagramSendLaneRow | null> {
    const rows = await this.db()
      .select()
      .from(instagram_send_lanes)
      .where(and(this.keyOf(key), eq(instagram_send_lanes.lane, lane)))
      .for('update');
    return rows[0] ?? null;
  }

  /**
   * Moves the fast lane's `sending_count` by `delta` (plan §30.2 steps 10, 12): + 1 in a fast claim's
   * commit, − 1 in its result save — never below 0 nor above the CHECK's 20. Answers whether a row moved.
   */
  async addToSendingCount({
    delta,
    ...key
  }: ChannelAccountKey & { delta: 1 | -1 }): Promise<boolean> {
    const moved = await this.db()
      .update(instagram_send_lanes)
      .set({
        sending_count: sql`least(greatest(${instagram_send_lanes.sending_count} + ${delta}, 0), 20)`,
        updated_at: laneUpdatedAtTimestamp,
      })
      .where(and(this.keyOf(key), eq(instagram_send_lanes.lane, 'fast')))
      .returning({ id: instagram_send_lanes.id });
    return moved.length > 0;
  }

  /**
   * The organization's fast messages `sending` across its accounts (S21): the sum of its fast lanes'
   * `sending_count`, read without a lock — the cap is a fairness bound, not a count to the message.
   */
  async sumOrganizationSendingCount(organizationId: number): Promise<number> {
    const rows = await this.db()
      .select({ total: sql<number>`coalesce(sum(${instagram_send_lanes.sending_count}), 0)::int` })
      .from(instagram_send_lanes)
      .where(
        and(
          eq(instagram_send_lanes.organization_id, organizationId),
          eq(instagram_send_lanes.lane, 'fast'),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Claims a test turn of a stopped lane whose stop time is over (plan §33.4): only while the
   * ticket's turn is the lane's and the stop is not one the owner must end. Sets the lease. Returns
   * the claimed row, or `null`.
   */
  async claimTestTurn({
    lane,
    turnNumber,
    leaseSeconds,
    testableReasons,
    ...key
  }: ChannelAccountKey & {
    lane: InstagramSendLane;
    turnNumber: number;
    leaseSeconds: number;
    testableReasons: readonly InstagramSendStopReason[];
  }): Promise<InstagramSendLaneRow | null> {
    if (testableReasons.length === 0) return null;
    const rows = await this.db()
      .update(instagram_send_lanes)
      .set({
        state: INSTAGRAM_SEND_LANE_STATE.WORKING,
        working_turn: turnNumber,
        lease_until: sql`now() + make_interval(secs => ${leaseSeconds})`,
        wait_reason: 'test',
        updated_at: laneUpdatedAtTimestamp,
      })
      .where(
        and(
          this.keyOf(key),
          eq(instagram_send_lanes.lane, lane),
          eq(instagram_send_lanes.turn_number, turnNumber),
          eq(instagram_send_lanes.state, INSTAGRAM_SEND_LANE_STATE.STOPPED),
          inArray(instagram_send_lanes.stop_reason, [...testableReasons]),
          sql`${instagram_send_lanes.stop_until} <= now()`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Takes the account's one test claim on its `slow` row (plan §33.4 step 1): only when no test
   * runs or its time is over. Answers whether this caller holds it now.
   */
  async claimAccountTest({
    testingLane,
    leaseSeconds,
    ...key
  }: ChannelAccountKey & {
    testingLane: InstagramSendLane;
    leaseSeconds: number;
  }): Promise<boolean> {
    const rows = await this.db()
      .update(instagram_send_lanes)
      .set({
        testing_lane: testingLane,
        testing_until: sql`now() + make_interval(secs => ${leaseSeconds})`,
        updated_at: laneUpdatedAtTimestamp,
      })
      .where(
        and(
          this.keyOf(key),
          eq(instagram_send_lanes.lane, 'slow'),
          sql`(${instagram_send_lanes.testing_until} IS NULL OR ${instagram_send_lanes.testing_until} <= now())`,
        ),
      )
      .returning({ id: instagram_send_lanes.id });
    return rows.length > 0;
  }

  /** Ends the account's test claim (plan §33.4): the test answered. */
  async endAccountTest(key: ChannelAccountKey): Promise<void> {
    await this.db()
      .update(instagram_send_lanes)
      .set({ testing_lane: null, testing_until: null, updated_at: laneUpdatedAtTimestamp })
      .where(and(this.keyOf(key), eq(instagram_send_lanes.lane, 'slow')));
  }

  /**
   * Puts a stop's end later without counting it up (plan §33.4: an unclear test waits the same time
   * again). Only lanes still holding `reason`.
   */
  async extendStop({
    reason,
    stopUntil,
    ...key
  }: ChannelAccountKey & { reason: InstagramSendStopReason; stopUntil: Date }): Promise<void> {
    await this.db()
      .update(instagram_send_lanes)
      .set({ stop_until: stopUntil, updated_at: laneUpdatedAtTimestamp })
      .where(and(this.keyOf(key), eq(instagram_send_lanes.stop_reason, reason)));
  }

  /** Half speed on these lanes until `until` (plan §33.4: a passed test). */
  async setHalfSpeed({
    lanes,
    until,
    ...key
  }: ChannelAccountKey & { lanes: readonly InstagramSendLane[]; until: Date }): Promise<void> {
    if (lanes.length === 0) return;
    await this.db()
      .update(instagram_send_lanes)
      .set({ half_speed_until: until, updated_at: laneUpdatedAtTimestamp })
      .where(and(this.keyOf(key), inArray(instagram_send_lanes.lane, [...lanes])));
  }

  /**
   * Half speed on these lanes until at least `until` — a later end already set is kept (plan §33.6
   * rule 3: the lanes released after an all-accounts test, ROUTE row R62).
   */
  async raiseHalfSpeed({
    lanes,
    until,
    ...key
  }: ChannelAccountKey & { lanes: readonly InstagramSendLane[]; until: Date }): Promise<void> {
    if (lanes.length === 0) return;
    await this.db()
      .update(instagram_send_lanes)
      .set({ half_speed_until: until, updated_at: laneUpdatedAtTimestamp })
      .where(
        and(
          this.keyOf(key),
          inArray(instagram_send_lanes.lane, [...lanes]),
          or(
            isNull(instagram_send_lanes.half_speed_until),
            lt(instagram_send_lanes.half_speed_until, until),
          ),
        ),
      );
  }

  /**
   * Writes the slow lane's stored "will go / may expire" estimate (S29, WC-24 — ROUTE row R48);
   * answers whether the slow row exists. `estimated_at` is Postgres's clock.
   */
  async writeEstimate({
    key,
    estimate,
  }: {
    key: ChannelAccountKey;
    estimate: {
      waitingCount: number;
      willGoCount: number;
      mayExpireCount: number;
      doneAt: Date | null;
    };
  }): Promise<boolean> {
    const rows = await this.db()
      .update(instagram_send_lanes)
      .set({
        estimate_waiting_count: estimate.waitingCount,
        estimate_will_go_count: estimate.willGoCount,
        estimate_may_expire_count: estimate.mayExpireCount,
        estimate_done_at: estimate.doneAt,
        estimated_at: sql`now()`,
        updated_at: laneUpdatedAtTimestamp,
      })
      .where(and(this.keyOf(key), eq(instagram_send_lanes.lane, 'slow')))
      .returning({ id: instagram_send_lanes.id });
    return rows.length > 0;
  }
}
