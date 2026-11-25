import type {
  ChannelBroadcastMessageResultInput,
  ChannelPortDatabaseHandle,
  ChannelSendingPort,
  ChannelSendingPorts,
} from '@/domains/app/app.channel-ports.js';
import type { ChannelAccountChannel } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import { uploadPublicIdsOf } from '@/domains/app/sub-domains/automation/automation-run/automation-run-step.util.js';
import {
  BroadcastSegmentRepository,
  segmentAutomationPublicIds,
} from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.repository.js';
import { BROADCAST_ACTIVE_STATUSES } from '@/domains/app/sub-domains/broadcast/broadcast.constants.js';
import { BroadcastRepository } from '@/domains/app/sub-domains/broadcast/broadcast.repository.js';
import {
  BROADCAST_AUDIENCE_PIECE_SIZE,
  type BroadcastRecipientStatus,
  broadcastMessageStepPath,
} from './broadcast-recipient.constants.js';
import {
  type BroadcastNumbersChange,
  type BroadcastRecipientParentRow,
  BroadcastRecipientRepository,
  type BroadcastRecipientRow,
} from './broadcast-recipient.repository.js';
import type {
  BroadcastAudiencePieceInput,
  BroadcastAudiencePieceResult,
  BroadcastChatOpenedOutcome,
  BroadcastRecipientKey,
  BroadcastRecipientSkipInput,
} from './broadcast-recipient.types.js';

/** The broadcast number a recipient's settled status adds 1 to (`unknown` counts in none, BC8). */
const NUMBER_OF_STATUS: Readonly<
  Record<Exclude<BroadcastRecipientStatus, 'waiting'>, keyof BroadcastNumbersChange | null>
> = {
  sent: 'sent',
  skipped: 'skipped',
  failed: 'failed',
  unknown: null,
};

/** Counts each id of a list (one broadcast's rows moved together). */
function countByBroadcast(broadcastIds: readonly number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const broadcastId of broadcastIds) {
    counts.set(broadcastId, (counts.get(broadcastId) ?? 0) + 1);
  }
  return counts;
}

/**
 * The recipients of broadcasts (feat-instagram-dm-sending routes-final § 7.C — BC16–BC18; ROUTE row
 * R23): the audience build's pieces, the "when her chat opens" row, each result of a broadcast
 * message, the skips of her erasure, pause, a cancel or a move down, and her first reply — every
 * move with the broadcast's numbers in the same commit. Messages go through the account's channel's
 * `ChannelSendingPort` only (BC18): this service names no channel and never picks a lane.
 *
 * @remarks
 * - **Algorithm:** a recipient is made `waiting` with `INSERT … ON CONFLICT DO NOTHING` on the
 *   once-per-person key, and its first message is saved through the port in the same commit (7.C.10
 *   — a recipient never waits without a message); a message the port refuses at once settles the
 *   recipient `skipped` with the port's reason. A result (`recordMessageResult`) moves the recipient
 *   only for message 1 (its status is her first message's, plan §19.19) and saves message N + 1
 *   after a `sent` N while the broadcast is not cancelled (plan §30.14 step 11), `not_before` from
 *   that message's `wait_minutes`.
 * - **Failure modes:** a broadcast whose channel has no sending port throws (the caller's commit
 *   rolls back, the job retries); a `skipped` or `failed` result without a reason throws (a
 *   channel's bug); database errors roll the caller's commit back.
 * - **Side effects:** writes `app.broadcast_recipients`, the numbers of `app.broadcasts`, and — via
 *   the port — the channel's waiting messages. Nothing is queued here: the `broadcast-audience` task
 *   chaining the pieces is ROUTE row R46's, the end duty's cancelled settle and intake's
 *   `handleChatOpened` R47's, the reply hook R38's, the 90-day clean-up R50's.
 * - **Notes:** `matched` grows with the recipients a piece makes (plan §30.14 step 3); a "when her
 *   chat opens" broadcast's `matched` is the segment count's (BC10, R46). `version_number` stays
 *   empty — a broadcast message has no versions (BC8 reuses the message list, which has none).
 */
export class BroadcastRecipientService {
  constructor(
    private readonly options: {
      /** One sending port per channel (AU35) — the app container's record, shared with the engine. */
      sendingPorts: ChannelSendingPorts;
    },
  ) {}

  /** The port of the broadcast's channel — a channel without one is a wiring error. */
  private portOf(broadcast: BroadcastRecipientParentRow): ChannelSendingPort {
    const port = this.options.sendingPorts[broadcast.channel as ChannelAccountChannel];
    if (port === undefined) {
      throw new Error(`broadcast recipient: no sending port wired for "${broadcast.channel}"`);
    }
    return port;
  }

