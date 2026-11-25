import { and, eq, sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { automation_reply_states } from './automation-reply-state.schema.js';

/** One `app.automation_reply_states` row as Drizzle reads it. */
export type AutomationReplyStateRow = typeof automation_reply_states.$inferSelect;

/** The keys of one automation's reply state. */
export interface AutomationReplyStateKey {
  organizationId: number;
  automationId: number;
}

/**
 * Drizzle access to `app.automation_reply_states` (feat-instagram-dm-sending routes-final § 4.A.3,
 * AU19): one row per automation, made at its first public reply.
 *
 * @remarks
 * - **Algorithm:** the upsert on the unique `(organization_id, automation_id)`; the reply lane's
 *   reads and writes (sub-domain 6, later rows) go through {@link AutomationReplyStateRepository.find}
 *   and {@link AutomationReplyStateRepository.save}; route 30 empties the box.
 * - **Failure modes:** a missing automation or account throws the composite keys' 23503.
 * - **Side effects:** writes `app.automation_reply_states` only.
 */
export class AutomationReplyStateRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** The automation's reply state, locked `FOR UPDATE` when asked; `null` before its first reply. */
  async find({
    organizationId,
    automationId,
    isLocked,
  }: AutomationReplyStateKey & { isLocked: boolean }): Promise<AutomationReplyStateRow | null> {
    const query = this.db()
      .select()
      .from(automation_reply_states)
      .where(
        and(
          eq(automation_reply_states.organization_id, organizationId),
          eq(automation_reply_states.automation_id, automationId),
        ),
      )
      .limit(1);
    const rows = isLocked ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  /** Writes the reply state (made on the first reply). */
  async save({
    organizationId,
    automationId,
    channelAccountId,
    boxStart,
    lastTextNumber,
    waitingCount,
  }: AutomationReplyStateKey & {
    channelAccountId: number;
    boxStart: Date | null;
    lastTextNumber: number | null;
    waitingCount: number;
  }): Promise<void> {
    const values = {
      box_start: boxStart,
      last_text_number: lastTextNumber,
      waiting_count: waitingCount,
    };
    await this.db()
      .insert(automation_reply_states)
      .values({
        organization_id: organizationId,
        automation_id: automationId,
        channel_account_id: channelAccountId,
        ...values,
      })
      .onConflictDoUpdate({
        target: [automation_reply_states.organization_id, automation_reply_states.automation_id],
        set: { ...values, updated_at: sql`now()` },
      });
  }

  /**
   * One more waiting public reply of the automation (plan §19.13 — the result save that makes a
   * public reply row): the row made on the first reply, else `waiting_count + 1`.
   */
  async addWaitingReply({
    organizationId,
    automationId,
    channelAccountId,
  }: AutomationReplyStateKey & { channelAccountId: number }): Promise<void> {
    await this.db()
      .insert(automation_reply_states)
      .values({
        organization_id: organizationId,
        automation_id: automationId,
        channel_account_id: channelAccountId,
        waiting_count: 1,
      })
      .onConflictDoUpdate({
        target: [automation_reply_states.organization_id, automation_reply_states.automation_id],
        set: {
          waiting_count: sql`${automation_reply_states.waiting_count} + 1`,
          updated_at: sql`now()`,
        },
      });
  }

  /**
   * `count` fewer waiting public replies (WC-18, the 500 trim): never below 0. No row is a no-op.
   */
  async subtractWaitingReplies({
    organizationId,
    automationId,
    count,
  }: AutomationReplyStateKey & { count: number }): Promise<void> {
    if (count <= 0) return;
    await this.db()
      .update(automation_reply_states)
      .set({
        waiting_count: sql`greatest(0, ${automation_reply_states.waiting_count} - ${count})`,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(automation_reply_states.organization_id, organizationId),
          eq(automation_reply_states.automation_id, automationId),
        ),
      );
  }

  /** Empties the hour box after a reply-step change (AU12): it starts again. No row is a no-op. */
  async emptyBox({ organizationId, automationId }: AutomationReplyStateKey): Promise<void> {
    await this.db()
      .update(automation_reply_states)
      .set({ box_start: null, last_text_number: null, updated_at: sql`now()` })
      .where(
        and(
          eq(automation_reply_states.organization_id, organizationId),
          eq(automation_reply_states.automation_id, automationId),
        ),
      );
  }
}

/** {@link AutomationReplyStateRepository} bound to a job's organization handle (the reply lane). */
export function createWorkerAutomationReplyStateRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationReplyStateRepository {
  assertWorkerDatabaseContext(['organization']);
  return new AutomationReplyStateRepository(databaseHandle);
}
