import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import {
  REPAIR_DUTY_PIECE_SIZE,
  type RepairDutyContext,
  type RepairDutyOutcome,
  runRepairDutyPieces,
} from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';
import {
  runGlobalRetentionWorkerJob,
  runOrganizationScopedWorkerJob,
  type WorkerDatabaseHandle,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { MILLISECONDS_PER_HOUR } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { CONTACT_CHAT_WINDOW_MS } from '@/domains/app/sub-domains/contact/contact.constants.js';
import { createWorkerAutomationReplyStateRepository } from '@/domains/app/sub-domains/automation/automation-reply-state.repository.js';
import { INSTAGRAM_PRIVATE_REPLY_EXPIRY_MILLISECONDS } from './instagram-outgoing-message/instagram-outgoing-message.constants.js';
import type { InstagramOutgoingMessageService } from './instagram-outgoing-message/instagram-outgoing-message.service.js';
import type {
  InstagramOutgoingMessageReason,
  InstagramSendAttemptCountGroup,
} from './instagram-outgoing-message/instagram-outgoing-message.constants.js';
import type { InstagramSendGateService } from './instagram-send-gate.service.js';
import { InstagramSendLaneRepository } from './instagram-send-lane.repository.js';
import {
  INSTAGRAM_SEND_CORE_SETTINGS,
  INSTAGRAM_SENDING_REPAIR_SETTINGS,
  type InstagramSlowQueueLane,
} from './instagram-sending.constants.js';
import {
  createRetentionInstagramSendingRepairRepository,
  createWorkerInstagramSendingRepairRepository,
  type InstagramRepairLaneRow,
  type InstagramRepairMessageRow,
} from './instagram-sending-repair.repository.js';

/**
 * A lane turn ticket the repair re-adds (the slow queue's payload).
 *
 * @remarks
 * Notes: public ids only (K8); the job id is the queue's own, so a turn is never added twice.
 */
export interface InstagramRepairLaneTicket {
  organizationPublicId: string;
  channelAccountPublicId: string;
  lane: InstagramSlowQueueLane;
  turnNumber: number;
}

/**
 * A fast message ticket the repair re-adds (the fast queue's payload).
 *
 * @remarks
 * Notes: `delayMilliseconds` spreads the tickets after a fast stop (WC-13).
 */
export interface InstagramRepairFastTicket {
  organizationPublicId: string;
  channelAccountPublicId: string;
  instagramMessagePublicId: string;
  automationRunStartedAt: string;
  tries: number;
  delayMilliseconds?: number | undefined;
}

/**
 * What the sending repair duties are built from.
 *
 * @remarks
 * Notes: the real ticket adders are the queues' `addMissingInstagramSendLaneTurns` /
 * `addMissingInstagramSendFastMessages`; `runInDatabaseSlot` is the process's Instagram database
 * limiter (SN24). Tests pass fakes.
 */
export interface InstagramSendingRepairDependencies {
  messageService: Pick<InstagramOutgoingMessageService, 'saveSendResult' | 'settleWaitingMessages'>;
  gateService: Pick<InstagramSendGateService, 'readGateOneCount'>;
  addLaneTurns(tickets: readonly InstagramRepairLaneTicket[]): Promise<{ added: number }>;
  addFastMessages(tickets: readonly InstagramRepairFastTicket[]): Promise<{ added: number }>;
  runInDatabaseSlot<T>(callback: () => Promise<T>): Promise<T>;
  /**
   * The job scope of one organization the cross-organization read named — minted by the repair
   * worker (job scopes are minted only on worker paths, `principal-scope-minting.policy`).
   */
  jobScopeFor(organizationPublicId: string): OrganizationPrincipalDatabaseScope;
  /** WC-18's limit; default `INSTAGRAM_SENDING_REPAIR_SETTINGS.replyBacklogMax` (tests use a small one). */
  replyBacklogMax?: number | undefined;
}

/** One piece's answer to the shared piece loop. */
interface RepairPiece<TCursor> {
  done: number;
  size: number;
  nextCursor: TCursor | null;
}

/** The rows of one read grouped by organization, in first-seen order. */
function groupByOrganization<Row extends { organization_public_id: string }>(
  rows: readonly Row[],
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const group = groups.get(row.organization_public_id);
    if (group === undefined) groups.set(row.organization_public_id, [row]);
    else group.push(row);
  }
  return groups;
}

