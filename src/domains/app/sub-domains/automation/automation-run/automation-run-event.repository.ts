import { and, asc, eq } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { AutomationRunEventType, AutomationRunStatus } from './automation-run.constants.js';
import { automation_run_events } from './automation-run-event.schema.js';
import type { AutomationRunKey } from './automation-run.types.js';

/** One `app.automation_run_events` row as Drizzle reads it. */
export type AutomationRunEventRow = typeof automation_run_events.$inferSelect;

/** One run event to append (AU23): a status change with its new status, or an email / phone received. */
export type AutomationRunEventValues = AutomationRunKey &
  (
    | { eventType: Extract<AutomationRunEventType, 'status_changed'>; status: AutomationRunStatus }
    | { eventType: Exclude<AutomationRunEventType, 'status_changed'>; status?: undefined }
  );

/**
 * Drizzle access to `app.automation_run_events` (routes-final § 3.B.3, AU23): append-only — the
 * run engine and the cancel steps insert one row per status change and per email or phone
 * collected, in the same unit of work as the run change.
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
          event_type: event.eventType,
          status: event.status ?? null,
        })),
      );
  }

  /** A run's history, oldest first. */
  async listForRun({ organizationId, runId }: AutomationRunKey): Promise<AutomationRunEventRow[]> {
    return this.db()
      .select()
      .from(automation_run_events)
      .where(
        and(
          eq(automation_run_events.organization_id, organizationId),
          eq(automation_run_events.automation_run_id, runId),
        ),
      )
      .orderBy(asc(automation_run_events.created_at), asc(automation_run_events.id));
  }
}

/** {@link AutomationRunEventRepository} bound to a job's organization handle — the run engine. */
export function createWorkerAutomationRunEventRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationRunEventRepository {
  assertWorkerDatabaseContext(['organization']);
  return new AutomationRunEventRepository(databaseHandle);
}
