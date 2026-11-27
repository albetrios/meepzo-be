import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { ChannelAccountPortScope } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import type { ChannelAccountPlanStopReason } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import type { ChannelConnectionKey } from '@/domains/app/sub-domains/channel-connection/channel-connection.repository.js';
import type { z } from 'zod';
import type { MetaGraphUsageRecorder } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { MetaUsagePace } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-usage.util.js';
import type { InstagramOutgoingMessageReason } from './instagram-outgoing-message/instagram-outgoing-message.constants.js';
import type { InstagramOutgoingMessageRow } from './instagram-outgoing-message/instagram-outgoing-message.repository.js';
import type { InstagramSendLaneRow } from './instagram-send-lane.repository.js';
import type {
  InstagramSendLane,
  InstagramSendLaneState,
  InstagramSlowQueueLane,
  InstagramSendResultGroup,
  InstagramSendStopReason,
  InstagramSendWaitReason,
} from './instagram-sending.constants.js';

/** The organization scope and channel account every lane call acts on, in the caller's unit. */
export type InstagramSendLaneTarget = ChannelAccountPortScope & { channelAccountId: number };

/** An error stop to start on some of an account's lanes (SN5). */
export interface InstagramSendLaneStopInput extends InstagramSendLaneTarget {
  /** The lanes it holds; `all` for every lane of the account. */
  lanes: readonly InstagramSendLane[] | 'all';
  reason: InstagramSendStopReason;
  /** `null` = until the owner acts. */
  stopUntil: Date | null;
  errorCode?: number | null | undefined;
  errorSubcode?: number | null | undefined;
}

/** What holds one lane now (SN12): the account's pause, suspend or plan stop, or the lane's own stop. */
export type InstagramSendLaneHold =
  | { kind: 'paused' }
  | { kind: 'suspended' }
  | { kind: 'plan_stop'; reason: ChannelAccountPlanStopReason }
  | { kind: 'error_stop'; reason: InstagramSendStopReason; until: Date | null };

/** The account fields a lane's hold reads (1B — CA3, CA7, P18). */
export interface InstagramSendLaneAccountState {
  paused_at: Date | null;
  suspended_at: Date | null;
  plan_stop_reason: string | null;
}

/** One lane of route 63's Instagram sending status (6.A.6). */
export interface InstagramSendingStatusLaneOutput {
  lane: InstagramSendLane;
  state: InstagramSendLaneState;
  waiting_count: number;
  wait_reason: InstagramSendWaitReason | null;
  next_send_at: string | null;
  stop: { reason: InstagramSendStopReason; until: string | null; started_at: string | null } | null;
  plan_stop: { reason: ChannelAccountPlanStopReason; since: string | null } | null;
}

/** Route 63's object — Instagram sending status (routes-final § 6.A.6). */
export interface InstagramSendingStatusOutput {
  channel_account_id: string;
  is_paused: boolean;
  is_suspended: boolean;
  new_account_limit_until: string | null;
  lanes: InstagramSendingStatusLaneOutput[];
  all_accounts_stop: { reason: string; until: string | null } | null;
  estimate: { waiting: number; will_go: number; may_expire: number; done_at: string | null } | null;
  today: {
    sent: number;
    unknown: number;
    skipped: number;
    skipped_window_closed: number;
    expired: number;
  };
  window_closed_by_automation: { automation_id: string; count: number }[];
  last_broadcast: {
    broadcast_id: string;
    name: string;
    status: string;
    sent: number;
    skipped: number;
    replies: number;
  } | null;
  last_backfill: {
    automation_id: string;
    status: string;
    found: number;
    matched: number;
    queued: number;
  } | null;
  last_retry: {
    automation_id?: string;
    contact_id?: string;
    retried: number;
    cannot: number;
    at: string;
  } | null;
  as_of: string;
}

/** The month meter's state (SN15): `nearly` from 80 %, `reached` at 100 %. */
export type DirectMessageMeterState = 'ok' | 'nearly' | 'reached';

/** One notice route 64 lists (6.A.6). */
export interface AppUsageNoticeOutput {
  kind:
    | 'direct_message_limit_nearly'
    | 'direct_message_limit_reached'
    | 'payment_failed'
    | 'plan_ended'
    | 'trial_ending'
    | 'being_set_up'
    | 'paused';
  ends_on: string | null;
}