  /**
   * Saves a broadcast's message `messageNumber` for her through the port. Answers the port's skip
   * reason, or `null` when the message waits.
   */
  private async saveMessage({
    databaseHandle,
    broadcast,
    recipient,
    messageNumber,
    now,
  }: {
    databaseHandle: ChannelPortDatabaseHandle;
    broadcast: BroadcastRecipientParentRow;
    recipient: BroadcastRecipientRow;
    messageNumber: number;
    now: Date;
  }): Promise<string | null> {
    const message = broadcast.messages[messageNumber - 1];
    if (message === undefined) return null;
    const saved = await this.portOf(broadcast).saveWaitingMessage({
      databaseHandle,
      organizationId: broadcast.organization_id,
      channelAccountId: broadcast.channel_account_id,
      contactId: recipient.contact_id,
      source: {
        broadcastId: broadcast.id,
        broadcastRecipientId: recipient.id,
        broadcastRecipientCreatedAt: recipient.created_at,
      },
      step: 'broadcast',
      messageNumber,
      versionNumber: recipient.version_number,
      wordingNumber: null,
      messageKind: message.kind,
      content: {
        stepPath: broadcastMessageStepPath(messageNumber),
        uploadPublicIds: uploadPublicIdsOf(message),
      },
      notBefore:
        message.wait_minutes > 0 ? new Date(now.getTime() + message.wait_minutes * 60_000) : null,
      triggerOccurredAt: recipient.created_at,
      answersEventId: null,
    });
    return saved.status === 'skipped' ? saved.reason : null;
  }

  /**
   * Saves message 1 for each new recipient; a message the port refuses at once settles its recipient
   * `skipped` with the port's reason. Answers how many were skipped.
   */
  private async saveFirstMessages({
    databaseHandle,
    broadcast,
    recipients,
  }: {
    databaseHandle: ChannelPortDatabaseHandle;
    broadcast: BroadcastRecipientParentRow;
    recipients: readonly BroadcastRecipientRow[];
  }): Promise<number> {
    const repository = new BroadcastRecipientRepository(databaseHandle);
    const now = new Date();
    let skippedCount = 0;
    for (const recipient of recipients) {
      const skipReason = await this.saveMessage({
        databaseHandle,
        broadcast,
        recipient,
        messageNumber: 1,
        now,
      });
      if (skipReason === null) continue;
      const settled = await repository.settleWaiting({
        key: {
          organizationId: broadcast.organization_id,
          broadcastId: broadcast.id,
          contactId: recipient.contact_id,
        },
        status: 'skipped',
        reason: skipReason,
        at: now,
      });
      if (settled !== null) skippedCount += 1;
    }
    return skippedCount;
  }

  /**
   * One piece of a `sending` broadcast's audience (WC-40 — the `broadcast-audience` task of ROUTE row
   * R46 calls it piece after piece): up to 500 matching contacts whose chat is open now, after the
   * cursor, each made a `waiting` recipient with message 1, in the caller's commit; `matched` grows
   * by the rows made. A second build makes no second row (the once-per-person key).
   *
   * @remarks
   * Algorithm: the broadcast locked by public id; not `sending` (cancelled, done, deleted) → an empty
   * last piece; the cursor's contact resolved (its public id → id; gone → from the start); its copy
   * of the conditions resolved against the account's automations; the piece read, inserted on
   * conflict, the messages saved, the numbers moved; a short piece is the last — the "audience
   * built" mark (7.A.10) set in the same commit (R46). Failure modes: no sending port for its channel
   * throws. Side effects: recipients, messages, `matched`, `skipped`, `audience_built_at`.
   */
  async buildAudiencePiece({
    databaseHandle,
    broadcastPublicId,
    afterContactPublicId,
  }: BroadcastAudiencePieceInput): Promise<BroadcastAudiencePieceResult> {
    const repository = new BroadcastRecipientRepository(databaseHandle);
    const broadcast = await repository.lockLiveBroadcastByPublicId(broadcastPublicId);
    if (broadcast === null || broadcast.status !== 'sending' || broadcast.conditions === null) {
      return {
        createdCount: 0,
        skippedCount: 0,
        lastContactPublicId: afterContactPublicId,
        isLastPiece: true,
        channelAccount: null,
      };
    }
    const afterContactId =
      afterContactPublicId === null
        ? 0
        : ((await repository.findContactIdByPublicId({
            organizationId: broadcast.organization_id,
            contactPublicId: afterContactPublicId,
          })) ?? 0);
    const automationIds = await new BroadcastSegmentRepository(
      databaseHandle,
    ).findAccountAutomationIds({
      organizationId: broadcast.organization_id,
      channelAccountId: broadcast.channel_account_id,
      automationPublicIds: segmentAutomationPublicIds(broadcast.conditions),
    });
    const contacts = await repository.listAudiencePiece({
      organizationId: broadcast.organization_id,
      channelAccountId: broadcast.channel_account_id,
      conditions: broadcast.conditions,
      automationIds,
      afterContactId,
      limit: BROADCAST_AUDIENCE_PIECE_SIZE,
    });
    const recipients = await repository.insertWaiting({
      organizationId: broadcast.organization_id,
      channelAccountId: broadcast.channel_account_id,
      broadcastId: broadcast.id,
      contactIds: contacts.map((contact) => contact.id),
    });
    const skippedCount = await this.saveFirstMessages({ databaseHandle, broadcast, recipients });
    await repository.addToBroadcastNumbers({
      organizationId: broadcast.organization_id,
      broadcastId: broadcast.id,
      change: { matched: recipients.length, skipped: skippedCount },
    });
    const isLastPiece = contacts.length < BROADCAST_AUDIENCE_PIECE_SIZE;
    if (isLastPiece) {
      await repository.markAudienceBuilt({
        organizationId: broadcast.organization_id,
        broadcastId: broadcast.id,
      });
    }
    return {
      createdCount: recipients.length,
      skippedCount,
      lastContactPublicId: contacts.at(-1)?.public_id ?? afterContactPublicId,
      isLastPiece,
      channelAccount: {
        organizationId: broadcast.organization_id,
        channelAccountId: broadcast.channel_account_id,
      },
    };
  }

