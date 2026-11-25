import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { ChannelAccountChannel } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';

/**
 * The app kernel's channel seams (feat-instagram-dm-sending routes-final § 4 AU35, rev 3 — P48, P50):
 * the outbound port every channel's sending sub-domain implements, what it is passed, the results it
 * hands back and the normalized inbound kinds. Automations (4) and broadcasts (7) never send and never
 * name a lane; `app.container.ts` wires one implementation per channel in `channelSendingPorts`, and
 * the caller picks it by the account's `channel`.
 *
 * @remarks
 * Types only: Instagram's implementation is sub-domain 6's message service (ROUTE rows R19–R20); the
 * run engine (4.B) saves every step through it since ROUTE row R14 and takes results at its
 * `recordMessageResult` (a follow check's `sent` result carries `reason` `following` or
 * `not_following`). Until R19–R20 wire `channelSendingPorts.instagram`, the engine throws on an event
 * of that channel and the automation routes skip the port's side effects (a pause's cancel is still
 * recorded as `cancelled_before_at`, which the lanes read).
 */

/** A database handle the caller's transaction runs on — the port writes in the caller's commit. */
export type ChannelPortDatabaseHandle = WorkerDatabaseHandle | RequestScopedPostgresDatabase;

/** The step a waiting message belongs to (AU35) — `follow_check` is a read of her follow, not a message. */
export type ChannelMessageStep =
  | 'hello'
  | 'follow'
  | 'follow_check'
  | 'email'
  | 'phone'
  | 'nudge'
  | 'messages'
  | 'public_reply'
  | 'hide_comment'
  | 'broadcast';

/** Where a waiting message comes from: a run of an automation, or a broadcast recipient. */
export type ChannelMessageSource =
  | { automationId: number; automationRunId: number; automationRunStartedAt: Date }
  | { broadcastId: number; broadcastRecipientId: number };

/**
 * What `saveWaitingMessage` is passed (AU35): the content **by reference only** — the step path and
 * the files' upload public ids, never the text (read at send, 6.B.10).
 */
export interface SaveWaitingMessageInput {
  databaseHandle: ChannelPortDatabaseHandle;
  organizationId: number;
  channelAccountId: number;
  contactId: number;
  source: ChannelMessageSource;
  step: ChannelMessageStep;
  messageNumber: number | null;
  versionNumber: number | null;
  wordingNumber: number | null;
  /** A kind of the channel's capability list (CA11). */
  messageKind: string;
  /** The step path (`steps.messages.2`) and the upload public ids it sends. */
  content: { stepPath: string; uploadPublicIds: readonly string[] };
  notBefore: Date | null;
  triggerOccurredAt: Date;
  /** The comment or message a private or public reply answers. */
  answersEventId: string | null;
}

/** What `saveWaitingMessage` answers: the row it wrote, or why the message can never go. */
export type SaveWaitingMessageResult =
  | { messagePublicId: string; status: 'waiting' }
  | { messagePublicId: null; status: 'skipped'; reason: string };

/** Which waiting messages a cancel or skip names (AU35). */
export interface ChannelWaitingMessageSelection {
  /** The caller's transaction; absent on an HTTP path, which runs in the caller's open unit. */
  databaseHandle?: ChannelPortDatabaseHandle | undefined;
  organizationId: number;
  by: 'run' | 'automation' | 'contact' | 'broadcast';
  id: number;
  reason: string;
}

/** A message's final result, reported to the engine in the same commit (AU35, AU25). */
export type ChannelMessageResult = 'sent' | 'failed' | 'skipped' | 'unknown';

/**
 * What a channel's sending sub-domain reports to `recordMessageResult` (AU35) — with its job's
 * organization scope, so the engine joins the result's commit (ROUTE row R14, P130).
 */
export interface ChannelMessageResultInput {
  /** The sending job's organization scope — the engine's writes join its open unit. */
  scope: OrganizationPrincipalDatabaseScope;
  databaseHandle: ChannelPortDatabaseHandle;
  organizationId: number;
  channelAccountId: number;
  automationRunId: number;
  automationRunStartedAt: Date;
  messagePublicId: string;
  step: ChannelMessageStep;
  messageNumber: number | null;
  result: ChannelMessageResult;
  reason: string | null;
  occurredAt: Date;
}

/** The normalized inbound kinds the run engine takes (4.B.10 — the inbound seam). */
export type ChannelInboundEventKind =
  | 'comment'
  | 'live_comment'
  | 'story_reply'
  | 'story_mention'
  | 'story_repost'
  | 'message'
  | 'shared_post'
  | 'starter_question'
  | 'ref_link'
  | 'ad_comment'
  | 'ad_message'
  | 'button_click'
  | 'tag_added'
  | 'tag_removed';

/**
 * The outbound port a channel's sending sub-domain implements (AU35, SN22): save a waiting message in
 * the caller's transaction, cancel or skip waiting ones, read the month's use.
 */
export interface ChannelSendingPort {
  /** Writes one waiting message in the caller's transaction and wakes its lane after commit. */
  saveWaitingMessage(input: SaveWaitingMessageInput): Promise<SaveWaitingMessageResult>;
  /** Cancels the selected waiting messages (`cancelled` with the reason) — pause, erase, delete. */
  cancelWaitingMessages(input: ChannelWaitingMessageSelection): Promise<number>;
  /** Skips the selected waiting messages (`skipped` with the reason) — live edits, P35's `replaced`. */
  skipWaitingMessages(input: ChannelWaitingMessageSelection): Promise<number>;
}

/** One sending port per channel — the caller picks it by the account's `channel`. */
export type ChannelSendingPorts = Partial<Record<ChannelAccountChannel, ChannelSendingPort>>;
