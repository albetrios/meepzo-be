import type {
  ChannelBroadcastMessageResultInput,
  ChannelMessageResultInput,
} from '@/domains/app/app.channel-ports.js';
import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { InstagramSendLane } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import type {
  InstagramMessageChannel,
  InstagramMessageFinalStatus,
  InstagramMessageReason,
  InstagramSendAttemptCountGroup,
} from './instagram-message.constants.js';
import type { InstagramMessageKey } from './instagram-message.repository.js';
import type { InstagramSendAttemptKey } from './instagram-send-attempt.repository.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';

/**
 * The run engine's save-result entry point (4.B `AutomationRunService.recordMessageResult`, AU35) —
 * a closure in the app container, since the engine is built after this service.
 */
export type InstagramMessageRunResultPort = (input: ChannelMessageResultInput) => Promise<void>;

/**
 * The broadcast recipients' save-result entry point (7.C `BroadcastRecipientService.recordMessageResult`,
 * BC18 — ROUTE row R23) — a closure in the app container, since broadcasts are built after this service.
 */
export type InstagramMessageBroadcastResultPort = (
  input: ChannelBroadcastMessageResultInput,
) => Promise<void>;

/**
 * The `retry-failed` job on the database-heavy task queue (WC-42, S19 — ROUTE row R46): one job per
 * automation or contact and minute (job id `retry-failed-<aut_… or con_…>-<minute>`), added after
 * the press. Without it (a unit test) the retry runs in the request, piece by piece (P136).
 */
export interface InstagramMessageRetryQueue {
  enqueueRetryFailed(input: {
    organizationPublicId: string;
    by: 'automation' | 'contact';
    /** `aut_…` / `con_…` — the job names the owner by public id (no bigserial in a job). */
    ownerPublicId: string;
  }): Promise<void>;
}

/**
 * The run engine's step of the retry (plan §33.10 rule 4 — `AutomationRunService.reopenRetriedRuns`,
 * R46): the runs that ended `failed` wait for their retried message again, their open keys back, in
 * the piece's commit — a closure in the app container, the engine is built after.
 */
export type InstagramMessageRunReopenPort = (input: {
  databaseHandle: WorkerDatabaseHandle;
  organizationId: number;
  runs: ReadonlyArray<{ runId: number; runStartedAt: Date }>;
}) => Promise<number>;

/**
 * What the retry's work takes besides its owner (WC-42): each piece's database slot (the task's) and
 * what to do after each piece's commit (wake the accounts' lanes).
 */
export interface InstagramMessageRetryOptions {
  runInDatabaseSlot?: (<T>(callback: () => Promise<T>) => Promise<T>) | undefined;
  afterPiece?: ((input: { channelAccountIds: readonly number[] }) => Promise<void>) | undefined;
}

/** The claim's message and attempt parts (SN3 (d)) — the lanes' commit adds the gates (R42). */
export interface InstagramMessageClaimInput {
  scope: OrganizationPrincipalDatabaseScope;
  key: InstagramMessageKey;
  lane: InstagramSendLane;
  channel: InstagramMessageChannel | null;
  countGroup: InstagramSendAttemptCountGroup;
}

/**
 * One answer to save (SN4 `saveSendResult`): the message's final status and Meta's id and codes,
 * the attempt's result group, HTTP status and duration.
 */
export interface InstagramSendResultInput {
  scope: OrganizationPrincipalDatabaseScope;
  key: InstagramMessageKey;
  attempt: InstagramSendAttemptKey | null;
  /** The final status, or `waiting` — back to the lane (a stop, a sure "not sent", SN5). */
  status: InstagramMessageFinalStatus | 'waiting';
  reason: InstagramMessageReason | null;
  /** Meta's `mid` of a sent message. */
  instagramMessageId: string | null;
  errorCode: number | null;
  errorSubcode: number | null;
  /** `sent` or a group of 6.A.10. */
  resultGroup: string;
  httpStatus: number | null;
  durationMilliseconds: number | null;
  /** Back to `waiting` only: a try is used up (`tries` + 1). */
  isTryUsed?: boolean | undefined;
  /** Back to `waiting` only: when it may go again (default now). */
  notBefore?: Date | undefined;
  /**
   * The claim's counts to give back in this commit (SN4: a sure "not sent") — the attempt's count
   * group and when the claim added it; the month only for a counted DM.
   */
  giveBack?: { countGroup: InstagramSendAttemptCountGroup; claimedAt: Date } | null | undefined;
}

/**
 * The contact's opening-DM bookkeeping (3.A.10 `ContactService.recordContactOpeningMessage`) the
 * result save calls in its commit for an opening DM `sent` or `unknown` (SN4).
 */
export type InstagramMessageOpeningPort = (input: {
  databaseHandle: WorkerDatabaseHandle;
  organizationId: number;
  contactId: number;
  sentAt: Date;
}) => Promise<unknown>;