  /**
   * "When her chat opens" (BC17 — intake's `handleChatOpened`, ROUTE row R47, calls it in its event
   * commit once it decided she matches): her recipient row of an active broadcast with message 1, or
   * her `skipped` · `owner_chat` row put back to `waiting` with a new message 1; a row already there
   * otherwise is left as it is.
   *
   * @remarks
   * Algorithm: the broadcast read; not active → `unchanged`; the insert on conflict, else the
   * reopen (`skipped` − 1). Failure modes: no sending port throws. Side effects: the row, its
   * message, `skipped`. Notes: the reopened recipient's message is a new row — the port reuses a
   * place only for a run's messages; the `owner_chat` message stays `skipped`.
   */
  async addChatOpenedRecipient({
    databaseHandle,
    organizationId,
    broadcastId,
    contactId,
  }: BroadcastRecipientKey & {
    databaseHandle: ChannelPortDatabaseHandle;
  }): Promise<BroadcastChatOpenedOutcome> {
    const repository = new BroadcastRecipientRepository(databaseHandle);
    const broadcast = await repository.findBroadcast({ organizationId, broadcastId });
    if (
      broadcast === null ||
      !(BROADCAST_ACTIVE_STATUSES as readonly string[]).includes(broadcast.status)
    ) {
      return 'unchanged';
    }
    const [created] = await repository.insertWaiting({
      organizationId,
      channelAccountId: broadcast.channel_account_id,
      broadcastId,
      contactIds: [contactId],
    });
    const recipient =
      created ?? (await repository.reopenOwnerChat({ organizationId, broadcastId, contactId }));
    if (recipient === null) return 'unchanged';
    const skippedCount = await this.saveFirstMessages({
      databaseHandle,
      broadcast,
      recipients: [recipient],
    });
    const change = skippedCount - (created === undefined ? 1 : 0);
    await repository.addToBroadcastNumbers({
      organizationId,
      broadcastId,
      change: { skipped: change },
    });
    return created === undefined ? 'reopened' : 'created';
  }