/** Route 64's object — App usage (routes-final § 6.A.6). */
export interface AppUsageOutput {
  direct_messages: {
    used: number;
    limit: number | null;
    resets_on: string;
    state: DirectMessageMeterState;
  };
  channel_accounts: { used: number; maximum: number };
  notices: AppUsageNoticeOutput[];
}

/**
 * The parts of route 63 that read tables of later rows (6.B messages R19, 7 broadcasts, 4's past
 * comments, the failed-message retry): optional, and empty until each row passes its reader to the
 * read service.
 */
export interface InstagramSendingStatusSources {
  /** Waiting messages per lane (6.B, ROUTE row R19). */
  countWaitingByLane?(
    options: InstagramSendLaneTarget,
  ): Promise<Partial<Record<InstagramSendLane, number>>>;
  /** Today's "chat closed" skips per automation (6.B, ROUTE row R42). */
  listWindowClosedByAutomation?(
    options: InstagramSendLaneTarget,
  ): Promise<InstagramSendingStatusOutput['window_closed_by_automation']>;
  /** The account's last broadcast (7, ROUTE row R22+). */
  findLastBroadcast?(
    options: InstagramSendLaneTarget,
  ): Promise<InstagramSendingStatusOutput['last_broadcast']>;
  /** The account's last past-comments read (4.C). */
  findLastBackfill?(
    options: InstagramSendLaneTarget,
  ): Promise<InstagramSendingStatusOutput['last_backfill']>;
  /** The account's last failed-message retry (6.B, ROUTE row R19). */
  findLastRetry?(
    options: InstagramSendLaneTarget,
  ): Promise<InstagramSendingStatusOutput['last_retry']>;
}

/** The reader of route 63's caller: the verified organization scope. */
export interface InstagramSendingCaller {
  scope: OrganizationPrincipalDatabaseScope;
}

/**
 * What a send or task ticket's work gets from its worker (SN24, P91): its job id and the process's
 * database limiter. Every unit of work — the claim, the one result save, a task piece — runs through
 * `runInDatabaseSlot`; no slot within 2 s throws `WorkerDatabaseSlotUnavailableError`, which the
 * worker turns into "the ticket goes back, no try used" while nothing has been sent yet.
 */
export interface InstagramSendTicketContext {
  jobId: string;
  runInDatabaseSlot<T>(callback: () => Promise<T>): Promise<T>;
  /**
   * Puts this ticket back `delayMilliseconds` later with no try used (BullMQ's `DelayedError`) — a
   * fast message whose connection waits on Meta's usage, or a surely-unsent call (R42). Only before
   * a result needs saving.
   */
  returnTicket(delayMilliseconds: number): Promise<never>;
}

/** One lane turn's ticket on `instagram-send-slow` (SN2), as validated by its job schema. */
export interface InstagramSendLaneTurnTicket {
  organizationPublicId: string;
  channelAccountPublicId: string;
  lane: InstagramSlowQueueLane;
  turnNumber: number;
}

/** One fast message's ticket on `instagram-send-fast` (SN2), as validated by its job schema. */
export interface InstagramSendFastMessageTicket {
  organizationPublicId: string;
  channelAccountPublicId: string;
  instagramMessagePublicId: string;
  automationRunStartedAt: string;
  tries: number;
}

/**
 * The work of one lane turn — the send core (ROUTE row R42) with the slow and reply lanes (R43) and
 * the broadcast lane (R45): claim the turn (`InstagramSendLaneService.claimLaneTurn`), send, save,
 * release it (`releaseLaneTurn`) with the lane's limits from `resolveInstagramEffectiveLimits`.
 */
export interface InstagramLaneTurnWork {
  workLaneTurn(input: {
    ticket: InstagramSendLaneTurnTicket;
    /** The ticket's organization job scope, minted by the worker (a job scope). */
    scope: OrganizationPrincipalDatabaseScope;
    context: InstagramSendTicketContext;
  }): Promise<void>;
}

/** The send of one fast message — the send core (R42) with the fast lane and its caps (R44, S21). */
export interface InstagramFastMessageWork {
  sendFastMessage(input: {
    ticket: InstagramSendFastMessageTicket;
    /** The ticket's organization job scope, minted by the worker (a job scope). */
    scope: OrganizationPrincipalDatabaseScope;
    context: InstagramSendTicketContext;
  }): Promise<void>;
}

/**
 * One task kind on `instagram-tasks` (SN2), registered under its job name by its owner (R40, R41,
 * R46): whether it calls Meta (then it asks `mayTakeTickets` first, AC-17.21), the schema of its
 * `taskInput` and its work.
 */
