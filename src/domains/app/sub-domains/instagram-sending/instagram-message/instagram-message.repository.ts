import { type SQL, and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
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
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import { contact_activities } from '@/domains/app/sub-domains/contact/contact-activity.schema.js';
import { CONTACT_CHAT_WINDOW_MS } from '@/domains/app/sub-domains/contact/contact.constants.js';
import type { InstagramSendLane } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import {
  INSTAGRAM_COMMENT_REPLY_EXPIRY_MILLISECONDS,
  INSTAGRAM_MESSAGE_KEEP_DAYS,
  INSTAGRAM_PERSON_FINAL_ERRORS,
  INSTAGRAM_PRIVATE_REPLY_EXPIRY_MILLISECONDS,
  type InstagramMessageChannel,
  type InstagramMessageFinalStatus,
  type InstagramMessageNotRetryableReason,
  type InstagramMessageReason,
  type InstagramMessageType,
} from './instagram-message.constants.js';
import { instagram_messages } from './instagram-message.schema.js';

/** One `app.instagram_messages` row as Drizzle reads it. */
export type InstagramMessageRow = typeof instagram_messages.$inferSelect;

/** A message's key: its public id and its split key (tickets carry both, SN17). */
export interface InstagramMessageKey {
  organizationId: number;
  publicId: string;
  automationRunStartedAt: Date;
}

/** One waiting row to write (SN22): the lane, channel and count decided by the service. */
export interface InstagramMessageWaitingValues {
  organizationId: number;
  channelAccountId: number;
  automationId: number | null;
  automationRunId: number | null;
  broadcastId: number | null;
  automationRunStartedAt: Date;
  contactId: number;
  messageType: InstagramMessageType;
  messageNumber: number | null;
  messageKind: string;
  versionNumber: number | null;
  wordingNumber: number | null;
  lane: InstagramSendLane;
  channel: InstagramMessageChannel | null;
  isCountedAsDirectMessage: boolean;
  notBefore: Date;
  triggerOccurredAt: Date | null;
}

/** A row's run place (plan §19.1 `uq_instagram_messages_run_type`). */
export interface InstagramMessageRunPlace {
  organizationId: number;
  automationRunId: number;
  automationRunStartedAt: Date;
  messageType: InstagramMessageType;
  messageNumber: number | null;
  messageKind: string;
}

/** Which waiting rows a cancel or skip ends (AU35's selection, by internal id). */
export interface InstagramMessageWaitingSelection {
  organizationId: number;
  by: 'run' | 'automation' | 'contact' | 'broadcast';
  id: number;
}

/** A failed message's verdict now: one of the blocks, or `retryable` (SN18). */
export type InstagramFailedMessageVerdict = InstagramMessageNotRetryableReason | 'retryable';

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
  run: instagram_messages.automation_run_id,
  automation: instagram_messages.automation_id,
  contact: instagram_messages.contact_id,
  broadcast: instagram_messages.broadcast_id,
} satisfies Record<InstagramMessageWaitingSelection['by'], unknown>;