/** The reasons the 7-day expiry (WC-15) ends a waiting message with, one settle each. */
const EXPIRY_REASONS = [
  'plan_limit',
  'plan_downgrade',
  'expired',
] as const satisfies readonly InstagramOutgoingMessageReason[];

/**
 * A waiting message's expiry reason by its account's plan stop (WC-15, P265): behind the month
 * limit `plan_limit`, behind a move down's stop `plan_downgrade`, else (no stop, or the plan
 * ended) `expired`.
 */
function expiryReasonOf(planStopReason: string | null): (typeof EXPIRY_REASONS)[number] {
  if (planStopReason === 'plan_limit' || planStopReason === 'plan_downgrade') return planStopReason;
  return 'expired';
}

/** The key the result save and the guarded ends take. */
function messageKeyOf(row: InstagramRepairMessageRow) {
  return {
    organizationId: Number(row.organization_id),
    publicId: row.public_id,
    automationRunStartedAt: new Date(row.automation_run_started_at),
  };
}

/** The slow-queue ticket of one lane turn. */
function laneTicketOf({
  row,
  turnNumber,
}: {
  row: InstagramRepairLaneRow;
  turnNumber: number;
}): InstagramRepairLaneTicket {
  return {
    organizationPublicId: row.organization_public_id,
    channelAccountPublicId: row.channel_account_public_id,
    lane: row.lane as InstagramSlowQueueLane,
    turnNumber,
  };
}

/** Adds the outcomes of a duty's steps. */
function sumOutcomes(outcomes: readonly RepairDutyOutcome[]): RepairDutyOutcome {
  return outcomes.reduce(
    (total, outcome) => ({
      done: total.done + outcome.done,
      backlog: total.backlog + outcome.backlog,
    }),
    { done: 0, backlog: 0 },
  );
}

/**
 * The repair duties of Instagram sending (feat-instagram-dm-sending § 6 SN6, SNC5; WC-13–WC-15,
 * WC-17–WC-20; P94): each one scheduled job's work, working pieces until its 40 s budget is spent —
 * a cross-organization read by ids, then each organization's change in its own job scope.
 *
 * @remarks
 * - **Algorithm:** every duty reads under the global-retention arm
 *   (`createRetentionInstagramSendingRepairRepository`), keyset by id, {@link REPAIR_DUTY_PIECE_SIZE}
 *   a piece, and changes each organization inside `runOrganizationScopedWorkerJob`; lost tickets are
 *   re-added in bulk with the queues' own job ids, so a turn or try is never added twice. Every unit
 *   of work holds a slot of the Instagram database limiter (SN24).
 * - **Failure modes:** an organization's failure is logged and counted out of that piece (its rows
 *   stay due for the next minute); a read error propagates to the duty's job.
 * - **Side effects:** the lanes, the messages (through the one result save or the waiting settle),
 *   the reply states, the minute counts; tickets on the send queues; warning logs for count
 *   mismatches (WC-20's alert).
 * - **Notes:** safe to run twice — every write is guarded on the state it repairs. Counters are never
 *   rebuilt from messages or runs (WC-20).
 */
export class InstagramSendingRepairService {
  constructor(private readonly dependencies: InstagramSendingRepairDependencies) {}

  /** A cross-organization read in a database slot. */
  private read<T>(callback: (databaseHandle: WorkerDatabaseHandle) => Promise<T>): Promise<T> {
    return this.dependencies.runInDatabaseSlot(() => runGlobalRetentionWorkerJob(callback));
  }

  /** One organization's change in a database slot; a failure is logged and answers `fallback`. */
  private async inOrganization<T>({
    organizationPublicId,
    duty,
    fallback,
    callback,
  }: {
    organizationPublicId: string;
    duty: string;
    fallback: T;
    callback: (databaseHandle: WorkerDatabaseHandle) => Promise<T>;
  }): Promise<T> {
    try {
      return await this.dependencies.runInDatabaseSlot(() =>
        runOrganizationScopedWorkerJob({ job: { organizationPublicId }, processor: callback }),
      );
    } catch (error) {
      logger.warn({ error, organizationPublicId, duty }, 'app.instagram_sending.repair_failed');
      return fallback;
    }
  }

