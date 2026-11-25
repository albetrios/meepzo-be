import { and, asc, eq, gt, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type BatchDeleteResult,
  deleteInBatchesByCondition,
  readOldestOverdueSeconds,
} from '@/infrastructure/database/utils/batch-delete.util.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { contact_activities } from '@/domains/app/sub-domains/contact/contact-activity.schema.js';
import { CONTACT_CHAT_WINDOW_MS } from '@/domains/app/sub-domains/contact/contact.constants.js';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import { automation_run_open_keys } from '@/domains/app/sub-domains/automation/automation-run/automation-run-open-key.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import {
  buildSegmentAudienceCondition,
  type SegmentAutomationIds,
} from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.repository.js';
import type { SegmentConditions } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import type { BroadcastRecipientStatus } from './broadcast-recipient.constants.js';
import { broadcast_recipients } from './broadcast-recipient.schema.js';

/** One `app.broadcast_recipients` row as Drizzle reads it. */
export type BroadcastRecipientRow = typeof broadcast_recipients.$inferSelect;

/** What the recipients read of their broadcast: its account, channel, status, audience copy and messages. */
export type BroadcastRecipientParentRow = Pick<
  typeof broadcasts.$inferSelect,
  | 'id'
  | 'public_id'
  | 'organization_id'
  | 'channel_account_id'
  | 'channel'
  | 'status'
  | 'conditions'
  | 'messages'
>;

/** The broadcast's numbers a recipient move adds to (BC8 — moved in the result's commit). */
export interface BroadcastNumbersChange {
  matched?: number;
  sent?: number;
  skipped?: number;
  failed?: number;
  replies?: number;
  taps?: number;
}

/** The columns {@link BroadcastRecipientParentRow} reads. */
const PARENT_COLUMNS = {
  id: broadcasts.id,
  public_id: broadcasts.public_id,
  organization_id: broadcasts.organization_id,
  channel_account_id: broadcasts.channel_account_id,
  channel: broadcasts.channel,
  status: broadcasts.status,
  conditions: broadcasts.conditions,
  messages: broadcasts.messages,
};

/** A recipient's once-per-person key in SQL. */
function recipientKey({
  organizationId,
  broadcastId,
  contactId,
}: {
  organizationId: number;
  broadcastId: number;
  contactId: number;
}): SQL | undefined {
  return and(
    eq(broadcast_recipients.organization_id, organizationId),
    eq(broadcast_recipients.broadcast_id, broadcastId),
    eq(broadcast_recipients.contact_id, contactId),
  );
}

/**
 * Drizzle access to `app.broadcast_recipients` (feat-instagram-dm-sending routes-final § 7.C — BC16,
 * BC17): the audience piece's read of the account's contacts, the once-per-person insert, each status
 * move as one guarded `UPDATE`, and the broadcast's numbers moved in the same commit.
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id` (tenant isolation does not rest on RLS
 *   alone); the status moves are `UPDATE … WHERE status = <from>`, so a repeat changes nothing. The
 *   audience piece reads 500 contacts by id after a cursor over BC13's audience expression
 *   (`buildSegmentAudienceCondition`) plus "her chat is open now" (24 hours less 15 minutes).
 * - **Failure modes:** none of its own; database errors roll the caller's commit back.
 * - **Side effects:** writes `app.broadcast_recipients` and the parent's numbers on
 *   `app.broadcasts` (its aggregate child, 7.C BC17); reads `app.contacts` and
 *   `app.contact_activities` (the audience) — join-only uses inside the app domain.
 * - **Notes:** an HTTP path runs inside the caller's `withAppDatabaseContext`; a worker passes its
 *   job's handle.
 */
