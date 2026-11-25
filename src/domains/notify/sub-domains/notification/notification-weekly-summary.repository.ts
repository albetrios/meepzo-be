import { sql } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';

/** One team organization whose summary hour it is: its public id and its Monday, `YYYY-MM-DD`. */
export interface WeeklySummaryDueOrganization {
  organizationPublicId: string;
  weekStart: string;
}

/**
 * The weekly summary's one cross-organization read (feat-instagram-dm-sending UN12, UNC9): the live
 * team organizations where it is now the summary's weekday and hour in their own time zone.
 *
 * @remarks
 * - **Algorithm:** one statement over `tenancy.organizations` — `type = 'TEAM'`, `status = 'ACTIVE'`,
 *   not deleted, `extract(isodow / hour FROM at AT TIME ZONE timezone)` against the given weekday
 *   and hour; the Monday is the local date at `at`.
 * - **Failure modes:** none of its own.
 * - **Side effects:** none — a read.
 * - **Notes:** a full read of the organizations table every hour (about 1,000 at target — plan:L8192
 *   "a few hundred reads an hour"); runs under the retention sweep arm, the organizations policy's
 *   cross-tenant `USING` arm (read only).
 */
export class NotificationWeeklySummaryRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** The organizations whose `weekday` (ISO, 1 = Monday) and `hour` it is at `at`, locally. */
  async listOrganizationsDueForWeeklySummary({
    at,
    weekday,
    hour,
  }: {
    at: Date;
    weekday: number;
    hour: number;
  }): Promise<WeeklySummaryDueOrganization[]> {
    const local = sql`(${at.toISOString()}::timestamptz AT TIME ZONE ${organizations.timezone})`;
    const result = await this.db().execute(sql`
      SELECT ${organizations.public_id} AS organization_public_id,
             (${local})::date::text AS week_start
      FROM ${organizations}
      WHERE ${organizations.type} = 'TEAM'
        AND ${organizations.status} = 'ACTIVE'
        AND ${organizations.deleted_at} IS NULL
        AND extract(isodow FROM ${local}) = ${weekday}
        AND extract(hour FROM ${local}) = ${hour}
      ORDER BY ${organizations.id}
    `);
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as { organization_public_id: string; week_start: string }[];
    return rows.map((row) => ({
      organizationPublicId: row.organization_public_id,
      weekStart: row.week_start,
    }));
  }
}

/**
 * The weekly-summary repository inside the retention sweep arm (`runGlobalRetentionWorkerJob`).
 *
 * @remarks
 * Asserts the worker context kind, as the other retention repositories do.
 */
export function createRetentionNotificationWeeklySummaryRepository(
  databaseHandle: WorkerDatabaseHandle,
): NotificationWeeklySummaryRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new NotificationWeeklySummaryRepository(databaseHandle);
}