  /**
   * WC-13 — puts lost send turns back: late slow, reply and broadcast turns (their ticket re-added
   * when it is gone; a late but present one only counted), an idle lane with a message that can go
   * (woken with a new turn), late fast messages (re-added, spread over 5 minutes after a fast stop
   * ended) and the fast lane's count of messages on their way.
   *
   * @remarks
   * Algorithm: four steps on one budget, each its keyset pieces. Failure modes: as the class says.
   * Side effects: the woken lanes, the fixed counts, the tickets.
   */
  async repairLostTurns(context: RepairDutyContext): Promise<RepairDutyOutcome> {
    const lateBefore = new Date(
      context.now.getTime() - INSTAGRAM_SENDING_REPAIR_SETTINGS.lateTurnMilliseconds,
    );
    const lateLanes = await runRepairDutyPieces<number>({
      context,
      runPiece: async (cursor): Promise<RepairPiece<number>> => {
        const lanes = await this.read((databaseHandle) =>
          createRetentionInstagramSendingRepairRepository(databaseHandle).listLateLanes({
            lateBefore,
            afterLaneId: cursor ?? 0,
            limit: REPAIR_DUTY_PIECE_SIZE,
          }),
        );
        const { added } = await this.dependencies.addLaneTurns(
          lanes.map((lane) => laneTicketOf({ row: lane, turnNumber: Number(lane.turn_number) })),
        );
        return pieceOf({ rows: lanes, done: added, idOf: (lane) => Number(lane.lane_id) });
      },
    });
    const idleLanes = await runRepairDutyPieces<number>({
      context,
      runPiece: (cursor) => this.wakeIdleLanes({ now: context.now, afterLaneId: cursor ?? 0 }),
    });
    const lateFast = await runRepairDutyPieces<number>({
      context,
      runPiece: (cursor) =>
        this.addLateFastMessages({ now: context.now, lateBefore, afterId: cursor ?? 0 }),
    });
    const fastCounts = await runRepairDutyPieces<number>({
      context,
      runPiece: (cursor) => this.fixFastCounts(cursor ?? 0),
    });
    return sumOutcomes([lateLanes, idleLanes, lateFast, fastCounts]);
  }

  /** WC-13's idle lanes: each woken with a new turn, its ticket added. */
  private async wakeIdleLanes({
    now,
    afterLaneId,
  }: {
    now: Date;
    afterLaneId: number;
  }): Promise<RepairPiece<number>> {
    const lanes = await this.read((databaseHandle) =>
      createRetentionInstagramSendingRepairRepository(databaseHandle).listIdleLanesWithWork({
        now,
        afterLaneId,
        limit: REPAIR_DUTY_PIECE_SIZE,
      }),
    );
    const tickets: InstagramRepairLaneTicket[] = [];
    for (const [organizationPublicId, group] of groupByOrganization(lanes)) {
      const woken = await this.inOrganization({
        organizationPublicId,
        duty: 'repair-lost-turns',
        fallback: [] as InstagramRepairLaneTicket[],
        callback: async (databaseHandle) => {
          const repository = createWorkerInstagramSendingRepairRepository(databaseHandle);
          const made: InstagramRepairLaneTicket[] = [];
          for (const lane of group) {
            const turnNumber = await repository.wakeIdleLane({
              organizationId: Number(lane.organization_id),
              laneId: Number(lane.lane_id),
            });
            if (turnNumber !== null) made.push(laneTicketOf({ row: lane, turnNumber }));
          }
          return made;
        },
      });
      tickets.push(...woken);
    }
    await this.dependencies.addLaneTurns(tickets);
    return pieceOf({ rows: lanes, done: tickets.length, idOf: (lane) => Number(lane.lane_id) });
  }

  /** WC-13's late fast messages: tickets re-added, spread over 5 minutes after a fast stop. */
  private async addLateFastMessages({
    now,
    lateBefore,
    afterId,
  }: {
    now: Date;
    lateBefore: Date;
    afterId: number;
  }): Promise<RepairPiece<number>> {
    const messages = await this.read((databaseHandle) =>
      createRetentionInstagramSendingRepairRepository(databaseHandle).listLateFastMessages({
        lateBefore,
        now,
        afterId,
        limit: REPAIR_DUTY_PIECE_SIZE,
      }),
    );
    const spread = INSTAGRAM_SENDING_REPAIR_SETTINGS.fastSpreadAfterStopMilliseconds;
    const { added } = await this.dependencies.addFastMessages(
      messages.map((message, index) => ({
        organizationPublicId: message.organization_public_id,
        channelAccountPublicId: message.channel_account_public_id,
        instagramMessagePublicId: message.public_id,
        automationRunStartedAt: new Date(message.automation_run_started_at).toISOString(),
        tries: Number(message.tries),
        delayMilliseconds:
          message.stop_until === null ? undefined : Math.floor((index * spread) / messages.length),
      })),
    );
    return pieceOf({ rows: messages, done: added, idOf: (message) => Number(message.id) });
  }

