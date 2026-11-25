import { withAppDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
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
  InstagramMessageClaimInput,
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
      /** WC-42's queue (R46); absent → the retry runs in the request. */
      retryQueue?: InstagramMessageRetryQueue | undefined;
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
      broadcastPublicId: null,
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
   * Meta's id and codes, its attempt is finished, and a run's message reports to the engine's
   * `recordMessageResult` in the same commit (`expired` as `skipped`). A repeat for a settled
   * message changes nothing. Answers the saved row, or `null`.
   *
   * @remarks
   * Algorithm: one unit — the guarded update, the attempt, the engine. Failure modes: a database
   * error rolls the whole save back (the lanes retry it inside the send, R42). Side effects: the
   * message, the attempt, the run's next step. Notes: count give-backs, the day counts and the stop
   * rules join this commit at R42.
   */
  async saveSendResult(input: InstagramSendResultInput): Promise<InstagramMessageRow | null> {
    return withAppDatabaseContext({
      scope: input.scope,
      callback: async (databaseHandle) => {
        const message = await new InstagramMessageRepository(databaseHandle).finishSending({
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
            result: channelResultOf(input.status),
            reason: input.reason,
            occurredAt: new Date(),
          });
        }
        return message;
      },
    });
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
