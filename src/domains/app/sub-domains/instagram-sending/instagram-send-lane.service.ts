import { withAppDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { enqueueInstagramSendLaneTurn } from './queues/instagram-send-slow.queue.js';
import type { ChannelAccountPlanStopReason } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import type {
  ChannelAccountActiveStopOutput,
  ChannelAccountLanePort,
} from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import type { ChannelConnectionLanePort } from '@/domains/app/sub-domains/channel-connection/channel-connection.types.js';
import type { InstagramAccountSettingsLanePort } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';
import type {
  InstagramSendLaneRepository,
  InstagramSendLaneRow,
} from './instagram-send-lane.repository.js';
import type {
  InstagramSendStopRepository,
  InstagramSendStopRow,
} from './instagram-send-stop.repository.js';
import { pickActiveStop } from './instagram-send-lane.util.js';
import {
  INSTAGRAM_SEND_LANES,
  INSTAGRAM_SLOW_QUEUE_LANES,
  INSTAGRAM_SEND_RECONNECT_STOP_REASONS,
  INSTAGRAM_SEND_STOP_ENDED_BY,
  type InstagramSendLane,
  type InstagramSendStopEndedBy,
  type InstagramSendStopReason,
  type InstagramSendWaitReason,
} from './instagram-sending.constants.js';
import type {
  InstagramSendLanePaceUpdate,
  InstagramSendLaneStopInput,
  InstagramSendLaneTarget,
} from './instagram-sending.types.js';

/**
 * The lanes of an Instagram channel account and their stops (feat-instagram-dm-sending routes-final
 * § 6.A — SN12, SN13, SNC10): the four lanes made at the pick, the lane steps of the connection
 * (MC6–MC8), of the channel account (routes 8–11, the break — CA4, CA5, CA7–CA9) and of route 12
 * (IA14), the error stops and their history, and the guarded turn of a lane.
 *
 * @remarks
 * Algorithm:
 * - Every method runs in its caller's organization scope and joins the caller's open unit of work
 *   (`withAppDatabaseContext` nests), so a lane step commits or rolls back with the account change
 *   it belongs to.
 * - Stops: a new error stop replaces a lane's current one only when at least as strong (the
 *   repository's guard); each stop that starts writes its history row in the same unit, and each
 *   end stamps it. The pause, the suspend and the plan stop are the channel account's (P99) — the
 *   lanes carry no copy, so a plan stop on the account and an error stop on a lane both hold.
 * - Turns: a turn is claimed only while the lane is not `working` and the ticket's turn is the
 *   lane's, so a lane is never worked by two turns; a release only while `working_turn` is the
 *   caller's.
 *
 * Failure modes: none of its own — guards that match nothing change nothing.
 *
 * Side effects: writes `app.instagram_send_lanes` and `app.instagram_send_stops`.
 *
 * Notes: implements {@link ChannelAccountLanePort}, {@link ChannelConnectionLanePort} and
 * {@link InstagramAccountSettingsLanePort}. A woken lane's next ticket is the lane-turn worker's
 * (the repair puts lanes due a turn back, ROUTE rows R37, R47): Postgres decides, the lane row is
 * marked due now.
 */
export class InstagramSendLaneService
  implements ChannelAccountLanePort, ChannelConnectionLanePort, InstagramAccountSettingsLanePort
{
  constructor(
    private readonly laneRepository: InstagramSendLaneRepository,
    private readonly stopRepository: InstagramSendStopRepository,
  ) {}

  /**
   * A newly picked account's four `ready` lanes (MC7, SN12), in the pick's commit; a reconnect or a
   * pick back keeps the rows it has.
   *
   * @remarks
   * Algorithm: one insert of the four rows, conflicts ignored. Failure modes: none of its own. Side
   * effects: up to four rows.
   */
  async createLanesForAccount({
    scope,
    organizationId,
    channelAccountId,
  }: InstagramSendLaneTarget): Promise<void> {
    await withAppDatabaseContext({
      scope,
      callback: () => this.laneRepository.insertLanes({ organizationId, channelAccountId }),
    });
  }

  /**
   * A disconnected account's lanes (MC8, CA8), or a plan-stopped one's (CA9), stopped with no turn;
   * with `planStopReason` the plan stop is recorded in the history (lane `all`, SN13).
   *
   * @remarks
   * Algorithm: one update of the account's lanes; the history row only when the account has no
   * open row of that plan stop. Failure modes: none of its own. Side effects: the lane rows; one
   * history row.
   */
  async stopLanes({
    scope,
    organizationId,
    channelAccountId,
    planStopReason,
  }: InstagramSendLaneTarget & {
    planStopReason?: ChannelAccountPlanStopReason | undefined;
  }): Promise<void> {
    const key = { organizationId, channelAccountId };
    await withAppDatabaseContext({
      scope,
      callback: async () => {
        await this.laneRepository.stopTurns(key);
        if (planStopReason === undefined) return;
        await this.recordPlanStop({ scope, organizationId, channelAccountId, planStopReason });
      },
    });
  }

  /**
   * Records a plan stop of the account in the history (lane `all`, SN13) unless one of that reason
   * is open — the lanes are not touched: a turn reads the account's plan stop (SN12, D62).
   *
   * @remarks
   * Algorithm: one read and at most one insert in the caller's unit. Failure modes: none of its own.
   * Side effects: one history row.
   */
  async recordPlanStop({
    scope,
    organizationId,
    channelAccountId,
    planStopReason,
  }: InstagramSendLaneTarget & { planStopReason: ChannelAccountPlanStopReason }): Promise<void> {
    const key = { organizationId, channelAccountId };
    await withAppDatabaseContext({
      scope,
      callback: async () => {
        const isOpen = await this.stopRepository.hasOpenStop({
          ...key,
          lane: 'all',
          reason: planStopReason,
        });
        if (!isOpen) {
          await this.stopRepository.insertStop({
            ...key,
            lane: 'all',
            reason: planStopReason,
            stopUntil: null,
            errorCode: null,
            errorSubcode: null,
          });
        }
      },
    });
  }

  /**
   * Each lane with no error stop gets a new turn now (route 10's resume, route 11's activated
   * account, route 12's limit change — AC-2.2, AC-3.8); a plan stop the account no longer holds is
   * ended in the history (`owner`).
   *
   * @remarks
   * Algorithm: one unit — the plan-stop history end, then the wake of `stopped` / `sleeping` lanes
   * without an error stop (a `working` lane keeps its turn). Failure modes: none of its own. Side
   * effects: the lane rows; the history rows. Notes: a paused, suspended or plan-stopped account's
   * woken lane still sends nothing — every turn reads the account (SN12); an error stop and a team
   * suspend stay (AC-2.3, AC-2.7).
   */
  async wakeLanes({
    scope,
    organizationId,
    channelAccountId,
  }: InstagramSendLaneTarget): Promise<void> {
    const key = { organizationId, channelAccountId };
    await withAppDatabaseContext({
      scope,
      callback: async () => {
        await this.stopRepository.endPlanStopsNoLongerHeld({
          ...key,
          endedBy: INSTAGRAM_SEND_STOP_ENDED_BY.OWNER,
        });
        await this.laneRepository.wake(key);
      },
    });
  }

  /**
   * New work for an account's lanes (a broadcast's audience piece, the owner's retry — ROUTE row
   * R46): {@link wakeLanes}, then the next ticket of each slow-queue lane that is due (`ready` or
   * `sleeping` with its next run), so the work starts without waiting for the repair.
   *
   * @remarks
   * Algorithm: the wake's unit, then one read of the lanes; per due slow-queue lane, one
   * `instagram-send-slow` ticket for its turn at its `next_run_at` (job ids dedupe a queued turn).
   * Without the account's public id (a caller that holds internal ids only) the lanes are marked due
   * and the repair adds their tickets (WC-13, R47). Failure modes: a failed add is logged — the
   * repair puts the ticket back. Side effects: the lane rows; the tickets.
   */
  async wakeLaneTurns({
    scope,
    organizationId,
    channelAccountId,
    channelAccountPublicId,
    extraDelayMilliseconds = 0,
    enqueueLaneTurn = enqueueInstagramSendLaneTurn,
  }: InstagramSendLaneTarget & {
    channelAccountPublicId: string | null;
    /** Added to each ticket's delay — the plan change spreads an organization's wake (WC-37). */
    extraDelayMilliseconds?: number;
    enqueueLaneTurn?: typeof enqueueInstagramSendLaneTurn;
  }): Promise<void> {
    await this.wakeLanes({ scope, organizationId, channelAccountId });
    if (channelAccountPublicId === null) return;
    const lanes = await this.listLanes({ scope, organizationId, channelAccountId });
    const now = Date.now();
    for (const row of lanes) {
      const lane = INSTAGRAM_SLOW_QUEUE_LANES.find((name) => name === row.lane);
      if (lane === undefined || (row.state !== 'ready' && row.state !== 'sleeping')) continue;
      if (row.next_run_at === null) continue;
      try {
        await enqueueLaneTurn({
          organizationPublicId: scope.organizationPublicId,
          channelAccountPublicId,
          lane,
          turnNumber: row.turn_number,
          delayMilliseconds: Math.max(row.next_run_at.getTime() - now, 0) + extraDelayMilliseconds,
        });
      } catch (error) {
        logger.warn(
          { error_name: (error as Error | null)?.name, channelAccountPublicId, lane },
          'app.instagram_send.enqueue_failed',
        );
      }
    }
  }

  /**
   * The stop holding most of the account's lanes (1B.6 `active_stop`), or `null`.
   *
   * @remarks
   * Algorithm: one read of the four lanes, then {@link pickActiveStop}. Failure modes: none. Side
   * effects: none.
   */
  async readActiveStop({
    scope,
    organizationId,
    channelAccountId,
  }: InstagramSendLaneTarget): Promise<ChannelAccountActiveStopOutput | null> {
    const lanes = await this.listLanes({ scope, organizationId, channelAccountId });
    return pickActiveStop(lanes);
  }

  /**
   * A reconnected account's reconnect stops ended — `login_expired`, `account_not_shared`,
   * `wrong_permission` (MC6, SN5) — and its lanes given a turn again.
   *
   * @remarks
   * Algorithm: one unit — the lanes' stops of those groups ended, their history ended (`owner`),
   * then the wake. Failure modes: none of its own. Side effects: the lane and history rows.
   */
  async endLoginStops({
    scope,
    organizationId,
    channelAccountId,
  }: InstagramSendLaneTarget): Promise<void> {
    await this.endLaneStops({
      scope,
      organizationId,
      channelAccountId,
      reasons: INSTAGRAM_SEND_RECONNECT_STOP_REASONS,
      endedBy: INSTAGRAM_SEND_STOP_ENDED_BY.OWNER,
    });
    await this.wakeLanes({ scope, organizationId, channelAccountId });
  }

  /**
   * The break's stop (CA4, SN5): every lane of the account stopped until the owner reconnects.
   *
   * @remarks
   * Algorithm: {@link startLaneStop} on all four lanes with no end. Failure modes: none of its own.
   * Side effects: the lane rows; one history row.
   */
  async startBrokenAccountStop({
    scope,
    organizationId,
    channelAccountId,
    reason,
  }: InstagramSendLaneTarget & { reason: 'login_expired' | 'account_not_shared' }): Promise<void> {
    await this.startLaneStop({
      scope,
      organizationId,
      channelAccountId,
      lanes: 'all',
      reason,
      stopUntil: null,
    });
  }

  /**
   * Starts an error stop on some or all of an account's lanes (SN5, SN13) and returns the lanes it
   * now holds — a lane already holding a stronger stop keeps it.
   *
   * @remarks
   * Algorithm: one unit — the guarded stop update, then one history row (lane `all` when every lane
   * took it, else one per lane that did). Failure modes: none of its own. Side effects: the lane and
   * history rows. Notes: the stop groups' rules (which answer stops what, for how long) are the send
   * core's (ROUTE row R42).
   */
  async startLaneStop({
    scope,
    organizationId,
    channelAccountId,
    lanes,
    reason,
    stopUntil,
    errorCode = null,
    errorSubcode = null,
  }: InstagramSendLaneStopInput): Promise<InstagramSendLane[]> {
    const key = { organizationId, channelAccountId };
    const targetLanes = lanes === 'all' ? INSTAGRAM_SEND_LANES : lanes;
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const stopped = await this.laneRepository.startStop({
          ...key,
          lanes: targetLanes,
          reason,
          stopUntil,
          errorCode,
          errorSubcode,
        });
        const historyLanes =
          stopped.length === INSTAGRAM_SEND_LANES.length ? (['all'] as const) : stopped;
        for (const lane of historyLanes) {
          await this.stopRepository.insertStop({
            ...key,
            lane,
            reason,
            stopUntil,
            errorCode,
            errorSubcode,
          });
        }
        return stopped;
      },
    });
  }

  /**
   * Ends an account's error stops of these groups (a reconnect, a passed test, the stop's time) and
   * stamps their history; returns the lanes it freed.
   *
   * @remarks
   * Algorithm: one unit — the guarded lane update, then the history end. Failure modes: none of its
   * own. Side effects: the lane and history rows.
   */
  async endLaneStops({
    scope,
    organizationId,
    channelAccountId,
    reasons,
    endedBy,
  }: InstagramSendLaneTarget & {
    reasons: readonly InstagramSendStopReason[];
    endedBy: InstagramSendStopEndedBy;
  }): Promise<InstagramSendLane[]> {
    const key = { organizationId, channelAccountId };
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const freed = await this.laneRepository.endStops({ ...key, reasons });
        await this.stopRepository.endOpenStops({ ...key, reasons, endedBy });
        return freed;
      },
    });
  }

  /**
   * Claims one turn of a lane for a ticket (plan §28.1) — `null` when the ticket is stale, the lane
   * is already worked or it holds an error stop.
   *
   * @remarks
   * Algorithm: one guarded update with a lease. Failure modes: none of its own. Side effects: the
   * lane row. Notes: the turn itself (the account's pause, suspend and plan stop, the box, the pick)
   * is the lane-turn worker's (ROUTE rows R37, R42).
   */
  async claimLaneTurn({
    scope,
    organizationId,
    channelAccountId,
    lane,
    turnNumber,
    leaseSeconds,
  }: InstagramSendLaneTarget & {
    lane: InstagramSendLane;
    turnNumber: number;
    leaseSeconds: number;
  }): Promise<InstagramSendLaneRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.laneRepository.claimTurn({
          organizationId,
          channelAccountId,
          lane,
          turnNumber,
          leaseSeconds,
        }),
    });
  }

  /**
   * Releases a worked turn (plan §28.1): the lane sleeps until `nextRunAt` with the next turn — or
   * stays stopped when a stop started meanwhile. `null` when the turn is no longer the caller's.
   *
   * @remarks
   * Algorithm: one guarded update. Failure modes: none of its own. Side effects: the lane row.
   */
  async releaseLaneTurn({
    scope,
    organizationId,
    channelAccountId,
    lane,
    workingTurn,
    nextRunAt,
    isHeld,
    waitReason,
    paceUpdate,
  }: InstagramSendLaneTarget & {
    lane: InstagramSendLane;
    workingTurn: number;
    /** `null` = no next run until a wake. */
    nextRunAt: Date | null;
    /** The account holds the lane (pause, suspend, plan stop): `stopped`. */
    isHeld?: boolean | undefined;
    waitReason?: InstagramSendWaitReason | null | undefined;
    /** The lane's pace columns after a send (box, last send, mix place — R43). */
    paceUpdate?: InstagramSendLanePaceUpdate | undefined;
  }): Promise<InstagramSendLaneRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.laneRepository.releaseTurn({
          organizationId,
          channelAccountId,
          lane,
          workingTurn,
          nextRunAt,
          isHeld: isHeld ?? false,
          waitReason: waitReason ?? null,
          paceUpdate,
        }),
    });
  }

  /**
   * The account's open stop history rows, oldest first (route 63's stop start times).
   *
   * @remarks
   * Algorithm: one read. Failure modes: none. Side effects: none.
   */
  async listOpenStops({
    scope,
    organizationId,
    channelAccountId,
  }: InstagramSendLaneTarget): Promise<InstagramSendStopRow[]> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.stopRepository.listOpenByAccount({ organizationId, channelAccountId }),
    });
  }

  /**
   * The account's four lanes, slow first.
   *
   * @remarks
   * Algorithm: one read. Failure modes: none. Side effects: none.
   */
  async listLanes({
    scope,
    organizationId,
    channelAccountId,
  }: InstagramSendLaneTarget): Promise<InstagramSendLaneRow[]> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.laneRepository.listByAccount({ organizationId, channelAccountId }),
    });
  }
}