/** The selection's column of a cancel or skip. */
function selectionCondition({ organizationId, by, id }: InstagramMessageWaitingSelection): SQL {
  const column = SELECTION_COLUMNS[by];
  return and(eq(instagram_messages.organization_id, organizationId), eq(column, id)) as SQL;
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

/**
 * Drizzle access to `app.instagram_messages` (feat-instagram-dm-sending routes-final § 6.B.3, SN16):
 * the waiting rows the run engine and broadcasts write through the sending port, the guarded moves
 * of waiting rows (cancel, skip, lane move, the owner's retry), the claim and the result save, and
 * the reads of route 24, routes 25–26 / 36–37, route 63 and the webhook's own-echo lookup.
 *
 * @remarks
 * - **Algorithm:** every writer other than the result save touches `waiting` rows only (a guarded
 *   update — 6.B.10); every query names `organization_id` (and, for a single row, the split key, so
 *   it reads one part).
 * - **Failure modes:** the table's CHECKs refuse an impossible row (23514); a second row for one
 *   run place breaks `idx_instagram_messages_run_type` (23505).
 * - **Side effects:** writes `app.instagram_messages` only; reads the run, the automation, the contact
 *   and her activity for joins (same bounded context).
 */
export class InstagramMessageRepository {
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
  async lockRunPlace(place: InstagramMessageRunPlace): Promise<InstagramMessageRow | null> {
    const [row] = await this.db()
      .select()
      .from(instagram_messages)
      .where(
        and(
          eq(instagram_messages.organization_id, place.organizationId),
          eq(instagram_messages.automation_run_id, place.automationRunId),
          eq(instagram_messages.automation_run_started_at, place.automationRunStartedAt),
          eq(instagram_messages.message_type, place.messageType),
          place.messageNumber === null
            ? sql`${instagram_messages.message_number} IS NULL`
            : eq(instagram_messages.message_number, place.messageNumber),
          eq(instagram_messages.message_kind, place.messageKind),
        ),
      )
      .limit(1)
      .for('update');
    return row ?? null;
  }

  /** Writes one `waiting` row; answers it. */
  async insertWaiting(values: InstagramMessageWaitingValues): Promise<InstagramMessageRow> {
    const [row] = await this.db()
      .insert(instagram_messages)
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
    row: InstagramMessageRow;
    values: Pick<
      InstagramMessageWaitingValues,
      'lane' | 'channel' | 'notBefore' | 'versionNumber' | 'wordingNumber'
    >;
    isAskedAgain: boolean;
  }): Promise<InstagramMessageRow | null> {
    const [updated] = await this.db()
      .update(instagram_messages)
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
        asks: isAskedAgain ? sql`${instagram_messages.asks} + 1` : instagram_messages.asks,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(instagram_messages.organization_id, row.organization_id),
          eq(instagram_messages.id, row.id),
          eq(instagram_messages.automation_run_started_at, row.automation_run_started_at),
          inArray(instagram_messages.status, ['sent', 'unknown']),
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
    selection: InstagramMessageWaitingSelection;
    status: 'cancelled' | 'skipped' | 'expired';
    reason: InstagramMessageReason;
  }): Promise<number> {
    const ended = await this.db()
      .update(instagram_messages)
      .set({ status, reason, updated_at: sql`now()` })
      .where(and(selectionCondition(selection), eq(instagram_messages.status, 'waiting')))
      .returning({ id: instagram_messages.id });
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
    key: InstagramMessageKey;
    lane: InstagramSendLane;
    channel: InstagramMessageChannel;
  }): Promise<boolean> {
    const moved = await this.db()
      .update(instagram_messages)
      .set({ lane, channel, updated_at: sql`now()` })
      .where(
        and(
          eq(instagram_messages.organization_id, key.organizationId),
          eq(instagram_messages.public_id, key.publicId),
          eq(instagram_messages.automation_run_started_at, key.automationRunStartedAt),
          eq(instagram_messages.status, 'waiting'),
        ),
      )
      .returning({ id: instagram_messages.id });
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
    key: InstagramMessageKey;
    lane: InstagramSendLane;
    channel: InstagramMessageChannel | null;
  }): Promise<InstagramMessageRow | null> {
    const [row] = await this.db()
      .update(instagram_messages)
      .set({ status: 'sending', sending_at: sql`now()`, updated_at: sql`now()` })
      .where(
        and(
          eq(instagram_messages.organization_id, key.organizationId),
          eq(instagram_messages.public_id, key.publicId),
          eq(instagram_messages.automation_run_started_at, key.automationRunStartedAt),
          eq(instagram_messages.status, 'waiting'),
          eq(instagram_messages.lane, lane),
          channel === null
            ? sql`${instagram_messages.channel} IS NULL`
            : eq(instagram_messages.channel, channel),
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
    key: InstagramMessageKey;
    status: InstagramMessageFinalStatus;
    reason: InstagramMessageReason | null;
    instagramMessageId: string | null;
    errorCode: number | null;
    errorSubcode: number | null;
  }): Promise<InstagramMessageRow | null> {
    const [row] = await this.db()
      .update(instagram_messages)
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
          eq(instagram_messages.organization_id, key.organizationId),
          eq(instagram_messages.public_id, key.publicId),
          eq(instagram_messages.automation_run_started_at, key.automationRunStartedAt),
          eq(instagram_messages.status, 'sending'),
        ),
      )
      .returning();
    return row ?? null;
  }

  /** One message by its key, or `null`. */
  async findByKey(key: InstagramMessageKey): Promise<InstagramMessageRow | null> {
    const [row] = await this.db()
      .select()
      .from(instagram_messages)
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
    key: InstagramMessageKey;
    isTryUsed: boolean;
    notBefore: Date;
    errorCode: number | null;
    errorSubcode: number | null;
  }): Promise<InstagramMessageRow | null> {
    const [row] = await this.db()
      .update(instagram_messages)
      .set({
        status: 'waiting',
        reason: null,
        sending_at: null,
        not_before: notBefore,
        tries: isTryUsed ? sql`${instagram_messages.tries} + 1` : instagram_messages.tries,
        error_code: errorCode,
        error_subcode: errorSubcode,
        updated_at: sql`now()`,
      })
      .where(and(this.whereKey(key), eq(instagram_messages.status, 'sending')))
      .returning();
    return row ?? null;
  }

  /** Her messages sent in the last hour (the person limit, SN3 — `idx_instagram_messages_person_sent`). */
  async countSentToContactInLastHour({
    organizationId,
    contactId,
  }: {
    organizationId: number;
    contactId: number;
  }): Promise<number> {
    const rows = await this.db()
      .select({ total: sql<number>`count(*)::int` })
      .from(instagram_messages)
      .where(
        and(
          eq(instagram_messages.organization_id, organizationId),
          eq(instagram_messages.contact_id, contactId),
          eq(instagram_messages.status, 'sent'),
          sql`${instagram_messages.sent_at} > now() - interval '1 hour'`,
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  /** The `WHERE` of one message by key. */
  private whereKey(key: InstagramMessageKey): SQL | undefined {
    return and(
      eq(instagram_messages.organization_id, key.organizationId),
      eq(instagram_messages.public_id, key.publicId),
      eq(instagram_messages.automation_run_started_at, key.automationRunStartedAt),
    );
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
      .select({ instagram_message_id: instagram_messages.instagram_message_id })
      .from(instagram_messages)
      .where(
        and(
          eq(instagram_messages.organization_id, organizationId),
          eq(instagram_messages.channel_account_id, channelAccountId),
          isNotNull(instagram_messages.instagram_message_id),
          inArray(instagram_messages.instagram_message_id, [...messageIds]),
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
      .select({ lane: instagram_messages.lane, count: sql<number>`count(*)::int` })
      .from(instagram_messages)
      .where(
        and(
          eq(instagram_messages.organization_id, organizationId),
          eq(instagram_messages.channel_account_id, channelAccountId),
          eq(instagram_messages.status, 'waiting'),
        ),
      )
      .groupBy(instagram_messages.lane);
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
        FROM ${instagram_messages} AS m
        WHERE m.organization_id = ${organizationId}
          AND m.channel_account_id = ${channelAccountId}
          AND m.owner_retry_at IS NOT NULL
      ), pressed AS (
        SELECT m.automation_id, m.contact_id
        FROM ${instagram_messages} AS m, last_press
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
             (SELECT count(*)::int FROM ${instagram_messages} AS f
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
      FROM ${instagram_messages} AS m
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
    return sql`FROM ${instagram_messages} AS m
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
      UPDATE ${instagram_messages} AS m
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
}

/** {@link InstagramMessageRepository} bound to a job's organization handle — the run engine, the lanes. */
export function createWorkerInstagramMessageRepository(
  databaseHandle: WorkerDatabaseHandle,
): InstagramMessageRepository {
  assertWorkerDatabaseContext(['organization']);
  return new InstagramMessageRepository(databaseHandle);
}
