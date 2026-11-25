import { withAppDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { brandWorkerContextDatabaseHandle } from '@/infrastructure/database/utils/database-handle.types.js';
import { randomInt } from 'node:crypto';
import { runEnqueueAfterCommit } from '@/core/events/event-bus.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { ChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { InstagramAccountSettingsRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { InstagramSendLaneRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.repository.js';
import type { enqueueInstagramSendFastMessage } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-fast.queue.js';
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
  FAST_LANE_SETTINGS,
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
  InstagramMessageBroadcastSentPort,
  InstagramMessageClaimInput,
  InstagramMessageOpeningPort,
  InstagramMessageRetryOptions,
  InstagramMessageRetryQueue,
  InstagramMessageRunReopenPort,
  InstagramMessageRunResultPort,
  InstagramSendResultInput,
} from './instagram-message.types.js';
import {
  channelResultOf,
  chooseInstagramMessagePlace,
  drawInstagramExtraDelayMilliseconds,
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
 * - **Notes:** the retry is the `retry-failed` job (R46) when its queue is passed; without it (a unit
 *   test) it runs in the request (P136).
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
      /** The engine's reopen of a retried message's `failed` run (plan §33.10 rule 4, R46). */
      reopenRetriedRuns?: InstagramMessageRunReopenPort | undefined;
      /** The contact's opening-DM bookkeeping (3.A.10), called in the result's commit (R42). */
      recordContactOpeningMessage?: InstagramMessageOpeningPort | undefined;
      /** The contact's `last_broadcast_at` (3.A.10), called in the result's commit (R45). */
      recordContactBroadcastSent?: InstagramMessageBroadcastSentPort | undefined;
      /** A fast message's ticket after the save's commit (R44); absent → the repair finds it. */
      enqueueFastMessage?: typeof enqueueInstagramSendFastMessage | undefined;
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
    const notBefore =
      input.notBefore ??
      (place.lane === 'fast' ? await this.fastNotBefore({ input, place, now }) : now);
    if ('automationRunId' in input.source) {
      const reused = await this.reuseLockedRunPlace({
        repository,
        input,
        place,
        notBefore,
        automationRunId: input.source.automationRunId,
        automationRunStartedAt: input.source.automationRunStartedAt,
      });
      if (reused !== null) return reused;
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
    await this.addFastTicketAfterCommit({
      input,
      place,
      ticket: {
        publicId: row.public_id,
        automationRunStartedAt: row.automation_run_started_at,
        tries: row.tries,
      },
      notBefore,
    });
    return { messagePublicId: row.public_id, status: 'waiting' };
  }

  /**
   * A fast message's `not_before` when the engine gave none (plan §30.2 step 13, §30.12): `none` →
   * now; `next` → a random 500–2,000 ms; `answer` → that plus, on a direct message whose plan holds the
   * extra delay, min + (max − min) × (r1 + r2) ÷ 2 of the account's extra delay — her event, both
   * delays at most 25 s (the extra delay is cut).
   */
  private async fastNotBefore({
    input,
    place,
    now,
  }: {
    input: SaveWaitingMessageInput;
    place: { channel: string | null };
    now: Date;
  }): Promise<Date> {
    const answerDelay = input.answerDelay ?? 'next';
    if (answerDelay === 'none') return now;
    const random = randomInt(
      FAST_LANE_SETTINGS.answerDelayMinimumMilliseconds,
      FAST_LANE_SETTINGS.answerDelayMaximumMilliseconds + 1,
    );
    let extra = 0;
    if (
      answerDelay === 'answer' &&
      input.isExtraDelayAllowed === true &&
      place.channel === 'direct'
    ) {
      const settings = await new InstagramAccountSettingsRepository(
        input.databaseHandle as RequestScopedPostgresDatabase,
      ).findByChannelAccount({
        organizationId: input.organizationId,
        channelAccountId: input.channelAccountId,
      });
      extra = drawInstagramExtraDelayMilliseconds({
        minimumSeconds: settings?.extra_delay_seconds_min ?? null,
        maximumSeconds: settings?.extra_delay_seconds_max ?? null,
        firstRandom: randomInt(0, 1_000_001) / 1_000_000,
        secondRandom: randomInt(0, 1_000_001) / 1_000_000,
      });
    }
    const delay = Math.min(
      random + extra,
      Math.max(FAST_LANE_SETTINGS.answerLatestMilliseconds, random),
    );
    return new Date(now.getTime() + delay);
  }

  /**
   * A fast message's ticket `fast-<igm_…>-<tries>` at its `not_before`, added after the caller's
   * commit (plan §30.2 step 13, WC-7): needs the job's organization public id and the producer wired;
   * otherwise the repair's late-message duty (WC-13, R47) finds the row. An enqueue error is logged.
   */
  private async addFastTicketAfterCommit({
    input,
    place,
    ticket,
    notBefore,
  }: {
    input: SaveWaitingMessageInput;
    place: { lane: InstagramSendLane };
    ticket: { publicId: string; automationRunStartedAt: Date; tries: number };
    notBefore: Date;
  }): Promise<void> {
    const enqueue = this.options.enqueueFastMessage;
    const organizationPublicId = input.organizationPublicId;
    if (place.lane !== 'fast' || enqueue === undefined || organizationPublicId === undefined)
      return;
    const account = await new ChannelAccountRepository(
      input.databaseHandle as RequestScopedPostgresDatabase,
    ).findById({ organizationId: input.organizationId, channelAccountId: input.channelAccountId });
    if (account === null) return;
    await runEnqueueAfterCommit(async () => {
      try {
        await enqueue({
          organizationPublicId,
          channelAccountPublicId: account.public_id,
          instagramMessagePublicId: ticket.publicId,
          automationRunStartedAt: ticket.automationRunStartedAt.toISOString(),
          tries: ticket.tries,
          delayMilliseconds: Math.max(notBefore.getTime() - Date.now(), 0),
        });
      } catch (error) {
        logger.warn(
          { error_name: (error as Error | null)?.name },
          'app.instagram_send.enqueue_failed',
        );
      }
    });
  }

  /**
   * A message `unknown` proved `sent` by her tap on its button — the payload's third part
   * (`<aut_…>::<run_…>::<igm_…>`, plan §14, WH8): the intake calls it in the event's unit (ROUTE row
   * R38), before the tap moves the run. Answers whether it moved.
   *
   * @remarks
   * Algorithm: one guarded update `unknown` → `sent` on the caller's handle. Failure modes: database
   * errors roll the caller's unit back. Side effects: the row; the engine is not told — her tap is
   * the engine's own input in the same unit.
   */
  async markTappedMessageSent({
    databaseHandle,
    organizationId,
    messagePublicId,
  }: {
    databaseHandle: SaveWaitingMessageInput['databaseHandle'];
    organizationId: number;
    messagePublicId: string;
  }): Promise<boolean> {
    const moved = await new InstagramMessageRepository(databaseHandle).markUnknownSent({
      organizationId,
      publicId: messagePublicId,
    });
    return moved !== null;
  }

  /** A run place saved again (SN16, D17): reopen a `sent` question or an `unknown` step once more. */
  /**
   * Locks the run's place for this message and, when a row already holds it, reuses that row
   * (adding a fast ticket when it goes back to waiting). Answers `null` when the place is free.
   */
  private async reuseLockedRunPlace({
    repository,
    input,
    place,
    notBefore,
    automationRunId,
    automationRunStartedAt,
  }: {
    repository: InstagramMessageRepository;
    input: SaveWaitingMessageInput;
    place: Extract<ReturnType<typeof chooseInstagramMessagePlace>, { kind: 'place' }>;
    notBefore: Date;
    automationRunId: number;
    automationRunStartedAt: Date;
  }): Promise<SaveWaitingMessageResult | null> {
    const existing = await repository.lockRunPlace({
      organizationId: input.organizationId,
      automationRunId,
      automationRunStartedAt,
      messageType: place.messageType,
      messageNumber: input.messageNumber,
      messageKind: input.messageKind,
    });
    if (existing === null) return null;
    const reused = await this.reuseRunPlace({ repository, existing, place, input, notBefore });
    if (reused.status === 'waiting' && existing.status !== 'waiting') {
      await this.addFastTicketAfterCommit({
        input,
        place,
        ticket: {
          publicId: reused.messagePublicId,
          automationRunStartedAt: existing.automation_run_started_at,
          tries: 0,
        },
        notBefore,
      });
    }
    return reused;
  }

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
        ownerPublicId: target.ownerPublicId,
      });
      return { summary, expectedRetryCount: summary.retryableCount, isQueued: true };
    }
    await this.retryAllowedFailedMessages({ target });
    return { summary, expectedRetryCount: summary.retryableCount, isQueued: false };
  }

  /**
   * The retry's work (WC-42 — the `retry-failed` job's body from R46): the allowed failed messages
   * back to `waiting`, {@link INSTAGRAM_MESSAGE_RETRY_PIECE_SIZE} per commit, each at most once
   * (`owner_retry_at`), re-checked under their contacts' locks. Answers how many.
   *
   * @remarks
   * Algorithm: pieces until one comes back short; every piece of one press shares its time. In each
   * piece's commit a retried message's run that ended `failed` is reopened, its open key back
   * (`reopenRetriedRuns`, plan §33.10 rule 4 — R46); a message whose automation and person hold
   * another open run stays `failed`. After each commit, `options.afterPiece` (the job wakes the
   * accounts' lanes). Each piece runs in `options.runInDatabaseSlot` when given (the job's slot).
   * Failure modes: a database error stops it (committed pieces stay; a repeat retries only the rest).
   * Side effects: the rows, the runs, their keys and events. Notes: the lanes pick them up (R37).
   */
  async retryAllowedFailedMessages({
    target,
    ...options
  }: InstagramMessageRetryOptions & { target: ChannelFailedMessagesTarget }): Promise<number> {
    const retriedAt = new Date();
    const runInSlot = options.runInDatabaseSlot ?? (<T>(callback: () => Promise<T>) => callback());
    let total = 0;
    for (;;) {
      const piece = await runInSlot(() =>
        withAppDatabaseContext({
          scope: target.scope,
          callback: async (databaseHandle) => {
            const retried = await new InstagramMessageRepository(databaseHandle).retryFailedPiece({
              owner: { organizationId: target.organizationId, by: target.by, id: target.id },
              limit: INSTAGRAM_MESSAGE_RETRY_PIECE_SIZE,
              retriedAt,
            });
            if (retried.runs.length > 0 && this.options.reopenRetriedRuns !== undefined) {
              await this.options.reopenRetriedRuns({
                databaseHandle: brandWorkerContextDatabaseHandle(databaseHandle),
                organizationId: target.organizationId,
                runs: retried.runs,
              });
            }
            return retried;
          },
        }),
      );
      total += piece.count;
      if (piece.count > 0 && options.afterPiece !== undefined) {
        await options.afterPiece({ channelAccountIds: piece.channelAccountIds });
      }
      if (piece.count < INSTAGRAM_MESSAGE_RETRY_PIECE_SIZE) return total;
    }
  }

  /**
   * The retry job's owner (WC-42 — R46): the automation or contact its public id names, as the
   * retry's target in the job's scope; `null` when gone (the job then does nothing).
   *
   * @remarks
   * Algorithm: one read in the scope's unit (RLS keeps it inside the organization). Failure modes:
   * none of its own. Side effects: none.
   */
  async resolveFailedMessagesTarget({
    scope,
    by,
    ownerPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    by: 'automation' | 'contact';
    ownerPublicId: string;
  }): Promise<ChannelFailedMessagesTarget | null> {
    const owner = await withAppDatabaseContext({
      scope,
      callback: (databaseHandle) =>
        new InstagramMessageRepository(databaseHandle).findFailedMessagesOwner({
          organizationPublicId: scope.organizationPublicId,
          by,
          ownerPublicId,
        }),
    });
    return owner === null
      ? null
      : { scope, organizationId: owner.organizationId, by, id: owner.id, ownerPublicId };
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
   * An echo of the owner's chat to her that may be one of our own messages whose send was not saved
   * with Meta's id yet (WH10, WHQ1 / P62): her direct messages `sending` or `unknown` without an id,
   * changed in the last `withinMinutes`. Exactly one `unknown` → it becomes `sent` with the echo's
   * id and its run hears `sent` (`confirmed`); one still `sending` → `in_flight` (the send is being
   * saved — the echo is ours); otherwise `none` — the owner typed it by hand.
   *
   * @remarks
   * Algorithm: joins intake's open unit (the event's one transaction): one read of at most 2 rows,
   * then the guarded `unknown` → `sent` update and the engine's `recordMessageResult` in the same
   * commit, as the result save does. Failure modes: a database error rolls the event back. Side
   * effects: the message row and the run's next step. Notes: no message text is stored, so the
   * match is by person and time, not by text.
   */
  async matchEchoedMessage({
    scope,
    organizationId,
    channelAccountId,
    contactInstagramUserId,
    instagramMessageId,
    withinMinutes,
  }: InstagramSendLaneTarget & {
    /** Her Instagram id (the echo's recipient). */
    contactInstagramUserId: string;
    /** The echo's `mid`. */
    instagramMessageId: string;
    withinMinutes: number;
  }): Promise<'confirmed' | 'in_flight' | 'none'> {
    return withAppDatabaseContext({
      scope,
      callback: async (databaseHandle) => {
        const repository = new InstagramMessageRepository(databaseHandle);
        const candidates = await repository.listUnconfirmedDirectMessagesSince({
          organizationId,
          channelAccountId,
          contactInstagramUserId,
          since: new Date(Date.now() - withinMinutes * 60_000),
        });
        if (candidates.some((candidate) => candidate.status === 'sending')) return 'in_flight';
        const [only] = candidates;
        if (only === undefined || candidates.length !== 1) return 'none';
        const message = await repository.confirmUnknownAsSent({
          key: {
            organizationId,
            publicId: only.public_id,
            automationRunStartedAt: only.automation_run_started_at,
          },
          instagramMessageId,
        });
        if (message === null) return 'none';
        if (message.automation_run_id !== null) {
          await this.options.recordRunMessageResult({
            scope,
            databaseHandle,
            organizationId,
            channelAccountId,
            automationRunId: message.automation_run_id,
            automationRunStartedAt: message.automation_run_started_at,
            messagePublicId: message.public_id,
            step: instagramMessageStepOf(
              message.message_type as Parameters<typeof instagramMessageStepOf>[0],
            ),
            messageNumber: message.message_number,
            result: 'sent',
            reason: null,
            occurredAt: new Date(),
          });
        }
        return 'confirmed';
      },
    });
  }

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
        if (message.lane === 'fast') {
          // The claim's place on the account's fast lane comes back (plan §30.2 step 12).
          await new InstagramSendLaneRepository(databaseHandle).addToSendingCount({
            organizationId: message.organization_id,
            channelAccountId: message.channel_account_id,
            delta: -1,
          });
        }
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

  /**
   * The repair duties' end of waiting messages (WC-15 the 7-day expiry, WC-17 a closed window,
   * WC-18 the reply trim): each `waiting` row takes `expired` or `skipped` with the reason, and
   * reports like a send's result in the same commit — today's line (S8) and the engine's
   * `recordMessageResult` (`expired` as `skipped`), so her run moves on as for any skipped message.
   * Answers how many ended; a message no longer waiting is left as it is.
   *
   * @remarks
   * Algorithm: one unit in the scope — per key the guarded end, then the settled message's
   * bookkeeping (the same path {@link saveSendResult} takes). Failure modes: a database error rolls
   * the piece back (the next minute tries again). Side effects: the rows, the day counts, the runs.
   */
  async settleWaitingMessages({
    scope,
    keys,
    status,
    reason,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    keys: readonly InstagramMessageKey[];
    status: 'expired' | 'skipped';
    reason: InstagramMessageReason;
  }): Promise<number> {
    if (keys.length === 0) return 0;
    return withAppDatabaseContext({
      scope,
      callback: async (databaseHandle) => {
        const repository = new InstagramMessageRepository(databaseHandle);
        let ended = 0;
        for (const key of keys) {
          const message = await repository.endWaitingByKey({ key, status, reason });
          if (message === null) continue;
          ended += 1;
          await this.recordSettledMessage({
            input: { scope, reason },
            status,
            message,
            databaseHandle,
          });
        }
        return ended;
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
    input: Pick<InstagramSendResultInput, 'scope' | 'reason'>;
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
    if (
      message.message_type === 'broadcast' &&
      (status === 'sent' || status === 'unknown') &&
      this.options.recordContactBroadcastSent !== undefined
    ) {
      // `unknown` too: Meta may have sent it, so the 24-hour broadcast gap counts it (as D8 does).
      await this.options.recordContactBroadcastSent({
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
   * The Live check's end of the account's waiting Live private replies (WC-16, AC-16.18, plan helper
   * rule 10): those whose Live is not in `onAirMediaIds` (or already marked ended), or whose comment
   * is older than `LIVE_REPLY_MAX_AGE_MINUTES`, become `expired` · `live_ended`, each reported like a
   * settled message (today's line, the run's `recordMessageResult` — `expired` as `skipped`) in the
   * same commit. Answers how many and the media ids of the Lives seen ended.
   *
   * @remarks
   * Algorithm: one unit in the job's organization scope — the guarded update of `waiting` rows
   * (`SKIP LOCKED`: a row the lane holds is left to the next round), then each row's report.
   * Failure modes: a database error rolls the unit back (the next round tries again). Side effects:
   * the messages, today's line, the runs' next step.
   */
  async expireWaitingLiveReplies({
    scope,
    organizationId,
    channelAccountId,
    onAirMediaIds,
    oldestCommentAt,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    channelAccountId: number;
    onAirMediaIds: readonly string[] | null;
    oldestCommentAt: Date;
  }): Promise<{ expiredCount: number; endedMediaIds: string[] }> {
    return withAppDatabaseContext({
      scope,
      callback: async (databaseHandle) => {
        const { rows, endedMediaIds } = await new InstagramMessageRepository(
          databaseHandle,
        ).expireWaitingLiveReplies({
          organizationId,
          channelAccountId,
          onAirMediaIds,
          oldestCommentAt,
        });
        for (const message of rows) {
          await this.recordSettledMessage({
            input: { scope, reason: 'live_ended' },
            status: 'expired',
            message,
            databaseHandle,
          });
        }
        return { expiredCount: rows.length, endedMediaIds };
      },
    });
  }

  /**
   * Ends one waiting message a lane turn's check passed over for good (plan §28.1 step 7, §29.5
   * rule 4, §30.2 step 6): `expired`, or `skipped` (she opted out, the owner excluded her, she was
   * erased, her window closed) — with today's line and the engine told in the same commit, as the
   * result save does; or `cancelled` (a nudge she answered — nothing else told; a cancelled
   * broadcast's message — its recipient `skipped` with the reason, R45). Answers whether it ended
   * (a message no longer waiting is left alone).
   *
   * @remarks
   * Algorithm: one unit — the guarded update, then the settled message's day line, opening
   * bookkeeping and the engine's or recipients' result. Failure modes: database errors roll it back.
   * Side effects: the row, the day line, the run's next step.
   */
  async endWaitingMessage({
    scope,
    key,
    status,
    reason,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    key: InstagramMessageKey;
    status: 'skipped' | 'expired' | 'cancelled';
    reason: InstagramMessageReason;
  }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: async (databaseHandle) => {
        const message = await new InstagramMessageRepository(databaseHandle).endWaitingByKey({
          key,
          status,
          reason,
        });
        if (message === null) return false;
        if (status === 'cancelled') {
          // A cancelled broadcast's message (plan §30.14 step 7): its recipient `skipped` with the
          // same reason. A nudge she answered first (§30.7 rule 4): her tap already moved the run.
          if (message.broadcast_id !== null && message.message_number !== null) {
            await this.options.recordBroadcastMessageResult({
              databaseHandle,
              organizationId: message.organization_id,
              broadcastId: message.broadcast_id,
              contactId: message.contact_id,
              messagePublicId: message.public_id,
              messageNumber: message.message_number,
              result: 'skipped',
              reason,
              occurredAt: new Date(),
            });
          }
          return true;
        }
        await this.recordSettledMessage({
          input: { scope, reason },
          status,
          message,
          databaseHandle,
        });
        return true;
      },
    });
  }

  /**
   * Today's "chat closed" skips of the account per automation (route 63's per-automation lines,
   * SN14).
   *
   * @remarks
   * Algorithm: one read in the scope's unit. Failure modes: none of its own. Side effects: none.
   */
  async listWindowClosedByAutomation({
    scope,
    organizationId,
    channelAccountId,
  }: InstagramSendLaneTarget): Promise<Array<{ automation_id: string; count: number }>> {
    const rows = await withAppDatabaseContext({
      scope,
      callback: (databaseHandle) =>
        new InstagramMessageRepository(databaseHandle).countWindowClosedTodayByAutomation({
          organizationId,
          channelAccountId,
        }),
    });
    return rows.map((row) => ({ automation_id: row.automationPublicId, count: row.count }));
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