export interface InstagramTaskHandler {
  callsMeta: boolean;
  inputSchema: z.ZodType<Record<string, unknown>>;
  run(input: {
    organizationPublicId: string;
    taskInput: Record<string, unknown>;
    context: InstagramSendTicketContext;
  }): Promise<void>;
}

/**
 * The work the Instagram send and task workers hand their tickets to (the worker composition root's
 * `appDomain.instagramSendWork`). `null` / no handler until the row that builds it: the lane turn
 * R42–R45, the fast message R42 / R44, the tasks R40 / R41 / R46 — a ticket for missing work is
 * logged and finished without touching a row.
 */
export interface InstagramSendWork {
  laneTurn: InstagramLaneTurnWork | null;
  fastMessage: InstagramFastMessageWork | null;
  taskHandlers: Readonly<Record<string, InstagramTaskHandler>>;
}

/**
 * What a sender needs about an account before a Meta call (SN22, SN23): the keys, the account's
 * Instagram user id, the connection's usage key and business id, and its encrypted token — read by
 * `InstagramSendAccessService.readSendAccess` in one unit, used after it closes.
 */
export interface InstagramSendAccess {
  /** The channel account's organization and internal id. */
  channelAccount: ChannelAccountKey;
  /** `cha_…`. */
  channelAccountPublicId: string;
  /** The connection's organization and internal id — the key of the break on 190 (MC11). */
  channelConnection: ChannelConnectionKey;
  /** `chc_…` — the usage key; `null` when the connection is gone. */
  channelConnectionPublicId: string | null;
  /** The connection's business id — the business-wide usage asset; `null` when gone. */
  clientBusinessId: string | null;
  /** The Instagram user id every Graph path of this account takes. */
  instagramUserId: string;
  /** The ciphertext — decrypted only by the Meta client; `null` when the connection has none. */
  encryptedAccessToken: string | null;
  /** The account and its connection are `connected` and a token is kept: a Meta call may go. */
  isSendable: boolean;
}

/** The keys of one message a lane rule hands the send core (SN17: the public id and its split key). */
export interface InstagramSendMessageKey {
  organizationId: number;
  publicId: string;
  automationRunStartedAt: Date;
}

/**
 * A lane turn's pick (plan §28.2): one message to send now, or none — with when the lane looks
 * again (`null` = when new work wakes it) and why it waits.
 */
export type InstagramSendPick =
  | {
      key: InstagramSendMessageKey;
      /**
       * A paced send ("Reply like a person" ON, D32): its send moves the lane's `last_sent_at`, the
       * 20 s gap's clock. Absent = the lane's own rule (the slow lane: every send).
       */
      isPaced?: boolean | undefined;
    }
  | { key: null; nextRunAt: Date | null; waitReason: InstagramSendWaitReason | null };

/**
 * A lane's next turn after a send (plan §28.3, §29.3): when, and the pace columns the release
 * writes in its commit — the box the next send falls in, the last send's time (the gap), the mix
 * place (`pick_count`, slow only). An absent column is left as it is.
 */
export interface InstagramSendNextTurn {
  nextRunAt: Date;
  boxStart?: Date | null | undefined;
  lastSentAt?: Date | null | undefined;
  pickCount?: number | undefined;
}

/** The pace columns a lane turn's release writes (see {@link InstagramSendNextTurn}). */
export type InstagramSendLanePaceUpdate = Omit<InstagramSendNextTurn, 'nextRunAt'>;

/**
 * The Meta call of one claimed message, built by its lane at the last moment (plan §24.4): it gets
 * the account's send access, the file's `attachment_id` when the message has one, and the
 * connection's usage recorder, and answers Meta's message id. It throws Meta's error as is.
 */
export type InstagramSendCall = (input: {
  access: InstagramSendAccess;
  attachmentId: string | null;
  recordUsage: MetaGraphUsageRecorder | undefined;
}) => Promise<{
  instagramMessageId: string | null;
  /** A follow check's answer (`following` / `not_following`), saved as its `sent` reason (P130). */
  reason?: 'following' | 'not_following' | undefined;
}>;

/**
 * What a lane composes for a claimed message: `skip` (it can never go — the reason), or the call
 * and the file (`upl_…`) it sends, uploaded once per account before the call (6.C).
 */
