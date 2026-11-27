import { type SQL, and, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { automation_runs } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { automation_run_open_keys } from '@/domains/app/sub-domains/automation/automation-run/automation-run-open-key.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { instagram_media } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.schema.js';
import { automation_reply_states } from '@/domains/app/sub-domains/automation/automation-reply-state.schema.js';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import { contact_activities } from '@/domains/app/sub-domains/contact/contact-activity.schema.js';
import { CONTACT_CHAT_WINDOW_MS } from '@/domains/app/sub-domains/contact/contact.constants.js';
import type { InstagramSendLane } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import {
  INSTAGRAM_COMMENT_REPLY_EXPIRY_MILLISECONDS,
  INSTAGRAM_MESSAGE_KEEP_DAYS,
  INSTAGRAM_PERSON_FINAL_ERRORS,
  INSTAGRAM_PRIVATE_REPLY_EXPIRY_MILLISECONDS,
  type InstagramOutgoingMessageChannel,
  type InstagramOutgoingMessageFinalStatus,
  type InstagramOutgoingMessageNotRetryableReason,
  type InstagramOutgoingMessageReason,
  type InstagramOutgoingMessageType,
} from './instagram-outgoing-message.constants.js';
import { instagram_outgoing_messages } from './instagram-outgoing-message.schema.js';

/** One `app.instagram_outgoing_messages` row as Drizzle reads it. */
export type InstagramOutgoingMessageRow = typeof instagram_outgoing_messages.$inferSelect;

/** A message's key: its public id and its split key (tickets carry both, SN17). */
export interface InstagramOutgoingMessageKey {
  organizationId: number;
  publicId: string;
  automationRunStartedAt: Date;
}

/** One waiting row to write (SN22): the lane, channel and count decided by the service. */
export interface InstagramOutgoingMessageWaitingValues {
  organizationId: number;
  channelAccountId: number;
  automationId: number | null;
  automationRunId: number | null;
  broadcastId: number | null;
  automationRunStartedAt: Date;
  contactId: number;
  messageType: InstagramOutgoingMessageType;
  messageNumber: number | null;
  messageKind: string;
  versionNumber: number | null;
  wordingNumber: number | null;
  lane: InstagramSendLane;
  channel: InstagramOutgoingMessageChannel | null;
  isCountedAsDirectMessage: boolean;
  notBefore: Date;
  triggerOccurredAt: Date | null;
}

/** A row's run place (plan §19.1 `uq_instagram_outgoing_messages_run_type`). */
export interface InstagramOutgoingMessageRunPlace {
  organizationId: number;
  automationRunId: number;
  automationRunStartedAt: Date;
  messageType: InstagramOutgoingMessageType;
  messageNumber: number | null;
  messageKind: string;
}

/** Which waiting rows a cancel or skip ends (AU35's selection, by internal id). */
export interface InstagramOutgoingMessageWaitingSelection {
  organizationId: number;
  by: 'run' | 'automation' | 'contact' | 'broadcast';
  id: number;
  /** At most this many, oldest first (a repair duty's piece); absent — every one. */
  limit?: number | undefined;
}

/** A failed message's verdict now: one of the blocks, or `retryable` (SN18). */
export type InstagramFailedMessageVerdict =
  | InstagramOutgoingMessageNotRetryableReason
  | 'retryable';

/** Whose failed messages (by internal id). */
export interface InstagramFailedMessagesOwner {
  organizationId: number;
  by: 'automation' | 'contact';
  id: number;
}

/** A row of a contact's "what happened" read (CT14). */
export interface InstagramContactMessageRow {
  id: number;
  public_id: string;
  cursor_created_at: string;
  automation_public_id: string | null;
  automation_name: string | null;
  automation_run_public_id: string | null;
  /** `brc_…` of a broadcast message's broadcast (sub-domain 7, R22), else `null`. */
  broadcast_public_id: string | null;
  message_type: string;
  message_number: number | null;
  status: string;
  reason: string | null;
  channel: string | null;
}

/** The rows of a raw `execute` — postgres-js answers an array, node-postgres `{ rows }`. */
function rowsOf<Row>(result: unknown): Row[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Row[];
}

/** The message column each kind of cancel or skip selection matches on. */
const SELECTION_COLUMNS = {
  run: instagram_outgoing_messages.automation_run_id,
  automation: instagram_outgoing_messages.automation_id,
  contact: instagram_outgoing_messages.contact_id,
  broadcast: instagram_outgoing_messages.broadcast_id,
} satisfies Record<InstagramOutgoingMessageWaitingSelection['by'], unknown>;

/** The selection's column of a cancel or skip. */
function selectionCondition({
  organizationId,
  by,
  id,
}: InstagramOutgoingMessageWaitingSelection): SQL {
  const column = SELECTION_COLUMNS[by];
  return and(
    eq(instagram_outgoing_messages.organization_id, organizationId),
    eq(column, id),
  ) as SQL;
}

/** The keyset condition of the contact's merged message list after `after` (none on the first page). */
function contactMessageCursorCondition(
  after: { occurredAt: string; source: 'message' | 'run_event'; id: number } | null,
): SQL {
  if (after === null) return sql`TRUE`;
  if (after.source === 'run_event') {
    // 'message' sorts below 'run_event' at one time: this time's messages are still ahead.
    return sql`m.created_at <= ${after.occurredAt}::timestamptz`;
  }
  return sql`(m.created_at < ${after.occurredAt}::timestamptz
                 OR (m.created_at = ${after.occurredAt}::timestamptz AND m.id < ${after.id}))`;
}

/** Meta's errors final for the person (SN18), as one SQL condition on a message row. */
function personFinalErrorCondition(): SQL {
  const parts = INSTAGRAM_PERSON_FINAL_ERRORS.map(({ code, subcode }) =>
    subcode === null
      ? sql`(m.error_code = ${code})`
      : sql`(m.error_code = ${code} AND m.error_subcode = ${subcode})`,
  );
  const separator = sql` OR `;
  return sql`(${sql.join(parts, separator)})`;
}

/** One candidate of a lane turn's pick (plan §28.2, §29.5): its key, automation and comment time. */
export interface InstagramOutgoingMessagePickCandidate {
  publicId: string;
  automationRunStartedAt: Date;
  automationId: number;
  triggerOccurredAt: Date | null;
}

/** An ON automation's best waiting public reply and its pacing (plan §29.3, §29.5 rule 2). */
export interface InstagramReplyPacedCandidate extends InstagramOutgoingMessagePickCandidate {
  /** `app.automations.public_reply_hour_limit` (empty = the default 60). */
  publicReplyHourLimit: number | null;
  /** Its reply state's `box_start`, or `null` before its first box. */
  boxStart: Date | null;
}

/** A broadcast lane candidate (plan §30.14 step 6): its key, her, its number and its broadcast's status. */
export interface InstagramBroadcastPickCandidate {
  publicId: string;
  automationRunStartedAt: Date;
  contactId: number;
  /** 1–3: the broadcast's message she gets. */
  messageNumber: number;
  /** `app.broadcasts.status` now (`sending`, `waiting_for_chats`, `cancelled`, …). */
  broadcastStatus: string;
}

/** A pick candidate from a raw row. */
function candidateOf(row: Record<string, unknown>): InstagramOutgoingMessagePickCandidate {
  return {
    publicId: String(row.public_id),
    automationRunStartedAt: new Date(String(row.automation_run_started_at)),
    automationId: Number(row.automation_id),
    triggerOccurredAt:
      row.trigger_occurred_at === null ? null : new Date(row.trigger_occurred_at as string),
  };
}

/**
 * Drizzle access to `app.instagram_outgoing_messages` (feat-instagram-dm-sending routes-final § 6.B.3, SN16):
 * the waiting rows the run engine and broadcasts write through the sending port, the guarded moves
 * of waiting rows (cancel, skip, lane move, the owner's retry), the claim and the result save, and
 * the reads of route 24, routes 25–26 / 36–37, route 63 and the webhook's own-echo lookup.
 *
 * @remarks
 * - **Algorithm:** every writer other than the result save touches `waiting` rows only (a guarded
 *   update — 6.B.10); every query names `organization_id` (and, for a single row, the split key, so
 *   it reads one part).
 * - **Failure modes:** the table's CHECKs refuse an impossible row (23514); a second row for one
 *   run place breaks `idx_instagram_outgoing_messages_run_type` (23505).
 * - **Side effects:** writes `app.instagram_outgoing_messages` only; reads the run, the automation, the contact
 *   and her activity for joins (same bounded context).
 */
export class InstagramOutgoingMessageRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** The run's way to start (the lane rule needs a live comment apart), or `null`. */
  async findRunTriggerType({
    organizationId,
    automationRunId,
    automationRunStartedAt,
  }: {
    organizationId: number;
    automationRunId: number;
    automationRunStartedAt: Date;
  }): Promise<string | null> {
    const [row] = await this.db()
      .select({ trigger_type: automation_runs.trigger_type })
      .from(automation_runs)
      .where(
        and(
          eq(automation_runs.organization_id, organizationId),
          eq(automation_runs.id, automationRunId),
          eq(automation_runs.started_at, automationRunStartedAt),
        ),
      )
      .limit(1);
    return row?.trigger_type ?? null;
  }

  /** Her last DM, story reply or tap — the 24-hour window's start (D8); `null` when none. */
  async findLastDirectMessageReceivedAt({
    organizationId,
    contactId,
  }: {
    organizationId: number;
    contactId: number;
  }): Promise<Date | null> {
    const [row] = await this.db()
      .select({ at: contact_activities.last_direct_message_received_at })
      .from(contact_activities)
      .where(
        and(
          eq(contact_activities.organization_id, organizationId),
          eq(contact_activities.contact_id, contactId),
        ),
      )
      .limit(1);
    return row?.at ?? null;
  }

  /** The row of one run place, locked `FOR UPDATE`, or `null`. */
  async lockRunPlace(
    place: InstagramOutgoingMessageRunPlace,
  ): Promise<InstagramOutgoingMessageRow | null> {
    const [row] = await this.db()
      .select()
      .from(instagram_outgoing_messages)
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, place.organizationId),
          eq(instagram_outgoing_messages.automation_run_id, place.automationRunId),
          eq(instagram_outgoing_messages.automation_run_started_at, place.automationRunStartedAt),
          eq(instagram_outgoing_messages.message_type, place.messageType),
          place.messageNumber === null
            ? sql`${instagram_outgoing_messages.message_number} IS NULL`
            : eq(instagram_outgoing_messages.message_number, place.messageNumber),
          eq(instagram_outgoing_messages.message_kind, place.messageKind),
        ),
      )
      .limit(1)
      .for('update');
    return row ?? null;
  }

  /** Writes one `waiting` row; answers it. */
  async insertWaiting(
    values: InstagramOutgoingMessageWaitingValues,
  ): Promise<InstagramOutgoingMessageRow> {
    const [row] = await this.db()
      .insert(instagram_outgoing_messages)
      .values({
        public_id: generatePublicId('instagramMessage'),
        organization_id: values.organizationId,
        channel_account_id: values.channelAccountId,
        automation_id: values.automationId,
        automation_run_id: values.automationRunId,
        broadcast_id: values.broadcastId,
        automation_run_started_at: values.automationRunStartedAt,
        contact_id: values.contactId,
        message_type: values.messageType,
        message_number: values.messageNumber,
        message_kind: values.messageKind,
        version_number: values.versionNumber,
        wording_number: values.wordingNumber,
        lane: values.lane,
        channel: values.channel,
        is_counted_as_direct_message: values.isCountedAsDirectMessage,
        not_before: values.notBefore,
        trigger_occurred_at: values.triggerOccurredAt,
      })
      .returning();
    return row!;
  }

  /**
   * One run place saved again (SN16): a `sent` question asked again (`asks` + 1) or an `unknown`
   * step on her next action (D17) goes back to `waiting` with its new lane, channel and time.
   */
  async reopenAsWaiting({
    row,
    values,
    isAskedAgain,
  }: {
    row: InstagramOutgoingMessageRow;
    values: Pick<
      InstagramOutgoingMessageWaitingValues,
      'lane' | 'channel' | 'notBefore' | 'versionNumber' | 'wordingNumber'
    >;
    isAskedAgain: boolean;
  }): Promise<InstagramOutgoingMessageRow | null> {
    const [updated] = await this.db()
      .update(instagram_outgoing_messages)
      .set({
        status: 'waiting',
        reason: null,
        lane: values.lane,
        channel: values.channel,
        not_before: values.notBefore,
        version_number: values.versionNumber,
        wording_number: values.wordingNumber,
        sent_at: null,
        tries: 0,
        asks: isAskedAgain
          ? sql`${instagram_outgoing_messages.asks} + 1`
          : instagram_outgoing_messages.asks,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, row.organization_id),
          eq(instagram_outgoing_messages.id, row.id),
          eq(instagram_outgoing_messages.automation_run_started_at, row.automation_run_started_at),
          inArray(instagram_outgoing_messages.status, ['sent', 'unknown']),
        ),
      )
      .returning();
    return updated ?? null;
  }

  /** Ends the selected `waiting` rows with a status and reason (AU35's cancel and skip). */
  async endWaiting({
    selection,
    status,
    reason,
  }: {
    selection: InstagramOutgoingMessageWaitingSelection;
    status: 'cancelled' | 'skipped' | 'expired';
    reason: InstagramOutgoingMessageReason;
  }): Promise<number> {
    const ended = await this.db()
      .update(instagram_outgoing_messages)
      .set({ status, reason, updated_at: sql`now()` })
      .where(
        and(
          selectionCondition(selection),
          eq(instagram_outgoing_messages.status, 'waiting'),
          selection.limit === undefined
            ? undefined
            : inArray(
                instagram_outgoing_messages.id,
                this.db()
                  .select({ id: instagram_outgoing_messages.id })
                  .from(instagram_outgoing_messages)
                  .where(
                    and(
                      selectionCondition(selection),
                      eq(instagram_outgoing_messages.status, 'waiting'),
                    ),
                  )
                  .orderBy(instagram_outgoing_messages.id)
                  .limit(selection.limit),
              ),
        ),
      )
      .returning({ id: instagram_outgoing_messages.id });
    return ended.length;
  }

  /**
   * Moves a `waiting` row to another lane and channel (plan §19.1 "Moving a message between lanes":
   * her window opened or closed) — the same row, only while it waits. Answers whether it moved.
   */
  async moveLane({
    key,
    lane,
    channel,
  }: {
    key: InstagramOutgoingMessageKey;
    lane: InstagramSendLane;
    channel: InstagramOutgoingMessageChannel;
  }): Promise<boolean> {
    const moved = await this.db()
      .update(instagram_outgoing_messages)
      .set({ lane, channel, updated_at: sql`now()` })
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, key.organizationId),
          eq(instagram_outgoing_messages.public_id, key.publicId),
          eq(instagram_outgoing_messages.automation_run_started_at, key.automationRunStartedAt),
          eq(instagram_outgoing_messages.status, 'waiting'),
        ),
      )
      .returning({ id: instagram_outgoing_messages.id });
    return moved.length > 0;
  }

  /**
   * The claim's message part (SN3 (d)): a `waiting` row of this lane and channel becomes `sending`
   * now — the guarded update a lane move in between makes miss. The gates and the month count join
   * the same commit at ROUTE row R42. Answers the row, or `null`.
   */
  async claimWaiting({
    key,
    lane,
    channel,
  }: {
    key: InstagramOutgoingMessageKey;
    lane: InstagramSendLane;
    channel: InstagramOutgoingMessageChannel | null;
  }): Promise<InstagramOutgoingMessageRow | null> {
    const [row] = await this.db()
      .update(instagram_outgoing_messages)
      .set({ status: 'sending', sending_at: sql`now()`, updated_at: sql`now()` })
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, key.organizationId),
          eq(instagram_outgoing_messages.public_id, key.publicId),
          eq(instagram_outgoing_messages.automation_run_started_at, key.automationRunStartedAt),
          eq(instagram_outgoing_messages.status, 'waiting'),
          eq(instagram_outgoing_messages.lane, lane),
          channel === null
            ? sql`${instagram_outgoing_messages.channel} IS NULL`
            : eq(instagram_outgoing_messages.channel, channel),
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * The result save's message part (SN4): a `sending` row takes its final status, reason, Meta's id
   * and codes — the only writer of a claimed row. Answers the row, or `null` when it is not
   * `sending` any more (a repeat save does nothing).
   */
  async finishSending({
    key,
    status,
    reason,
    instagramMessageId,
    errorCode,
    errorSubcode,
  }: {
    key: InstagramOutgoingMessageKey;
    status: InstagramOutgoingMessageFinalStatus;
    reason: InstagramOutgoingMessageReason | null;
    instagramMessageId: string | null;
    errorCode: number | null;
    errorSubcode: number | null;
  }): Promise<InstagramOutgoingMessageRow | null> {
    const [row] = await this.db()
      .update(instagram_outgoing_messages)
      .set({
        status,
        reason,
        instagram_message_id: instagramMessageId,
        error_code: errorCode,
        error_subcode: errorSubcode,
        sending_at: null,
        sent_at: status === 'sent' ? sql`now()` : null,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, key.organizationId),
          eq(instagram_outgoing_messages.public_id, key.publicId),
          eq(instagram_outgoing_messages.automation_run_started_at, key.automationRunStartedAt),
          eq(instagram_outgoing_messages.status, 'sending'),
        ),
      )
      .returning();
    return row ?? null;
  }

  /** One message by its key, or `null`. */
  async findByKey(key: InstagramOutgoingMessageKey): Promise<InstagramOutgoingMessageRow | null> {
    const [row] = await this.db()
      .select()
      .from(instagram_outgoing_messages)
      .where(this.whereKey(key))
      .limit(1);
    return row ?? null;
  }

  /**
   * The result save's "back to `waiting`" (SN5: a stop never fails a DM; a sure "not sent"): a
   * `sending` row waits again from `notBefore`, its try counted when `isTryUsed`. Answers the row, or
   * `null` when it is not `sending` any more.
   */
  async putBackWaiting({
    key,
    isTryUsed,
    notBefore,
    errorCode,
    errorSubcode,
  }: {
    key: InstagramOutgoingMessageKey;
    isTryUsed: boolean;
    notBefore: Date;
    errorCode: number | null;
    errorSubcode: number | null;
  }): Promise<InstagramOutgoingMessageRow | null> {
    const [row] = await this.db()
      .update(instagram_outgoing_messages)
      .set({
        status: 'waiting',
        reason: null,
        sending_at: null,
        not_before: notBefore,
        tries: isTryUsed
          ? sql`${instagram_outgoing_messages.tries} + 1`
          : instagram_outgoing_messages.tries,
        error_code: errorCode,
        error_subcode: errorSubcode,
        updated_at: sql`now()`,
      })
      .where(and(this.whereKey(key), eq(instagram_outgoing_messages.status, 'sending')))
      .returning();
    return row ?? null;
  }

  /** Her messages sent in the last hour (the person limit, SN3 — `idx_instagram_outgoing_messages_person_sent`). */
  async countSentToContactInLastHour({
    organizationId,
    contactId,
  }: {
    organizationId: number;
    contactId: number;
  }): Promise<number> {
    const rows = await this.db()
      .select({ total: sql<number>`count(*)::int` })
      .from(instagram_outgoing_messages)
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, organizationId),
          eq(instagram_outgoing_messages.contact_id, contactId),
          eq(instagram_outgoing_messages.status, 'sent'),
          sql`${instagram_outgoing_messages.sent_at} > now() - interval '1 hour'`,
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Her fast messages `sending` now (plan §30.2 step 5: one of hers at a time) — or, with
   * `messageKind`, the account's fast messages of that kind `sending` (step 8: 5 audio at once).
   */
  async countFastSending({
    organizationId,
    contactId,
    channelAccountId,
    messageKind,
  }:
    | { organizationId: number; contactId: number; channelAccountId?: never; messageKind?: never }
    | {
        organizationId: number;
        channelAccountId: number;
        messageKind: string;
        contactId?: never;
      }): Promise<number> {
    const rows = await this.db()
      .select({ total: sql<number>`count(*)::int` })
      .from(instagram_outgoing_messages)
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, organizationId),
          eq(instagram_outgoing_messages.status, 'sending'),
          eq(instagram_outgoing_messages.lane, 'fast'),
          contactId === undefined
            ? undefined
            : eq(instagram_outgoing_messages.contact_id, contactId),
          channelAccountId === undefined
            ? undefined
            : eq(instagram_outgoing_messages.channel_account_id, channelAccountId),
          messageKind === undefined
            ? undefined
            : eq(instagram_outgoing_messages.message_kind, messageKind),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * A message `unknown` proved `sent` by her tap on its button (the payload's `igm_…` part, plan §14,
   * WH8): `sent` now, its reason cleared. Answers whether it moved (a message in any other state is
   * left alone).
   */
  async markUnknownSent({
    organizationId,
    publicId,
  }: {
    organizationId: number;
    publicId: string;
  }): Promise<InstagramOutgoingMessageRow | null> {
    const [row] = await this.db()
      .update(instagram_outgoing_messages)
      .set({
        status: 'sent',
        reason: null,
        sent_at: sql`coalesce(${instagram_outgoing_messages.sent_at}, now())`,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, organizationId),
          eq(instagram_outgoing_messages.public_id, publicId),
          eq(instagram_outgoing_messages.status, 'unknown'),
        ),
      )
      .returning();
    return row ?? null;
  }

  /** The `WHERE` of one message by key. */
  private whereKey(key: InstagramOutgoingMessageKey): SQL | undefined {
    return and(
      eq(instagram_outgoing_messages.organization_id, key.organizationId),
      eq(instagram_outgoing_messages.public_id, key.publicId),
      eq(instagram_outgoing_messages.automation_run_started_at, key.automationRunStartedAt),
    );
  }

  /**
   * Her direct messages of the account that are `sending` or `unknown` without Meta's id, changed
   * since `since` — what an echo of the owner's chat may be one of (WH10, P62); at most 2 rows (the
   * caller only needs "exactly one").
   */
  async listUnconfirmedDirectMessagesSince({
    organizationId,
    channelAccountId,
    contactInstagramUserId,
    since,
  }: {
    organizationId: number;
    channelAccountId: number;
    /** Her Instagram id — the contact is found by it (an echo carries no contact of ours). */
    contactInstagramUserId: string;
    since: Date;
  }): Promise<InstagramOutgoingMessageRow[]> {
    return this.db()
      .select()
      .from(instagram_outgoing_messages)
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, organizationId),
          eq(instagram_outgoing_messages.channel_account_id, channelAccountId),
          eq(
            instagram_outgoing_messages.contact_id,
            sql`(SELECT ${contacts.id} FROM ${contacts}
              WHERE ${contacts.organization_id} = ${organizationId}
                AND ${contacts.channel_account_id} = ${channelAccountId}
                AND ${contacts.instagram_user_id} = ${contactInstagramUserId})`,
          ),
          inArray(instagram_outgoing_messages.status, ['sending', 'unknown']),
          inArray(instagram_outgoing_messages.channel, ['direct', 'private_reply']),
          isNull(instagram_outgoing_messages.instagram_message_id),
          gte(instagram_outgoing_messages.updated_at, since),
        ),
      )
      .limit(2);
  }

  /**
   * An `unknown` message whose echo came back (WH10): `sent`, with Meta's id. `null` when it is no
   * longer `unknown`.
   */
  async confirmUnknownAsSent({
    key,
    instagramMessageId,
  }: {
    key: InstagramOutgoingMessageKey;
    instagramMessageId: string;
  }): Promise<InstagramOutgoingMessageRow | null> {
    const [row] = await this.db()
      .update(instagram_outgoing_messages)
      .set({
        status: 'sent',
        reason: null,
        instagram_message_id: instagramMessageId,
        sent_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, key.organizationId),
          eq(instagram_outgoing_messages.public_id, key.publicId),
          eq(instagram_outgoing_messages.automation_run_started_at, key.automationRunStartedAt),
          eq(instagram_outgoing_messages.status, 'unknown'),
        ),
      )
      .returning();
    return row ?? null;
  }

  /** The Meta message ids among `messageIds` that one account sent (WHQ1, P62). */
  async findOwnSentMessageIds({
    organizationId,
    channelAccountId,
    messageIds,
  }: {
    organizationId: number;
    channelAccountId: number;
    messageIds: readonly string[];
  }): Promise<string[]> {
    if (messageIds.length === 0) return [];
    const rows = await this.db()
      .select({ instagram_message_id: instagram_outgoing_messages.instagram_message_id })
      .from(instagram_outgoing_messages)
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, organizationId),
          eq(instagram_outgoing_messages.channel_account_id, channelAccountId),
          isNotNull(instagram_outgoing_messages.instagram_message_id),
          inArray(instagram_outgoing_messages.instagram_message_id, [...messageIds]),
        ),
      );
    return rows.flatMap((row) =>
      row.instagram_message_id === null ? [] : [row.instagram_message_id],
    );
  }

  /** The account's waiting messages per lane (route 63). */
  async countWaitingByLane({
    organizationId,
    channelAccountId,
  }: {
    organizationId: number;
    channelAccountId: number;
  }): Promise<Array<{ lane: string; count: number }>> {
    const rows = await this.db()
      .select({ lane: instagram_outgoing_messages.lane, count: sql<number>`count(*)::int` })
      .from(instagram_outgoing_messages)
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, organizationId),
          eq(instagram_outgoing_messages.channel_account_id, channelAccountId),
          eq(instagram_outgoing_messages.status, 'waiting'),
        ),
      )
      .groupBy(instagram_outgoing_messages.lane);
    return rows.map((row) => ({ lane: row.lane, count: Number(row.count) }));
  }

  /**
   * The account's last owner retry (route 63's `last_retry`): the newest `owner_retry_at`, the rows
   * it put back, the one automation or contact they share, and how many failed rows of that
   * automation or contact are still not retried.
   */
  async findLastRetry({
    organizationId,
    channelAccountId,
  }: {
    organizationId: number;
    channelAccountId: number;
  }): Promise<{
    at: Date;
    retried: number;
    cannot: number;
    automationPublicId: string | null;
    contactPublicId: string | null;
  } | null> {
    const result = await this.db().execute(sql`
      WITH last_press AS (
        SELECT max(m.owner_retry_at) AS at
        FROM ${instagram_outgoing_messages} AS m
        WHERE m.organization_id = ${organizationId}
          AND m.channel_account_id = ${channelAccountId}
          AND m.owner_retry_at IS NOT NULL
      ), pressed AS (
        SELECT m.automation_id, m.contact_id
        FROM ${instagram_outgoing_messages} AS m, last_press
        WHERE m.organization_id = ${organizationId}
          AND m.channel_account_id = ${channelAccountId}
          AND m.owner_retry_at = last_press.at
      ), shared AS (
        SELECT count(*)::int AS retried,
               CASE WHEN count(DISTINCT automation_id) = 1 AND bool_and(automation_id IS NOT NULL)
                    THEN min(automation_id) END AS automation_id,
               CASE WHEN count(DISTINCT contact_id) = 1 THEN min(contact_id) END AS contact_id
        FROM pressed
      )
      SELECT to_char(last_press.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
             shared.retried,
             (SELECT a.public_id FROM ${automations} AS a
               WHERE a.organization_id = ${organizationId} AND a.id = shared.automation_id) AS automation_public_id,
             (SELECT c.public_id FROM ${contacts} AS c
               WHERE c.organization_id = ${organizationId} AND c.id = shared.contact_id
                 AND shared.automation_id IS NULL) AS contact_public_id,
             (SELECT count(*)::int FROM ${instagram_outgoing_messages} AS f
               WHERE f.organization_id = ${organizationId}
                 AND f.channel_account_id = ${channelAccountId}
                 AND f.status = 'failed' AND f.owner_retry_at IS NULL
                 AND (shared.automation_id IS NULL OR f.automation_id = shared.automation_id)
                 AND (shared.automation_id IS NOT NULL OR shared.contact_id IS NULL
                      OR f.contact_id = shared.contact_id)
                 AND f.created_at >= last_press.at - make_interval(days => ${INSTAGRAM_MESSAGE_KEEP_DAYS})) AS cannot
      FROM last_press, shared
      WHERE last_press.at IS NOT NULL
    `);
    const [row] = rowsOf<{
      at: string;
      retried: number;
      cannot: number;
      automation_public_id: string | null;
      contact_public_id: string | null;
    }>(result);
    if (row === undefined) return null;
    return {
      at: new Date(row.at),
      retried: Number(row.retried),
      cannot: Number(row.cannot),
      automationPublicId: row.automation_public_id,
      contactPublicId: row.contact_public_id,
    };
  }

  /**
   * Her messages of the last {@link INSTAGRAM_MESSAGE_KEEP_DAYS} days, newest first, after the
   * keyset `(created_at, 'message', id)` (CT14) — with the automation's id and name, the run's id and
   * a broadcast message's broadcast id (R22).
   */
  async listContactMessages({
    organizationId,
    contactId,
    after,
    limit,
  }: {
    organizationId: number;
    contactId: number;
    after: { occurredAt: string; source: 'message' | 'run_event'; id: number } | null;
    limit: number;
  }): Promise<InstagramContactMessageRow[]> {
    const cursorCondition = contactMessageCursorCondition(after);
    const result = await this.db().execute(sql`
      SELECT m.id, m.public_id,
             to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
             a.public_id AS automation_public_id, a.name AS automation_name,
             r.public_id AS automation_run_public_id,
             b.public_id AS broadcast_public_id,
             m.message_type, m.message_number, m.status, m.reason, m.channel
      FROM ${instagram_outgoing_messages} AS m
      LEFT JOIN ${automations} AS a
        ON a.organization_id = m.organization_id AND a.id = m.automation_id
      LEFT JOIN ${automation_runs} AS r
        ON r.organization_id = m.organization_id AND r.id = m.automation_run_id
       AND r.started_at = m.automation_run_started_at
      LEFT JOIN ${broadcasts} AS b
        ON b.organization_id = m.organization_id AND b.id = m.broadcast_id
      WHERE m.organization_id = ${organizationId}
        AND m.contact_id = ${contactId}
        AND m.created_at >= now() - make_interval(days => ${INSTAGRAM_MESSAGE_KEEP_DAYS})
        AND ${cursorCondition}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limit}
    `);
    return rowsOf<InstagramContactMessageRow>(result).map((row) => ({
      ...row,
      id: Number(row.id),
      message_number: row.message_number === null ? null : Number(row.message_number),
    }));
  }

  /**
   * The verdict SQL of one failed row now (SN18, plan §33.10 rule 2), first match wins: already
   * retried, a broadcast, final for her (erased, opted out, paused, or a person error), the text
   * still refused, too old (an opening private reply after comment + 7 days − 30 min, a public reply
   * or hide after 7 days), her chat closed (any other DM), else retryable.
   */
  private verdictExpression(): SQL {
    const privateReplyExpiry = sql`make_interval(secs => ${INSTAGRAM_PRIVATE_REPLY_EXPIRY_MILLISECONDS / 1000})`;
    const commentReplyExpiry = sql`make_interval(secs => ${INSTAGRAM_COMMENT_REPLY_EXPIRY_MILLISECONDS / 1000})`;
    const chatWindow = sql`make_interval(secs => ${CONTACT_CHAT_WINDOW_MS / 1000})`;
    return sql`CASE
      WHEN m.owner_retry_at IS NOT NULL THEN 'already_retried'
      WHEN m.message_type = 'broadcast' THEN 'broadcast'
      WHEN c.id IS NULL OR c.deleted_at IS NOT NULL OR c.opted_out_at IS NOT NULL
        OR c.automations_off_at IS NOT NULL OR ${personFinalErrorCondition()} THEN 'final_for_person'
      WHEN a.stopped_reason = 'bad_text' THEN 'text_refused'
      WHEN m.channel = 'private_reply'
        AND (m.trigger_occurred_at IS NULL OR m.trigger_occurred_at + ${privateReplyExpiry} <= now()) THEN 'too_old'
      WHEN m.channel IN ('comment_reply', 'comment_hide')
        AND (m.trigger_occurred_at IS NULL OR m.trigger_occurred_at + ${commentReplyExpiry} <= now()) THEN 'too_old'
      WHEN m.channel = 'direct'
        AND (ca.last_direct_message_received_at IS NULL
             OR ca.last_direct_message_received_at + ${chatWindow} <= now()) THEN 'chat_closed'
      ELSE 'retryable'
    END`;
  }

  /** The `FROM … WHERE` of an owner's failed messages of the last 30 days, with the verdict's joins. */
  private failedMessagesSource(owner: InstagramFailedMessagesOwner): SQL {
    const ownerCondition =
      owner.by === 'automation'
        ? sql`m.automation_id = ${owner.id}`
        : sql`m.contact_id = ${owner.id}`;
    return sql`FROM ${instagram_outgoing_messages} AS m
      LEFT JOIN ${contacts} AS c ON c.organization_id = m.organization_id AND c.id = m.contact_id
      LEFT JOIN ${contact_activities} AS ca
        ON ca.organization_id = m.organization_id AND ca.contact_id = m.contact_id
      LEFT JOIN ${automations} AS a ON a.organization_id = m.organization_id AND a.id = m.automation_id
      WHERE m.organization_id = ${owner.organizationId}
        AND ${ownerCondition}
        AND m.status = 'failed'
        AND m.created_at >= now() - make_interval(days => ${INSTAGRAM_MESSAGE_KEEP_DAYS})`;
  }

  /** The owner's failed messages counted by verdict (route 25 / 36 — changes nothing). */
  async countFailedByVerdict(
    owner: InstagramFailedMessagesOwner,
  ): Promise<Array<{ verdict: InstagramFailedMessageVerdict; count: number }>> {
    const result = await this.db().execute(sql`
      SELECT verdict, count(*)::int AS count
      FROM (SELECT ${this.verdictExpression()} AS verdict ${this.failedMessagesSource(owner)}) AS verdicts
      GROUP BY verdict
    `);
    return rowsOf<{ verdict: InstagramFailedMessageVerdict; count: number }>(result).map((row) => ({
      verdict: row.verdict,
      count: Number(row.count),
    }));
  }

  /**
   * The owner of a retry job by public id (`aut_…` / `con_…`, WC-42): its organization and internal
   * id, or `null` when gone — named inside the job's organization (by its public id), not by RLS
   * alone.
   */
  async findFailedMessagesOwner({
    organizationPublicId,
    by,
    ownerPublicId,
  }: {
    organizationPublicId: string;
    by: 'automation' | 'contact';
    ownerPublicId: string;
  }): Promise<{ organizationId: number; id: number } | null> {
    const table = by === 'automation' ? automations : contacts;
    const [row] = await this.db()
      .select({ organizationId: table.organization_id, id: table.id })
      .from(table)
      .innerJoin(organizations, eq(organizations.id, table.organization_id))
      .where(
        and(eq(organizations.public_id, organizationPublicId), eq(table.public_id, ownerPublicId)),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * One piece of the owner's retry (SN18, plan §33.10 rule 4): up to `limit` retryable failed rows,
   * in contact order, their contacts locked first (`FOR UPDATE` — the lock order), back to `waiting`
   * now with `owner_retry_at` = `retriedAt` and no try used. A message whose automation and person
   * hold another run's open key (rule 2's last line) is left `failed` and unmarked — a later press,
   * once that run ended, retries it. Answers how many, the accounts touched and the runs of the
   * retried messages (the caller reopens the ones that ended `failed`).
   */
  async retryFailedPiece({
    owner,
    limit,
    retriedAt,
  }: {
    owner: InstagramFailedMessagesOwner;
    limit: number;
    retriedAt: Date;
  }): Promise<{
    count: number;
    channelAccountIds: number[];
    runs: Array<{ runId: number; runStartedAt: Date }>;
  }> {
    const result = await this.db().execute(sql`
      WITH picked AS (
        SELECT m.id, m.automation_run_started_at, m.contact_id
        ${this.failedMessagesSource(owner)}
          AND ${this.verdictExpression()} = 'retryable'
          AND NOT EXISTS (
            SELECT 1 FROM ${automation_run_open_keys} AS k
            WHERE k.organization_id = m.organization_id
              AND k.automation_id = m.automation_id
              AND k.contact_id = m.contact_id
              AND (k.automation_run_id <> m.automation_run_id
                OR k.automation_run_started_at <> m.automation_run_started_at)
          )
        ORDER BY m.contact_id, m.id
        LIMIT ${limit}
      ), locked AS (
        SELECT c.id FROM ${contacts} AS c
        WHERE c.organization_id = ${owner.organizationId}
          AND c.id IN (SELECT contact_id FROM picked)
        ORDER BY c.id
        FOR UPDATE
      )
      UPDATE ${instagram_outgoing_messages} AS m
      SET status = 'waiting', reason = NULL, tries = 0, owner_retry_at = ${retriedAt},
          not_before = now(), updated_at = now()
      FROM picked
      WHERE m.organization_id = ${owner.organizationId}
        AND m.id = picked.id
        AND m.automation_run_started_at = picked.automation_run_started_at
        AND m.status = 'failed'
        AND m.owner_retry_at IS NULL
        -- The contacts' locks are taken before any row changes (the scalar read runs the CTE once).
        AND (SELECT count(*) FROM locked) >= 0
      RETURNING m.channel_account_id, m.automation_run_id, m.automation_run_started_at
    `);
    const rows = rowsOf<{
      channel_account_id: number;
      automation_run_id: number | null;
      automation_run_started_at: Date | string;
    }>(result);
    const runs = new Map<string, { runId: number; runStartedAt: Date }>();
    for (const row of rows) {
      if (row.automation_run_id === null) continue;
      const runStartedAt = new Date(row.automation_run_started_at);
      runs.set(`${String(row.automation_run_id)}:${runStartedAt.toISOString()}`, {
        runId: Number(row.automation_run_id),
        runStartedAt,
      });
    }
    return {
      count: rows.length,
      channelAccountIds: [...new Set(rows.map((row) => Number(row.channel_account_id)))],
      runs: [...runs.values()],
    };
  }

  /**
   * The account's waiting Live private replies whose Live is no longer on air (its media id not in
   * `onAirMediaIds`, or already marked ended) or whose comment is older than `oldestCommentAt` end
   * `expired` · `live_ended` (WC-16, plan helper rule 10) — a guarded update of `waiting` rows only.
   * Answers the expired rows and the media ids of their Lives.
   */
  async expireWaitingLiveReplies({
    organizationId,
    channelAccountId,
    onAirMediaIds,
    oldestCommentAt,
  }: {
    organizationId: number;
    channelAccountId: number;
    /** The Lives Instagram lists as on air; `null` = not read (only the age and stored ends count). */
    onAirMediaIds: readonly string[] | null;
    oldestCommentAt: Date;
  }): Promise<{ rows: InstagramOutgoingMessageRow[]; endedMediaIds: string[] }> {
    let onAir = sql`TRUE`;
    if (onAirMediaIds !== null) {
      onAir =
        onAirMediaIds.length === 0
          ? sql`FALSE`
          : sql`r.trigger_instagram_media_id IN (${sql.join(
              onAirMediaIds.map((mediaId) => sql`${mediaId}`),
              sql`, `,
            )})`;
    }
    const candidates = rowsOf<{
      id: number | string;
      automation_run_started_at: Date | string;
      media_id: string | null;
    }>(
      await this.db().execute(sql`
        SELECT m.id, m.automation_run_started_at, r.trigger_instagram_media_id AS media_id
        FROM ${instagram_outgoing_messages} m
        JOIN ${automation_runs} r
          ON r.organization_id = m.organization_id
         AND r.id = m.automation_run_id
         AND r.started_at = m.automation_run_started_at
        WHERE m.organization_id = ${organizationId}
          AND m.channel_account_id = ${channelAccountId}
          AND m.status = 'waiting'
          AND m.channel = 'private_reply'
          AND r.trigger_type = 'live_comment'
          AND (
            m.trigger_occurred_at < ${oldestCommentAt.toISOString()}::timestamptz
            OR r.trigger_instagram_media_id IS NULL
            OR NOT (${onAir})
            OR EXISTS (
              SELECT 1 FROM ${instagram_media} media
              WHERE media.organization_id = m.organization_id
                AND media.channel_account_id = m.channel_account_id
                AND media.instagram_media_id = r.trigger_instagram_media_id
                AND media.live_ended_at IS NOT NULL)
          )
        FOR UPDATE OF m SKIP LOCKED`),
    );
    if (candidates.length === 0) return { rows: [], endedMediaIds: [] };
    const rows = await this.db()
      .update(instagram_outgoing_messages)
      .set({ status: 'expired', reason: 'live_ended', updated_at: sql`now()` })
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, organizationId),
          eq(instagram_outgoing_messages.status, 'waiting'),
          sql`(${instagram_outgoing_messages.id}, ${instagram_outgoing_messages.automation_run_started_at}) IN (${sql.join(
            candidates.map(
              (candidate) =>
                sql`(${Number(candidate.id)}, ${new Date(candidate.automation_run_started_at).toISOString()}::timestamptz)`,
            ),
            sql`, `,
          )})`,
        ),
      )
      .returning();
    const endedMediaIds = new Set<string>();
    for (const candidate of candidates) {
      if (
        candidate.media_id !== null &&
        onAirMediaIds !== null &&
        !onAirMediaIds.includes(candidate.media_id)
      ) {
        endedMediaIds.add(candidate.media_id);
      }
    }
    return { rows, endedMediaIds: [...endedMediaIds] };
  }

  /**
   * The account's waiting opening DMs counted by the hours left before they expire (0 = due now,
   * else 1 … ), the latest expiry, and the opening DMs made in the last hour — the waiting
   * estimate's one grouped read (WC-24, plan helper rule 17).
   */
  async summarizeWaitingOpeningMessages({
    organizationId,
    channelAccountId,
    now,
  }: {
    organizationId: number;
    channelAccountId: number;
    now: Date;
  }): Promise<{
    waitingByHoursLeft: Map<number, number>;
    lastExpiresAt: Date | null;
    newLastHour: number;
  }> {
    const expiry = sql`make_interval(secs => ${INSTAGRAM_PRIVATE_REPLY_EXPIRY_MILLISECONDS / 1000})`;
    const result = await this.db().execute(sql`
      SELECT greatest(ceil(extract(epoch FROM (m.trigger_occurred_at + ${expiry}
                 - ${now.toISOString()}::timestamptz)) / 3600), 0)::int AS hours_left,
             count(*)::int AS waiting_count,
             max(m.trigger_occurred_at + ${expiry}) AS last_expires_at
      FROM ${instagram_outgoing_messages} m
      WHERE m.organization_id = ${organizationId}
        AND m.channel_account_id = ${channelAccountId}
        AND m.lane = 'slow'
        AND m.status = 'waiting'
        AND m.message_type = 'opening_message'
      GROUP BY 1`);
    const waitingByHoursLeft = new Map<number, number>();
    let lastExpiresAt: Date | null = null;
    for (const row of rowsOf<{
      hours_left: number;
      waiting_count: number;
      last_expires_at: Date | string | null;
    }>(result)) {
      waitingByHoursLeft.set(Number(row.hours_left), Number(row.waiting_count));
      if (row.last_expires_at !== null) {
        const expiresAt = new Date(row.last_expires_at);
        if (lastExpiresAt === null || expiresAt > lastExpiresAt) lastExpiresAt = expiresAt;
      }
    }
    const fresh = await this.db().execute(sql`
      SELECT count(*)::int AS new_count
      FROM ${instagram_outgoing_messages} m
      WHERE m.organization_id = ${organizationId}
        AND m.channel_account_id = ${channelAccountId}
        AND m.lane = 'slow'
        AND m.message_type = 'opening_message'
        AND m.created_at > ${now.toISOString()}::timestamptz - interval '1 hour'`);
    const newLastHour = Number(rowsOf<{ new_count: number }>(fresh)[0]?.new_count ?? 0);
    return { waitingByHoursLeft, lastExpiresAt, newLastHour };
  }

  /**
   * The slow lane's two pick candidates (plan §28.2, WC-5): of each live, unstopped automation of
   * the account its newest waiting opening under `newSince` (a new comment) and its oldest one
   * before it (an old comment), each only once its `not_before` is over and made after the
   * automation's `cancelled_before_at`; then the newest of the new ones and the oldest of the old.
   */
  async listSlowPickCandidates({
    organizationId,
    channelAccountId,
    now,
    newSince,
  }: {
    organizationId: number;
    channelAccountId: number;
    now: Date;
    newSince: Date;
  }): Promise<{
    newest: InstagramOutgoingMessagePickCandidate | null;
    oldest: InstagramOutgoingMessagePickCandidate | null;
  }> {
    const waitingOf = (isNew: boolean) => sql`
      SELECT m.public_id, m.automation_run_started_at, m.automation_id, m.trigger_occurred_at
      FROM ${instagram_outgoing_messages} AS m
      WHERE m.organization_id = ${organizationId}
        AND m.channel_account_id = ${channelAccountId}
        AND m.automation_id = live.id
        AND m.lane = 'slow' AND m.status = 'waiting'
        AND (m.not_before IS NULL OR m.not_before <= ${now.toISOString()}::timestamptz)
        AND (live.cancelled_before_at IS NULL OR m.created_at > live.cancelled_before_at)
        AND ${
          isNew
            ? sql`m.trigger_occurred_at >= ${newSince.toISOString()}::timestamptz`
            : sql`m.trigger_occurred_at < ${newSince.toISOString()}::timestamptz`
        }
      ORDER BY m.trigger_occurred_at ${isNew ? sql`DESC` : sql`ASC`}, m.id
      LIMIT 1`;
    const result = await this.db().execute(sql`
      WITH live AS (
        SELECT a.id, a.cancelled_before_at FROM ${automations} AS a
        WHERE a.organization_id = ${organizationId} AND a.channel_account_id = ${channelAccountId}
          AND a.status = 'live' AND a.deleted_at IS NULL AND a.stopped_reason IS NULL
      ), newest AS (
        SELECT 'new' AS place, picked.* FROM live CROSS JOIN LATERAL (${waitingOf(true)}) AS picked
        ORDER BY picked.trigger_occurred_at DESC LIMIT 1
      ), oldest AS (
        SELECT 'old' AS place, picked.* FROM live CROSS JOIN LATERAL (${waitingOf(false)}) AS picked
        ORDER BY picked.trigger_occurred_at ASC LIMIT 1
      )
      SELECT * FROM newest UNION ALL SELECT * FROM oldest`);
    const rows = result.rows;
    const newest = rows.find((row) => row.place === 'new');
    const oldest = rows.find((row) => row.place === 'old');
    return {
      newest: newest === undefined ? null : candidateOf(newest),
      oldest: oldest === undefined ? null : candidateOf(oldest),
    };
  }

  /**
   * The reply lane's message that goes right away (plan §29.5 rule 2, first part): of the account's
   * live automations, the oldest waiting hide or unpaced public reply ("Reply like a person" OFF, or
   * a plan without it — D57) whose `not_before` is over; a hide only once its run's public reply is
   * no longer waiting or sending (§29.4 rule 2: reply first, then hide).
   */
  async findReplyDueCandidate({
    organizationId,
    channelAccountId,
    now,
    isReplyLikePersonOffered,
  }: {
    organizationId: number;
    channelAccountId: number;
    now: Date;
    /** The plan's `reply_like_person` switch (P83): off → every reply goes unpaced. */
    isReplyLikePersonOffered: boolean;
  }): Promise<InstagramOutgoingMessagePickCandidate | null> {
    const result = await this.db().execute(sql`
      SELECT m.public_id, m.automation_run_started_at, m.automation_id, m.trigger_occurred_at
      FROM ${instagram_outgoing_messages} AS m
      JOIN ${automations} AS a ON a.organization_id = m.organization_id AND a.id = m.automation_id
      WHERE m.organization_id = ${organizationId}
        AND m.channel_account_id = ${channelAccountId}
        AND m.lane = 'reply' AND m.status = 'waiting'
        AND (m.not_before IS NULL OR m.not_before <= ${now.toISOString()}::timestamptz)
        AND a.status = 'live' AND a.deleted_at IS NULL
        AND (a.cancelled_before_at IS NULL OR m.created_at > a.cancelled_before_at)
        AND (
          (m.message_type = 'public_reply'
            AND (NOT a.is_reply_like_person_enabled OR NOT ${isReplyLikePersonOffered}))
          OR (m.message_type = 'hide_comment' AND NOT EXISTS (
            SELECT 1 FROM ${instagram_outgoing_messages} AS r
            WHERE r.organization_id = m.organization_id
              AND r.automation_run_id = m.automation_run_id
              AND r.automation_run_started_at = m.automation_run_started_at
              AND r.message_type = 'public_reply'
              AND r.status IN ('waiting', 'sending')))
        )
      ORDER BY m.not_before NULLS FIRST, m.id
      LIMIT 1`);
    const row = result.rows[0];
    return row === undefined ? null : candidateOf(row);
  }

  /**
   * Each "Reply like a person" automation's newest waiting public reply (plan §29.5 rule 2, second
   * part), with its hour limit and reply state's box: live automations of the account with the
   * switch on — only called while the plan offers it.
   */
  async listReplyPacedCandidates({
    organizationId,
    channelAccountId,
    now,
  }: {
    organizationId: number;
    channelAccountId: number;
    now: Date;
  }): Promise<InstagramReplyPacedCandidate[]> {
    const result = await this.db().execute(sql`
      SELECT picked.*, a.public_reply_hour_limit, s.box_start
      FROM ${automations} AS a
      LEFT JOIN ${automation_reply_states} AS s
        ON s.organization_id = a.organization_id AND s.automation_id = a.id
      CROSS JOIN LATERAL (
        SELECT m.public_id, m.automation_run_started_at, m.automation_id, m.trigger_occurred_at
        FROM ${instagram_outgoing_messages} AS m
        WHERE m.organization_id = ${organizationId}
          AND m.channel_account_id = ${channelAccountId}
          AND m.automation_id = a.id
          AND m.lane = 'reply' AND m.status = 'waiting' AND m.message_type = 'public_reply'
          AND (m.not_before IS NULL OR m.not_before <= ${now.toISOString()}::timestamptz)
          AND (a.cancelled_before_at IS NULL OR m.created_at > a.cancelled_before_at)
        ORDER BY m.trigger_occurred_at DESC, m.id DESC
        LIMIT 1
      ) AS picked
      WHERE a.organization_id = ${organizationId} AND a.channel_account_id = ${channelAccountId}
        AND a.status = 'live' AND a.deleted_at IS NULL AND a.is_reply_like_person_enabled`);
    return result.rows.map((row) => ({
      ...candidateOf(row),
      publicReplyHourLimit:
        row.public_reply_hour_limit === null ? null : Number(row.public_reply_hour_limit),
      boxStart: row.box_start === null ? null : new Date(row.box_start as string),
    }));
  }

  /**
   * The broadcast lane's pick candidates (plan §30.14 step 6, WC-8): the account's waiting broadcast
   * messages whose `not_before` is over, her chat window closing soonest first (her oldest
   * `last_direct_message_received_at`), across its broadcasts — at most `limit`, with each one's
   * broadcast status for the check again.
   */
  async listBroadcastPickCandidates({
    organizationId,
    channelAccountId,
    now,
    limit,
  }: {
    organizationId: number;
    channelAccountId: number;
    now: Date;
    limit: number;
  }): Promise<InstagramBroadcastPickCandidate[]> {
    const result = await this.db().execute(sql`
      SELECT m.public_id, m.automation_run_started_at, m.contact_id, m.message_number,
             b.status AS broadcast_status
      FROM ${instagram_outgoing_messages} AS m
      JOIN ${broadcasts} AS b ON b.organization_id = m.organization_id AND b.id = m.broadcast_id
      LEFT JOIN ${contact_activities} AS ca
        ON ca.organization_id = m.organization_id AND ca.contact_id = m.contact_id
      WHERE m.organization_id = ${organizationId}
        AND m.channel_account_id = ${channelAccountId}
        AND m.lane = 'broadcast' AND m.status = 'waiting'
        AND (m.not_before IS NULL OR m.not_before <= ${now.toISOString()}::timestamptz)
      ORDER BY ca.last_direct_message_received_at ASC NULLS FIRST, m.id
      LIMIT ${limit}`);
    return result.rows.map((row) => ({
      publicId: String(row.public_id),
      automationRunStartedAt: new Date(String(row.automation_run_started_at)),
      contactId: Number(row.contact_id),
      messageNumber: Number(row.message_number ?? 1),
      broadcastStatus: String(row.broadcast_status),
    }));
  }

  /**
   * The earliest future `not_before` of the account's waiting rows of a lane (plan §28.5 rule 1:
   * the lane sleeps until then), or `null` when nothing waits for a time.
   */
  async findEarliestWaitingNotBefore({
    organizationId,
    channelAccountId,
    lane,
    now,
  }: {
    organizationId: number;
    channelAccountId: number;
    lane: InstagramSendLane;
    now: Date;
  }): Promise<Date | null> {
    const [row] = await this.db()
      .select({ at: sql<string | null>`min(${instagram_outgoing_messages.not_before})` })
      .from(instagram_outgoing_messages)
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, organizationId),
          eq(instagram_outgoing_messages.channel_account_id, channelAccountId),
          eq(instagram_outgoing_messages.lane, lane),
          eq(instagram_outgoing_messages.status, 'waiting'),
          sql`${instagram_outgoing_messages.not_before} > ${now.toISOString()}::timestamptz`,
        ),
      );
    return row?.at === null || row?.at === undefined ? null : new Date(row.at);
  }

  /** Puts a waiting row's `not_before` later (the 24-hour person rule, plan §28.2 rule 4). */
  async delayWaiting({
    key,
    notBefore,
  }: {
    key: InstagramOutgoingMessageKey;
    notBefore: Date;
  }): Promise<boolean> {
    const moved = await this.db()
      .update(instagram_outgoing_messages)
      .set({ not_before: notBefore, updated_at: sql`now()` })
      .where(and(this.whereKey(key), eq(instagram_outgoing_messages.status, 'waiting')))
      .returning({ id: instagram_outgoing_messages.id });
    return moved.length > 0;
  }

  /**
   * Ends one waiting row (a lane pick's check again, plan §28.1 step 7; a repair duty's end, WC-15,
   * WC-17, WC-18): `skipped`, `expired` or `cancelled` with its reason, only while it waits. Answers
   * the ended row, or `null` when it is not `waiting` any more (a repeat does nothing).
   */
  async endWaitingByKey({
    key,
    status,
    reason,
  }: {
    key: InstagramOutgoingMessageKey;
    status: 'skipped' | 'expired' | 'cancelled';
    reason: InstagramOutgoingMessageReason;
  }): Promise<InstagramOutgoingMessageRow | null> {
    const [row] = await this.db()
      .update(instagram_outgoing_messages)
      .set({ status, reason, updated_at: sql`now()` })
      .where(and(this.whereKey(key), eq(instagram_outgoing_messages.status, 'waiting')))
      .returning();
    return row ?? null;
  }

  /**
   * Today's "chat closed" skips of the account per automation (route 63's per-automation lines,
   * SN14): messages `skipped` · `window_closed` since the start of the organization's day, with the
   * automation's public id, most first.
   */
  async countWindowClosedTodayByAutomation({
    organizationId,
    channelAccountId,
  }: {
    organizationId: number;
    channelAccountId: number;
  }): Promise<Array<{ automationPublicId: string; count: number }>> {
    const result = await this.db().execute(sql`
      WITH day_start AS (
        SELECT (date_trunc('day', now() AT TIME ZONE o.timezone)) AT TIME ZONE o.timezone AS at
        FROM ${organizations} AS o WHERE o.id = ${organizationId}
      )
      SELECT a.public_id AS automation_public_id, count(*)::int AS count
      FROM ${instagram_outgoing_messages} AS m
      JOIN ${automations} AS a ON a.organization_id = m.organization_id AND a.id = m.automation_id
      CROSS JOIN day_start
      WHERE m.organization_id = ${organizationId}
        AND m.channel_account_id = ${channelAccountId}
        AND m.status = 'skipped' AND m.reason = 'window_closed'
        AND m.updated_at >= day_start.at
      GROUP BY a.public_id
      ORDER BY count(*) DESC, a.public_id`);
    return result.rows.map((row) => ({
      automationPublicId: String(row.automation_public_id),
      count: Number(row.count),
    }));
  }
}

/** {@link InstagramOutgoingMessageRepository} bound to a job's organization handle — the run engine, the lanes. */
export function createWorkerInstagramOutgoingMessageRepository(
  databaseHandle: WorkerDatabaseHandle,
): InstagramOutgoingMessageRepository {
  assertWorkerDatabaseContext(['organization']);
  return new InstagramOutgoingMessageRepository(databaseHandle);
}
