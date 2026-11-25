import { setTimeout as sleepFor } from 'node:timers/promises';
import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { WorkerDatabaseSlotUnavailableError } from '@/infrastructure/queue/worker-runtime/worker-database-slot-limiter.js';
import { NotFoundError } from '@/shared/errors/auth.error.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  getPostgresErrorCode,
  isPostgresLockTimeout,
  isTransientConnectionError,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import {
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_SECOND,
} from '@/shared/constants/ttl.constants.js';
import { describeMetaGraphError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type { MetaUsagePace } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-usage.util.js';
import type { ChannelConnectionKey } from '@/domains/app/sub-domains/channel-connection/channel-connection.repository.js';
import { ChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import type { InstagramAttachmentService } from './instagram-attachment/instagram-attachment.service.js';
import type { InstagramMessageService } from './instagram-message/instagram-message.service.js';
import {
  InstagramMessageRepository,
  type InstagramMessageRow,
} from './instagram-message/instagram-message.repository.js';
import {
  type InstagramSendAttemptKey,
  InstagramSendAttemptRepository,
} from './instagram-message/instagram-send-attempt.repository.js';
import type {
  InstagramMessageChannel,
  InstagramMessageReason,
  InstagramSendAttemptCountGroup,
} from './instagram-message/instagram-message.constants.js';
import type { InstagramSendResultInput } from './instagram-message/instagram-message.types.js';
import type { InstagramSendAccessService } from './instagram-send-access.service.js';
import {
  classifyInstagramSendError,
  decideInstagramSendOutcome,
  type InstagramSendErrorReading,
  type InstagramSendOutcome,
  type InstagramSendStopAction,
  INSTAGRAM_SEND_STOP_GROUPS,
  ladderStep,
  stopDurationOf,
} from './instagram-send-error.util.js';
import type { InstagramSendGateService } from './instagram-send-gate.service.js';
import {
  InstagramSendLaneRepository,
  type InstagramSendLaneRow,
} from './instagram-send-lane.repository.js';
import type { InstagramSendLaneService } from './instagram-send-lane.service.js';
import { planStopHoldsLane } from './instagram-send-lane.util.js';
import {
  FAST_LANE_SETTINGS,
  INSTAGRAM_SEND_CORE_SETTINGS,
  INSTAGRAM_SEND_STOP_ENDED_BY,
  INSTAGRAM_SLOW_QUEUE_LANES,
  type InstagramSendLane,
  type InstagramSendResultGroup,
  type InstagramSendStopReason,
  type InstagramSendWaitReason,
  type InstagramSlowQueueLane,
} from './instagram-sending.constants.js';
import type {
  InstagramFastMessageWork,
  InstagramLaneTurnWork,
  InstagramSendAccess,
  InstagramSendFastMessageTicket,
  InstagramSendLanePaceUpdate,
  InstagramSendLaneRules,
  InstagramSendLaneTarget,
  InstagramSendLaneTurnTicket,
  InstagramSendLimits,
  InstagramSendMessageKey,
  InstagramSendPick,
  InstagramSendResult,
  InstagramSendTicketContext,
} from './instagram-sending.types.js';
import { enqueueInstagramSendLaneTurn } from './queues/instagram-send-slow.queue.js';
import { enqueueInstagramSendFastMessage } from './queues/instagram-send-fast.queue.js';
import type { SendingStateService } from './sending-state.service.js';

const SETTINGS = INSTAGRAM_SEND_CORE_SETTINGS;

/** The error stops an account test may end (plan §33.4 rule 5: never the owner's or the team's). */
const TESTABLE_STOP_REASONS: readonly InstagramSendStopReason[] = [
  'too_fast',
  'instagram_down',
  'access_off',
  'app_not_approved',
  'account_flagged',
  'blocked',
];

/** Result groups that say nothing clear about the account ("unclear", plan §33.4). */
const UNCLEAR_GROUPS: readonly InstagramSendResultGroup[] = [
  'no_answer',
  'try_later',
  'never_connected',
];

/** A test ticket whose account test is held by another lane comes back this much later (§33.4). */
const TEST_BUSY_RETRY_MILLISECONDS = 30 * MILLISECONDS_PER_SECOND;

/** The SQLSTATE of a deadlock (SN4: the save is tried again). */
const POSTGRES_DEADLOCK_DETECTED = '40P01';

/**
 * The account breaks the send core reaches (MC11, CA4): the connection's and one account's.
 *
 * @remarks
 * Notes: wired to the connection's and the channel account's services in the app container.
 */
export interface InstagramSendBreakPort {
  /** `ChannelConnectionService.markConnectionBroken` — every account of the connection (AC-17.12). */
  markConnectionBroken(input: {
    scope: OrganizationPrincipalDatabaseScope;
    channelConnection: ChannelConnectionKey;
    lastCheckError: string;
    requestId: string;
  }): Promise<boolean>;
  /** `ChannelAccountService.markAccountBroken` — one account (`account_not_shared`). */
  markAccountBroken(input: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    channelAccountId: number;
    requestId?: string | undefined;
    stopReason?: 'login_expired' | 'account_not_shared' | undefined;
  }): Promise<boolean>;
}

/**
 * The ticket producers the core adds the next tickets with (after each commit).
 *
 * @remarks
 * Notes: the real producers by default; tests record the tickets instead.
 */
export interface InstagramSendTicketProducers {
  enqueueLaneTurn: typeof enqueueInstagramSendLaneTurn;
  enqueueFastMessage: typeof enqueueInstagramSendFastMessage;
}

/**
 * Everything the send core is built from (the app container).
 *
 * @remarks
 * Notes: built by `createInstagramSendWork` in the app container.
 */
export interface InstagramSendCoreDependencies {
  laneService: Pick<
    InstagramSendLaneService,
    'claimLaneTurn' | 'releaseLaneTurn' | 'startLaneStop' | 'endLaneStops' | 'listLanes'
  >;
  messageService: Pick<InstagramMessageService, 'saveSendResult'>;
  gateService: Pick<InstagramSendGateService, 'passGateOne' | 'recordGateOne' | 'claimSend'>;
  accessService: Pick<
    InstagramSendAccessService,
    'readSendAccess' | 'readSendPace' | 'buildUsageRecorder'
  >;
  attachmentService: Pick<
    InstagramAttachmentService,
    'findOrUploadAttachment' | 'forgetAttachment'
  >;
  sendingStateService: Pick<SendingStateService, 'recordAppLimit' | 'readAllAccountsStop'>;
  /** The plan's `message_month_limit` (billing, through `MessageMonthCountService.readMonthLimit`). */
  readMonthLimit(scope: OrganizationPrincipalDatabaseScope): Promise<number | null>;
  breakPort: InstagramSendBreakPort;
  /** Each lane's own rules (R43 slow / reply, R44 fast, R45 broadcast); a lane without rules sends nothing. */
  laneRules: Partial<Record<InstagramSendLane, InstagramSendLaneRules>>;
  producers?: InstagramSendTicketProducers | undefined;
  /** Waits between result-save tries (tests pass a fake). */
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  /**
   * The read-only call that tests an `instagram_down` stop before any real person is (plan §33.5
   * rule 2, ROUTE row R48): `answered` lets the test DM go, `unclear` keeps the stop its time again.
   * Absent = no read-only call (the test DM goes).
   */
  probeAccount?:
    | ((input: {
        scope: OrganizationPrincipalDatabaseScope;
        access: InstagramSendAccess;
      }) => Promise<'answered' | 'unclear'>)
    | undefined;
}

/** The count group of a message (SN3): `none` for follow checks and hides. */
function countGroupOf(message: InstagramMessageRow): InstagramSendAttemptCountGroup {
  if (message.channel === null || message.channel === 'comment_hide') return 'none';
  switch (message.lane) {
    case 'slow':
      return 'open';
    case 'reply':
      return 'reply';
    case 'broadcast':
      return 'broadcast';
    default:
      return 'fast';
  }
}

/** Whether a slow-queue lane (one ticket per turn). */
function isSlowQueueLane(lane: string): lane is InstagramSlowQueueLane {
  return (INSTAGRAM_SLOW_QUEUE_LANES as readonly string[]).includes(lane);
}

/** One box (plan §28): 3600 ÷ hour limit seconds, doubled at Meta's 80 % or at half speed. */
function defaultNextTurnAt({
  lane,
  pace,
  limits,
  now,
}: {
  lane: InstagramSendLaneRow;
  pace: MetaUsagePace;
  limits: InstagramSendLimits;
  now: Date;
}): Date {
  const box = MILLISECONDS_PER_HOUR / Math.max(limits.hourLimit, 1);
  const isHalfSpeed =
    pace === 'slow' ||
    (lane.half_speed_until !== null && lane.half_speed_until.getTime() > now.getTime());
  return new Date(now.getTime() + (isHalfSpeed ? 2 * box : box));
}

/** A message's key from its row. */
function keyOf(message: InstagramMessageRow): InstagramSendMessageKey {
  return {
    organizationId: message.organization_id,
    publicId: message.public_id,
    automationRunStartedAt: message.automation_run_started_at,
  };
}

/** A reading with no Meta answer of its own (a skip, a file, a send). */
function readingOf(group: InstagramSendResultGroup): InstagramSendErrorReading {
  return {
    group,
    httpStatus: null,
    errorCode: null,
    errorSubcode: null,
    retryAfterMilliseconds: null,
  };
}

/** A message ended before any call: the claim's counts go back (it never reached her). */
const SKIPPED_BEFORE_CALL: InstagramSendOutcome = {
  status: 'skipped',
  reason: null,
  isTryUsed: false,
  notBeforeDelayMilliseconds: 0,
  isGivenBack: true,
  stop: null,
};

/** What a claimed turn does before its release: when next, and why it waits. */
interface TurnEnd {
  nextRunAt: Date | null;
  isHeld: boolean;
  waitReason: InstagramSendWaitReason | null;
  /** The lane's pace columns after a send (the lane's `nextTurnAt`). */
  paceUpdate?: InstagramSendLanePaceUpdate | undefined;
}

/**
 * The send core (feat-instagram-dm-sending routes-final § 6 SN3–SN5, SN8, SN23; SNC3, SNC4, SNC7;
 * ROUTE row R42): the work behind the lane-turn and fast-message tickets — the turn's claim and
 * release, the account's holds and the all-accounts stop, Meta's usage read before each call, gate 1,
 * the one claim commit (gate 2, her hour, the month), the file upload, the call outside any
 * transaction, the error group, the one result save retried inside the send, the stops and their
 * tests, and the next tickets. Each lane's own rules (pick, text, limits, pace) plug in through
 * {@link InstagramSendLaneRules}.
 *
 * @remarks
 * - **Algorithm:** a lane turn — the turn claimed (or, with its stop over, a test turn under the
 *   account's one test claim), the account read (paused, suspended, a plan stop holding this lane →
 *   `stopped`), the all-accounts stop, the pace (95 % → sleep until Meta's time), the lane's pick,
 *   {@link sendMessage}, the test's end, the release, then the next tickets of every slow-queue lane
 *   of the account (job ids dedupe). A fast message — the same send under its own ticket; a hold, a
 *   wait or a refusal puts the ticket back or leaves the message `waiting` for its wake.
 * - **Failure modes:** a slot miss before the claim puts the ticket back (no try); after Meta answered
 *   the save waits for a slot and retries (deadlock / lock timeout 3 times, a lost connection after
 *   1, 2, 4, 8 s) — when it still fails the message stays `sending`, its lease ends and the repair
 *   settles it `unknown` (D17: never sent again by itself). A lane without rules sends nothing.
 * - **Side effects:** the rows of the claim and the save, the stops, the breaks, the tickets; Meta
 *   calls outside every unit of work (K10).
 * - **Notes:** the lanes' own rules are R43–R45; the repair duties (WC-13, WC-14) and the outage
 *   watch (WC-22) are R47–R48. The Meta circuit stays the backstop of every call class: an open
 *   circuit reads `never_connected` (S14, P109).
 */
export class InstagramSendCoreService implements InstagramLaneTurnWork, InstagramFastMessageWork {
  private readonly producers: InstagramSendTicketProducers;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly dependencies: InstagramSendCoreDependencies) {
    this.producers = dependencies.producers ?? {
      enqueueLaneTurn: enqueueInstagramSendLaneTurn,
      enqueueFastMessage: enqueueInstagramSendFastMessage,
    };
    this.sleep = dependencies.sleep ?? ((milliseconds) => sleepFor(milliseconds).then(() => {}));
  }

  /**
   * One lane turn's ticket (plan §28.1): claim, send at most one message, release, next tickets.
   *
   * @remarks
   * Algorithm: as the class says. Failure modes: a slot miss before the claim propagates (the ticket
   * goes back); a gone account finishes the ticket. Side effects: as the class says.
   */
  async workLaneTurn({
    ticket,
    scope,
    context,
  }: {
    ticket: InstagramSendLaneTurnTicket;
    scope: OrganizationPrincipalDatabaseScope;
    context: InstagramSendTicketContext;
  }): Promise<void> {
    const rules = this.dependencies.laneRules[ticket.lane];
    if (rules === undefined) {
      logger.info(
        { lane: ticket.lane, jobId: context.jobId },
        'app.instagram_send.lane_rules_not_built',
      );
      return;
    }
    const access = await this.readAccess({ scope, ticket, context });
    if (access === null) return;
    const target: InstagramSendLaneTarget = { scope, ...access.channelAccount };
    const turn = await context.runInDatabaseSlot(() =>
      this.claimTurn({ target, lane: ticket.lane, turnNumber: ticket.turnNumber }),
    );
    if (turn === 'test_busy') await context.returnTicket(TEST_BUSY_RETRY_MILLISECONDS);
    if (turn === null || turn === 'test_busy') return;
    let end: TurnEnd = { nextRunAt: new Date(), isHeld: false, waitReason: null };
    try {
      end = await this.workClaimedTurn({ target, access, rules, turn, context });
    } finally {
      await this.untilSaved({
        context,
        what: 'release',
        callback: () =>
          this.dependencies.laneService.releaseLaneTurn({
            ...target,
            lane: ticket.lane,
            workingTurn: ticket.turnNumber,
            nextRunAt: end.nextRunAt,
            isHeld: end.isHeld,
            waitReason: end.waitReason,
            paceUpdate: end.paceUpdate,
          }),
      });
      await this.scheduleLaneTickets({ target, access, context });
    }
  }

  /** The account's send access, or `null` when the account is gone (the ticket finishes). */
  private async readAccess({
    scope,
    ticket,
    context,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    ticket: { channelAccountPublicId: string };
    context: InstagramSendTicketContext;
  }): Promise<InstagramSendAccess | null> {
    try {
      return await context.runInDatabaseSlot(() =>
        this.dependencies.accessService.readSendAccess({
          scope,
          channelAccountPublicId: ticket.channelAccountPublicId,
        }),
      );
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  /**
   * Claims the ticket's turn — or, when the lane holds a stop whose time is over, a test turn under
   * the account's one test claim (plan §33.4). `test_busy` when another lane tests.
   */
  private async claimTurn({
    target,
    lane,
    turnNumber,
  }: {
    target: InstagramSendLaneTarget;
    lane: InstagramSendLane;
    turnNumber: number;
  }): Promise<{ row: InstagramSendLaneRow; isTest: boolean } | 'test_busy' | null> {
    const claimed = await this.dependencies.laneService.claimLaneTurn({
      ...target,
      lane,
      turnNumber,
      leaseSeconds: SETTINGS.leaseSeconds,
    });
    if (claimed !== null) return { row: claimed, isTest: false };
    return withAppDatabaseContext({
      scope: target.scope,
      callback: async (databaseHandle) => {
        const lanes = new InstagramSendLaneRepository(databaseHandle);
        const key = {
          organizationId: target.organizationId,
          channelAccountId: target.channelAccountId,
        };
        const row = (await lanes.listByAccount(key)).find((candidate) => candidate.lane === lane);
        const isTestDue =
          row !== undefined &&
          row.state === 'stopped' &&
          row.turn_number === turnNumber &&
          TESTABLE_STOP_REASONS.includes(row.stop_reason as InstagramSendStopReason) &&
          row.stop_until !== null &&
          row.stop_until.getTime() <= Date.now();
        if (!isTestDue) return null;
        const isTestHeld = await lanes.claimAccountTest({
          ...key,
          testingLane: lane,
          leaseSeconds:
            SETTINGS.testLeaseMinutes * (MILLISECONDS_PER_MINUTE / MILLISECONDS_PER_SECOND),
        });
        if (!isTestHeld) return 'test_busy';
        const test = await lanes.claimTestTurn({
          ...key,
          lane,
          turnNumber,
          leaseSeconds: SETTINGS.leaseSeconds,
          testableReasons: TESTABLE_STOP_REASONS,
        });
        if (test === null) await lanes.endAccountTest(key);
        return test === null ? null : { row: test, isTest: true };
      },
    });
  }

  /** A claimed turn's work: holds, pace, pick, send, the test's end; answers how it is released. */
  private async workClaimedTurn({
    target,
    access,
    rules,
    turn,
    context,
  }: {
    target: InstagramSendLaneTarget;
    access: InstagramSendAccess;
    rules: InstagramSendLaneRules;
    turn: { row: InstagramSendLaneRow; isTest: boolean };
    context: InstagramSendTicketContext;
  }): Promise<TurnEnd> {
    const lane = turn.row.lane as InstagramSendLane;
    const now = new Date();
    const hold = await context.runInDatabaseSlot(() => this.readHold({ target, lane, now }));
    if (hold !== null) {
      if (turn.isTest) await this.endTest({ target, context });
      return hold;
    }
    const pace = await context.runInDatabaseSlot(() =>
      this.dependencies.accessService.readSendPace({ scope: target.scope, access, now }),
    );
    if (pace.pace === 'wait') {
      if (turn.isTest) await this.endTest({ target, context });
      return { nextRunAt: pace.waitUntil, isHeld: false, waitReason: 'box' };
    }
    if (await this.isDownTestUnclear({ target, access, turn })) {
      // §33.5 rule 2: Instagram still gives no clear answer — no person is used as the test.
      await this.extendTestedStop({ target, row: turn.row, delayMilliseconds: null, context });
      return { nextRunAt: null, isHeld: false, waitReason: null };
    }
    const pick = await context.runInDatabaseSlot(
      async () =>
        (await rules.pickNextMessage?.({
          scope: target.scope,
          target,
          lane: turn.row,
          now,
          isTest: turn.isTest,
          pace: pace.pace,
        })) ?? { key: null, nextRunAt: null, waitReason: null },
    );
    if (pick.key === null) {
      if (turn.isTest) {
        await this.extendTestedStop({
          target,
          row: turn.row,
          delayMilliseconds: SETTINGS.idleTurnSeconds * MILLISECONDS_PER_SECOND,
          context,
        });
      }
      return { nextRunAt: pick.nextRunAt, isHeld: false, waitReason: pick.waitReason };
    }
    const limits = await rules.readLimits({ scope: target.scope, access, now });
    const result = await this.sendMessage({
      target,
      access,
      rules,
      limits,
      key: pick.key,
      context,
    });
    if (turn.isTest) await this.finishTest({ target, row: turn.row, result, context });
    return this.turnEndAfter({ rules, row: turn.row, pick, result, pace: pace.pace, limits });
  }

  /**
   * Whether a test turn of an `instagram_down` stop met an unclear read-only call (plan §33.5 rule
   * 2): the probe runs outside any transaction and slot; no probe wired → `false`.
   */
  private async isDownTestUnclear({
    target,
    access,
    turn,
  }: {
    target: InstagramSendLaneTarget;
    access: InstagramSendAccess;
    turn: { row: InstagramSendLaneRow; isTest: boolean };
  }): Promise<boolean> {
    const probe = this.dependencies.probeAccount;
    if (!turn.isTest || turn.row.stop_reason !== 'instagram_down' || probe === undefined) {
      return false;
    }
    return (await probe({ scope: target.scope, access })) === 'unclear';
  }

  /** When the lane goes again after a send (the lane's rule, else one box). */
  private turnEndAfter({
    rules,
    row,
    pick,
    result,
    pace,
    limits,
  }: {
    rules: InstagramSendLaneRules;
    row: InstagramSendLaneRow;
    pick: Extract<InstagramSendPick, { key: InstagramSendMessageKey }>;
    result: InstagramSendResult;
    pace: MetaUsagePace;
    limits: InstagramSendLimits;
  }): TurnEnd {
    const now = new Date();
    if (result.kind === 'refused' && result.reason === 'month_limit') {
      return {
        nextRunAt: null,
        isHeld: planStopHoldsLane({
          planStopReason: 'plan_limit',
          lane: row.lane as InstagramSendLane,
        }),
        waitReason: null,
      };
    }
    if (
      result.kind === 'refused' &&
      (result.reason === 'hour_limit' || result.reason === 'gate_one')
    ) {
      return {
        nextRunAt: new Date(now.getTime() + MILLISECONDS_PER_MINUTE),
        isHeld: false,
        waitReason: 'hour_limit',
      };
    }
    const next = rules.nextTurnAt?.({ lane: row, pick, result, pace, limits, now });
    if (next === undefined) {
      return {
        nextRunAt: defaultNextTurnAt({ lane: row, pace, limits, now }),
        isHeld: false,
        waitReason: 'box',
      };
    }
    const { nextRunAt, ...paceUpdate } = next;
    return { nextRunAt, isHeld: false, waitReason: 'box', paceUpdate };
  }

  /**
   * What holds the lane now (SN9, SN12): the account's pause, suspend or a plan stop holding this
   * lane (`stopped` until its wake), or the all-accounts stop (asleep until its end). `null` = free.
   */
  private async readHold({
    target,
    lane,
    now,
  }: {
    target: InstagramSendLaneTarget;
    lane: InstagramSendLane;
    now: Date;
  }): Promise<TurnEnd | null> {
    const account = await withAppDatabaseContext({
      scope: target.scope,
      callback: () =>
        new ChannelAccountRepository().findById({
          organizationId: target.organizationId,
          channelAccountId: target.channelAccountId,
        }),
    });
    if (
      account === null ||
      account.paused_at !== null ||
      account.suspended_at !== null ||
      planStopHoldsLane({ planStopReason: account.plan_stop_reason, lane })
    ) {
      return { nextRunAt: null, isHeld: true, waitReason: 'stop' };
    }
    const allStop = await this.dependencies.sendingStateService.readAllAccountsStop(now);
    return allStop === null
      ? null
      : { nextRunAt: allStop.until, isHeld: false, waitReason: 'stop' };
  }

  /**
   * One fast message's ticket (plan §30): the same send as a lane turn's, under its own ticket.
   *
   * @remarks
   * Algorithm: rules, access, the message still `waiting` in the fast lane, the holds (the fast
   * lane's own stop and its test), `not_before` and the pace (the ticket back), the lane's
   * `checkFastMessage` (ended, moved or later — R44), then {@link sendMessage}; a used try adds the
   * next try's ticket, a sure "not sent" puts this one back; her busy contact (1 s) or full places
   * (500 ms) put it back too.
   * Failure modes: as {@link workLaneTurn}. Side effects: as the class says.
   */
  async sendFastMessage({
    ticket,
    scope,
    context,
  }: {
    ticket: InstagramSendFastMessageTicket;
    scope: OrganizationPrincipalDatabaseScope;
    context: InstagramSendTicketContext;
  }): Promise<void> {
    const rules = this.dependencies.laneRules.fast;
    if (rules === undefined) {
      logger.info(
        { lane: 'fast', jobId: context.jobId },
        'app.instagram_send.lane_rules_not_built',
      );
      return;
    }
    const access = await this.readAccess({ scope, ticket, context });
    if (access === null) return;
    const target: InstagramSendLaneTarget = { scope, ...access.channelAccount };
    const key: InstagramSendMessageKey = {
      organizationId: target.organizationId,
      publicId: ticket.instagramMessagePublicId,
      automationRunStartedAt: new Date(ticket.automationRunStartedAt),
    };
    const now = new Date();
    const ready = await context.runInDatabaseSlot(() =>
      this.readFastReadiness({ target, key, now }),
    );
    if (ready.kind === 'later') await context.returnTicket(ready.delayMilliseconds);
    if (ready.kind !== 'go') return;
    const pace = await context.runInDatabaseSlot(() =>
      this.dependencies.accessService.readSendPace({ scope, access, now }),
    );
    if (pace.pace === 'wait' && pace.waitUntil !== null) {
      if (ready.isTest) await this.endTest({ target, context });
      await context.returnTicket(Math.max(pace.waitUntil.getTime() - now.getTime(), 0));
    }
    const check =
      rules.checkFastMessage === undefined
        ? ({ kind: 'send' } as const)
        : await context.runInDatabaseSlot(() =>
            rules.checkFastMessage!({ scope, target, key, now }),
          );
    if (check.kind !== 'send') {
      if (ready.isTest) await this.endTest({ target, context });
      if (check.kind === 'later') await context.returnTicket(check.delayMilliseconds);
      return;
    }
    const limits = await rules.readLimits({ scope, access, now });
    const result = await this.sendMessage({ target, access, rules, limits, key, context });
    if (ready.isTest && ready.row !== null) {
      await this.finishTest({ target, row: ready.row, result, context });
    }
    await this.afterFastResult({ ticket, result, context });
  }

  /** A fast message's next ticket after its send. */
  private async afterFastResult({
    ticket,
    result,
    context,
  }: {
    ticket: InstagramSendFastMessageTicket;
    result: InstagramSendResult;
    context: InstagramSendTicketContext;
  }): Promise<void> {
    if (result.kind === 'refused') {
      if (result.reason === 'person_busy') {
        await context.returnTicket(FAST_LANE_SETTINGS.personBusyRetryMilliseconds);
      } else if (result.reason === 'fast_busy') {
        await context.returnTicket(FAST_LANE_SETTINGS.accountBusyRetryMilliseconds);
      } else if (
        result.reason === 'hour_limit' ||
        result.reason === 'gate_one' ||
        result.reason === 'person_limit'
      ) {
        await context.returnTicket(MILLISECONDS_PER_MINUTE);
      }
      return;
    }
    const { retryAt } = result;
    if (result.status !== 'waiting' || retryAt === null) return;
    if (result.tries > ticket.tries) {
      await this.enqueueQuietly(() =>
        this.producers.enqueueFastMessage({
          organizationPublicId: ticket.organizationPublicId,
          channelAccountPublicId: ticket.channelAccountPublicId,
          instagramMessagePublicId: ticket.instagramMessagePublicId,
          automationRunStartedAt: ticket.automationRunStartedAt,
          tries: result.tries,
          delayMilliseconds: Math.max(retryAt.getTime() - Date.now(), 0),
        }),
      );
      return;
    }
    if (result.group === 'never_connected') {
      await context.returnTicket(Math.max(retryAt.getTime() - Date.now(), 0));
    }
  }

  /** Whether a fast message may go now: `go` (maybe as the account's test), `later`, or `drop`. */
  private async readFastReadiness({
    target,
    key,
    now,
  }: {
    target: InstagramSendLaneTarget;
    key: InstagramSendMessageKey;
    now: Date;
  }): Promise<
    | { kind: 'go'; isTest: boolean; row: InstagramSendLaneRow | null }
    | { kind: 'later'; delayMilliseconds: number }
    | { kind: 'drop' }
  > {
    const message = await withAppDatabaseContext({
      scope: target.scope,
      callback: () => new InstagramMessageRepository().findByKey(key),
    });
    if (message === null || message.status !== 'waiting' || message.lane !== 'fast') {
      return { kind: 'drop' };
    }
    if (message.not_before !== null && message.not_before.getTime() > now.getTime()) {
      return { kind: 'later', delayMilliseconds: message.not_before.getTime() - now.getTime() };
    }
    const hold = await this.readHold({ target, lane: 'fast', now });
    if (hold !== null) {
      return hold.nextRunAt === null
        ? { kind: 'drop' }
        : {
            kind: 'later',
            delayMilliseconds: Math.max(hold.nextRunAt.getTime() - now.getTime(), 0),
          };
    }
    return this.claimFastTest({ target, now });
  }

  /** The fast lane's stop: free → go; over → go as the account's test; else drop (its end wakes it). */
  private async claimFastTest({
    target,
    now,
  }: {
    target: InstagramSendLaneTarget;
    now: Date;
  }): Promise<
    | { kind: 'go'; isTest: boolean; row: InstagramSendLaneRow | null }
    | { kind: 'later'; delayMilliseconds: number }
    | { kind: 'drop' }
  > {
    return withAppDatabaseContext({
      scope: target.scope,
      callback: async (databaseHandle) => {
        const lanes = new InstagramSendLaneRepository(databaseHandle);
        const key = {
          organizationId: target.organizationId,
          channelAccountId: target.channelAccountId,
        };
        const row = (await lanes.listByAccount(key)).find((candidate) => candidate.lane === 'fast');
        if (row === undefined) return { kind: 'drop' as const };
        if (row.stop_reason === null) return { kind: 'go' as const, isTest: false, row: null };
        const isTestDue =
          TESTABLE_STOP_REASONS.includes(row.stop_reason as InstagramSendStopReason) &&
          row.stop_until !== null &&
          row.stop_until.getTime() <= now.getTime();
        if (!isTestDue) return { kind: 'drop' as const };
        const isTestHeld = await lanes.claimAccountTest({
          ...key,
          testingLane: 'fast',
          leaseSeconds:
            SETTINGS.testLeaseMinutes * (MILLISECONDS_PER_MINUTE / MILLISECONDS_PER_SECOND),
        });
        return isTestHeld
          ? { kind: 'go' as const, isTest: true, row }
          : { kind: 'later' as const, delayMilliseconds: TEST_BUSY_RETRY_MILLISECONDS };
      },
    });
  }

  /**
   * One message's send (SN3, SN4, SN5): gate 1, the claim's one commit, the lane's composition, the
   * file, the call outside any unit, the group, the one result save (retried inside), the stops.
   *
   * @remarks
   * Algorithm: as the class says. Failure modes: a slot miss before the claim propagates (nothing
   * was sent); after the claim every database step waits for its slot. Side effects: as the class
   * says. Notes: public so a lane (R43–R45) and the repair (R47) can drive one message.
   */
  async sendMessage({
    target,
    access,
    rules,
    limits,
    key,
    context,
  }: {
    target: InstagramSendLaneTarget;
    access: InstagramSendAccess;
    rules: InstagramSendLaneRules;
    limits: InstagramSendLimits;
    key: InstagramSendMessageKey;
    context: InstagramSendTicketContext;
  }): Promise<InstagramSendResult> {
    if (!access.isSendable) return { kind: 'refused', reason: 'not_sendable' };
    const { scope } = target;
    const message = await context.runInDatabaseSlot(() =>
      withAppDatabaseContext({
        scope,
        callback: () => new InstagramMessageRepository().findByKey(key),
      }),
    );
    if (message === null || message.status !== 'waiting')
      return { kind: 'refused', reason: 'gone' };
    const countGroup = countGroupOf(message);
    const isGateOnePassed = await this.dependencies.gateService.passGateOne({
      scope,
      channelAccountPublicId: access.channelAccountPublicId,
      countGroup,
      hourLimit: limits.hourLimit,
    });
    if (!isGateOnePassed) return { kind: 'refused', reason: 'gate_one' };
    const monthLimit = message.is_counted_as_direct_message
      ? await this.dependencies.readMonthLimit(scope)
      : null;
    const claim = await context.runInDatabaseSlot(() =>
      this.dependencies.gateService.claimSend({
        scope,
        key,
        lane: message.lane as InstagramSendLane,
        channel: message.channel as InstagramMessageChannel | null,
        countGroup,
        hourLimit: limits.hourLimit,
        personHourLimit: limits.personHourLimit,
        monthLimit,
      }),
    );
    if (claim.kind === 'refused') return claim;
    await this.dependencies.gateService.recordGateOne({
      scope,
      channelAccountPublicId: access.channelAccountPublicId,
      countGroup,
    });
    return this.sendClaimed({
      target,
      access,
      rules,
      message: claim.message,
      attempt: claim.attempt,
      countGroup,
      context,
    });
  }

  /** The part of a send after its claim committed: nothing here gives the ticket back. */
  private async sendClaimed({
    target,
    access,
    rules,
    message,
    attempt,
    countGroup,
    context,
  }: {
    target: InstagramSendLaneTarget;
    access: InstagramSendAccess;
    rules: InstagramSendLaneRules;
    message: InstagramMessageRow;
    attempt: InstagramSendAttemptKey;
    countGroup: InstagramSendAttemptCountGroup;
    context: InstagramSendTicketContext;
  }): Promise<InstagramSendResult> {
    const { scope } = target;
    const lane = message.lane as InstagramSendLane;
    const channel = message.channel as InstagramMessageChannel | null;
    const settle = ({
      reading,
      outcome = decideInstagramSendOutcome({
        reading,
        lane,
        messageType: message.message_type,
        channel,
        tries: message.tries,
      }),
      instagramMessageId = null,
      durationMilliseconds = null,
    }: {
      reading: InstagramSendErrorReading;
      outcome?: InstagramSendOutcome | undefined;
      instagramMessageId?: string | null | undefined;
      durationMilliseconds?: number | null | undefined;
    }) =>
      this.saveOutcome({
        context,
        input: {
          scope,
          key: keyOf(message),
          attempt,
          instagramMessageId,
          errorCode: reading.errorCode,
          errorSubcode: reading.errorSubcode,
          httpStatus: reading.httpStatus,
          durationMilliseconds,
          status: outcome.status,
          reason: outcome.reason,
          resultGroup: reading.group,
          giveBack: outcome.isGivenBack ? { countGroup, claimedAt: attempt.startedAt } : null,
        },
        outcome,
        message,
      });
    const composition = await this.untilSaved({
      context,
      what: 'compose',
      callback: () => rules.composeMessage({ scope, message, access }),
    });
    if (composition === null) return settle({ reading: readingOf('never_connected') });
    if (composition.kind === 'skip') {
      return settle({
        reading: readingOf('never_connected'),
        outcome: { ...SKIPPED_BEFORE_CALL, reason: composition.reason },
      });
    }
    const file = await this.resolveAttachment({
      target,
      access,
      uploadPublicId: composition.uploadPublicId,
      channel,
    });
    if (file.kind !== 'ready') {
      const result = await settle({ reading: file.reading, outcome: file.outcome });
      await this.applyStops({
        target,
        access,
        outcome: file.outcome ?? null,
        reading: file.reading,
        callError: file.error,
        context,
      });
      return result;
    }
    const startedAt = Date.now();
    let reading = readingOf('sent');
    let instagramMessageId: string | null = null;
    let answerReason: InstagramMessageReason | null = null;
    let callError: unknown = null;
    try {
      const answer = await composition.call({
        access,
        attachmentId: file.attachmentId,
        recordUsage: this.dependencies.accessService.buildUsageRecorder({ scope, access }),
      });
      instagramMessageId = answer.instagramMessageId;
      answerReason = answer.reason ?? null;
    } catch (error) {
      callError = error;
      reading = classifyInstagramSendError({ error, channel });
    }
    const durationMilliseconds = Date.now() - startedAt;
    if (instagramMessageId !== null) {
      // An id, never text (SN4): an echo or a tap can still prove the message `sent`.
      logger.info(
        { instagramMessagePublicId: message.public_id, metaMessageId: instagramMessageId },
        'app.instagram_send.sent',
      );
    }
    const uploadPublicId = composition.uploadPublicId;
    if (reading.group === 'attachment' && uploadPublicId !== null) {
      await this.untilSaved({
        context,
        what: 'forget attachment',
        callback: () =>
          this.dependencies.attachmentService.forgetAttachment({
            scope,
            key: { ...access.channelAccount, uploadPublicId },
          }),
      });
    }
    const decided = decideInstagramSendOutcome({
      reading,
      lane,
      messageType: message.message_type,
      channel,
      tries: message.tries,
    });
    // A follow check's `sent` carries what Meta said: following or not (P130).
    const outcome =
      decided.status === 'sent' && answerReason !== null
        ? { ...decided, reason: answerReason }
        : decided;
    const result = await settle({ reading, outcome, instagramMessageId, durationMilliseconds });
    await this.applyStops({ target, access, outcome, reading, callError, context });
    return result;
  }

  /** Saves an outcome through the one result save and answers the lane's result. */
  private async saveOutcome({
    context,
    input,
    outcome,
    message,
  }: {
    context: InstagramSendTicketContext;
    input: Omit<InstagramSendResultInput, 'isTryUsed' | 'notBefore'>;
    outcome: InstagramSendOutcome;
    message: InstagramMessageRow;
  }): Promise<InstagramSendResult> {
    const retryAt =
      outcome.status === 'waiting'
        ? new Date(Date.now() + outcome.notBeforeDelayMilliseconds)
        : null;
    const saved = await this.saveResult({
      context,
      input: {
        ...input,
        isTryUsed: outcome.isTryUsed,
        ...(retryAt === null ? {} : { notBefore: retryAt }),
      },
    });
    return {
      kind: 'done',
      group: input.resultGroup as InstagramSendResultGroup,
      status: outcome.status,
      retryAt,
      tries: saved?.tries ?? message.tries + (outcome.isTryUsed ? 1 : 0),
    };
  }

  /**
   * The message's file uploaded once per account (6.C, SN20): ready with its id — or the reading and
   * outcome of why not: an unusable file `failed` · `attachment_failed` (not counted); a held account
   * or Meta's usage → back to `waiting` (no try); a refused upload → its group (a stop is a stop,
   * else a used try of 3).
   */
  private async resolveAttachment({
    target,
    access,
    uploadPublicId,
    channel,
  }: {
    target: InstagramSendLaneTarget;
    access: InstagramSendAccess;
    uploadPublicId: string | null;
    channel: InstagramMessageChannel | null;
  }): Promise<
    | { kind: 'ready'; attachmentId: string | null }
    | {
        kind: 'not_ready';
        reading: InstagramSendErrorReading;
        outcome?: InstagramSendOutcome | undefined;
        error: unknown;
      }
  > {
    if (uploadPublicId === null) return { kind: 'ready', attachmentId: null };
    const found = await this.dependencies.attachmentService.findOrUploadAttachment({
      scope: target.scope,
      access,
      uploadPublicId,
    });
    switch (found.status) {
      case 'ready':
        return { kind: 'ready', attachmentId: found.attachmentId };
      case 'unusable':
        return {
          kind: 'not_ready',
          reading: readingOf('attachment'),
          outcome: { ...SKIPPED_BEFORE_CALL, status: 'failed', reason: 'attachment_failed' },
          error: null,
        };
      case 'upload_failed': {
        const reading = classifyInstagramSendError({ error: found.error, channel });
        const isStop = INSTAGRAM_SEND_STOP_GROUPS.includes(reading.group);
        return {
          kind: 'not_ready',
          reading:
            isStop || reading.group === 'never_connected'
              ? reading
              : { ...reading, group: 'attachment' },
          error: found.error,
        };
      }
      default: {
        const waitMilliseconds =
          found.status === 'usage_wait' && found.waitUntil !== null
            ? Math.max(found.waitUntil.getTime() - Date.now(), 0)
            : 0;
        return {
          kind: 'not_ready',
          reading: readingOf('never_connected'),
          outcome: {
            ...SKIPPED_BEFORE_CALL,
            status: 'waiting',
            reason: null,
            notBeforeDelayMilliseconds: waitMilliseconds,
          },
          error: null,
        };
      }
    }
  }

  /**
   * The one result save, retried inside the send (SN4): a slot miss waits again; a deadlock or a
   * lock timeout is tried 3 more times; a lost connection after 1, 2, 4, 8 s. Still failing → logged
   * and `null` — the message stays `sending` until its lease ends and the repair settles it
   * `unknown` (D17).
   */
  private async saveResult({
    context,
    input,
  }: {
    context: InstagramSendTicketContext;
    input: InstagramSendResultInput;
  }): Promise<InstagramMessageRow | null> {
    let lockRetries = 0;
    let connectionRetries = 0;
    for (;;) {
      try {
        return await this.untilSaved({
          context,
          what: 'result save',
          callback: () => this.dependencies.messageService.saveSendResult(input),
          isThrowing: true,
        });
      } catch (error) {
        const isLockConflict =
          getPostgresErrorCode(error) === POSTGRES_DEADLOCK_DETECTED ||
          isPostgresLockTimeout(error);
        if (isLockConflict && lockRetries < SETTINGS.saveLockRetries) {
          lockRetries += 1;
          continue;
        }
        const wait = SETTINGS.saveConnectionRetrySeconds[connectionRetries];
        if (!isLockConflict && isTransientConnectionError(error) && wait !== undefined) {
          connectionRetries += 1;
          await this.sleep(wait * MILLISECONDS_PER_SECOND);
          continue;
        }
        logger.error(
          {
            instagramMessagePublicId: input.key.publicId,
            metaMessageId: input.instagramMessageId,
            resultGroup: input.resultGroup,
            error_name: (error as Error | null)?.name,
          },
          'app.instagram_send.result_save_failed',
        );
        return null;
      }
    }
  }

  /**
   * Runs a database step after the claim: a slot miss waits for the next slot (the ticket is never
   * given back once something may have been sent), until the lease's time. With `isThrowing` the
   * step's own errors propagate; else they are logged and answer `null`.
   */
  private async untilSaved<T>({
    context,
    what,
    callback,
    isThrowing = false,
  }: {
    context: InstagramSendTicketContext;
    what: string;
    callback: () => Promise<T>;
    isThrowing?: boolean;
  }): Promise<T | null> {
    const deadline = Date.now() + SETTINGS.leaseSeconds * MILLISECONDS_PER_SECOND;
    for (;;) {
      try {
        return await context.runInDatabaseSlot(callback);
      } catch (error) {
        if (error instanceof WorkerDatabaseSlotUnavailableError && Date.now() < deadline) continue;
        if (isThrowing) throw error;
        logger.error(
          {
            what,
            error_name: (error as Error | null)?.name,
            error_code: getPostgresErrorCode(error),
          },
          'app.instagram_send.step_failed',
        );
        return null;
      }
    }
  }

  /** The stop an answer starts, and the "in a row" rules read from the attempts (SN5). */
  private async applyStops({
    target,
    access,
    outcome,
    reading,
    callError,
    context,
  }: {
    target: InstagramSendLaneTarget;
    access: InstagramSendAccess;
    outcome: InstagramSendOutcome | null;
    reading: InstagramSendErrorReading;
    callError: unknown;
    context: InstagramSendTicketContext;
  }): Promise<void> {
    if (outcome?.stop != null) {
      await this.startStop({ target, access, stop: outcome.stop, reading, callError, context });
      return;
    }
    if (
      reading.group !== 'wrong_permission' &&
      reading.group !== 'no_answer' &&
      reading.group !== 'try_later'
    ) {
      return;
    }
    const inARow = await this.untilSaved({
      context,
      what: 'in a row',
      callback: () =>
        withAppDatabaseContext({
          scope: target.scope,
          callback: () =>
            new InstagramSendAttemptRepository().listLastResults({
              organizationId: target.organizationId,
              channelAccountId: target.channelAccountId,
              limit: Math.max(SETTINGS.downInARow, SETTINGS.wrongPermissionPeopleInARow),
            }),
        }),
    });
    if (inARow === null) return;
    const stop = decideInARowStop({ group: reading.group, lastResults: inARow });
    if (stop !== null) {
      await this.startStop({ target, access, stop, reading, callError, context });
    }
  }

  /** Starts one stop (6.A.10): lanes with their ladder, the connection's or the account's break, the app limit. */
  private async startStop({
    target,
    access,
    stop,
    reading,
    callError,
    context,
  }: {
    target: InstagramSendLaneTarget;
    access: InstagramSendAccess;
    stop: InstagramSendStopAction;
    reading: InstagramSendErrorReading;
    callError: unknown;
    context: InstagramSendTicketContext;
  }): Promise<void> {
    const { scope } = target;
    if (stop.kind === 'connection') {
      await this.untilSaved({
        context,
        what: 'connection break',
        callback: () =>
          this.dependencies.breakPort.markConnectionBroken({
            scope,
            channelConnection: access.channelConnection,
            lastCheckError: describeMetaGraphError(callError),
            requestId: context.jobId,
          }),
      });
      return;
    }
    if (stop.kind === 'account') {
      await this.untilSaved({
        context,
        what: 'account break',
        callback: () =>
          this.dependencies.breakPort.markAccountBroken({
            ...target,
            requestId: context.jobId,
            stopReason: 'account_not_shared',
          }),
      });
      return;
    }
    if (stop.kind === 'app_limit') {
      const scopeOfStop = await this.untilSaved({
        context,
        what: 'app limit',
        callback: () =>
          this.dependencies.sendingStateService.recordAppLimit({
            channelAccountId: target.channelAccountId,
          }),
      });
      if (scopeOfStop === 'all') return;
      const tooFast = decideInstagramSendOutcome({
        reading: { ...reading, group: 'too_fast' },
        lane: stop.lane,
        messageType: '',
        channel: null,
        tries: 0,
      }).stop;
      if (tooFast !== null)
        await this.startStop({ target, access, stop: tooFast, reading, callError, context });
      return;
    }
    await this.untilSaved({
      context,
      what: 'lane stop',
      callback: async () => {
        const lanes = await this.dependencies.laneService.listLanes(target);
        const first = lanes.find(
          (row) => stop.lanes === 'all' || stop.lanes.includes(row.lane as InstagramSendLane),
        );
        const stopCount = first?.stop_reason === stop.reason ? first.stop_count : 0;
        const stopUntil =
          stop.durationMilliseconds === null
            ? null
            : new Date(Date.now() + stop.durationMilliseconds(stopCount));
        return this.dependencies.laneService.startLaneStop({
          ...target,
          lanes: stop.lanes,
          reason: stop.reason,
          stopUntil,
          errorCode: reading.errorCode,
          errorSubcode: reading.errorCode === null ? null : reading.errorSubcode,
        });
      },
    });
  }

  /**
   * A test's end (plan §33.4): good → the stop ends (`test`) and half speed starts (24 h after a
   * block, else 1 h); a stop → its new stop already started; unclear → the same time again; a
   * problem with that person or text → the next turn tests again.
   */
  private async finishTest({
    target,
    row,
    result,
    context,
  }: {
    target: InstagramSendLaneTarget;
    row: InstagramSendLaneRow;
    result: InstagramSendResult;
    context: InstagramSendTicketContext;
  }): Promise<void> {
    const reason = row.stop_reason as InstagramSendStopReason | null;
    if (reason === null) {
      await this.endTest({ target, context });
      return;
    }
    if (result.kind === 'done' && result.status === 'sent') {
      await this.untilSaved({
        context,
        what: 'test passed',
        callback: () =>
          withAppDatabaseContext({
            scope: target.scope,
            callback: async () => {
              const freed = await this.dependencies.laneService.endLaneStops({
                ...target,
                reasons: [reason],
                endedBy: INSTAGRAM_SEND_STOP_ENDED_BY.TEST,
              });
              const hours =
                reason === 'blocked' ? SETTINGS.halfSpeedAfterBlockHours : SETTINGS.halfSpeedHours;
              await new InstagramSendLaneRepository().setHalfSpeed({
                organizationId: target.organizationId,
                channelAccountId: target.channelAccountId,
                lanes: freed,
                until: new Date(Date.now() + hours * MILLISECONDS_PER_HOUR),
              });
            },
          }),
      });
    } else if (
      result.kind === 'refused' ||
      UNCLEAR_GROUPS.includes(result.group) ||
      (await this.isLastTestTurn({ target, row, context }))
    ) {
      await this.extendTestedStop({ target, row, delayMilliseconds: null, context });
      return;
    }
    await this.endTest({ target, context });
  }

  /**
   * Whether a test that said nothing about the account (that person, that text) was the stop's last
   * test turn (`testMaxTurns`, plan §33.4): every finished attempt of the account since the stop's
   * end is one of its test turns.
   */
  private async isLastTestTurn({
    target,
    row,
    context,
  }: {
    target: InstagramSendLaneTarget;
    row: InstagramSendLaneRow;
    context: InstagramSendTicketContext;
  }): Promise<boolean> {
    const stopEnd = row.stop_until;
    if (stopEnd === null) return false;
    const turns = await this.untilSaved({
      context,
      what: 'test turns',
      callback: () =>
        withAppDatabaseContext({
          scope: target.scope,
          callback: () =>
            new InstagramSendAttemptRepository().countFinishedSince({
              organizationId: target.organizationId,
              channelAccountId: target.channelAccountId,
              since: stopEnd,
            }),
        }),
    });
    return (turns ?? 0) >= SETTINGS.testMaxTurns;
  }

  /** An unclear test (or none possible): the same stop again — no count added — and the test ends. */
  private async extendTestedStop({
    target,
    row,
    delayMilliseconds,
    context,
  }: {
    target: InstagramSendLaneTarget;
    row: InstagramSendLaneRow;
    /** `null` = the stop's own time again. */
    delayMilliseconds: number | null;
    context: InstagramSendTicketContext;
  }): Promise<void> {
    const reason = row.stop_reason as InstagramSendStopReason | null;
    if (reason !== null) {
      const again =
        delayMilliseconds ??
        stopDurationOf({
          reason,
          stopCount: Math.max(row.stop_count - 1, 0),
          lane: row.lane as InstagramSendLane,
        }) ??
        SETTINGS.accessTestMinutes * MILLISECONDS_PER_MINUTE;
      await this.untilSaved({
        context,
        what: 'test unclear',
        callback: () =>
          withAppDatabaseContext({
            scope: target.scope,
            callback: () =>
              new InstagramSendLaneRepository().extendStop({
                organizationId: target.organizationId,
                channelAccountId: target.channelAccountId,
                reason,
                stopUntil: new Date(Date.now() + again),
              }),
          }),
      });
    }
    await this.endTest({ target, context });
  }

  /** Ends the account's test claim. */
  private async endTest({
    target,
    context,
  }: {
    target: InstagramSendLaneTarget;
    context: InstagramSendTicketContext;
  }): Promise<void> {
    await this.untilSaved({
      context,
      what: 'test end',
      callback: () =>
        withAppDatabaseContext({
          scope: target.scope,
          callback: () =>
            new InstagramSendLaneRepository().endAccountTest({
              organizationId: target.organizationId,
              channelAccountId: target.channelAccountId,
            }),
        }),
    });
  }

  /**
   * The next ticket of every slow-queue lane of the account (after the release's commit): a sleeping
   * or ready lane at its `next_run_at`, a stopped lane at its stop's end (its test) — so sending
   * starts again by itself (SN5). Job ids dedupe a ticket already queued.
   */
  private async scheduleLaneTickets({
    target,
    access,
    context,
  }: {
    target: InstagramSendLaneTarget;
    access: InstagramSendAccess;
    context: InstagramSendTicketContext;
  }): Promise<void> {
    const lanes = await this.untilSaved({
      context,
      what: 'lane read',
      callback: () => this.dependencies.laneService.listLanes(target),
    });
    const now = Date.now();
    for (const row of lanes ?? []) {
      if (!isSlowQueueLane(row.lane) || row.state === 'working') continue;
      const dueAt = row.state === 'stopped' ? row.stop_until : row.next_run_at;
      if (dueAt === null) continue;
      await this.enqueueQuietly(() =>
        this.producers.enqueueLaneTurn({
          organizationPublicId: target.scope.organizationPublicId,
          channelAccountPublicId: access.channelAccountPublicId,
          lane: row.lane as InstagramSlowQueueLane,
          turnNumber: row.turn_number,
          delayMilliseconds: Math.max(dueAt.getTime() - now, 0),
        }),
      );
    }
  }

  /** An enqueue after commit: a failure is logged and the repair puts the ticket back (R47). */
  private async enqueueQuietly(enqueue: () => Promise<void>): Promise<void> {
    try {
      await enqueue();
    } catch (error) {
      logger.warn(
        { error_name: (error as Error | null)?.name },
        'app.instagram_send.enqueue_failed',
      );
    }
  }
}

/**
 * The "in a row" stops read from the account's last attempts (plan §33.2 rule 3, §33.5 rule 1):
 * 3 "no answer" / "try later" in a row → `instagram_down` on every lane (5 · 10 · 20 · 40 minutes);
 * `wrong_permission` for 3 different people in a row (never a follow check or hide) → every lane
 * until the owner reconnects. `null` = no stop.
 *
 * @remarks
 * Pure — exported for its unit test.
 */
export function decideInARowStop({
  group,
  lastResults,
}: {
  group: InstagramSendResultGroup;
  lastResults: readonly { resultGroup: string; contactId: number; countGroup: string }[];
}): InstagramSendStopAction | null {
  if (group === 'wrong_permission') {
    const counted = lastResults.filter((result) => result.countGroup !== 'none');
    const last = counted.slice(0, SETTINGS.wrongPermissionPeopleInARow);
    const isInARow =
      last.length === SETTINGS.wrongPermissionPeopleInARow &&
      last.every((result) => result.resultGroup === 'wrong_permission') &&
      new Set(last.map((result) => result.contactId)).size === SETTINGS.wrongPermissionPeopleInARow;
    return isInARow
      ? { kind: 'lanes', reason: 'wrong_permission', lanes: 'all', durationMilliseconds: null }
      : null;
  }
  const last = lastResults.slice(0, SETTINGS.downInARow);
  const isDown =
    last.length === SETTINGS.downInARow &&
    last.every(
      (result) => result.resultGroup === 'no_answer' || result.resultGroup === 'try_later',
    );
  return isDown
    ? {
        kind: 'lanes',
        reason: 'instagram_down',
        lanes: 'all',
        durationMilliseconds: (stopCount) =>
          ladderStep({ ladder: SETTINGS.downStopMinutes, stopCount }) * MILLISECONDS_PER_MINUTE,
      }
    : null;
}