export type InstagramSendComposition =
  | { kind: 'skip'; reason: InstagramOutgoingMessageReason }
  | { kind: 'send'; uploadPublicId: string | null; call: InstagramSendCall };

/** The limits a lane reads for one send (the account's settings, `resolveInstagramEffectiveLimits`). */
export interface InstagramSendLimits {
  /** Gate 2's hour limit of the lane's count group. */
  hourLimit: number;
  /** Her hour limit (`person_hour_limit`); `null` = not checked. */
  personHourLimit: number | null;
}

/** How one send ended for the lane (SN3–SN5): refused before the call, or Meta's answer saved. */
export type InstagramSendResult =
  | {
      kind: 'refused';
      reason:
        | 'gone'
        | 'hour_limit'
        | 'person_limit'
        | 'month_limit'
        | 'not_sendable'
        | 'usage_wait'
        | 'gate_one'
        /** A fast message: her contact is being claimed, or another of hers is `sending` (§30.2). */
        | 'person_busy'
        /** A fast message: the account's 20, its 5 audio or the organization's places are taken. */
        | 'fast_busy'
        /**
         * A counted DM: the month moved near its limit between the claim's free read and its check —
         * the next try takes the month lock (the hard cap, SN8).
         */
        | 'month_busy';
    }
  | {
      kind: 'done';
      group: InstagramSendResultGroup;
      status: InstagramSendOutcomeStatus;
      /** Back to `waiting` with a used try: when it may go again. */
      retryAt: Date | null;
      /** The message's tries after the save. */
      tries: number;
    };

/** The status a send's message ended in (or `waiting` when it went back). */
export type InstagramSendOutcomeStatus =
  | 'sent'
  | 'unknown'
  | 'failed'
  | 'skipped'
  | 'expired'
  | 'waiting';

/** What a fast message's checks before its claim decided (plan §30.2 step 6). */
export type InstagramFastMessageCheck =
  | { kind: 'send' }
  | { kind: 'later'; delayMilliseconds: number }
  | { kind: 'ended' };

/**
 * One lane's own rules, plugged into the send core (feat-instagram-dm-sending § 6 WC-5–WC-8): the
 * slow and reply lanes (ROUTE row R43), the fast lane (R44), the broadcast lane (R45). The core owns
 * the turn, the gates, the month, the call, the one result save, the error groups and the stops; a
 * lane owns its limits, its pick, its message's text and its pace.
 */
export interface InstagramSendLaneRules {
  /** The lane's limits for this account now. */
  readLimits(input: {
    scope: OrganizationPrincipalDatabaseScope;
    access: InstagramSendAccess;
    now: Date;
  }): Promise<InstagramSendLimits>;
  /** A lane turn's pick (slow, reply, broadcast); the fast lane has one ticket per message. */
  pickNextMessage?(input: {
    scope: OrganizationPrincipalDatabaseScope;
    target: InstagramSendLaneTarget;
    lane: InstagramSendLaneRow;
    now: Date;
    isTest: boolean;
    /** Meta's usage pace of the connection (`slow` at 80 %: the boxes double, SN23). */
    pace: MetaUsagePace;
  }): Promise<InstagramSendPick>;
  /**
   * A fast message's checks just before its claim (plan §30.2 step 6): `send`, `later` (the ticket
   * back after the delay), or `ended` (the check ended or moved the message, the ticket is done).
   */
  checkFastMessage?(input: {
    scope: OrganizationPrincipalDatabaseScope;
    target: InstagramSendLaneTarget;
    key: InstagramSendMessageKey;
    now: Date;
  }): Promise<InstagramFastMessageCheck>;
  /** The claimed message's Meta call, read from Postgres at the last moment (plan §24.4). */
  composeMessage(input: {
    scope: OrganizationPrincipalDatabaseScope;
    message: InstagramOutgoingMessageRow;
    access: InstagramSendAccess;
  }): Promise<InstagramSendComposition>;
  /**
   * When the lane's next turn is due after this one, with the pace columns its release writes;
   * absent → one box (3600 ÷ hour limit seconds, doubled at Meta's 80 % or at half speed).
   */
  nextTurnAt?(input: {
    lane: InstagramSendLaneRow;
    /** The pick this turn sent. */
    pick: Extract<InstagramSendPick, { key: InstagramSendMessageKey }>;
    result: InstagramSendResult;
    pace: MetaUsagePace;
    limits: InstagramSendLimits;
    now: Date;
  }): InstagramSendNextTurn;
}