  /**
   * The "when her chat opens" hook (BC17, AC-9.6, AC-21.4, AC-21.5 — intake calls it in her
   * message's commit after the run engine, the run engine in the commit that ends her run): of the
   * account's `waiting_for_chats` broadcasts still inside their days whose copy of the audience she
   * matches, the oldest gets her recipient row through {@link addChatOpenedRecipient} — only when
   * no run of hers is open, no broadcast of hers is waiting and the owner has not typed to her in
   * the last 6 hours. Answers 1 when a row was made or put back, else 0.
   *
   * @remarks
   * Algorithm: the three holds first (the owner's chat, an open-run key, a waiting recipient of
   * hers), then the waiting broadcasts oldest first, each matched by the audience read over her one
   * contact, until one takes her (the 24-hour gap holds the others for now). Failure modes: no sending
   * port throws (the event's unit rolls back and intake retries). Side effects: recipients, their
   * message 1, the broadcasts' `skipped`.
   */
  async handleChatOpened({
    databaseHandle,
    organizationId,
    channelAccountId,
    contactId,
    isOwnerChatting,
  }: {
    databaseHandle: ChannelPortDatabaseHandle;
    organizationId: number;
    channelAccountId: number;
    contactId: number;
    isOwnerChatting: boolean;
  }): Promise<number> {
    if (isOwnerChatting) return 0;
    const repository = new BroadcastRecipientRepository(databaseHandle);
    if (await repository.hasOpenRun({ organizationId, contactId })) return 0;
    // One broadcast at a time (plan §27.15 rule 5): a waiting one of hers goes first.
    if (await repository.hasWaitingRecipient({ organizationId, contactId })) return 0;
    const waiting = await new BroadcastRepository(databaseHandle).listWaitingForChats({
      organizationId,
      channelAccountId,
    });
    for (const broadcast of waiting) {
      if (broadcast.conditions === null) continue;
      const automationIds = await new BroadcastSegmentRepository(
        databaseHandle,
      ).findAccountAutomationIds({
        organizationId,
        channelAccountId,
        automationPublicIds: segmentAutomationPublicIds(broadcast.conditions),
      });
      const [match] = await repository.listAudiencePiece({
        organizationId,
        channelAccountId,
        conditions: broadcast.conditions,
        automationIds,
        afterContactId: contactId - 1,
        limit: 1,
      });
      if (match?.id !== contactId) continue;
      const outcome = await this.addChatOpenedRecipient({
        databaseHandle,
        organizationId,
        broadcastId: broadcast.id,
        contactId,
      });
      // The oldest matching broadcast only; the 24-hour gap holds the others for now.
      if (outcome !== 'unchanged') return 1;
    }
    return 0;
  }

  /**
   * A broadcast message's final result (BC17, BC18 — the outbound seam's way back, called by the
   * channel's result save in its commit): message 1 settles her `waiting` recipient (`sent` with
   * `sent_at`, `skipped`, `failed`, `unknown`) and adds 1 to the broadcast's `sent`, `skipped` or
   * `failed`; a `sent` message N saves message N + 1 while the broadcast is not cancelled. A repeat
   * changes nothing.
   *
   * @remarks
   * Algorithm: the broadcast read, the guarded settle, the numbers, the next message. Failure modes:
   * `skipped` / `failed` without a reason throws. Side effects: the recipient, the numbers, the next
   * message. Notes: her `last_broadcast_at` is the channel's result save's (7.3; Instagram's at R42);
   * a repeat of message N ≥ 2 never arrives — the channel's result save answers a settled message
   * before it calls here.
   */
  async recordMessageResult(input: ChannelBroadcastMessageResultInput): Promise<void> {
    if ((input.result === 'skipped' || input.result === 'failed') && input.reason === null) {
      throw new Error(`broadcast recipient: a ${input.result} result needs a reason`);
    }
    const repository = new BroadcastRecipientRepository(input.databaseHandle);
    const key = {
      organizationId: input.organizationId,
      broadcastId: input.broadcastId,
      contactId: input.contactId,
    };
    const broadcast = await repository.findBroadcast(key);
    if (broadcast === null) return;
    if (input.messageNumber === 1) {
      const settled = await repository.settleWaiting({
        key,
        status: input.result,
        reason: input.reason,
        at: input.occurredAt,
      });
      // A repeat of message 1's result changes nothing — and saves no second message 2.
      if (settled === null) return;
      const number = NUMBER_OF_STATUS[input.result];
      if (number !== null) {
        await repository.addToBroadcastNumbers({
          organizationId: input.organizationId,
          broadcastId: input.broadcastId,
          change: { [number]: 1 },
        });
      }
    }
    if (input.result !== 'sent' || broadcast.status === 'cancelled') return;
    const recipient = await repository.find(key);
    if (recipient === null) return;
    await this.saveMessage({
      databaseHandle: input.databaseHandle,
      broadcast,
      recipient,
      messageNumber: input.messageNumber + 1,
      now: input.occurredAt,
    });
  }

