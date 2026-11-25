import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { automation_runs } from './automation-run.schema.js';
import { automation_run_open_keys } from './automation-run-open-key.schema.js';

/** One `app.automation_run_open_keys` row as Drizzle reads it. */
export type AutomationRunOpenKeyRow = typeof automation_run_open_keys.$inferSelect;

/** The open run of one automation and person (AU37). */
export interface AutomationRunOpenKeyValues {
  organizationId: number;
  automationId: number;
  contactId: number;
  runId: number;
  runStartedAt: Date;
}

/** One run whose key a commit ends: its id and start month. */
export interface AutomationRunOpenKeyRun {
  id: number;
  started_at: Date;
}

/**
 * Drizzle access to `app.automation_run_open_keys` (routes-final § 4.B.3, AU37, P100): the key a
 * run's start inserts in its commit, the delete in the commit that ends it, and the repair duty's
 * removal of keys whose run has ended (WC-67).
 *
 * @remarks
 * - **Algorithm:** {@link insert} is `INSERT … ON CONFLICT DO NOTHING` on the primary key
 *   `(organization_id, automation_id, contact_id)` — `false` when another open run holds the key, the
 *   database's guarantee of one open run per automation and person. Every other statement names
 *   `organization_id`, except the repair's cross-organization delete (retention handle).
 * - **Failure modes:** a run of another organization breaks the composite reference (23503).
 * - **Side effects:** writes `app.automation_run_open_keys` only.
 */
export class AutomationRunOpenKeyRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Inserts the key of a new open run; `false` when the automation and person already hold one. */
  async insert(values: AutomationRunOpenKeyValues): Promise<boolean> {
    const rows = await this.db()
      .insert(automation_run_open_keys)
      .values({
        organization_id: values.organizationId,
        automation_id: values.automationId,
        contact_id: values.contactId,
        automation_run_id: values.runId,
        automation_run_started_at: values.runStartedAt,
      })
      .onConflictDoNothing()
      .returning({ automation_run_id: automation_run_open_keys.automation_run_id });
    return rows.length > 0;
  }

  /** The key of one automation and person, locked `FOR UPDATE`; `null` when no run is open. */
  async lockForAutomationAndContact({
    organizationId,
    automationId,
    contactId,
  }: {
    organizationId: number;
    automationId: number;
    contactId: number;
  }): Promise<AutomationRunOpenKeyRow | null> {
    const rows = await this.db()
      .select()
      .from(automation_run_open_keys)
      .where(
        and(
          eq(automation_run_open_keys.organization_id, organizationId),
          eq(automation_run_open_keys.automation_id, automationId),
          eq(automation_run_open_keys.contact_id, contactId),
        ),
      )
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /** The automations of the contact's open runs, each once, ascending — the lock order (D47). */
  async listAutomationIdsOfContact({
    organizationId,
    contactId,
  }: {
    organizationId: number;
    contactId: number;
  }): Promise<number[]> {
    const rows = await this.db()
      .select({ automation_id: automation_run_open_keys.automation_id })
      .from(automation_run_open_keys)
      .where(
        and(
          eq(automation_run_open_keys.organization_id, organizationId),
          eq(automation_run_open_keys.contact_id, contactId),
        ),
      )
      .orderBy(asc(automation_run_open_keys.automation_id));
    return rows.map((row) => row.automation_id);
  }

  /** Deletes the keys of runs a commit ends (completed, failed, cancelled); returns how many. */
  async deleteForRuns({
    organizationId,
    runs,
  }: {
    organizationId: number;
    runs: readonly AutomationRunOpenKeyRun[];
  }): Promise<number> {
    if (runs.length === 0) return 0;
    const rows = await this.db()
      .delete(automation_run_open_keys)
      .where(
        and(
          eq(automation_run_open_keys.organization_id, organizationId),
          inArray(
            automation_run_open_keys.automation_run_id,
            runs.map((run) => run.id),
          ),
        ),
      )
      .returning({ automation_run_id: automation_run_open_keys.automation_run_id });
    return rows.length;
  }

  /**
   * The repair duty (WC-67, P100): deletes up to `limit` keys of every organization whose run is no
   * longer open (or gone) — a missed delete never blocks her for good. Returns how many. Runs only on
   * a retention handle ({@link createRetentionAutomationRunOpenKeyRepository}).
   */
  async deleteKeysOfEndedRuns({ limit }: { limit: number }): Promise<number> {
    const stale = this.db()
      .select({
        organization_id: automation_run_open_keys.organization_id,
        automation_id: automation_run_open_keys.automation_id,
        contact_id: automation_run_open_keys.contact_id,
      })
      .from(automation_run_open_keys)
      .where(
        sql`NOT EXISTS (
          SELECT 1 FROM ${automation_runs}
          WHERE ${automation_runs.organization_id} = ${automation_run_open_keys.organization_id}
            AND ${automation_runs.id} = ${automation_run_open_keys.automation_run_id}
            AND ${automation_runs.started_at} = ${automation_run_open_keys.automation_run_started_at}
            AND ${automation_runs.status} IN ('running', 'waiting')
        )`,
      )
      .limit(limit)
      .for('update', { skipLocked: true });
    const rows = await this.db()
      .delete(automation_run_open_keys)
      .where(
        sql`(${automation_run_open_keys.organization_id}, ${automation_run_open_keys.automation_id}, ${automation_run_open_keys.contact_id}) IN (${stale})`,
      )
      .returning({ automation_run_id: automation_run_open_keys.automation_run_id });
    return rows.length;
  }
}

/** {@link AutomationRunOpenKeyRepository} bound to a job's organization handle — the engine, WC-45. */
export function createWorkerAutomationRunOpenKeyRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationRunOpenKeyRepository {
  assertWorkerDatabaseContext(['organization']);
  return new AutomationRunOpenKeyRepository(databaseHandle);
}

/**
 * {@link AutomationRunOpenKeyRepository} bound to a retention handle — the repair duty's
 * cross-organization delete (WC-67), through the sweep arm the policy carries in `USING`.
 */
export function createRetentionAutomationRunOpenKeyRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationRunOpenKeyRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new AutomationRunOpenKeyRepository(databaseHandle);
}