  /** WC-13's fast counts: each drifted lane's count set to its messages `sending`. */
  private async fixFastCounts(afterLaneId: number): Promise<RepairPiece<number>> {
    const lanes = await this.read((databaseHandle) =>
      createRetentionInstagramSendingRepairRepository(databaseHandle).listFastCountDrift({
        afterLaneId,
        limit: REPAIR_DUTY_PIECE_SIZE,
      }),
    );
    let fixed = 0;
    for (const [organizationPublicId, group] of groupByOrganization(lanes)) {
      fixed += await this.inOrganization({
        organizationPublicId,
        duty: 'repair-lost-turns',
        fallback: 0,
        callback: async (databaseHandle) => {
          const repository = createWorkerInstagramSendingRepairRepository(databaseHandle);
          let changed = 0;
          for (const lane of group) {
            const isChanged = await repository.fixFastSendingCount({
              organizationId: Number(lane.organization_id),
              laneId: Number(lane.lane_id),
            });
            if (isChanged) changed += 1;
          }
          return changed;
        },
      });
    }
    return pieceOf({ rows: lanes, done: fixed, idOf: (lane) => Number(lane.lane_id) });
  }

  /**
   * WC-14 — settles stuck sends: a message `sending` past its lease becomes `unknown` · `worker_lost`
   * through the one result save (one with Meta's id `sent`; a follow check back to waiting) — never
   * sent again by itself (D17); a lane whose turn lease ran out is released with a new turn now and
   * its ticket; an account test that ran out ends "not clear" (its stop stays).
   *
   * @remarks
   * Algorithm: messages first, then lanes, then tests, on one budget. Failure modes: as the class
   * says. Side effects: the messages and what their save moves, the lanes, the tickets.
   */
  async settleStuckSends(context: RepairDutyContext): Promise<RepairDutyOutcome> {
    const sendingBefore = new Date(
      context.now.getTime() - INSTAGRAM_SEND_CORE_SETTINGS.leaseSeconds * 1000,
    );
    const messages = await runRepairDutyPieces<number>({
      context,
      runPiece: (cursor) => this.settleStuckMessages({ sendingBefore, afterId: cursor ?? 0 }),
    });
    const lanes = await runRepairDutyPieces<number>({
      context,
      runPiece: (cursor) =>
        this.releaseExpiredLeases({ now: context.now, afterLaneId: cursor ?? 0 }),
    });
    const tests = await runRepairDutyPieces<number>({
      context,
      runPiece: (cursor) => this.endExpiredTests({ now: context.now, afterLaneId: cursor ?? 0 }),
    });
    return sumOutcomes([messages, lanes, tests]);
  }

  /** WC-14's messages: each through the one result save. */
  private async settleStuckMessages({
    sendingBefore,
    afterId,
  }: {
    sendingBefore: Date;
    afterId: number;
  }): Promise<RepairPiece<number>> {
    const messages = await this.read((databaseHandle) =>
      createRetentionInstagramSendingRepairRepository(databaseHandle).listStuckSendingMessages({
        sendingBefore,
        afterId,
        limit: REPAIR_DUTY_PIECE_SIZE,
      }),
    );
    let settled = 0;
    for (const message of messages) {
      const scope = this.dependencies.jobScopeFor(message.organization_public_id);
      const isFollowCheck = message.message_type === 'follow_check';
      const isSent = message.instagram_message_id !== null;
      let status: 'waiting' | 'sent' | 'unknown' = 'unknown';
      if (isFollowCheck) status = 'waiting';
      else if (isSent) status = 'sent';
      try {
        const saved = await this.dependencies.runInDatabaseSlot(() =>
          this.dependencies.messageService.saveSendResult({
            scope,
            key: messageKeyOf(message),
            attempt: null,
            status,
            reason: isFollowCheck || isSent ? null : 'worker_lost',
            instagramMessageId: message.instagram_message_id,
            errorCode: null,
            errorSubcode: null,
            resultGroup: isSent ? 'sent' : 'no_answer',
            httpStatus: null,
            durationMilliseconds: null,
          }),
        );
        if (saved !== null) settled += 1;
      } catch (error) {
        logger.warn(
          {
            error,
            organizationPublicId: message.organization_public_id,
            instagramMessagePublicId: message.public_id,
          },
          'app.instagram_sending.repair_failed',
        );
      }
    }
    return pieceOf({ rows: messages, done: settled, idOf: (message) => Number(message.id) });
  }

