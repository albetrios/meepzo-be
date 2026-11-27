import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { withSavepoint } from '@/infrastructure/database/transaction.js';
import {
  type WorkerDatabaseSlotLimiter,
  toDatabaseSlotRunner,
} from '@/infrastructure/queue/worker-runtime/worker-database-slot-limiter.js';
import {
  INSTAGRAM_WEBHOOK_EVENTS_PER_JOB,
  INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS,
  INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES,
} from '@/shared/constants/instagram.constants.js';
import {
  getPostgresErrorCode,
  isDatabaseUnavailableError,
  isPostgresLockTimeout,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { ChannelAccountService } from '@/domains/app/sub-domains/channel-account/channel-account.service.js';
import type { BroadcastRecipientService } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.service.js';
import type { InstagramWebhookProcessingAccount } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import type { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import type { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import type { InstagramMediaRow } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import {
  type InstagramMediaGraphItem,
  readInstagramMediaItem,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import type { AutomationService } from '@/domains/app/sub-domains/automation/automation.service.js';
import type { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import type {
  AutomationRunEvent,
  AutomationRunHandlingOutcome,
  AutomationRunHandlingResult,
  AutomationRunTriggerInput,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run.types.js';
import type { InstagramOutgoingMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/instagram-outgoing-message.service.js';
import { STOP_WORDS } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import type {
  InstagramWebhookEventIntakeGroup,
  InstagramWebhookEventSkipReason,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.constants.js';
import type {
  InstagramWebhookEventClaimKey,
  InstagramWebhookEventRow,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import type { InstagramWebhookEventService } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';
import {
  type InstagramWebhookEventDispatch,
  readInstagramWebhookEventDispatch,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event-dispatch.util.js';
import {
  INSTAGRAM_COMMENT_INTAKE_JOBS_PER_ACCOUNT,
  INSTAGRAM_ECHO_MATCH_MINUTES,
  INSTAGRAM_INBOUND_FLOOD_PER_MINUTE,
  INSTAGRAM_INTAKE_ACCOUNT_SOFT_LIMIT,
  INSTAGRAM_INTAKE_LOCK_RETRIES,
  INSTAGRAM_INTAKE_LOW_PRIORITY,
  INSTAGRAM_INTAKE_PRIORITY,
  INSTAGRAM_LATE_COMMENT_MINUTES,
  INSTAGRAM_MISSED_COMMENT_ROUND_MINUTES,
  INSTAGRAM_OWNER_CHAT_QUIET_HOURS,
  INSTAGRAM_WEBHOOK_EVENT_RETRY_AFTER_MINUTES,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.constants.js';
import {
  type InstagramWebhookIntakeEnqueue,
  InstagramWebhookEventPermanentError,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';
import { enqueueInstagramWebhookIntake } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';

/** One minute, in milliseconds (the flood window, WH16). */
const ONE_MINUTE_MILLISECONDS = 60_000;

/**
 * The kinds that are her reply to a broadcast (BC17 — her first message after it): her chat
 * messages. A tap on a broadcast's button counts in its `taps` instead (§ 7.A.10).
 */
const BROADCAST_REPLY_KINDS: ReadonlySet<string> = new Set([
  'message',
  'story_reply',
  'story_mention',
  'shared_post',
  'starter_question',
  'referral',
]);

/** Postgres's `deadlock_detected` and `serialization_failure` — retried like a lock timeout (WH12). */
const RETRIED_LOCK_ERROR_CODES: ReadonlySet<string> = new Set(['40P01', '40001']);

/**
 * The services intake drives (feat-instagram-dm-sending § 5 WH7, WH27) — each through its owner's
 * service, never a repository; the contacts and the run engine only through the inbound seam.
 *
 * @remarks
 * - **Algorithm:** structural `Pick`s, so intake depends only on what it calls: the account read
 *   (state, switch, token), the stop words (2.B), 5.B's claim, marks and reads, contacts'
 *   `recordInboundContactEvent` / `recordContactOptOut`, the stored post and "next post" link, the
 *   run engine's three event entry points and 6's own-message reads.
 * - **Failure modes:** none — a type.
 * - **Side effects:** none.
 * - **Notes:** satisfied by the app container's services from the worker composition root
 *   (`createWorkerContainers` → `appDomain`); unit tests pass fakes.
 */
export interface InstagramWebhookIntakeServices {
  instagramAccountService: Pick<InstagramAccountService, 'findWebhookProcessingAccount'>;
  /** The account's break (D44) — it starts the lanes' login stop with the status change (SN5). */
  channelAccountService: Pick<ChannelAccountService, 'markAccountBroken'>;
  /** Her reply after a broadcast (BC17), in her message's commit. */
  broadcastRecipientService: Pick<
    BroadcastRecipientService,
    'recordContactReply' | 'handleChatOpened' | 'findBroadcastTap' | 'recordBroadcastTap'
  >;
  instagramAccountSettingsService: Pick<InstagramAccountSettingsService, 'findSettings'>;
  instagramWebhookEventService: Pick<
    InstagramWebhookEventService,
    | 'claimNextEvent'
    | 'markEventProcessed'
    | 'markEventSkipped'
    | 'markEventFailed'
    | 'releaseEventClaim'
    | 'countContactMessageEventsSince'
    | 'listEchoMessageIdsSince'
    | 'countWaitingEvents'
  >;
  contactService: Pick<
    ContactService,
    'lockInboundContact' | 'recordInboundContactEvent' | 'recordContactOptOut'
  >;
  instagramMediaService: Pick<
    InstagramMediaService,
    'findStoredMedia' | 'upsertFromInstagram' | 'updateCommentWatch'
  >;
  automationService: Pick<AutomationService, 'linkNextPostAutomations'>;
  automationRunService: Pick<
    AutomationRunService,
    'startCommentRun' | 'handleDirectMessage' | 'handleButtonClick'
  >;
  instagramOutgoingMessageService: Pick<
    InstagramOutgoingMessageService,
    'findOwnSentMessageIds' | 'matchEchoedMessage' | 'markTappedMessageSent'
  >;
}

/**
 * The low-priority read of a new contact's Instagram profile (scale review S11, P97): intake adds it
 * after the event's commit instead of calling Meta itself — the contact is saved without it.
 *
 * @remarks
 * The app container wires `enqueueInstagramContactProfileRead` (an `instagram-tasks` task); a unit
 * test passes a recorder. A failed add is logged — the contact simply keeps no profile.
 */
export type InstagramContactProfileReadEnqueue = (input: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  contactPublicId: string;
}) => Promise<void>;

/**
 * The one Meta read intake may still make itself (WH12 step 2): a comment's own time when its
 * webhook came over {@link INSTAGRAM_LATE_COMMENT_MINUTES} minutes late — 3 s, through
 * `metaGraphCircuit`, failing open to the received time. `null` → the received time.
 *
 * @remarks
 * Built by `createInstagramLateCommentTimeReader` (the missed-comment look's file, ROUTE row R39) and
 * passed by the intake worker; {@link NO_LATE_COMMENT_TIME_READ} — `null`, the fail-open path
 * (WH25) — is the default when none is given.
 */
export type InstagramLateCommentTimeReader = (input: {
  scope: OrganizationPrincipalDatabaseScope;
  channelAccountPublicId: string;
  instagramCommentId: string;
  requestId: string;
}) => Promise<Date | null>;

/**
 * The default {@link InstagramLateCommentTimeReader} when none is given: always the received time.
 *
 * @remarks
 * Notes: the fail-open answer (WH25) — no Meta call is made.
 */
export const NO_LATE_COMMENT_TIME_READ: InstagramLateCommentTimeReader = async () => null;

/**
 * The launch's read of a commented post intake has not stored yet (D18, IA17): outside any
 * transaction, through `metaGraphCircuit` per call, failing open. The real client by default; tests
 * pass fakes.
 *
 * @remarks
 * Notes: not one of WH25's two reads — kept at R41 beside the 15-minute "next post" linking (WC-43),
 * because the stored post's publish time serves the `between` scope and its row the missed-comment
 * watch (WH17); a difference (P312, P315).
 */
export interface InstagramWebhookIntakeInstagramClient {
  readInstagramMediaItem: typeof readInstagramMediaItem;
}

/** The real Instagram client's post read. */
const INSTAGRAM_CLIENT: InstagramWebhookIntakeInstagramClient = { readInstagramMediaItem };

/**
 * What one intake job did (WH12), returned as the job's result (Bull Board).
 *
 * @remarks
 * - **Algorithm:** `account_not_found` — no account with the job's public id; `drained` — nothing
 *   of the group waits (or its head is leased by another job); `yielded` —
 *   {@link INSTAGRAM_WEBHOOK_EVENTS_PER_JOB} events were handled and a follow-up job added.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** logged as `app.instagram_webhook.intake_job_completed`.
 */
export interface InstagramWebhookIntakeJobResult {
  outcome: 'account_not_found' | 'drained' | 'yielded';
  processedEventCount: number;
  skippedEventCount: number;
  failedEventCount: number;
}

/** What the event's one transaction decided (before it ran). */
type IntakeDecision =
  | { status: 'processed' }
  | { status: 'skipped'; skipReason: InstagramWebhookEventSkipReason };

/** What one event came to. */
type EventOutcome = 'processed' | 'skipped' | 'failed' | 'claim_lost';

/** What the event's one transaction did, for the log line and the after-commit steps. */
interface TransactionResult {
  outcome: EventOutcome;
  handling: AutomationRunHandlingOutcome | 'opted_out' | 'owner_message' | 'reaction' | null;
  runPublicIds: string[];
  /** A contact this event created — her profile is read by a low-priority task after commit. */
  newContactPublicId: string | null;
}

/** Thrown inside the transaction when the engine found the account gone (`account_unavailable`). */
class AccountUnavailableDuringIntake extends Error {
  constructor() {
    super('account_unavailable');
    this.name = 'AccountUnavailableDuringIntake';
  }
}

/** Everything one claimed event's intake needs. */
interface ClaimedEventContext {
  scope: OrganizationPrincipalDatabaseScope;
  organizationPublicId: string;
  channelAccountPublicId: string;
  services: InstagramWebhookIntakeServices;
  event: InstagramWebhookEventRow;
  claim: InstagramWebhookEventClaimKey;
  isLastAttempt: boolean;
  requestId: string;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
  readLateCommentTime: InstagramLateCommentTimeReader;
  instagramClient: InstagramWebhookIntakeInstagramClient;
}

/** The ids every intake log line carries (WH6) — never the payload, text, email or phone. */
function eventLogFields(context: ClaimedEventContext): Record<string, unknown> {
  return {
    jobId: context.requestId,
    organizationPublicId: context.organizationPublicId,
    channelAccountPublicId: context.channelAccountPublicId,
    instagramWebhookEventPublicId: context.event.public_id,
    eventKind: context.event.event_kind,
    eventKey: context.event.event_key,
    attemptCount: context.event.attempt_count,
  };
}

/**
 * An event's `error_message` (WH12): a code only — never payload text, never the error's own
 * message (a database error can quote a value).
 *
 * @remarks
 * - **Algorithm:** a {@link InstagramWebhookEventPermanentError} → its message (already a code);
 *   anything else → `processing_error:<error name>`, plus Postgres's SQLSTATE when it has one.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 * - **Notes:** exported for the unit test; the repository cuts it to the column's 2000 characters.
 */
export function describeInstagramWebhookIntakeError(error: unknown): string {
  if (error instanceof InstagramWebhookEventPermanentError) return error.message;
  const name = error instanceof Error ? error.name : typeof error;
  const code = getPostgresErrorCode(error);
  return code === undefined ? `processing_error:${name}` : `processing_error:${name}:${code}`;
}

/** A deadlock, a serialization failure or a lock timeout — the transaction is retried (WH12). */
function isRetriedLockError(error: unknown): boolean {
  const code = getPostgresErrorCode(error);
  return (code !== undefined && RETRIED_LOCK_ERROR_CODES.has(code)) || isPostgresLockTimeout(error);
}

/**
 * Why a claimed event is skipped before its transaction (WH3): the account gone or `revoked` →
 * `account_disconnected`; its switch off → `automation_disabled`. An `error`, paused or stopped
 * account is taken in — its messages wait in its stopped lanes.
 */
function accountSkipReason(
  account: InstagramWebhookProcessingAccount | null,
): InstagramWebhookEventSkipReason | null {
  if (account === null || account.connectionStatus === 'revoked') return 'account_disconnected';
  if (!account.isAutomationEnabled) return 'automation_disabled';
  return null;
}

/**
 * Her whole message cleaned as plan §14.4 rule 1 says: lower case, punctuation, symbols and emoji
 * removed, spaces trimmed and folded — "STOP!" is "stop" (ROUTE row R54, AC-19.11).
 */
function cleanStopWordText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Extended_Pictographic}]|\u200d|\ufe0f/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Whether her text is a stop word of the account (D49, CT6): `STOP_WORDS` plus `extra_stop_words`. */
function isStopWord({ text, extraStopWords }: { text: string | null; extraStopWords: string[] }) {
  if (text === null) return false;
  const word = cleanStopWordText(text);
  return (
    word !== '' &&
    (STOP_WORDS.includes(word) || extraStopWords.some((extra) => cleanStopWordText(extra) === word))
  );
}

/** The facts read before the event's transaction (WH12 step 2) — reads only, no lock held. */
interface PreparedEvent {
  dispatch: InstagramWebhookEventDispatch;
  account: InstagramWebhookProcessingAccount;
  decision: IntakeDecision;
  occurredAt: Date;
  isStopWord: boolean;
  isOwnerChatting: boolean;
  /** A comment's post as stored, or read from Meta when not stored yet (`null` when neither). */
  commentedPost: { stored: InstagramMediaRow | null; read: InstagramMediaGraphItem | null } | null;
}

/** Whether the owner typed to her by hand in the last 6 hours (WH10): an echo not of ours. */
async function readIsOwnerChatting({
  context,
  channelAccount,
  contactInstagramUserId,
}: {
  context: ClaimedEventContext;
  channelAccount: { organizationId: number; channelAccountId: number };
  contactInstagramUserId: string;
}): Promise<boolean> {
  const { scope, services } = context;
  const echoMessageIds = await services.instagramWebhookEventService.listEchoMessageIdsSince({
    scope,
    channelAccount,
    contactInstagramUserId,
    since: new Date(Date.now() - INSTAGRAM_OWNER_CHAT_QUIET_HOURS * 60 * ONE_MINUTE_MILLISECONDS),
  });
  if (echoMessageIds.length === 0) return false;
  const ours = await services.instagramOutgoingMessageService.findOwnSentMessageIds({
    scope,
    channelAccount,
    messageIds: echoMessageIds,
  });
  return echoMessageIds.some((messageId) => !ours.has(messageId));
}

/** WH12 step 2: the account check, the dispatch and the reads its decision needs. */
async function prepareEvent({
  context,
  account,
}: {
  context: ClaimedEventContext;
  account: InstagramWebhookProcessingAccount;
}): Promise<PreparedEvent> {
  const { event, scope, services } = context;
  const dispatch = readInstagramWebhookEventDispatch({
    eventKind: event.event_kind,
    payload: event.payload,
    contactInstagramUserId: event.contact_instagram_user_id,
  });
  const channelAccount = {
    organizationId: account.instagramAccount.organizationId,
    channelAccountId: account.channelAccountId,
  };
  let occurredAt = event.occurred_at ?? event.created_at;
  if (
    (dispatch.inboundKind === 'comment' || dispatch.inboundKind === 'live_comment') &&
    event.created_at.getTime() - occurredAt.getTime() >
      INSTAGRAM_LATE_COMMENT_MINUTES * ONE_MINUTE_MILLISECONDS
  ) {
    // A late webhook: the comment's own time from Meta, failing open (WH12 step 2, WH25).
    try {
      occurredAt =
        (await context.readLateCommentTime({
          scope,
          channelAccountPublicId: context.channelAccountPublicId,
          instagramCommentId: dispatch.instagramCommentId,
          requestId: context.requestId,
        })) ?? occurredAt;
    } catch (error) {
      logger.warn(
        { ...eventLogFields(context), failure: describeInstagramWebhookIntakeError(error) },
        'app.instagram_webhook.comment_time_read_failed',
      );
    }
  }
  let stopWord = false;
  let isOwnerChatting = false;
  let decision: IntakeDecision = { status: 'processed' };
  const typedText = typedTextOf(dispatch);
  if (dispatch.inboundKind === 'message' || typedText !== null) {
    const settings = await services.instagramAccountSettingsService.findSettings({
      scope,
      channelAccount,
    });
    stopWord = isStopWord({
      text: typedText,
      extraStopWords: settings?.extra_stop_words ?? [],
    });
  }
  if (
    dispatch.inboundKind !== 'owner_message' &&
    dispatch.inboundKind !== 'comment' &&
    dispatch.inboundKind !== 'live_comment'
  ) {
    const recentCount = await services.instagramWebhookEventService.countContactMessageEventsSince({
      scope,
      channelAccount,
      contactInstagramUserId: dispatch.contactInstagramUserId,
      since: new Date(event.created_at.getTime() - ONE_MINUTE_MILLISECONDS),
    });
    if (recentCount > INSTAGRAM_INBOUND_FLOOD_PER_MINUTE) {
      decision = { status: 'skipped', skipReason: 'flood' };
    }
  }
  if (
    decision.status === 'processed' &&
    (dispatch.inboundKind === 'message' ||
      dispatch.inboundKind === 'story_reply' ||
      dispatch.inboundKind === 'story_mention' ||
      dispatch.inboundKind === 'shared_post' ||
      (dispatch.inboundKind === 'referral' && dispatch.carriedMessage !== null))
  ) {
    isOwnerChatting = await readIsOwnerChatting({
      context,
      channelAccount,
      contactInstagramUserId: dispatch.contactInstagramUserId,
    });
  }
  const commentedPost =
    dispatch.inboundKind === 'comment' || dispatch.inboundKind === 'live_comment'
      ? await readCommentedPost({ context, account, instagramMediaId: dispatch.instagramMediaId })
      : null;
  return {
    dispatch,
    account,
    decision,
    occurredAt,
    isStopWord: stopWord,
    isOwnerChatting,
    commentedPost,
  };
}

/** `instagram_api:<code>/<subcode>` — or the error's class when Meta sent no code. */
function describeMetaGraphApiError(error: MetaGraphApiError): string {
  if (error.instagramErrorCode === null) return `instagram_api:${error.errorClass}`;
  return error.instagramErrorSubcode === null
    ? `instagram_api:${error.instagramErrorCode}`
    : `instagram_api:${error.instagramErrorCode}/${error.instagramErrorSubcode}`;
}

/**
 * Meta refused the account's token on the post read (D44, the one exception to failing open): the
 * channel account's break (`markAccountBroken` — the guarded status change, the reconnect notice
 * and the lanes' login stop, SN5), then the event fails at once. Any other failure returns, for the caller to fail open.
 */
async function failOnTokenRefusal({
  context,
  account,
  error,
}: {
  context: ClaimedEventContext;
  account: InstagramWebhookProcessingAccount;
  error: unknown;
}): Promise<void> {
  if (!(error instanceof MetaGraphApiError) || error.errorClass !== 'auth') return;
  // The channel account's break: the status change, the reconnect notice and the lanes' login stop.
  await context.services.channelAccountService.markAccountBroken({
    scope: context.scope,
    organizationId: account.instagramAccount.organizationId,
    channelAccountId: account.channelAccountId,
    requestId: context.requestId,
  });
  throw new InstagramWebhookEventPermanentError(describeMetaGraphApiError(error), { cause: error });
}

/**
 * A comment's post (D18, IA17): the stored row, else one fail-open Meta read of it (no lock held) —
 * its publish time for the `between` scope and "next post" linking, its row for the missed-comment
 * watch (P315).
 */
async function readCommentedPost({
  context,
  account,
  instagramMediaId,
}: {
  context: ClaimedEventContext;
  account: InstagramWebhookProcessingAccount;
  instagramMediaId: string;
}): Promise<PreparedEvent['commentedPost']> {
  const stored = await context.services.instagramMediaService.findStoredMedia({
    scope: context.scope,
    channelAccount: {
      organizationId: account.instagramAccount.organizationId,
      channelAccountId: account.channelAccountId,
    },
    instagramMediaId,
  });
  if (stored !== null || account.encryptedAccessToken === null) return { stored, read: null };
  try {
    const read = await context.instagramClient.readInstagramMediaItem({
      encryptedAccessToken: account.encryptedAccessToken,
      instagramMediaId,
      requestId: context.requestId,
    });
    return { stored, read };
  } catch (error) {
    await failOnTokenRefusal({ context, account, error });
    logger.warn(
      { ...eventLogFields(context), failure: describeInstagramWebhookIntakeError(error) },
      'app.instagram_webhook.post_read_failed',
    );
    return { stored, read: null };
  }
}

/**
 * A comment's post and "next post" link (D18, AU15) inside the event's transaction: a post read
 * from Meta is stored in a savepoint, then the link in another — a failed store or link is logged
 * and the comment still matched. Answers the stored post (for its missed-comment watch) and its
 * publish time for the engine's `between` scope.
 */
async function linkCommentedPost({
  context,
  account,
  instagramMediaId,
  commentedPost,
}: {
  context: ClaimedEventContext;
  account: InstagramWebhookProcessingAccount;
  instagramMediaId: string;
  commentedPost: PreparedEvent['commentedPost'];
}): Promise<InstagramMediaRow | null> {
  const { scope, services } = context;
  const channelAccount = {
    organizationId: account.instagramAccount.organizationId,
    channelAccountId: account.channelAccountId,
  };
  let storedPost = commentedPost?.stored ?? null;
  const mediaItem = commentedPost?.read ?? null;
  if (storedPost === null && mediaItem !== null) {
    try {
      storedPost =
        (await withSavepoint(() =>
          services.instagramMediaService.upsertFromInstagram({ scope, channelAccount, mediaItem }),
        )) ?? null;
    } catch (error) {
      // An answer the media service cannot map is Meta's fault — logged, the comment still matched.
      if (!(error instanceof MetaGraphApiError)) throw error;
      logger.warn(
        { ...eventLogFields(context), failure: describeInstagramWebhookIntakeError(error) },
        'app.instagram_webhook.post_store_failed',
      );
    }
  }
  if (storedPost === null) return null;
  const publishedAt = storedPost.published_at;
  try {
    await withSavepoint(() =>
      services.automationService.linkNextPostAutomations({
        scope,
        channelAccountPublicId: context.channelAccountPublicId,
        instagramMediaId,
        publishedAt,
      }),
    );
  } catch (error) {
    logger.warn(
      { ...eventLogFields(context), failure: describeInstagramWebhookIntakeError(error) },
      'app.instagram_webhook.next_post_link_failed',
    );
  }
  return storedPost;
}

/** The engine's answers that leave a post unwatched: no automation took the comment (WH17). */
const UNWATCHED_COMMENT_OUTCOMES: ReadonlySet<AutomationRunHandlingOutcome> = new Set([
  'nothing_matched',
  'account_unavailable',
]);

/**
 * Starts a post's missed-comment watch (WH17, WC-26) the first time one of its comments reaches a
 * live comment automation: `comments_next_check_at` 30 minutes on and the comment as its last seen,
 * in a savepoint of the event's transaction — written once per watch (a watched post's later
 * comments do not touch the row), a failure logged and the comment still taken in. A Live is not
 * watched (its comments are not read back).
 */
async function startCommentWatch({
  context,
  account,
  storedPost,
  occurredAt,
}: {
  context: ClaimedEventContext;
  account: InstagramWebhookProcessingAccount;
  storedPost: InstagramMediaRow;
  occurredAt: Date;
}): Promise<void> {
  if (storedPost.comments_next_check_at !== null || storedPost.media_product_type === 'live')
    return;
  try {
    await withSavepoint(() =>
      context.services.instagramMediaService.updateCommentWatch({
        scope: context.scope,
        channelAccount: {
          organizationId: account.instagramAccount.organizationId,
          channelAccountId: account.channelAccountId,
        },
        instagramMediaId: storedPost.instagram_media_id,
        watch: {
          commentsNextCheckAt: new Date(
            Date.now() + INSTAGRAM_MISSED_COMMENT_ROUND_MINUTES * ONE_MINUTE_MILLISECONDS,
          ),
          lastCommentAt: occurredAt,
        },
      }),
    );
  } catch (error) {
    logger.warn(
      { ...eventLogFields(context), failure: describeInstagramWebhookIntakeError(error) },
      'app.instagram_webhook.comment_watch_start_failed',
    );
  }
}

/** The comment run's kind (WH27): a Live comment, else an ad's comment when it carries an ad id. */
function commentRunKindOf(dispatch: {
  inboundKind: 'comment' | 'live_comment';
  adId: string | null;
}): 'live_comment' | 'comment' | 'ad_comment' {
  if (dispatch.inboundKind === 'live_comment') return 'live_comment';
  return dispatch.adId === null ? 'comment' : 'ad_comment';
}

/** The run engine's entry point for the dispatched kind (WH13, WH27; 4.B.10). */
async function callRunEngine({
  context,
  prepared,
  trigger,
  isFirstMessage,
  broadcastStartAutomationPublicId = null,
}: {
  context: ClaimedEventContext;
  prepared: PreparedEvent;
  trigger: AutomationRunTriggerInput;
  /** Her first message in the chat (`first_message_at` was empty) — plan §4.3 level 4. */
  isFirstMessage: boolean;
  /** A tapped broadcast button's "start automation" (§ 7.A.10); `null` — none. */
  broadcastStartAutomationPublicId?: string | null;
}): Promise<AutomationRunHandlingResult | null> {
  const { automationRunService } = context.services;
  const { dispatch } = prepared;
  switch (dispatch.inboundKind) {
    case 'comment':
    case 'live_comment': {
      const storedPost = await linkCommentedPost({
        context,
        account: prepared.account,
        instagramMediaId: dispatch.instagramMediaId,
        commentedPost: prepared.commentedPost,
      });
      const mediaPublishedAt = storedPost?.published_at ?? null;
      const handled = await automationRunService.startCommentRun({
        ...trigger,
        kind: commentRunKindOf(dispatch),
        commentId: dispatch.instagramCommentId,
        mediaId: dispatch.instagramMediaId,
        adId: dispatch.adId,
        parentCommentId: dispatch.parentCommentId,
        isOwnComment: false,
        mediaPublishedAt,
        text: dispatch.text,
        commenterUsername: dispatch.username,
      });
      if (storedPost !== null && !UNWATCHED_COMMENT_OUTCOMES.has(handled.outcome)) {
        await startCommentWatch({
          context,
          account: prepared.account,
          storedPost,
          occurredAt: prepared.occurredAt,
        });
      }
      return handled;
    }
    case 'message':
    case 'story_reply':
    case 'story_mention':
    case 'shared_post':
      return automationRunService.handleDirectMessage({
        ...trigger,
        kind: dispatch.inboundKind,
        text: dispatch.text,
        quickReplyPayload: dispatch.quickReplyPayload,
        attachmentEmail: dispatch.attachmentEmail,
        storyId: dispatch.storyId,
        sharedMediaId: dispatch.sharedMediaId,
        isFirstMessage,
        isOwnerChatting: prepared.isOwnerChatting,
      });
    case 'postback':
      // A broadcast message's button starts the automation it names for her (§ 7.A.10).
      if (dispatch.broadcastPublicId !== null) {
        if (broadcastStartAutomationPublicId === null) return null;
        return automationRunService.handleButtonClick({
          ...trigger,
          kind: 'broadcast_tap',
          automationPublicId: broadcastStartAutomationPublicId,
        });
      }
      // A payload this engine never sent names no run: nothing continues (D18).
      if (dispatch.button === null) return null;
      return automationRunService.handleButtonClick({
        ...trigger,
        kind: 'postback',
        ...dispatch.button,
      });
    case 'starter_question':
      return automationRunService.handleButtonClick({
        ...trigger,
        kind: 'starter_question',
        starterQuestion: dispatch.starterQuestion,
      });
    case 'referral':
      // Her message the referral rode on goes on as a message when no automation takes the
      // referral (the engine's fall-back, like a paused starter question's).
      return automationRunService.handleButtonClick({
        ...trigger,
        kind: dispatch.adId === null ? 'ref_link' : 'ad_message',
        refCode: dispatch.refCode,
        adId: dispatch.adId,
        carriedMessage:
          dispatch.carriedMessage === null
            ? null
            : {
                ...dispatch.carriedMessage,
                isFirstMessage,
                isOwnerChatting: prepared.isOwnerChatting,
              },
      });
    default:
      return null;
  }
}

/**
 * Her typed text the stop word reads: a message's, or the message a referral rode on (a
 * click-to-DM ad's first DM); `null` for every other kind.
 */
function typedTextOf(dispatch: InstagramWebhookEventDispatch): string | null {
  if (dispatch.inboundKind === 'message') return dispatch.text;
  if (dispatch.inboundKind === 'referral') return dispatch.carriedMessage?.text ?? null;
  return null;
}

/** The guarded first statement (WH12 step 3): the event final while it still waits. */
function markEventFinal({
  context,
  decision,
}: {
  context: ClaimedEventContext;
  decision: IntakeDecision;
}): Promise<boolean> {
  const { scope, services, claim } = context;
  return decision.status === 'processed'
    ? services.instagramWebhookEventService.markEventProcessed({ scope, claim })
    : services.instagramWebhookEventService.markEventSkipped({
        scope,
        claim,
        skipReason: decision.skipReason,
      });
}

/**
 * The part of the event's transaction after her contact is recorded (WH12 step 3, WH13, WH16): a
 * stop word opts her out first (even inside a flood); a skipped event or a reaction stops there;
 * else the run engine's entry point (automation → runs, the one lock order).
 */
async function decideAfterContact({
  context,
  prepared,
  databaseHandle,
  recorded,
}: {
  context: ClaimedEventContext;
  prepared: PreparedEvent;
  databaseHandle: WorkerDatabaseHandle;
  recorded: Awaited<ReturnType<ContactService['recordInboundContactEvent']>>;
}): Promise<Pick<TransactionResult, 'handling' | 'runPublicIds'>> {
  const { scope, services } = context;
  if (prepared.isStopWord) {
    // Her waiting messages skipped, her open runs cancelled (the pause steps, CT6).
    await services.contactService.recordContactOptOut({
      databaseHandle,
      organizationId: prepared.account.instagramAccount.organizationId,
      contactId: recorded.contact.id,
      optedOutAt: prepared.occurredAt,
    });
    return { handling: 'opted_out', runPublicIds: [] };
  }
  if (prepared.decision.status === 'skipped') return { handling: null, runPublicIds: [] };
  if (prepared.dispatch.inboundKind === 'reaction')
    return { handling: 'reaction', runPublicIds: [] };
  const organizationId = prepared.account.instagramAccount.organizationId;
  const broadcastTap = await readTapBeforeEngine({ context, prepared, databaseHandle });
  const handled = await callRunEngine({
    context,
    prepared,
    trigger: {
      scope,
      channelAccountPublicId: context.channelAccountPublicId,
      contact: recorded.contact,
      event: runEventOf({ context, prepared }),
    },
    isFirstMessage: recorded.isFirstMessage,
    broadcastStartAutomationPublicId: broadcastTap?.startAutomationPublicId ?? null,
  });
  if (handled?.outcome === 'account_unavailable') throw new AccountUnavailableDuringIntake();
  if (broadcastTap !== null) {
    // The broadcast's `taps` + 1 (§ 7.A.10) — after the engine, in the one lock order.
    await services.broadcastRecipientService.recordBroadcastTap({
      databaseHandle,
      organizationId,
      broadcastId: broadcastTap.broadcastId,
    });
  }
  if (BROADCAST_REPLY_KINDS.has(prepared.dispatch.inboundKind)) {
    // Her reply after a broadcast (BC17) — after the engine, so the lock order stays contact →
    // automation → runs, then her recipients.
    await services.broadcastRecipientService.recordContactReply({
      databaseHandle,
      organizationId: prepared.account.instagramAccount.organizationId,
      contactId: recorded.contact.id,
      repliedAt: prepared.occurredAt,
    });
    // Her chat opened: a "when her chat opens" broadcast she matches makes her row (BC17, R47) —
    // after the engine, so a run it just started holds her (an open-run key) and she waits.
    await services.broadcastRecipientService.handleChatOpened({
      databaseHandle,
      organizationId: prepared.account.instagramAccount.organizationId,
      channelAccountId: prepared.account.channelAccountId,
      contactId: recorded.contact.id,
      isOwnerChatting: prepared.isOwnerChatting,
    });
  }
  return { handling: handled?.outcome ?? 'ignored', runPublicIds: handled?.runPublicIds ?? [] };
}

/**
 * A tap's work before the run engine, in the tap's unit: the message whose button she tapped goes
 * `unknown` → `sent` (her tap proves it arrived — the payload's `igm_…`, R44), and a broadcast
 * message's button names its broadcast and the automation it starts (§ 7.A.10, R45). `null` when
 * the event is no tap on a broadcast's button.
 */
async function readTapBeforeEngine({
  context,
  prepared,
  databaseHandle,
}: {
  context: ClaimedEventContext;
  prepared: PreparedEvent;
  databaseHandle: WorkerDatabaseHandle;
}): Promise<{ broadcastId: number; startAutomationPublicId: string | null } | null> {
  const { dispatch } = prepared;
  if (dispatch.inboundKind !== 'postback') return null;
  const organizationId = prepared.account.instagramAccount.organizationId;
  if (dispatch.messagePublicId !== null) {
    await context.services.instagramOutgoingMessageService.markTappedMessageSent({
      databaseHandle,
      organizationId,
      messagePublicId: dispatch.messagePublicId,
    });
  }
  if (dispatch.broadcastPublicId === null) return null;
  return context.services.broadcastRecipientService.findBroadcastTap({
    databaseHandle,
    organizationId,
    broadcastPublicId: dispatch.broadcastPublicId,
  });
}

/**
 * The event's one transaction (WH12 step 3) — the first statement marks the event final while it
 * still waits (0 rows → another run did it: stop), then contact → run engine (automation → runs) →
 * the message rows (6, through the engine's sending port), in the one lock order (WH26).
 */
async function runEventTransaction({
  context,
  prepared,
}: {
  context: ClaimedEventContext;
  prepared: PreparedEvent;
}): Promise<TransactionResult> {
  const { scope, services } = context;
  const { dispatch, account, decision } = prepared;
  const organizationId = account.instagramAccount.organizationId;
  return context.runInDatabaseSlot(() =>
    withAppDatabaseContext({
      scope,
      callback: async (databaseHandle: WorkerDatabaseHandle): Promise<TransactionResult> => {
        const empty = { handling: null, runPublicIds: [], newContactPublicId: null };
        // Lock order (WH26): her contact first, before the mark — two intake jobs of one person
        // queue here; an erase holding her goes first and the event then starts her afresh (CT9).
        await services.contactService.lockInboundContact({
          databaseHandle,
          organizationId,
          channelAccountId: account.channelAccountId,
          providerUserId: dispatch.contactInstagramUserId,
        });
        if (!(await markEventFinal({ context, decision }))) {
          return { outcome: 'claim_lost', ...empty };
        }
        if (dispatch.inboundKind === 'owner_message') {
          // WH10: our own message whose send was not saved with Meta's id yet → `sent`; else the
          // owner typed it — the quiet time reads this processed echo (6 hours).
          await services.instagramOutgoingMessageService.matchEchoedMessage({
            scope,
            organizationId,
            channelAccountId: account.channelAccountId,
            contactInstagramUserId: dispatch.contactInstagramUserId,
            instagramMessageId: dispatch.instagramMessageId,
            withinMinutes: INSTAGRAM_ECHO_MATCH_MINUTES,
          });
          return { outcome: decision.status, ...empty, handling: 'owner_message' };
        }
        // Lock order (WH26): her contact first — the upsert locks her row.
        const isComment =
          dispatch.inboundKind === 'comment' || dispatch.inboundKind === 'live_comment';
        const recorded = await services.contactService.recordInboundContactEvent({
          databaseHandle,
          organizationId,
          channelAccountId: account.channelAccountId,
          providerUserId: dispatch.contactInstagramUserId,
          kind: dispatch.inboundKind,
          occurredAt: prepared.occurredAt,
          username: isComment ? dispatch.username : null,
        });
        const decided = await decideAfterContact({ context, prepared, databaseHandle, recorded });
        return {
          outcome: decision.status,
          ...decided,
          newContactPublicId: recorded.isNewContact ? recorded.contact.public_id : null,
        };
      },
    }),
  );
}

/** The engine's event (4.B.10): its key, its own id (the "every time" once key, D65), its time. */
function runEventOf({
  context,
  prepared,
}: {
  context: ClaimedEventContext;
  prepared: PreparedEvent;
}): AutomationRunEvent {
  const { event } = context;
  return {
    eventKey: event.event_key,
    eventId: event.event_key.slice(event.event_key.indexOf(':') + 1),
    occurredAt: prepared.occurredAt,
    isLastAttempt: context.isLastAttempt,
    requestId: context.requestId,
  };
}

/** WH12 step 3 with its lock retries: a deadlock or lock timeout runs the transaction again ×3. */
async function runEventTransactionWithLockRetries({
  context,
  prepared,
}: {
  context: ClaimedEventContext;
  prepared: PreparedEvent;
}): Promise<TransactionResult> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await runEventTransaction({ context, prepared });
    } catch (error) {
      if (!isRetriedLockError(error) || retry >= INSTAGRAM_INTAKE_LOCK_RETRIES) throw error;
      logger.warn(
        { ...eventLogFields(context), retry: retry + 1, code: getPostgresErrorCode(error) },
        'app.instagram_webhook.event_lock_retry',
      );
    }
  }
}

/** Marks a claimed event `skipped` outside the event transaction (WH3) and logs it. */
async function skipClaimedEvent({
  context,
  skipReason,
}: {
  context: ClaimedEventContext;
  skipReason: InstagramWebhookEventSkipReason;
}): Promise<EventOutcome> {
  const { services, scope, claim } = context;
  const isMarked = await context.runInDatabaseSlot(() =>
    services.instagramWebhookEventService.markEventSkipped({ scope, claim, skipReason }),
  );
  logger.info(
    { ...eventLogFields(context), skipReason, isMarked },
    'app.instagram_webhook.event_skipped',
  );
  return isMarked ? 'skipped' : 'claim_lost';
}

/**
 * A failure of one claimed event (WH12): Postgres unreachable or a lost connection gives the claim
 * back **without using a try** and rethrows (the job retries with backoff); a permanent refusal
 * fails the event at once with no `next_attempt_at`; the 5th failed try fails it with
 * `next_attempt_at` an hour later (the pick-up tries it again, WH17); any earlier failure ends the
 * lease (the try kept) and rethrows, so the group's job retries with backoff.
 */
async function settleFailedEvent({
  context,
  error,
}: {
  context: ClaimedEventContext;
  error: unknown;
}): Promise<EventOutcome> {
  const { services, scope, claim } = context;
  if (isDatabaseUnavailableError(error)) {
    await services.instagramWebhookEventService
      .releaseEventClaim({ scope, claim })
      .catch(() => undefined);
    logger.warn(eventLogFields(context), 'app.instagram_webhook.event_released_for_database');
    throw error;
  }
  const errorMessage = describeInstagramWebhookIntakeError(error);
  const isPermanent = error instanceof InstagramWebhookEventPermanentError;
  if (isPermanent || context.isLastAttempt) {
    const isMarked = await context.runInDatabaseSlot(() =>
      services.instagramWebhookEventService.markEventFailed({
        scope,
        claim,
        errorMessage,
        retryAfterMinutes: isPermanent ? null : INSTAGRAM_WEBHOOK_EVENT_RETRY_AFTER_MINUTES,
      }),
    );
    logger.warn(
      { ...eventLogFields(context), errorMessage, isMarked },
      'app.instagram_webhook.event_failed',
    );
    return isMarked ? 'failed' : 'claim_lost';
  }
  await context.runInDatabaseSlot(() =>
    services.instagramWebhookEventService.releaseEventClaim({ scope, claim, isAttemptSpent: true }),
  );
  logger.warn(
    { ...eventLogFields(context), errorMessage },
    'app.instagram_webhook.event_retry_scheduled',
  );
  throw error;
}

/** WH12 for one claimed event: the account check, the reads, the one transaction, the after-commit. */
async function takeInClaimedEvent({
  context,
  enqueueProfileRead,
}: {
  context: ClaimedEventContext;
  enqueueProfileRead: InstagramContactProfileReadEnqueue | null;
}): Promise<EventOutcome> {
  const { services, scope } = context;
  try {
    const account = await context.runInDatabaseSlot(() =>
      services.instagramAccountService.findWebhookProcessingAccount({
        scope,
        instagramAccountPublicId: context.channelAccountPublicId,
      }),
    );
    const skipReason = accountSkipReason(account);
    if (account === null || skipReason !== null) {
      return skipClaimedEvent({ context, skipReason: skipReason ?? 'account_disconnected' });
    }
    const prepared = await context.runInDatabaseSlot(() => prepareEvent({ context, account }));
    let transaction: TransactionResult;
    try {
      transaction = await runEventTransactionWithLockRetries({ context, prepared });
    } catch (error) {
      if (!(error instanceof AccountUnavailableDuringIntake)) throw error;
      return skipClaimedEvent({ context, skipReason: 'account_disconnected' });
    }
    logger.info(
      {
        ...eventLogFields(context),
        outcome: transaction.outcome,
        inboundKind: prepared.dispatch.inboundKind,
        handling: transaction.handling,
        runPublicIds: transaction.runPublicIds,
        ...(prepared.decision.status === 'skipped'
          ? { skipReason: prepared.decision.skipReason }
          : {}),
      },
      'app.instagram_webhook.event_taken_in',
    );
    // After the commit: the new contact's profile as a low-priority task (S11), best effort.
    if (transaction.newContactPublicId !== null && enqueueProfileRead !== null) {
      await enqueueProfileRead({
        organizationPublicId: context.organizationPublicId,
        channelAccountPublicId: context.channelAccountPublicId,
        contactPublicId: transaction.newContactPublicId,
      }).catch((error: unknown) => {
        logger.warn(
          { ...eventLogFields(context), failure: describeInstagramWebhookIntakeError(error) },
          'app.instagram_webhook.profile_read_enqueue_failed',
        );
      });
    }
    return transaction.outcome;
  } catch (error) {
    return settleFailedEvent({ context, error });
  }
}

/**
 * The follow-up of a job that handled its 25 events (WH5, WH11): messages and Live go on at
 * priority 1; comments at 5, or {@link INSTAGRAM_INTAKE_LOW_PRIORITY} while more than
 * {@link INSTAGRAM_INTAKE_ACCOUNT_SOFT_LIMIT} wait, in every comment slot (S11).
 */
async function enqueueFollowUps({
  scope,
  services,
  intakeKind,
  channelAccount,
  organizationPublicId,
  channelAccountPublicId,
  requestId,
  enqueueFollowUp,
}: {
  scope: OrganizationPrincipalDatabaseScope;
  services: InstagramWebhookIntakeServices;
  intakeKind: InstagramWebhookEventIntakeGroup;
  channelAccount: { organizationId: number; channelAccountId: number };
  organizationPublicId: string;
  channelAccountPublicId: string;
  requestId: string;
  enqueueFollowUp: InstagramWebhookIntakeEnqueue;
}): Promise<void> {
  if (intakeKind !== 'comments') {
    await enqueueFollowUp({ organizationPublicId, channelAccountPublicId, intakeKind, requestId });
    return;
  }
  const waitingCount = await services.instagramWebhookEventService.countWaitingEvents({
    scope,
    channelAccount,
    intakeGroup: 'comments',
    cap: INSTAGRAM_INTAKE_ACCOUNT_SOFT_LIMIT + 1,
  });
  const priority =
    waitingCount > INSTAGRAM_INTAKE_ACCOUNT_SOFT_LIMIT
      ? INSTAGRAM_INTAKE_LOW_PRIORITY
      : INSTAGRAM_INTAKE_PRIORITY.comments;
  for (let slot = 0; slot < INSTAGRAM_COMMENT_INTAKE_JOBS_PER_ACCOUNT; slot += 1) {
    await enqueueFollowUp({
      organizationPublicId,
      channelAccountPublicId,
      intakeKind,
      requestId,
      priority,
      slot,
    });
  }
}

/** An event whose tries are spent (WH21): logged with its kind and tries, never its content. */
function logExhaustedEvent({
  logFields,
  event,
}: {
  logFields: Record<string, unknown>;
  event: { public_id: string; event_kind: string; attempt_count: number };
}): void {
  logger.warn(
    {
      ...logFields,
      instagramWebhookEventPublicId: event.public_id,
      eventKind: event.event_kind,
      attemptCount: event.attempt_count,
    },
    'app.instagram_webhook.event_attempts_exhausted',
  );
}

/** One claimed event's outcome added to the job's counts. */
function countEventOutcome({
  result,
  outcome,
}: {
  result: InstagramWebhookIntakeJobResult;
  outcome: Awaited<ReturnType<typeof takeInClaimedEvent>>;
}): void {
  if (outcome === 'processed') result.processedEventCount += 1;
  else if (outcome === 'skipped') result.skippedEventCount += 1;
  else if (outcome === 'failed') result.failedEventCount += 1;
}

/**
 * One intake job of a kind group of one Instagram account (feat-instagram-dm-sending § 5 WH5,
 * WH11–WH14, WH16, WH25–WH27; worker-changes WC-1–WC-3): decides and saves — never sends.
 *
 * @remarks
 * - **Algorithm:** under the job's organization scope (`PRINCIPAL_SCOPE.JOB`, K8): the account read
 *   (`null` → nothing to do). Then, up to {@link INSTAGRAM_WEBHOOK_EVENTS_PER_JOB} times:
 *   (1) claim the group's oldest waiting event in a short unit — the head for `messages` / `live`,
 *   the oldest free row `SKIP LOCKED` for `comments` (S11); one more try, a 5-minute lease; a row
 *   that used its 5 tries is `failed` with `next_attempt_at` by the claim; (2) outside any
 *   transaction: the account again (gone or `revoked` → `skipped account_disconnected`, the switch
 *   off → `skipped automation_disabled`; an `error` or stopped account is taken in, WH3), the
 *   dispatch (WH27's normalized kind), a late comment's own time (failing open), the stop words,
 *   the flood count (WH16 — more than 20 of her message events in a minute → `skipped flood`) and
 *   the owner's quiet time (WH10); (3) **one transaction**: the guarded mark first (0 rows → done
 *   already, stop), her contact (`recordInboundContactEvent` — the lock order's first lock, WH26), a
 *   stop word's opt-out, then the run engine's entry point (automation → runs; the message rows
 *   through the engine's sending port); an echo instead matches our own unconfirmed message (6) or
 *   starts the quiet time; (4) after the commit, a new contact's profile read as a low-priority
 *   task (S11). After the batch, one follow-up job (comments: every slot, the lowest priority while
 *   over 500 wait).
 * - **Failure modes:** a deadlock or lock timeout retries the transaction 3 times; Postgres
 *   unreachable gives the claim back without a try and rethrows (the job's backoff); a permanent
 *   refusal (an unreadable payload) fails the event at once; the 5th failed try fails it with
 *   `next_attempt_at` an hour later; an earlier failure keeps the try and rethrows — only that
 *   group of that account waits. Never paused by a provider outage (WH25): intake makes no Meta
 *   call but the late comment's time read, which fails open.
 * - **Side effects:** event status, tries and lease (5.B); the contact (3), runs, run events,
 *   comment logs, counts and waiting messages (4.B, 6) — in the event's one commit; a profile-read
 *   task; at most a few follow-up jobs.
 * - **Notes:** every unit of work takes a slot of the process's Instagram database limiter
 *   (`runInDatabaseSlot`, SN24); logs carry ids, kinds and counts only (WH6). A skipped event is
 *   never taken in later, even when the switch is turned back on.
 */
export async function processInstagramWebhookIntakeJob({
  jobData,
  services,
  jobId,
  enqueueFollowUp = enqueueInstagramWebhookIntake,
  enqueueProfileRead = null,
  readLateCommentTime = NO_LATE_COMMENT_TIME_READ,
  instagramClient = INSTAGRAM_CLIENT,
  limiter = null,
}: {
  jobData: {
    organizationPublicId: string;
    channelAccountPublicId: string;
    intakeKind: InstagramWebhookEventIntakeGroup;
  };
  services: InstagramWebhookIntakeServices;
  /** The job's id — the request id of log lines and the engine. */
  jobId: string;
  enqueueFollowUp?: InstagramWebhookIntakeEnqueue | undefined;
  enqueueProfileRead?: InstagramContactProfileReadEnqueue | null | undefined;
  readLateCommentTime?: InstagramLateCommentTimeReader | undefined;
  instagramClient?: InstagramWebhookIntakeInstagramClient | undefined;
  /** The process's Instagram database limiter (SN24); `null` runs every unit without a slot. */
  limiter?: WorkerDatabaseSlotLimiter | null | undefined;
}): Promise<InstagramWebhookIntakeJobResult> {
  const { organizationPublicId, channelAccountPublicId, intakeKind } = jobData;
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  const runInDatabaseSlot = toDatabaseSlotRunner(limiter);
  const result: InstagramWebhookIntakeJobResult = {
    outcome: 'drained',
    processedEventCount: 0,
    skippedEventCount: 0,
    failedEventCount: 0,
  };
  const logFields = { jobId, organizationPublicId, channelAccountPublicId, intakeKind };

  const account = await runInDatabaseSlot(() =>
    services.instagramAccountService.findWebhookProcessingAccount({
      scope,
      instagramAccountPublicId: channelAccountPublicId,
    }),
  );
  if (account === null) {
    logger.warn(logFields, 'app.instagram_webhook.account_not_found');
    return { ...result, outcome: 'account_not_found' };
  }
  const channelAccount = {
    organizationId: account.instagramAccount.organizationId,
    channelAccountId: account.channelAccountId,
  };

  for (let handledCount = 0; handledCount < INSTAGRAM_WEBHOOK_EVENTS_PER_JOB; handledCount += 1) {
    const claimed = await runInDatabaseSlot(() =>
      services.instagramWebhookEventService.claimNextEvent({
        scope,
        channelAccount,
        intakeGroup: intakeKind,
        maxProcessingAttempts: INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS,
        claimLeaseMinutes: INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES,
        retryAfterMinutes: INSTAGRAM_WEBHOOK_EVENT_RETRY_AFTER_MINUTES,
      }),
    );
    if (claimed === null) {
      logger.info({ ...logFields, ...result }, 'app.instagram_webhook.intake_job_completed');
      return result;
    }
    if (claimed.outcome === 'exhausted') {
      result.failedEventCount += 1;
      logExhaustedEvent({ logFields, event: claimed.event });
      continue;
    }
    const { event } = claimed;
    const outcome = await takeInClaimedEvent({
      context: {
        scope,
        organizationPublicId,
        channelAccountPublicId,
        services,
        event,
        claim: { ...channelAccount, eventId: event.id, claimedAttemptCount: event.attempt_count },
        isLastAttempt: event.attempt_count >= INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS,
        requestId: jobId,
        runInDatabaseSlot,
        readLateCommentTime,
        instagramClient,
      },
      enqueueProfileRead,
    });
    countEventOutcome({ result, outcome });
  }

  // WH12: the batch is done — yield the slot, and let a follow-up job go on with the group.
  result.outcome = 'yielded';
  try {
    await runInDatabaseSlot(() =>
      enqueueFollowUps({
        scope,
        services,
        intakeKind,
        channelAccount,
        organizationPublicId,
        channelAccountPublicId,
        requestId: jobId,
        enqueueFollowUp,
      }),
    );
  } catch (error) {
    logger.warn(
      { ...logFields, failure: describeInstagramWebhookIntakeError(error) },
      'app.instagram_webhook.follow_up_enqueue_failed',
    );
  }
  logger.info({ ...logFields, ...result }, 'app.instagram_webhook.intake_job_completed');
  return result;
}
