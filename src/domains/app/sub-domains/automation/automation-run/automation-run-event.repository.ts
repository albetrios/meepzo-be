import { and, asc, eq, sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { AutomationRunEventType, AutomationRunStatus } from './automation-run.constants.js';
import { automation_run_events } from './automation-run-event.schema.js';
import type { AutomationRunKey } from './automation-run.types.js';
import { automation_runs } from './automation-run.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';

/** One run event of a contact's "what happened" (routes-final § 3.A CT14, route 24). */
export interface AutomationContactRunEventRow {
  id: number;
  cursor_created_at: string;
  event_type: string;
  status: string | null;
  automation_public_id: string;
  automation_name: string;
  automation_run_public_id: string;
}

/** One `app.automation_run_events` row as Drizzle reads it. */
export type AutomationRunEventRow = typeof automation_run_events.$inferSelect;

/** One run event to append (AU27): a status change with its new status, or an answer or a tap. */
export type AutomationRunEventValues = AutomationRunKey &
  (
    | { eventType: Extract<AutomationRunEventType, 'status_changed'>; status: AutomationRunStatus }
    | { eventType: Exclude<AutomationRunEventType, 'status_changed'>; status?: undefined }
  );

/**
 * Drizzle access to `app.automation_run_events` (routes-final § 4.B.3, AU27): append-only — the
 * run engine and the cancel steps insert one row per status change, email or phone collected and
 * hello or follow tap, in the same unit of work as the run change; each row carries its run's start
 * (the month split key, AU36).
 *
 * @remarks
 * - **Algorithm:** inserts only (no update, no delete — the run's cascade removes them); every row
 *   names `organization_id`.
 * - **Failure modes:** a run of another organization breaks the composite reference (23503).
 * - **Side effects:** writes `app.automation_run_events` only.
 * - **Notes:** the engine binds a job handle ({@link createWorkerAutomationRunEventRepository}).
 */
export class AutomationRunEventRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Appends run events in one insert; nothing to append is a no-op. */
  async insertMany(events: readonly AutomationRunEventValues[]): Promise<void> {
    if (events.length === 0) return;
    await this.db()
      .insert(automation_run_events)
      .values(
        events.map((event) => ({
          organization_id: event.organizationId,
          automation_run_id: event.runId,
          automation_run_started_at: event.runStartedAt,
          event_type: event.eventType,
          status: event.status ?? null,
        })),
      );
  }

  /**
   * Her runs' history, newest first, after the keyset `(created_at, 'run_event', id)` (CT14, route 24)
   * — over her runs (`idx_automation_runs_contact`), each event with its automation and run ids.
   */
  async listForContact({
    organizationId,
    contactId,
    after,
    limit,
  }: {
    organizationId: number;
    contactId: number;
    after: { occurredAt: string; source: 'message' | 'run_event'; id: number } | null;
    limit: number;
  }): Promise<AutomationContactRunEventRow[]> {
    const cursorCondition =
      after === null
        ? sql`TRUE`
        : after.source === 'message'
          ? // 'message' sorts below 'run_event' at one time: this time's events are already shown.
            sql`e.created_at < ${after.occurredAt}::timestamptz`
          : sql`(e.created_at < ${after.occurredAt}::timestamptz
                 OR (e.created_at = ${after.occurredAt}::timestamptz AND e.id < ${after.id}))`;
    const result = await this.db().execute(sql`
      SELECT e.id,
             to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
             e.event_type, e.status,
             a.public_id AS automation_public_id, a.name AS automation_name,
             r.public_id AS automation_run_public_id
      FROM ${automation_runs} AS r
      JOIN ${automation_run_events} AS e
        ON e.organization_id = r.organization_id AND e.automation_run_id = r.id
       AND e.automation_run_started_at = r.started_at
      JOIN ${automations} AS a ON a.organization_id = r.organization_id AND a.id = r.automation_id
      WHERE r.organization_id = ${organizationId}
        AND r.contact_id = ${contactId}
        AND ${cursorCondition}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ${limit}
    `);
    return rowsOf<AutomationContactRunEventRow>(result).map((row) => ({
      ...row,
      id: Number(row.id),
    }));
  }

  /** A run's history, oldest first. */
  async listForRun({
    organizationId,
    runId,
    runStartedAt,
  }: AutomationRunKey): Promise<AutomationRunEventRow[]> {
    return this.db()
      .select()
      .from(automation_run_events)
      .where(
        and(
          eq(automation_run_events.organization_id, organizationId),
          eq(automation_run_events.automation_run_id, runId),
          eq(automation_run_events.automation_run_started_at, runStartedAt),
        ),
      )
      .orderBy(asc(automation_run_events.created_at), asc(automation_run_events.id));
  }
}

/** The rows of a raw `execute` — postgres-js answers an array, node-postgres `{ rows }`. */
function rowsOf<Row>(result: unknown): Row[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Row[];
}

/** {@link AutomationRunEventRepository} bound to a job's organization handle — the run engine. */
export function createWorkerAutomationRunEventRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationRunEventRepository {
  assertWorkerDatabaseContext(['organization']);
  return new AutomationRunEventRepository(databaseHandle);
}