  /** WC-14's lanes: released with a new turn now; a slow-queue lane gets its ticket. */
  private async releaseExpiredLeases({
    now,
    afterLaneId,
  }: {
    now: Date;
    afterLaneId: number;
  }): Promise<RepairPiece<number>> {
    const lanes = await this.read((databaseHandle) =>
      createRetentionInstagramSendingRepairRepository(databaseHandle).listExpiredLeaseLanes({
        now,
        afterLaneId,
        limit: REPAIR_DUTY_PIECE_SIZE,
      }),
    );
    let released = 0;
    const tickets: InstagramRepairLaneTicket[] = [];
    for (const [organizationPublicId, group] of groupByOrganization(lanes)) {
      const freed = await this.inOrganization({
        organizationPublicId,
        duty: 'repair-stuck-sends',
        fallback: [] as { lane: InstagramRepairLaneRow; turnNumber: number }[],
        callback: async (databaseHandle) => {
          const repository = new InstagramSendLaneRepository(databaseHandle);
          const made: { lane: InstagramRepairLaneRow; turnNumber: number }[] = [];
          for (const lane of group) {
            if (lane.working_turn === null) continue;
            const row = await repository.releaseTurn({
              organizationId: Number(lane.organization_id),
              channelAccountId: Number(lane.channel_account_id),
              lane: lane.lane,
              workingTurn: Number(lane.working_turn),
              nextRunAt: now,
            });
            if (row !== null) made.push({ lane, turnNumber: Number(row.turn_number) });
          }
          return made;
        },
      });
      released += freed.length;
      for (const { lane, turnNumber } of freed) {
        if (lane.lane !== 'fast') tickets.push(laneTicketOf({ row: lane, turnNumber }));
      }
    }
    await this.dependencies.addLaneTurns(tickets);
    return pieceOf({ rows: lanes, done: released, idOf: (lane) => Number(lane.lane_id) });
  }

  /** WC-14's tests: the account's test claim ended. */
  private async endExpiredTests({
    now,
    afterLaneId,
  }: {
    now: Date;
    afterLaneId: number;
  }): Promise<RepairPiece<number>> {
    const lanes = await this.read((databaseHandle) =>
      createRetentionInstagramSendingRepairRepository(databaseHandle).listExpiredTests({
        now,
        afterLaneId,
        limit: REPAIR_DUTY_PIECE_SIZE,
      }),
    );
    let ended = 0;
    for (const [organizationPublicId, group] of groupByOrganization(lanes)) {
      ended += await this.inOrganization({
        organizationPublicId,
        duty: 'repair-stuck-sends',
        fallback: 0,
        callback: async (databaseHandle) => {
          const repository = new InstagramSendLaneRepository(databaseHandle);
          for (const lane of group) {
            await repository.endAccountTest({
              organizationId: Number(lane.organization_id),
              channelAccountId: Number(lane.channel_account_id),
            });
          }
          return group.length;
        },
      });
    }
    return pieceOf({ rows: lanes, done: ended, idOf: (lane) => Number(lane.lane_id) });
  }

