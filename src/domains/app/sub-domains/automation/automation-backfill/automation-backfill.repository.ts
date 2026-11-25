import { and, eq, inArray } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { AUTOMATION_BACKFILL_OPEN_STATUSES } from './automation-backfill.constants.js';
import { automation_backfills } from './automation-backfill.schema.js';

/** One `app.automation_backfills` row as Drizzle reads it. */
export type AutomationBackfillRow = typeof automation_backfills.$inferSelect;

/** The unique index route 38's race loser hits — one queued or reading read per automation. */
export const AUTOMATION_BACKFILL_OPEN_INDEX = 'idx_automation_backfills_open';

/**
 * Drizzle access to `app.automation_backfills` (feat-instagram-dm-sending routes-final § 4.C.3):
 * route 38's insert, route 39's read and the automation's open read; the read job's claims and
 * counters are ROUTE row R41's.
 *
 * @remarks
 * - **Algorithm:** every read is keyed by the organization and the automation (a read of another
 *   automation is never found); the open read is the one `queued` or `reading` row.
 * - **Failure modes:** a second open insert for the automation throws the 23505 of
 *   {@link AUTOMATION_BACKFILL_OPEN_INDEX} — the service maps it to
 *   `409 automation_backfill_in_progress`; a missing automation or account throws the composite
 *   keys' 23503.
 * - **Side effects:** writes `app.automation_backfills` only.
 */
export class AutomationBackfillRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** The automation's `queued` or `reading` read; `null` when none. */
  async findOpenByAutomation({
    organizationId,
    automationId,
  }: {
    organizationId: number;
    automationId: number;
  }): Promise<AutomationBackfillRow | null> {
    const rows = await this.db()
      .select()
      .from(automation_backfills)
      .where(
        and(
          eq(automation_backfills.organization_id, organizationId),
          eq(automation_backfills.automation_id, automationId),
          inArray(automation_backfills.status, [...AUTOMATION_BACKFILL_OPEN_STATUSES]),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The automation's read with this public id; `null` when absent or another automation's. */
  async findByPublicId({
    organizationId,
    automationId,
    automationBackfillPublicId,
  }: {
    organizationId: number;
    automationId: number;
    automationBackfillPublicId: string;
  }): Promise<AutomationBackfillRow | null> {
    const rows = await this.db()
      .select()
      .from(automation_backfills)
      .where(
        and(
          eq(automation_backfills.organization_id, organizationId),
          eq(automation_backfills.automation_id, automationId),
          eq(automation_backfills.public_id, automationBackfillPublicId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Inserts a `queued` read (route 38) and returns it. */
  async insertQueued({
    organizationId,
    channelAccountId,
    automationId,
    days,
    requestedByUserId,
  }: {
    organizationId: number;
    channelAccountId: number;
    automationId: number;
    days: number;
    requestedByUserId: number | null;
  }): Promise<AutomationBackfillRow> {
    const rows = await runInsertWithPublicIdentifierRetry({
      insert: () =>
        this.db()
          .insert(automation_backfills)
          .values({
            public_id: generatePublicId('automationBackfill'),
            organization_id: organizationId,
            channel_account_id: channelAccountId,
            automation_id: automationId,
            days,
            status: 'queued',
            requested_by_user_id: requestedByUserId,
          })
          .returning(),
    });
    const row = rows[0];
    if (row === undefined) {
      throw new Error('automation backfill insert returned no row');
    }
    return row;
  }
}