export class BroadcastRecipientRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** A live broadcast by public id, locked for this commit (the audience piece moves its `matched`). */
  async lockLiveBroadcastByPublicId(publicId: string): Promise<BroadcastRecipientParentRow | null> {
    const [row] = await this.db()
      .select(PARENT_COLUMNS)
      .from(broadcasts)
      .where(and(eq(broadcasts.public_id, publicId), isNull(broadcasts.deleted_at)))
      .for('no key update')
      .limit(1);
    return row ?? null;
  }

  /** A broadcast by its internal id (deleted ones too — a result may still arrive). */
  async findBroadcast({
    organizationId,
    broadcastId,
  }: {
    organizationId: number;
    broadcastId: number;
  }): Promise<BroadcastRecipientParentRow | null> {
    const [row] = await this.db()
      .select(PARENT_COLUMNS)
      .from(broadcasts)
      .where(and(eq(broadcasts.organization_id, organizationId), eq(broadcasts.id, broadcastId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The audience cursor's contact (WC-40): the internal id of the contact the previous piece ended
   * on, named by public id in the chained job (no bigserial in a job, be-workers-events); `null`
   * when there is none (the next piece then starts over — its inserts are once per person).
   */
  async findContactIdByPublicId({
    organizationId,
    contactPublicId,
  }: {
    organizationId: number;
    contactPublicId: string;
  }): Promise<number | null> {
    const [row] = await this.db()
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(eq(contacts.organization_id, organizationId), eq(contacts.public_id, contactPublicId)),
      )
      .limit(1);
    return row?.id ?? null;
  }

  /**
   * The "audience built" mark (7.A.10, WC-40): set once, in the commit of the audience build's last
   * piece, while the broadcast is `sending` — the end duty (WC-29) ends it only after.
   */
  async markAudienceBuilt({
    organizationId,
    broadcastId,
  }: {
    organizationId: number;
    broadcastId: number;
  }): Promise<void> {
    await this.db()
      .update(broadcasts)
      .set({ audience_built_at: sql`now()` })
      .where(
        and(
          eq(broadcasts.organization_id, organizationId),
          eq(broadcasts.id, broadcastId),
          eq(broadcasts.status, 'sending'),
          isNull(broadcasts.audience_built_at),
        ),
      );
  }

  /**
   * Whether she holds an open run of any automation (BC17: a "when her chat opens" row waits until
   * her runs finished) — the open-run keys (AU37).
   */
  async hasOpenRun({
    organizationId,
    contactId,
  }: {
    organizationId: number;
    contactId: number;
  }): Promise<boolean> {
    const [row] = await this.db()
      .select({ contactId: automation_run_open_keys.contact_id })
      .from(automation_run_open_keys)
      .where(
        and(
          eq(automation_run_open_keys.organization_id, organizationId),
          eq(automation_run_open_keys.contact_id, contactId),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * Whether she holds a `waiting` recipient row of any broadcast (plan §27.15 rule 5 — ROUTE row
   * R56): one broadcast at a time, so several "when her chat opens" ones send her only the oldest.
   */
  async hasWaitingRecipient({
    organizationId,
    contactId,
  }: {
    organizationId: number;
    contactId: number;
  }): Promise<boolean> {
    const [row] = await this.db()
      .select({ id: broadcast_recipients.id })
      .from(broadcast_recipients)
      .where(
        and(
          eq(broadcast_recipients.organization_id, organizationId),
          eq(broadcast_recipients.contact_id, contactId),
          eq(broadcast_recipients.status, 'waiting'),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * One piece of a broadcast's audience (WC-40): up to `limit` contacts (id and public id) after
   * `afterContactId`, in id order, that match the copy of its conditions, are not left out (BC13, 7.10) and whose chat
   * is open now.
   */
  async listAudiencePiece({
    organizationId,
    channelAccountId,
    conditions,
    automationIds,
    afterContactId,
    limit,
  }: {
    organizationId: number;
    channelAccountId: number;
    conditions: SegmentConditions;
    automationIds: SegmentAutomationIds;
    afterContactId: number;
    limit: number;
  }): Promise<Array<{ id: number; public_id: string }>> {
    const chatOpenSince = sql`now() - make_interval(secs => ${CONTACT_CHAT_WINDOW_MS / 1000}::double precision)`;
    return this.db()
      .select({ id: contacts.id, public_id: contacts.public_id })
      .from(contacts)
      .innerJoin(
        contact_activities,
        and(
          eq(contact_activities.organization_id, contacts.organization_id),
          eq(contact_activities.contact_id, contacts.id),
        ),
      )
      .where(
        and(
          buildSegmentAudienceCondition({
            organizationId,
            channelAccountId,
            conditions,
            automationIds,
          }),
          gt(contacts.id, afterContactId),
          gte(contact_activities.last_direct_message_received_at, chatOpenSince),
        ),
      )
      .orderBy(asc(contacts.id))
      .limit(limit);
  }

  /**
   * `waiting` rows for the contacts (BC17 — `INSERT … ON CONFLICT DO NOTHING`): answers the rows
   * made; a contact who already has one for this broadcast is left out.
   */
  async insertWaiting({
    organizationId,
    channelAccountId,
    broadcastId,
    contactIds,
  }: {
    organizationId: number;
    channelAccountId: number;
    broadcastId: number;
    contactIds: readonly number[];
  }): Promise<BroadcastRecipientRow[]> {
    if (contactIds.length === 0) return [];
    return this.db()
      .insert(broadcast_recipients)
      .values(
        contactIds.map((contactId) => ({
          organization_id: organizationId,
          channel_account_id: channelAccountId,
          broadcast_id: broadcastId,
          contact_id: contactId,
        })),
      )
      .onConflictDoNothing({
        target: [
          broadcast_recipients.organization_id,
          broadcast_recipients.broadcast_id,
          broadcast_recipients.contact_id,
        ],
      })
      .returning();
  }

  /** Her row of the broadcast, or `null`. */
  async find(key: {
    organizationId: number;
    broadcastId: number;
    contactId: number;
  }): Promise<BroadcastRecipientRow | null> {
    const [row] = await this.db()
      .select()
      .from(broadcast_recipients)
      .where(recipientKey(key))
      .limit(1);
    return row ?? null;
  }

  /**
   * A `waiting` row takes its first message's result (plan §20.10): the status, the reason
   * (`skipped` / `failed` / `unknown`) and `sent_at` with `sent`. Answers the row, or `null` when it
   * no longer waits (a repeat).
   */
  async settleWaiting({
    key,
    status,
    reason,
    at,
  }: {
    key: { organizationId: number; broadcastId: number; contactId: number };
    status: Exclude<BroadcastRecipientStatus, 'waiting'>;
    reason: string | null;
    at: Date;
  }): Promise<BroadcastRecipientRow | null> {
    const [row] = await this.db()
      .update(broadcast_recipients)
      .set({
        status,
        reason: status === 'sent' ? null : reason,
        sent_at: status === 'sent' ? at : null,
        updated_at: sql`greatest(now(), ${broadcast_recipients.created_at})`,
      })
      .where(and(recipientKey(key), eq(broadcast_recipients.status, 'waiting')))
      .returning();
    return row ?? null;
  }

  /**
   * A `skipped` · `owner_chat` row back to `waiting` (BC16, plan §20.10) — the same row. Answers it,
   * or `null` when it is not such a row.
   */
  async reopenOwnerChat(key: {
    organizationId: number;
    broadcastId: number;
    contactId: number;
  }): Promise<BroadcastRecipientRow | null> {
    const [row] = await this.db()
      .update(broadcast_recipients)
      .set({
        status: 'waiting',
        reason: null,
        updated_at: sql`greatest(now(), ${broadcast_recipients.created_at})`,
      })
      .where(
        and(
          recipientKey(key),
          eq(broadcast_recipients.status, 'skipped'),
          eq(broadcast_recipients.reason, 'owner_chat'),
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * Her `waiting` rows of every broadcast `skipped` with the reason (her erasure or pause, plan
   * §20.10). Answers the broadcast id of each row moved.
   */
  async skipWaitingOfContact({
    organizationId,
    contactId,
    reason,
  }: {
    organizationId: number;
    contactId: number;
    reason: string;
  }): Promise<number[]> {
    const rows = await this.db()
      .update(broadcast_recipients)
      .set({
        status: 'skipped',
        reason,
        updated_at: sql`greatest(now(), ${broadcast_recipients.created_at})`,
      })
      .where(
        and(
          eq(broadcast_recipients.organization_id, organizationId),
          eq(broadcast_recipients.contact_id, contactId),
          eq(broadcast_recipients.status, 'waiting'),
        ),
      )
      .returning({ broadcast_id: broadcast_recipients.broadcast_id });
    return rows.map((row) => row.broadcast_id);
  }

  /**
   * Up to `limit` `waiting` rows of one broadcast `skipped` with the reason (a cancel or a move
   * down — the end duty's piece, R47). Answers how many moved.
   */
  async skipWaitingOfBroadcast({
    organizationId,
    broadcastId,
    reason,
    limit,
  }: {
    organizationId: number;
    broadcastId: number;
    reason: string;
    limit: number;
  }): Promise<number> {
    const piece = this.db()
      .select({ id: broadcast_recipients.id })
      .from(broadcast_recipients)
      .where(
        and(
          eq(broadcast_recipients.organization_id, organizationId),
          eq(broadcast_recipients.broadcast_id, broadcastId),
          eq(broadcast_recipients.status, 'waiting'),
        ),
      )
      .orderBy(asc(broadcast_recipients.id))
      .limit(limit);
    const rows = await this.db()
      .update(broadcast_recipients)
      .set({
        status: 'skipped',
        reason,
        updated_at: sql`greatest(now(), ${broadcast_recipients.created_at})`,
      })
      .where(
        and(
          eq(broadcast_recipients.organization_id, organizationId),
          eq(broadcast_recipients.status, 'waiting'),
          inArray(broadcast_recipients.id, piece),
        ),
      )
      .returning({ id: broadcast_recipients.id });
    return rows.length;
  }

  /**
   * Her first message after a broadcast went (BC17): `replied_at` on each of her `sent` rows sent
   * before it that has none yet — set once. Answers the broadcast id of each row set.
   */
  async recordReply({
    organizationId,
    contactId,
    repliedAt,
  }: {
    organizationId: number;
    contactId: number;
    repliedAt: Date;
  }): Promise<number[]> {
    const rows = await this.db()
      .update(broadcast_recipients)
      .set({
        replied_at: repliedAt,
        updated_at: sql`greatest(now(), ${broadcast_recipients.created_at})`,
      })
      .where(
        and(
          eq(broadcast_recipients.organization_id, organizationId),
          eq(broadcast_recipients.contact_id, contactId),
          eq(broadcast_recipients.status, 'sent'),
          isNull(broadcast_recipients.replied_at),
          lte(broadcast_recipients.sent_at, repliedAt),
        ),
      )
      .returning({ broadcast_id: broadcast_recipients.broadcast_id });
    return rows.map((row) => row.broadcast_id);
  }

  /**
   * A tapped broadcast button's broadcast (§ 7.A.10): its id and the public id of the automation
   * its "start automation" button names (`null` when it names none, or that automation is deleted)
   * — `null` when the broadcast is not this organization's or is deleted.
   */
  async findTapTarget({
    organizationId,
    broadcastPublicId,
  }: {
    organizationId: number;
    broadcastPublicId: string;
  }): Promise<{ broadcastId: number; startAutomationPublicId: string | null } | null> {
    const [row] = await this.db()
      .select({
        broadcastId: broadcasts.id,
        startAutomationPublicId: automations.public_id,
      })
      .from(broadcasts)
      .leftJoin(
        automations,
        and(
          eq(automations.organization_id, broadcasts.organization_id),
          eq(automations.id, broadcasts.start_automation_id),
          isNull(automations.deleted_at),
        ),
      )
      .where(
        and(
          eq(broadcasts.organization_id, organizationId),
          eq(broadcasts.public_id, broadcastPublicId),
          isNull(broadcasts.deleted_at),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Adds to a broadcast's numbers (BC8) — in the commit of the move that caused it. */
  async addToBroadcastNumbers({
    organizationId,
    broadcastId,
    change,
  }: {
    organizationId: number;
    broadcastId: number;
    change: BroadcastNumbersChange;
  }): Promise<void> {
    const entries = Object.entries(change).filter(
      ([, value]) => value !== undefined && value !== 0,
    );
    if (entries.length === 0) return;
    const values: Record<string, SQL> = {};
    for (const [field, value] of entries) {
      const column = broadcasts[field as keyof BroadcastNumbersChange];
      values[field] = sql`${column} + ${value}`;
    }
    await this.db()
      .update(broadcasts)
      .set(values)
      .where(and(eq(broadcasts.organization_id, organizationId), eq(broadcasts.id, broadcastId)));
  }

  /**
   * The recipients' clean-up (WC-53, BCC9): deletes recipients made before `cutoff`, at most
   * `maxBatches` batches in this unit of work (`idx_broadcast_recipients_created_at`). Needs the
   * retention context ({@link createRetentionBroadcastRecipientRepository}).
   */
  async deleteCreatedBefore({
    cutoff,
    maxBatches,
  }: {
    cutoff: Date;
    maxBatches: number;
  }): Promise<BatchDeleteResult> {
    return deleteInBatchesByCondition({
      databaseHandle: this.db(),
      table: broadcast_recipients,
      idColumn: broadcast_recipients.id,
      whereCondition: sql`${broadcast_recipients.created_at} < ${cutoff.toISOString()}::timestamptz`,
      maxBatches,
      logContext: 'broadcast-recipient-retention',
      tableLabel: 'app.broadcast_recipients',
    });
  }

  /** Seconds the oldest recipient made before `cutoff` is past it — the clean-up's gauge (P92). */
  async readCreatedOverdueSeconds(cutoff: Date): Promise<number> {
    return readOldestOverdueSeconds({
      databaseHandle: this.db(),
      table: broadcast_recipients,
      column: broadcast_recipients.created_at,
      cutoff,
      whereCondition: sql`${broadcast_recipients.created_at} < ${cutoff.toISOString()}::timestamptz`,
    });
  }
}

/**
 * {@link BroadcastRecipientRepository} bound to a retention handle (`runGlobalRetentionWorkerJob`) — the recipients' 90-day clean-up (WC-53), which only
 * deletes (the policy's sweep arm is in `USING`).
 */
export function createRetentionBroadcastRecipientRepository(
  databaseHandle: WorkerDatabaseHandle,
): BroadcastRecipientRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new BroadcastRecipientRepository(databaseHandle);
}