  /**
   * WC-15 — expires waiting opening DMs, public replies and hides whose comment time + 7 days − 30
   * minutes is over: `expired`, with `plan_limit` when it waited behind the month limit (its
   * account's plan stop), `plan_downgrade` when it waited behind a move down's stop (P265), else
   * `expired` — never sent.
   *
   * @remarks
   * Algorithm: keyset pieces over `idx_instagram_outgoing_messages_expiry`; per organization one settle
   * commit. Failure modes: as the class says. Side effects: the messages, their runs, the day line.
   */
  async expireWaitingMessages(context: RepairDutyContext): Promise<RepairDutyOutcome> {
    const triggerBefore = new Date(
      context.now.getTime() - INSTAGRAM_PRIVATE_REPLY_EXPIRY_MILLISECONDS,
    );
    return runRepairDutyPieces<number>({
      context,
      runPiece: async (cursor) => {
        const messages = await this.read((databaseHandle) =>
          createRetentionInstagramSendingRepairRepository(
            databaseHandle,
          ).listExpiredWaitingMessages({
            triggerBefore,
            afterId: cursor ?? 0,
            limit: REPAIR_DUTY_PIECE_SIZE,
          }),
        );
        let expired = 0;
        for (const [organizationPublicId, group] of groupByOrganization(messages)) {
          for (const reason of EXPIRY_REASONS) {
            const keys = group
              .filter((message) => expiryReasonOf(message.plan_stop_reason) === reason)
              .map(messageKeyOf);
            expired += await this.settleWaiting({
              organizationPublicId,
              duty: 'repair-expiry',
              keys,
              status: 'expired',
              reason,
            });
          }
        }
        return pieceOf({ rows: messages, done: expired, idOf: (message) => Number(message.id) });
      },
    });
  }

  /**
   * WC-17 — skips waiting DMs whose chat window closed (answers, list messages, nudges):
   * `skipped` · `window_closed`, reported to the run engine like any skipped message (an answer's
   * run waits for her next message, a list's run ends, a nudge's run still waits for her tap — the
   * engine's rules, AU35).
   *
   * @remarks
   * Algorithm: keyset pieces of the fast lane's `direct` messages whose 24-hour window (D8) closed;
   * per organization one settle commit. Failure modes: as the class says. Side effects: the
   * messages, their runs, the day line.
   */
  async skipClosedWindows(context: RepairDutyContext): Promise<RepairDutyOutcome> {
    const windowOpenSince = new Date(context.now.getTime() - CONTACT_CHAT_WINDOW_MS);
    return runRepairDutyPieces<number>({
      context,
      runPiece: async (cursor) => {
        const messages = await this.read((databaseHandle) =>
          createRetentionInstagramSendingRepairRepository(databaseHandle).listClosedWindowMessages({
            windowOpenSince,
            afterId: cursor ?? 0,
            limit: REPAIR_DUTY_PIECE_SIZE,
          }),
        );
        let skipped = 0;
        for (const [organizationPublicId, group] of groupByOrganization(messages)) {
          skipped += await this.settleWaiting({
            organizationPublicId,
            duty: 'repair-closed-windows',
            keys: group.map(messageKeyOf),
            status: 'skipped',
            reason: 'window_closed',
          });
        }
        return pieceOf({ rows: messages, done: skipped, idOf: (message) => Number(message.id) });
      },
    });
  }

  /**
   * WC-18 — trims too many waiting public replies: an automation with "Reply like a person" on and
   * over 500 waiting replies has its oldest beyond 500 `skipped` · `hour_limit`; their hides are
   * still made (only replies are trimmed), and the reply state's `waiting_count` goes down by as many.
   *
   * @remarks
   * Algorithm: keyset pieces of the reply states over the limit; per automation the oldest replies
   * over it (≤ 500 a piece) settled, then the count. Failure modes: as the class says. Side effects:
   * the messages, their runs and comment logs, the reply state.
   */
  async trimReplyBacklog(context: RepairDutyContext): Promise<RepairDutyOutcome> {
    const keep =
      this.dependencies.replyBacklogMax ?? INSTAGRAM_SENDING_REPAIR_SETTINGS.replyBacklogMax;
    return runRepairDutyPieces<number>({
      context,
      runPiece: async (cursor) => {
        const automations = await this.read((databaseHandle) =>
          createRetentionInstagramSendingRepairRepository(databaseHandle).listReplyBacklogs({
            maxWaiting: keep,
            afterAutomationId: cursor ?? 0,
            limit: REPAIR_DUTY_PIECE_SIZE,
          }),
        );
        let trimmed = 0;
        for (const automation of automations) {
          if (context.isBudgetSpent()) break;
          const organizationId = Number(automation.organization_id);
          const automationId = Number(automation.automation_id);
          const replies = await this.inOrganization({
            organizationPublicId: automation.organization_public_id,
            duty: 'repair-reply-trim',
            fallback: [] as { public_id: string; automation_run_started_at: Date }[],
            callback: (databaseHandle) =>
              createWorkerInstagramSendingRepairRepository(databaseHandle).listRepliesOverLimit({
                organizationId,
                automationId,
                keep,
                limit: REPAIR_DUTY_PIECE_SIZE,
              }),
          });
          const count = await this.settleWaiting({
            organizationPublicId: automation.organization_public_id,
            duty: 'repair-reply-trim',
            keys: replies.map((reply) => ({
              organizationId,
              publicId: reply.public_id,
              automationRunStartedAt: new Date(reply.automation_run_started_at),
            })),
            status: 'skipped',
            reason: 'hour_limit',
          });
          if (count > 0) {
            await this.inOrganization({
              organizationPublicId: automation.organization_public_id,
              duty: 'repair-reply-trim',
              fallback: undefined,
              callback: (databaseHandle) =>
                createWorkerAutomationReplyStateRepository(databaseHandle).subtractWaitingReplies({
                  organizationId,
                  automationId,
                  count,
                }),
            });
          }
          trimmed += count;
        }
        return pieceOf({
          rows: automations,
          done: trimmed,
          idOf: (automation) => Number(automation.automation_id),
        });
      },
    });
  }

