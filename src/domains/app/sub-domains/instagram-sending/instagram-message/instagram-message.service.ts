import { withAppDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { runEnqueueAfterCommit } from '@/core/events/event-bus.js';
import { InstagramSendDayCountRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-day-count.repository.js';
import type { InstagramSendDayCounts } from '@/domains/app/sub-domains/instagram-sending/instagram-send-day-count.repository.js';
import { InstagramSendMinuteCountRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-minute-count.repository.js';
import { MessageMonthCountRepository } from '@/domains/app/sub-domains/instagram-sending/message-month-count.repository.js';
import { invalidateCachedMessageMonthCount } from '@/domains/app/sub-domains/instagram-sending/message-month-count.cache.js';
import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type {
  ChannelActivityCursor,
  ChannelContactMessageEntry,
  ChannelFailedMessageBlock,
  ChannelFailedMessagesRetry,
  ChannelFailedMessagesSummary,
  ChannelFailedMessagesTarget,
  ChannelSendingPort,
  ChannelWaitingMessageSelection,
  SaveWaitingMessageInput,
  SaveWaitingMessageResult,
} from '@/domains/app/app.channel-ports.js';
import { CONTACT_CHAT_WINDOW_MS } from '@/domains/app/sub-domains/contact/contact.constants.js';
import type { InstagramOwnSentMessageLookup } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';
import type {
  InstagramSendLaneTarget,
  InstagramSendingStatusOutput,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import {
  INSTAGRAM_SEND_LANES,
  type InstagramSendLane,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import {
  INSTAGRAM_MESSAGE_KEEP_DAYS,
  INSTAGRAM_MESSAGE_KINDS,
  INSTAGRAM_MESSAGE_NOT_RETRYABLE_REASONS,
  INSTAGRAM_MESSAGE_REASONS,
  INSTAGRAM_MESSAGE_RETRY_PIECE_SIZE,
  type InstagramMessageReason,
} from './instagram-message.constants.js';
import {
  type InstagramMessageKey,
  InstagramMessageRepository,
  type InstagramMessageRow,
} from './instagram-message.repository.js';
import { InstagramSendAttemptRepository } from './instagram-send-attempt.repository.js';
import type {
  InstagramMessageBroadcastResultPort,
  InstagramMessageClaimInput,
  InstagramMessageOpeningPort,
  InstagramMessageRetryQueue,
  InstagramMessageRunResultPort,
  InstagramSendResultInput,
} from './instagram-message.types.js';
import {
  channelResultOf,
  chooseInstagramMessagePlace,
  instagramMessageStepOf,
  isInstagramChatWindowOpen,
} from './instagram-message.util.js';

/** A reason the port was passed, checked against the column's list (a programming error otherwise). */
function messageReasonOf(reason: string): InstagramMessageReason {
  if (!(INSTAGRAM_MESSAGE_REASONS as readonly string[]).includes(reason)) {
    throw new Error(`instagram message: unknown reason "${reason}"`);
  }
  return reason as InstagramMessageReason;
}

/** An empty count of every block (SN18). */
function emptyBlocks(): Record<ChannelFailedMessageBlock, number> {
  return Object.fromEntries(
    INSTAGRAM_MESSAGE_NOT_RETRYABLE_REASONS.map((reason) => [reason, 0]),
  ) as Record<ChannelFailedMessageBlock, number>;
}

/** Today's line (S8) of a settled status: `failed` has no column; `expired` counts as expired. */
function dayCountsOf({
  status,
  reason,
}: {
  status: 'sent' | 'unknown' | 'failed' | 'skipped' | 'expired';
  reason: InstagramMessageReason | null;
}): Partial<InstagramSendDayCounts> | null {
  switch (status) {
    case 'sent':
      return { sent: 1 };
    case 'unknown':
      return { unknown: 1 };
    case 'skipped':
      return reason === 'window_closed' ? { skipped: 1, skippedWindowClosed: 1 } : { skipped: 1 };
    case 'expired':
      return { expired: 1 };
    default:
      return null;
  }
}

/**
 * Instagram's messages (feat-instagram-dm-sending routes-final § 6.B, SN16–SN19, SN22) — Instagram's
 * implementation of the app kernel's `ChannelSendingPort`: the run engine (4.B) and broadcasts (7)
 * save waiting messages through it, it picks the lane, cancels and skips waiting ones, reads a
 * contact's messages (route 24), counts and retries the failed ones (routes 25–26, 36–37); and the
 * claim and the one result save the lanes call (SN3 (d), SN4), the webhook's own-echo lookup (WHQ1,
 * P62) and route 63's waiting counts and last retry.
 *
 * @remarks
 * - **Algorithm:** `saveWaitingMessage` writes in the caller's transaction (its handle): the type
 *   from the step, the lane and channel from the run's way to start and her window
 *   ({@link chooseInstagramMessagePlace}); a run place already saved is reused — a `sent` question
 *   asked again or an `unknown` step on her next action goes back to `waiting` (D17), a waiting or
 *   sending one is answered as it is. `saveSendResult` is the only writer of a claimed row and, for a
 *   run's message, calls the engine's `recordMessageResult` in the same commit.
 * - **Failure modes:** an unknown reason or message kind throws (a caller's bug); a CHECK refuses an
 *   impossible row (23514); database errors roll the caller's commit back.
 * - **Side effects:** writes `app.instagram_messages` and `app.instagram_send_attempts`; the engine's
 *   writes on a result. Nothing sends here: the lane turns, the fast tickets, the gates and the lane
 *   wake after commit are the lanes' (ROUTE rows R37, R42), which pick waiting rows up.
 * - **Notes:** the retry runs in the request until the `retry-failed` job is wired (R46, P136).
 */
export class InstagramMessageService implements ChannelSendingPort {
  constructor(
    private readonly options: {
      /** The engine's `recordMessageResult` (AU35) — a closure, the engine is built after. */
      recordRunMessageResult: InstagramMessageRunResultPort;
      /** The broadcast recipients' `recordMessageResult` (BC18, R23) — a closure, built after. */
      recordBroadcastMessageResult: InstagramMessageBroadcastResultPort;
      /** WC-42's queue (R46); absent → the retry runs in the request. */
      retryQueue?: InstagramMessageRetryQueue | undefined;
      /** The contact's opening-DM bookkeeping (3.A.10), called in the result's commit (R42). */
      recordContactOpeningMessage?: InstagramMessageOpeningPort | undefined;
    },
  ) {}

  /**
   * Writes one waiting message in the caller's transaction (AU35, SN22) — or answers `skipped` ·
   * `window_closed` when it is a DM whose window is already closed.
   *
   * @remarks
   * Algorithm: the run's way to start and her window read on the caller's handle, the place chosen,
   * the run place locked and reused, else a new `igm_…` row. Failure modes: an unknown kind throws.
   * Side effects: one row written or reopened.
   */
  async saveWaitingMessage(input: SaveWaitingMessageInput): Promise<SaveWaitingMessageResult> {
    if (!(INSTAGRAM_MESSAGE_KINDS as readonly string[]).includes(input.messageKind)) {
      throw new Error(`instagram message: unknown message kind "${input.messageKind}"`);
    }
    const repository = new InstagramMessageRepository(input.databaseHandle);
    const now = new Date();
    const isRun = 'automationRunId' in input.source;
    const triggerType =
      'automationRunId' in input.source
        ? await repository.findRunTriggerType({
            organizationId: input.organizationId,
            automationRunId: input.source.automationRunId,
            automationRunStartedAt: input.source.automationRunStartedAt,
          })
        : null;
    const lastDirectMessageReceivedAt = await repository.findLastDirectMessageReceivedAt({
      organizationId: input.organizationId,
      contactId: input.contactId,
    });
    const place = chooseInstagramMessagePlace({
      step: input.step,
      triggerType,
      answersEventId: input.answersEventId,
      isWindowOpen: isInstagramChatWindowOpen({
        lastDirectMessageReceivedAt,
        now,
        windowMilliseconds: CONTACT_CHAT_WINDOW_MS,
      }),
    });
    if (place.kind === 'skip') {
      return { messagePublicId: null, status: 'skipped', reason: place.reason };
    }
    const notBefore = input.notBefore ?? now;
    if ('automationRunId' in input.source) {
      const existing = await repository.lockRunPlace({
        organizationId: input.organizationId,
        automationRunId: input.source.automationRunId,
        automationRunStartedAt: input.source.automationRunStartedAt,
        messageType: place.messageType,
        messageNumber: input.messageNumber,
        messageKind: input.messageKind,
      });
      if (existing !== null) {
        return this.reuseRunPlace({ repository, existing, place, input, notBefore });
      }
    }
    const row = await repository.insertWaiting({
      organizationId: input.organizationId,
      channelAccountId: input.channelAccountId,
      automationId: 'automationId' in input.source ? input.source.automationId : null,
      automationRunId: 'automationRunId' in input.source ? input.source.automationRunId : null,
      broadcastId: 'broadcastId' in input.source ? input.source.broadcastId : null,
      automationRunStartedAt:
        'automationRunStartedAt' in input.source
          ? input.source.automationRunStartedAt
          : input.source.broadcastRecipientCreatedAt,
      contactId: input.contactId,
      messageType: place.messageType,
      messageNumber: input.messageNumber,
      messageKind: input.messageKind,
      versionNumber: input.versionNumber,
      wordingNumber: input.wordingNumber,
      lane: place.lane,
      channel: place.channel,
      isCountedAsDirectMessage: place.isCountedAsDirectMessage,
      notBefore,
      triggerOccurredAt: isRun ? input.triggerOccurredAt : null,
    });
    return { messagePublicId: row.public_id, status: 'waiting' };
  }

  /** A run place saved again (SN16, D17): reopen a `sent` question or an `unknown` step once more. */
  private async reuseRunPlace({
    repository,
    existing,
    place,
    input,
    notBefore,
  }: {
    repository: InstagramMessageRepository;
    existing: InstagramMessageRow;
    place: Extract<ReturnType<typeof chooseInstagramMessagePlace>, { kind: 'place' }>;
    input: SaveWaitingMessageInput;
    notBefore: Date;
  }): Promise<SaveWaitingMessageResult> {
    if (existing.status === 'waiting' || existing.status === 'sending') {
      return { messagePublicId: existing.public_id, status: 'waiting' };
    }
    if (existing.status !== 'sent' && existing.status !== 'unknown') {
      return { messagePublicId: null, status: 'skipped', reason: 'duplicate' };
    }
    const reopened = await repository.reopenAsWaiting({
      row: existing,
      values: {
        lane: place.lane,
        channel: place.channel,
        notBefore,
        versionNumber: input.versionNumber,
        wordingNumber: input.wordingNumber,
      },
      isAskedAgain: existing.status === 'sent',
    });
    return reopened === null
      ? { messagePublicId: null, status: 'skipped', reason: 'duplicate' }
      : { messagePublicId: reopened.public_id, status: 'waiting' };
  }

  /**
   * Cancels the selected waiting messages (`cancelled` with the reason — a delete, an erase, a pause
   * with Cancel, a live edit, the 7-day wait, her answer before a nudge). Answers how many.
   *
   * @remarks
   * Algorithm: one guarded update of `waiting` rows on the caller's handle (or the request's unit).
   * Failure modes: an unknown reason throws. Side effects: the rows.
   */
  async cancelWaitingMessages(selection: ChannelWaitingMessageSelection): Promise<number> {
    return new InstagramMessageRepository(selection.databaseHandle).endWaiting({
      selection,
      status: 'cancelled',
      reason: messageReasonOf(selection.reason),
    });
  }

  /**
   * Skips the selected waiting messages (`skipped` with the reason — her pause or opt-out, P35's
   * `replaced`). Answers how many.
   *
   * @remarks
   * Algorithm: as {@link cancelWaitingMessages}. Failure modes: an unknown reason throws. Side
   * effects: the rows.
   */
  async skipWaitingMessages(selection: ChannelWaitingMessageSelection): Promise<number> {
    return new InstagramMessageRepository(selection.databaseHandle).endWaiting({
      selection,
      status: 'skipped',
      reason: messageReasonOf(selection.reason),
    });
  }

  /**
   * Her messages of about the last 30 days, newest first, after the cursor (route 24, CT14) — ids,
   * statuses and reasons, never text.
   *
   * @remarks
   * Algorithm: one read in the scope's unit. Failure modes: none of its own. Side effects: none.
   */
  async listContactMessages({
    scope,
    organizationId,
    contactId,
    after,
    limit,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    contactId: number;
    after: ChannelActivityCursor | null;
    limit: number;
  }): Promise<ChannelContactMessageEntry[]> {
    const rows = await withAppDatabaseContext({
      scope,
      callback: (databaseHandle) =>
        new InstagramMessageRepository(databaseHandle).listContactMessages({
          organizationId,
          contactId,
          after,
          limit,
        }),
    });
    return rows.map((row) => ({
      id: row.id,
      publicId: row.public_id,
      occurredAt: row.cursor_created_at,
      automation:
        row.automation_public_id === null
          ? null
          : { id: row.automation_public_id, name: row.automation_name ?? '' },
      automationRunPublicId: row.automation_run_public_id,
      broadcastPublicId: row.broadcast_public_id,
      messageType: row.message_type,
      messageNumber: row.message_number,
      status: row.status,
      reason: row.reason,
      channel: row.channel,
    }));
  }

  /**
   * Counts the failed messages of an automation or a contact of about the last 30 days: how many can
   * go again now and why the others cannot (SN18) — changes nothing.
   *
   * @remarks
   * Algorithm: one grouped read in the scope's unit. Failure modes: none of its own. Side effects:
   * none.
   */
  async summarizeFailedMessages(
    target: ChannelFailedMessagesTarget,
  ): Promise<ChannelFailedMessagesSummary> {
    const counts = await withAppDatabaseContext({
      scope: target.scope,
      callback: (databaseHandle) =>
        new InstagramMessageRepository(databaseHandle).countFailedByVerdict({
          organizationId: target.organizationId,
          by: target.by,
          id: target.id,
        }),
    });
    const notRetryable = emptyBlocks();
    let failedCount = 0;
    let retryableCount = 0;
    for (const { verdict, count } of counts) {
      failedCount += count;
      if (verdict === 'retryable') retryableCount += count;
      else notRetryable[verdict] += count;
    }
    return { failedCount, retryableCount, notRetryable, horizonDays: INSTAGRAM_MESSAGE_KEEP_DAYS };
  }

  /**
   * One press of "Retry failed messages" (SN18): the summary, then the `retry-failed` job when it is
   * wired (R46), else the retry itself in the request ({@link retryAllowedFailedMessages}).
   *
   * @remarks
   * Algorithm: count, then queue or run. Failure modes: a database error propagates (pieces already
   * committed stay). Side effects: the job, or the rows back to `waiting`.
   */
  async retryFailedMessages(
    target: ChannelFailedMessagesTarget,
  ): Promise<ChannelFailedMessagesRetry> {
    const summary = await this.summarizeFailedMessages(target);
    if (summary.retryableCount === 0) {
      return { summary, expectedRetryCount: 0, isQueued: false };
    }
    if (this.options.retryQueue !== undefined) {
      await this.options.retryQueue.enqueueRetryFailed({
        organizationPublicId: target.scope.organizationPublicId,
        by: target.by,
        id: target.id,
      });
      return { summary, expectedRetryCount: summary.retryableCount, isQueued: true };
    }
    await this.retryAllowedFailedMessages(target);
    return { summary, expectedRetryCount: summary.retryableCount, isQueued: false };
  }

  /**
   * The retry's work (WC-42 — the `retry-failed` job's body from R46): the allowed failed messages
   * back to `waiting`, {@link INSTAGRAM_MESSAGE_RETRY_PIECE_SIZE} per commit, each at most once
   * (`owner_retry_at`), re-checked under their contacts' locks. Answers how many.
   *
   * @remarks
   * Algorithm: pieces until one comes back short; every piece of one press shares its time. Failure
   * modes: a database error stops it (committed pieces stay; a repeat retries only the rest). Side
   * effects: the rows. Notes: the lanes pick them up (R37); reopening a failed run is R46's (plan
   * §33.10 rule 4).
   */
  async retryAllowedFailedMessages(target: ChannelFailedMessagesTarget): Promise<number> {
    const retriedAt = new Date();
    let total = 0;
    for (;;) {
      const piece = await withAppDatabaseContext({
        scope: target.scope,
        callback: (databaseHandle) =>
          new InstagramMessageRepository(databaseHandle).retryFailedPiece({
            owner: { organizationId: target.organizationId, by: target.by, id: target.id },
            limit: INSTAGRAM_MESSAGE_RETRY_PIECE_SIZE,
            retriedAt,
          }),
      });
      total += piece.count;
      if (piece.count < INSTAGRAM_MESSAGE_RETRY_PIECE_SIZE) return total;
    }
  }

  /**
   * The webhook receiver's own-echo lookup (WHQ1, P62): the Meta ids among `messageIds` this account
   * sent — the receiver drops their echoes, so our own messages save nothing.
   *
   * @remarks
   * Algorithm: one read in the scope's unit (the store unit when one is open). Failure modes: none of
   * its own. Side effects: none.
   */
  readonly findOwnSentMessageIds: InstagramOwnSentMessageLookup = async ({
    scope,
    channelAccount,
    messageIds,
  }) => {
    const found = await withAppDatabaseContext({
      scope,
      callback: (databaseHandle) =>
        new InstagramMessageRepository(databaseHandle).findOwnSentMessageIds({
          organizationId: channelAccount.organizationId,
          channelAccountId: channelAccount.channelAccountId,
          messageIds,
        }),
    });
    return new Set(found);
  };

  /**
   * Route 63's waiting messages per lane (AC-7.12).
   *
   * @remarks
   * Algorithm: one grouped read in the scope's unit. Failure modes: none. Side effects: none.
   */
  async countWaitingByLane({
    scope,
    organizationId,
    channelAccountId,
  }: InstagramSendLaneTarget): Promise<Partial<Record<InstagramSendLane, number>>> {
    const rows = await withAppDatabaseContext({
      scope,
      callback: (databaseHandle) =>
        new InstagramMessageRepository(databaseHandle).countWaitingByLane({
          organizationId,
          channelAccountId,
        }),
    });
    const counts: Partial<Record<InstagramSendLane, number>> = {};
    for (const { lane, count } of rows) {
      if ((INSTAGRAM_SEND_LANES as readonly string[]).includes(lane)) {
        counts[lane as InstagramSendLane] = count;
      }
    }
    return counts;
  }

  /**
   * Route 63's last retry of the account: when, how many went back, how many failed ones of the same
   * automation (or contact) are still not retried.
   *
   * @remarks
   * Algorithm: one read in the scope's unit. Failure modes: none. Side effects: none.
   */
  async findLastRetry({
    scope,
    organizationId,
    channelAccountId,
  }: InstagramSendLaneTarget): Promise<InstagramSendingStatusOutput['last_retry']> {
    const last = await withAppDatabaseContext({
      scope,
      callback: (databaseHandle) =>
        new InstagramMessageRepository(databaseHandle).findLastRetry({
          organizationId,
          channelAccountId,
        }),
    });
    if (last === null) return null;
    return {
      ...(last.automationPublicId === null ? {} : { automation_id: last.automationPublicId }),
      ...(last.contactPublicId === null ? {} : { contact_id: last.contactPublicId }),
      retried: last.retried,
      cannot: last.cannot,
      at: last.at.toISOString(),
    };
  }

  /**
   * The claim's message and attempt parts (SN3 (d), SN19): a waiting row of this lane and channel
   * becomes `sending` and its attempt starts, in one commit — the lanes add the gates and the month
   * count to it (R42). Answers the row and the attempt, or `null` when it no longer waits there.
   *
   * @remarks
   * Algorithm: the guarded update, then the attempt insert. Failure modes: database errors roll the
   * claim back. Side effects: the row and one attempt.
   */
  async claimMessage(
    input: InstagramMessageClaimInput,
  ): Promise<{ message: InstagramMessageRow; attempt: { id: number; startedAt: Date } } | null> {
    return withAppDatabaseContext({
      scope: input.scope,
      callback: async (databaseHandle) => {
        const message = await new InstagramMessageRepository(databaseHandle).claimWaiting({
          key: input.key,
          lane: input.lane,
          channel: input.channel,
        });
        if (message === null) return null;
        const attempt = await new InstagramSendAttemptRepository(databaseHandle).start({
          organizationId: message.organization_id,
          channelAccountId: message.channel_account_id,
          messageId: message.id,
          automationId: message.automation_id,
          contactId: message.contact_id,
          lane: input.lane,
          countGroup: input.countGroup,
        });
        return { message, attempt: { id: attempt.id, startedAt: attempt.startedAt } };
      },
    });
  }

  /**
   * The one result save (SN4 `saveSendResult`): a `sending` message takes its final status, reason,
   * Meta's id and codes — or goes back to `waiting` (a stop, a sure "not sent") — its attempt is
   * finished, the claim's counts are given back when asked, today's line moves (S8), an opening DM's
   * bookkeeping moves, and a run's message reports to the engine's `recordMessageResult` — a
   * broadcast's to its recipients' `recordMessageResult` (R23) — in the same
   * commit (`expired` as `skipped`; `waiting` reports nothing). A repeat for a settled message
   * changes nothing. Answers the saved row, or `null`.
   *
   * @remarks
   * Algorithm: one unit — the guarded update, the attempt, the give-backs, the day counts, the
   * contact, the engine or the recipient. Failure modes: a database error rolls the whole save back (the send core
   * retries it inside the send, R42). Side effects: the message, the attempt, the counts (the
   * month's Redis copy tombstoned after commit), the run's next step or the recipient, the
   * broadcast's numbers and its next message.
   */
  async saveSendResult(input: InstagramSendResultInput): Promise<InstagramMessageRow | null> {
    return withAppDatabaseContext({
      scope: input.scope,
      callback: async (databaseHandle) => {
        const repository = new InstagramMessageRepository(databaseHandle);
        const message =
          input.status === 'waiting'
            ? await repository.putBackWaiting({
                key: input.key,
                isTryUsed: input.isTryUsed ?? false,
                notBefore: input.notBefore ?? new Date(),
                errorCode: input.errorCode,
                errorSubcode: input.errorSubcode,
              })
            : await repository.finishSending({
                key: input.key,
                status: input.status,
                reason: input.reason,
                instagramMessageId: input.instagramMessageId,
                errorCode: input.errorCode,
                errorSubcode: input.errorSubcode,
              });
        if (message === null) return null;
        if (input.attempt !== null) {
          await new InstagramSendAttemptRepository(databaseHandle).finish({
            key: input.attempt,
            resultGroup: input.resultGroup,
            httpStatus: input.httpStatus,
            errorCode: input.errorCode,
            errorSubcode: input.errorSubcode,
            durationMilliseconds: input.durationMilliseconds,
          });
        }
        await this.giveCountsBack({ input, message, databaseHandle });
        if (input.status === 'waiting') return message;
        await this.recordSettledMessage({ input, status: input.status, message, databaseHandle });
        return message;
      },
    });
  }

  /** The claim's minute and month counts given back (SN4), in the save's unit. */
  private async giveCountsBack({
    input,
    message,
    databaseHandle,
  }: {
    input: InstagramSendResultInput;
    message: InstagramMessageRow;
    databaseHandle: RequestScopedPostgresDatabase;
  }): Promise<void> {
    const giveBack = input.giveBack ?? null;
    if (giveBack === null) return;
    const key = {
      organizationId: message.organization_id,
      channelAccountId: message.channel_account_id,
    };
    if (giveBack.countGroup !== 'none') {
      await new InstagramSendMinuteCountRepository(databaseHandle).subtractFromMinute({
        ...key,
        countGroup: giveBack.countGroup,
        count: 1,
        claimedAt: giveBack.claimedAt,
      });
    }
    if (message.is_counted_as_direct_message) {
      await new MessageMonthCountRepository(databaseHandle).subtractFromMonth({ ...key, count: 1 });
      await runEnqueueAfterCommit(() =>
        invalidateCachedMessageMonthCount(input.scope.organizationPublicId),
      );
    }
  }

  /** A settled message's day line (S8), opening bookkeeping and engine report, in the save's unit. */
  private async recordSettledMessage({
    input,
    status,
    message,
    databaseHandle,
  }: {
    input: InstagramSendResultInput;
    status: Exclude<InstagramSendResultInput['status'], 'waiting'>;
    message: InstagramMessageRow;
    databaseHandle: RequestScopedPostgresDatabase;
  }): Promise<void> {
    const occurredAt = new Date();
    const dayCounts = dayCountsOf({ status, reason: input.reason });
    if (dayCounts !== null) {
      await new InstagramSendDayCountRepository(databaseHandle).addToToday({
        organizationId: message.organization_id,
        channelAccountId: message.channel_account_id,
        counts: dayCounts,
      });
    }
    if (
      message.message_type === 'opening_message' &&
      (status === 'sent' || status === 'unknown') &&
      this.options.recordContactOpeningMessage !== undefined
    ) {
      await this.options.recordContactOpeningMessage({
        databaseHandle: databaseHandle as WorkerDatabaseHandle,
        organizationId: message.organization_id,
        contactId: message.contact_id,
        sentAt: occurredAt,
      });
    }
    if (message.automation_run_id !== null) {
      await this.options.recordRunMessageResult({
        scope: input.scope,
        databaseHandle,
        organizationId: message.organization_id,
        channelAccountId: message.channel_account_id,
        automationRunId: message.automation_run_id,
        automationRunStartedAt: message.automation_run_started_at,
        messagePublicId: message.public_id,
        step: instagramMessageStepOf(
          message.message_type as Parameters<typeof instagramMessageStepOf>[0],
        ),
        messageNumber: message.message_number,
        result: channelResultOf(status),
        reason: input.reason,
        occurredAt,
      });
    } else if (message.broadcast_id !== null && message.message_number !== null) {
      await this.options.recordBroadcastMessageResult({
        databaseHandle,
        organizationId: message.organization_id,
        broadcastId: message.broadcast_id,
        contactId: message.contact_id,
        messagePublicId: message.public_id,
        messageNumber: message.message_number,
        result: channelResultOf(status),
        reason: input.reason,
        occurredAt,
      });
    }
  }

  /**
   * Moves a waiting message to another lane and channel (plan §19.1: her window opened or closed) —
   * the same row, only while it waits. Answers whether it moved.
   *
   * @remarks
   * Algorithm: one guarded update. Failure modes: none of its own. Side effects: the row.
   */
  async moveMessageLane({
    scope,
    key,
    lane,
    channel,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    key: InstagramMessageKey;
    lane: InstagramSendLane;
    channel: 'private_reply' | 'direct';
  }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: (databaseHandle) =>
        new InstagramMessageRepository(databaseHandle).moveLane({ key, lane, channel }),
    });
  }
}
