import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { ChannelAccountPortScope } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import type { ChannelAccountPlanStopReason } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import type { z } from 'zod';
import type {
  InstagramSendLane,
  InstagramSendLaneState,
  InstagramSlowQueueLane,
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
    context: InstagramSendTicketContext;
  }): Promise<void>;
}

/** The send of one fast message — the send core (R42) with the fast lane and its caps (R44, S21). */
export interface InstagramFastMessageWork {
  sendFastMessage(input: {
    ticket: InstagramSendFastMessageTicket;
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