  /**
   * WC-19 — cancels the waiting messages of automations paused with Cancel that were made before the
   * pause (`cancelled` · `cancelled_by_owner`), 500 a piece until the budget is spent; until then
   * the lanes already skip them.
   *
   * @remarks
   * Algorithm: keyset pieces of the automations with `cancelled_before_at` still holding such
   * messages; per automation one guarded update of up to 500. Failure modes: as the class says.
   * Side effects: the messages.
   */
  async cancelPausedAutomationMessages(context: RepairDutyContext): Promise<RepairDutyOutcome> {
    return runRepairDutyPieces<number>({
      context,
      runPiece: async (cursor) => {
        const automations = await this.read((databaseHandle) =>
          createRetentionInstagramSendingRepairRepository(
            databaseHandle,
          ).listPausedCancelAutomations({
            afterAutomationId: cursor ?? 0,
            limit: REPAIR_DUTY_PIECE_SIZE,
          }),
        );
        let cancelled = 0;
        let isFull = false;
        for (const automation of automations) {
          if (context.isBudgetSpent() || automation.cancelled_before_at === null) continue;
          const createdBefore = new Date(automation.cancelled_before_at);
          const count = await this.inOrganization({
            organizationPublicId: automation.organization_public_id,
            duty: 'repair-paused-cancel',
            fallback: 0,
            callback: (databaseHandle) =>
              createWorkerInstagramSendingRepairRepository(databaseHandle).cancelWaitingBeforePause(
                {
                  organizationId: Number(automation.organization_id),
                  automationId: Number(automation.automation_id),
                  createdBefore,
                  limit: REPAIR_DUTY_PIECE_SIZE,
                },
              ),
          });
          if (count === REPAIR_DUTY_PIECE_SIZE) isFull = true;
          cancelled += count;
        }
        const piece = pieceOf({
          rows: automations,
          done: cancelled,
          idOf: (automation) => Number(automation.automation_id),
        });
        // An automation with more than a piece left: read again from the start, while the budget
        // lasts.
        return isFull && piece.nextCursor === null
          ? { ...piece, size: REPAIR_DUTY_PIECE_SIZE, nextCursor: 0 }
          : piece;
      },
    });
  }

  /**
   * WC-20 — keeps the send counts right: deletes minute counts over 2 hours old; compares gate 1's
   * quick counts (Redis) with the last hour's minute counts, and once a day each organization's
   * month count with the counted DMs tried this month — a mismatch is logged for the team's alert.
   * Counters are never rebuilt from messages or runs.
   *
   * @remarks
   * Algorithm: the delete in pieces until the budget is spent, then one comparison read each.
   * `isDailyCheck` comes from the job (the first round after 03:00 UTC). Failure modes: a Redis
   * read that does not answer is skipped. Side effects: the deleted minute counts; warning logs.
   */
  async keepSendCounts(
    context: RepairDutyContext & { isDailyCheck: boolean },
  ): Promise<RepairDutyOutcome> {
    const deleteBefore = new Date(
      context.now.getTime() - INSTAGRAM_SENDING_REPAIR_SETTINGS.minuteCountKeepMilliseconds,
    );
    const deleted = await runRepairDutyPieces<number>({
      context,
      runPiece: async () => {
        const count = await this.read((databaseHandle) =>
          createRetentionInstagramSendingRepairRepository(databaseHandle).deleteOldMinuteCounts({
            before: deleteBefore,
            limit: REPAIR_DUTY_PIECE_SIZE,
          }),
        );
        return { done: count, size: count, nextCursor: count < REPAIR_DUTY_PIECE_SIZE ? null : 1 };
      },
    });
    await this.compareQuickCounts(new Date(context.now.getTime() - MILLISECONDS_PER_HOUR));
    if (context.isDailyCheck) await this.compareMonthCounts();
    return deleted;
  }