  /**
   * Her `waiting` recipients of every broadcast `skipped` with the reason — her erasure
   * (`contact_deleted`, CT8) or her pause (`contact_excluded`, `opted_out`, CTC4) — each broadcast's
   * `skipped` + its count, in the caller's commit. Answers how many.
   *
   * @remarks
   * Algorithm: one guarded update, then the numbers per broadcast. Failure modes: none of its own.
   * Side effects: the rows and the numbers. Notes: her waiting messages are the ports' own steps.
   */
  async skipContactWaitingRecipients({
    databaseHandle,
    organizationId,
    reason,
    contactId,
  }: BroadcastRecipientSkipInput & { contactId: number }): Promise<number> {
    const repository = new BroadcastRecipientRepository(databaseHandle);
    const broadcastIds = await repository.skipWaitingOfContact({
      organizationId,
      contactId,
      reason,
    });
    for (const [broadcastId, count] of countByBroadcast(broadcastIds)) {
      await repository.addToBroadcastNumbers({
        organizationId,
        broadcastId,
        change: { skipped: count },
      });
    }
    return broadcastIds.length;
  }

  /**
   * Up to `limit` `waiting` recipients of a cancelled broadcast `skipped` (`broadcast_cancelled` or
   * `plan_feature_off`) and its `skipped` + their count — the end duty's piece (WC-29, ROUTE row R47,
   * which cancels their waiting messages through the port). Answers how many.
   *
   * @remarks
   * Algorithm: one guarded update over a piece, then the numbers. Failure modes: none of its own.
   * Side effects: the rows and the number.
   */
  async skipBroadcastWaitingRecipients({
    databaseHandle,
    organizationId,
    reason,
    broadcastId,
    limit,
  }: BroadcastRecipientSkipInput & { broadcastId: number; limit: number }): Promise<number> {
    const repository = new BroadcastRecipientRepository(databaseHandle);
    const count = await repository.skipWaitingOfBroadcast({
      organizationId,
      broadcastId,
      reason,
      limit,
    });
    await repository.addToBroadcastNumbers({
      organizationId,
      broadcastId,
      change: { skipped: count },
    });
    return count;
  }

  /**
   * Her first message after a broadcast went (BC17 — intake, ROUTE row R38, in her message's
   * commit): `replied_at` on each of her `sent` recipients that has none, and that broadcast's
   * `replies` + 1 — once per recipient. Answers how many.
   *
   * @remarks
   * Algorithm: one guarded update, then the numbers. Failure modes: none of its own. Side effects:
   * the rows and `replies`.
   */
  async recordContactReply({
    databaseHandle,
    organizationId,
    contactId,
    repliedAt,
  }: {
    databaseHandle?: ChannelPortDatabaseHandle | undefined;
    organizationId: number;
    contactId: number;
    repliedAt: Date;
  }): Promise<number> {
    const repository = new BroadcastRecipientRepository(databaseHandle);
    const broadcastIds = await repository.recordReply({ organizationId, contactId, repliedAt });
    for (const [broadcastId, count] of countByBroadcast(broadcastIds)) {
      await repository.addToBroadcastNumbers({
        organizationId,
        broadcastId,
        change: { replies: count },
      });
    }
    return broadcastIds.length;
  }

  /**
   * A tap on a broadcast message's button or quick reply (§ 7.A.10 — intake's, in the tap's unit):
   * the broadcast it names and the automation its "start automation" button starts, read before
   * the run engine; `null` when the broadcast is gone or another organization's.
   *
   * @remarks
   * Algorithm: one read on the caller's handle. Failure modes: database errors roll the caller's
   * unit back. Side effects: none — `taps` is {@link BroadcastRecipientService.recordBroadcastTap}'s.
   */
  async findBroadcastTap({
    databaseHandle,
    organizationId,
    broadcastPublicId,
  }: {
    databaseHandle: ChannelPortDatabaseHandle;
    organizationId: number;
    broadcastPublicId: string;
  }): Promise<{ broadcastId: number; startAutomationPublicId: string | null } | null> {
    return new BroadcastRecipientRepository(databaseHandle).findTapTarget({
      organizationId,
      broadcastPublicId,
    });
  }

  /**
   * Adds 1 to a broadcast's `taps` (§ 7.A.10, BC8) — intake's, after the run engine, in the tap's
   * unit (the one lock order: contact → automation → runs, then the broadcast).
   *
   * @remarks
   * Algorithm: one guarded `UPDATE`. Failure modes: database errors roll the caller's unit back.
   * Side effects: the broadcast's `taps`. Notes: the event is final once, so a tap counts once.
   */
  async recordBroadcastTap({
    databaseHandle,
    organizationId,
    broadcastId,
  }: {
    databaseHandle: ChannelPortDatabaseHandle;
    organizationId: number;
    broadcastId: number;
  }): Promise<void> {
    await new BroadcastRecipientRepository(databaseHandle).addToBroadcastNumbers({
      organizationId,
      broadcastId,
      change: { taps: 1 },
    });
  }
}