  /** WC-20's quick counts: gate 1 against the minute counts of the last hour, per account and group. */
  private async compareQuickCounts(since: Date): Promise<void> {
    const totals = await this.read((databaseHandle) =>
      createRetentionInstagramSendingRepairRepository(databaseHandle).listRecentMinuteTotals({
        since,
        limit: REPAIR_DUTY_PIECE_SIZE,
      }),
    );
    let mismatchCount = 0;
    for (const total of totals) {
      const quickCount = await this.dependencies.gateService.readGateOneCount({
        scope: this.dependencies.jobScopeFor(total.organization_public_id),
        channelAccountPublicId: total.channel_account_public_id,
        countGroup: total.count_group as InstagramSendAttemptCountGroup,
      });
      if (quickCount === null) continue;
      // Gate 1 is an advisory look kept an hour; the minute counts are the truth (SN3) — a gap
      // beyond the tolerance is a mismatch for the team, never a rebuild.
      if (
        Math.abs(quickCount - Number(total.total)) >
        INSTAGRAM_SENDING_REPAIR_SETTINGS.quickCountTolerance
      ) {
        mismatchCount += 1;
        logger.warn(
          {
            organizationPublicId: total.organization_public_id,
            channelAccountPublicId: total.channel_account_public_id,
            countGroup: total.count_group,
            quickCount,
            minuteCount: Number(total.total),
          },
          'app.instagram_sending.quick_count_mismatch',
        );
      }
    }
    if (mismatchCount > 0) {
      logger.warn({ mismatchCount }, 'app.instagram_sending.count_mismatch');
    }
  }

  /** WC-20's daily check: each organization's month count against the counted DMs tried. */
  private async compareMonthCounts(): Promise<void> {
    let afterOrganizationId = 0;
    for (;;) {
      const months = await this.read((databaseHandle) =>
        createRetentionInstagramSendingRepairRepository(databaseHandle).listMonthChecks({
          afterOrganizationId,
          limit: REPAIR_DUTY_PIECE_SIZE,
        }),
      );
      for (const month of months) {
        if (Number(month.counted) !== Number(month.tried)) {
          logger.warn(
            {
              organizationPublicId: month.organization_public_id,
              monthStart: month.month_start,
              monthCount: Number(month.counted),
              triedCount: Number(month.tried),
            },
            'app.instagram_sending.month_count_mismatch',
          );
        }
      }
      const last = months.at(-1);
      if (last === undefined || months.length < REPAIR_DUTY_PIECE_SIZE) return;
      afterOrganizationId = Number(last.organization_id);
    }
  }

  /** One organization's settle of waiting messages in a slot; a failure counts 0. */
  private settleWaiting({
    organizationPublicId,
    duty,
    keys,
    status,
    reason,
  }: {
    organizationPublicId: string;
    duty: string;
    keys: Parameters<InstagramOutgoingMessageService['settleWaitingMessages']>[0]['keys'];
    status: 'expired' | 'skipped';
    reason: Parameters<InstagramOutgoingMessageService['settleWaitingMessages']>[0]['reason'];
  }): Promise<number> {
    if (keys.length === 0) return Promise.resolve(0);
    return this.dependencies
      .runInDatabaseSlot(() =>
        this.dependencies.messageService.settleWaitingMessages({
          scope: this.dependencies.jobScopeFor(organizationPublicId),
          keys,
          status,
          reason,
        }),
      )
      .catch((error: unknown) => {
        logger.warn({ error, organizationPublicId, duty }, 'app.instagram_sending.repair_failed');
        return 0;
      });
  }
}

/** A piece's answer from its rows: the next cursor is the last row's id while the piece was full. */
function pieceOf<Row>({
  rows,
  done,
  idOf,
}: {
  rows: readonly Row[];
  done: number;
  idOf: (row: Row) => number;
}): RepairPiece<number> {
  const last = rows.at(-1);
  return {
    done,
    size: rows.length,
    nextCursor: last === undefined || rows.length < REPAIR_DUTY_PIECE_SIZE ? null : idOf(last),
  };
}
