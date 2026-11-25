import { type SQL, and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  databaseNowTimestamp,
  databaseUpdatedAtTimestamp,
} from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import type { AutomationTriggerType } from '@/domains/app/sub-domains/automation/automation.constants.js';
import {
  AUTOMATION_RUN_OPEN_STATUSES,
  type AutomationRunCancelReason,
  type AutomationRunWaitingFor,
} from './automation-run.constants.js';
import { automation_runs } from './automation-run.schema.js';
import type { AutomationRunKey, AutomationRunVersionNumbers } from './automation-run.types.js';

/** `updated_at` for every change of a run — never before the row's `created_at`. */
const runUpdatedAtTimestamp = databaseUpdatedAtTimestamp(automation_runs.created_at);

/** One `app.automation_runs` row as Drizzle reads it. */
export type AutomationRunRow = typeof automation_runs.$inferSelect;

/** What a new run is born with (AU21): `running` at `keyword_match`. */
export interface AutomationRunInsertValues {
  organizationId: number;
  automationId: number;
  contactId: number;
  triggerType: AutomationTriggerType;
  triggerMediaId: string | null;
  triggerCommentId: string | null;
  triggerStoryId: string | null;
  triggerOccurredAt: Date;
  onceKey: string;
  versionNumbers: AutomationRunVersionNumbers;
  /** The event that starts it. */
  lastEventKey: string;
}

/** The columns one run change may set — every run write goes through {@link AutomationRunRepository.update}. */
export type AutomationRunChanges = PgUpdateSetSource<typeof automation_runs>;

/** One run that has waited since before the cutoff (WC-45) — a row of the hourly scan. */
export interface AutomationRunWaitExpiryCandidate {
  runId: number;
  organizationId: number;
  organizationPublicId: string;
}

/** The ids of one ended run — its key to delete and its waiting messages to end. */
export interface AutomationEndedRun {
  id: number;
  started_at: Date;
  automation_id: number;
  contact_id: number;
}

/** The open-run guard: `running` or `waiting`. */
const OPEN_RUN = inArray(automation_runs.status, [...AUTOMATION_RUN_OPEN_STATUSES]);

/** One run by its key — the start month prunes the read to one part (AU36). */
function byRunKey({ organizationId, runId, runStartedAt }: AutomationRunKey): SQL {
  return and(
    eq(automation_runs.organization_id, organizationId),
    eq(automation_runs.id, runId),
    eq(automation_runs.started_at, runStartedAt),
  ) as SQL;
}

/** A run still waiting since before `waitingSinceBefore` — the 7-day scan and its re-check. */
function waitingSince(waitingSinceBefore: Date): SQL {
  return and(
    eq(automation_runs.status, 'waiting'),
    lt(automation_runs.waiting_since_at, waitingSinceBefore),
  ) as SQL;
}

/**
 * Drizzle access to `app.automation_runs` (routes-final § 4.B.3, AUC9, AUC14): the runs the engine
 * starts, locks, moves and ends, the once rule's read (AU22), the cancels of an automation delete, a
 * contact erase or pause and the 7-day wait (WC-45).
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id`; a run is named by its id and start month
 *   (`byRunKey`), so a read prunes to one month part. A run moves under a `FOR UPDATE` lock. The one
 *   open run per automation and person is the open-key table's (AU37), not this table's.
 * - **Failure modes:** a value that breaks a `chk_automation_runs_*` CHECK throws Postgres 23514.
 * - **Side effects:** writes `app.automation_runs` only.
 * - **Notes:** the engine and the 7-day cancel bind a job handle
 *   ({@link createWorkerAutomationRunRepository}); the delete's and the erase's steps run inside the
 *   route's own unit (no handle); the 7-day scan binds a retention handle
 *   ({@link createRetentionAutomationRunRepository}). Parts are dropped by the shared upkeep (R49),
 *   never row by row.
 */
export class AutomationRunRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Inserts a new `running` run at `keyword_match` and returns it. */
  async insert(values: AutomationRunInsertValues): Promise<AutomationRunRow> {
    const rows = await runInsertWithPublicIdentifierRetry({
      insert: () =>
        this.db()
          .insert(automation_runs)
          .values({
            public_id: generatePublicId('automationRun'),
            organization_id: values.organizationId,
            automation_id: values.automationId,
            contact_id: values.contactId,
            trigger_type: values.triggerType,
            trigger_instagram_media_id: values.triggerMediaId,
            trigger_instagram_comment_id: values.triggerCommentId,
            trigger_instagram_story_id: values.triggerStoryId,
            trigger_occurred_at: values.triggerOccurredAt,
            once_key: values.onceKey,
            version_numbers: values.versionNumbers,
            last_instagram_event_key: values.lastEventKey,
          })
          .returning(),
    });
    const row = rows[0];
    if (row === undefined) {
      throw new Error('automation run insert returned no row');
    }
    return row;
  }

  /** Deletes a run just inserted in this unit — its open key lost the race (AU37). */
  async deleteJustInserted(key: AutomationRunKey): Promise<void> {
    await this.db().delete(automation_runs).where(byRunKey(key));
  }

  /** The run, not locked — its automation and contact are locked before the run (D47). */
  async findByKey(key: AutomationRunKey): Promise<AutomationRunRow | null> {
    const rows = await this.db().select().from(automation_runs).where(byRunKey(key)).limit(1);
    return rows[0] ?? null;
  }

  /** The run, locked `FOR UPDATE` until the unit of work ends; `null` when absent. */
  async lockByKey(key: AutomationRunKey): Promise<AutomationRunRow | null> {
    const rows = await this.db()
      .select()
      .from(automation_runs)
      .where(byRunKey(key))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /**
   * The contact's run with this public id, locked `FOR UPDATE` — a tap on our button; `null` when
   * absent, another contact's or another organization's.
   */
  async lockContactRunByPublicId({
    organizationId,
    contactId,
    runPublicId,
  }: {
    organizationId: number;
    contactId: number;
    runPublicId: string;
  }): Promise<AutomationRunRow | null> {
    const rows = await this.db()
      .select()
      .from(automation_runs)
      .where(
        and(
          eq(automation_runs.organization_id, organizationId),
          eq(automation_runs.contact_id, contactId),
          eq(automation_runs.public_id, runPublicId),
        ),
      )
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /**
   * Whether a DM already went for this automation, person and once key (AU22) — across the kept
   * parts (`idx_automation_runs_once`).
   */
  async hasDirectMessageForOnceKey({
    organizationId,
    automationId,
    contactId,
    onceKey,
  }: {
    organizationId: number;
    automationId: number;
    contactId: number;
    onceKey: string;
  }): Promise<boolean> {
    const rows = await this.db()
      .select({ id: automation_runs.id })
      .from(automation_runs)
      .where(
        and(
          eq(automation_runs.organization_id, organizationId),
          eq(automation_runs.automation_id, automationId),
          eq(automation_runs.contact_id, contactId),
          eq(automation_runs.once_key, onceKey),
          isNotNull(automation_runs.direct_message_sent_at),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The contact's `waiting` runs that wait for one of `waitingFor`, locked `FOR UPDATE`: email waits
   * first, then phone, then the oldest wait — the run her message answers (plan §4.3 level 1).
   */
  async lockWaitingRunsOfContact({
    organizationId,
    contactId,
    waitingFor,
  }: {
    organizationId: number;
    contactId: number;
    waitingFor: readonly AutomationRunWaitingFor[];
  }): Promise<AutomationRunRow[]> {
    return this.db()
      .select()
      .from(automation_runs)
      .where(
        and(
          eq(automation_runs.organization_id, organizationId),
          eq(automation_runs.contact_id, contactId),
          eq(automation_runs.status, 'waiting'),
          inArray(automation_runs.waiting_for, [...waitingFor]),
        ),
      )
      .orderBy(
        sql`(${automation_runs.waiting_for} = 'email') DESC`,
        sql`(${automation_runs.waiting_for} = 'phone') DESC`,
        asc(automation_runs.waiting_since_at),
        asc(automation_runs.id),
      )
      .for('update');
  }

  /**
   * Whether the event with this key already moved a run of the contact — a retried event finds its
   * work done (its commit holds every write, so there is nothing to resume).
   */
  async hasRunMovedByEvent({
    organizationId,
    contactId,
    eventKey,
    since,
  }: {
    organizationId: number;
    contactId: number;
    eventKey: string;
    /** Only runs started since then can carry the key — prunes old parts. */
    since: Date;
  }): Promise<boolean> {
    const rows = await this.db()
      .select({ id: automation_runs.id })
      .from(automation_runs)
      .where(
        and(
          eq(automation_runs.organization_id, organizationId),
          eq(automation_runs.contact_id, contactId),
          gte(automation_runs.started_at, since),
          eq(automation_runs.last_instagram_event_key, eventKey),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Writes `changes` to one run, stamping `updated_at`; returns the run, or `null` when absent. */
  async update({
    changes,
    ...key
  }: AutomationRunKey & { changes: AutomationRunChanges }): Promise<AutomationRunRow | null> {
    const rows = await this.db()
      .update(automation_runs)
      .set({ ...changes, updated_at: runUpdatedAtTimestamp })
      .where(byRunKey(key))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Cancels every `running` and `waiting` run matching `narrowing`: `cancelled` with its reason and
   * time, the wait cleared. Returns the cancelled runs.
   */
  private async cancelOpenRuns({
    organizationId,
    reason,
    narrowing,
  }: {
    organizationId: number;
    reason: AutomationRunCancelReason;
    narrowing: SQL;
  }): Promise<AutomationEndedRun[]> {
    return this.db()
      .update(automation_runs)
      .set({
        status: 'cancelled',
        cancel_reason: reason,
        cancelled_at: databaseNowTimestamp,
        waiting_for: null,
        waiting_since_at: null,
        last_step_at: databaseNowTimestamp,
        updated_at: runUpdatedAtTimestamp,
      })
      .where(and(eq(automation_runs.organization_id, organizationId), narrowing, OPEN_RUN))
      .returning({
        id: automation_runs.id,
        started_at: automation_runs.started_at,
        automation_id: automation_runs.automation_id,
        contact_id: automation_runs.contact_id,
      });
  }

  /** Cancels the automation's open runs (`automation_deleted`); returns them. */
  async cancelOpenRunsOfAutomation({
    organizationId,
    automationId,
  }: {
    organizationId: number;
    automationId: number;
  }): Promise<AutomationEndedRun[]> {
    return this.cancelOpenRuns({
      organizationId,
      reason: 'automation_deleted',
      narrowing: eq(automation_runs.automation_id, automationId),
    });
  }

  /** Cancels the contact's open runs (`contact_deleted`, or the pause's reason); returns them. */
  async cancelOpenRunsOfContact({
    organizationId,
    contactId,
    reason = 'contact_deleted',
  }: {
    organizationId: number;
    contactId: number;
    reason?: Extract<
      AutomationRunCancelReason,
      'contact_deleted' | 'contact_excluded' | 'opted_out'
    >;
  }): Promise<AutomationEndedRun[]> {
    return this.cancelOpenRuns({
      organizationId,
      reason,
      narrowing: eq(automation_runs.contact_id, contactId),
    });
  }

  /**
   * Cancels the given runs of one organization that still wait since before `waitingSinceBefore`
   * (`wait_expired`, WC-45) — the scan's condition checked again in the same statement. Takes them
   * `FOR UPDATE SKIP LOCKED`: one another transaction holds is left to the next hour.
   */
  async cancelExpiredWaitingRuns({
    organizationId,
    runIds,
    waitingSinceBefore,
  }: {
    organizationId: number;
    runIds: readonly number[];
    waitingSinceBefore: Date;
  }): Promise<AutomationEndedRun[]> {
    if (runIds.length === 0) return [];
    const stillWaiting = this.db()
      .select({ id: automation_runs.id })
      .from(automation_runs)
      .where(
        and(
          eq(automation_runs.organization_id, organizationId),
          inArray(automation_runs.id, [...runIds]),
          waitingSince(waitingSinceBefore),
        ),
      )
      .for('update', { skipLocked: true });
    return this.cancelOpenRuns({
      organizationId,
      reason: 'wait_expired',
      narrowing: inArray(automation_runs.id, stillWaiting),
    });
  }

  /**
   * Up to `limit` runs of every organization still waiting since before `waitingSinceBefore`,
   * longest wait first — the 7-day check's cross-organization scan (WC-45). A deleted organization's
   * runs are left out. Runs only on a retention handle ({@link createRetentionAutomationRunRepository}).
   */
  async listWaitExpiryCandidates({
    waitingSinceBefore,
    limit,
  }: {
    waitingSinceBefore: Date;
    limit: number;
  }): Promise<AutomationRunWaitExpiryCandidate[]> {
    return this.db()
      .select({
        runId: automation_runs.id,
        organizationId: automation_runs.organization_id,
        organizationPublicId: organizations.public_id,
      })
      .from(automation_runs)
      .innerJoin(organizations, eq(organizations.id, automation_runs.organization_id))
      .where(and(waitingSince(waitingSinceBefore), sql`${organizations.deleted_at} IS NULL`))
      .orderBy(asc(automation_runs.waiting_since_at), asc(automation_runs.id))
      .limit(limit);
  }

  /** The contact's newest runs, newest first — the contact's "What happened" (CT14) and tests. */
  async listForContact({
    organizationId,
    contactId,
    limit,
  }: {
    organizationId: number;
    contactId: number;
    limit: number;
  }): Promise<AutomationRunRow[]> {
    return this.db()
      .select()
      .from(automation_runs)
      .where(
        and(
          eq(automation_runs.organization_id, organizationId),
          eq(automation_runs.contact_id, contactId),
        ),
      )
      .orderBy(desc(automation_runs.started_at), desc(automation_runs.id))
      .limit(limit);
  }
}

/**
 * {@link AutomationRunRepository} bound to a job's organization handle — the run engine's unit of
 * work (`withAppDatabaseContext` with the job's scope) and the 7-day cancel's per-organization job.
 */
export function createWorkerAutomationRunRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationRunRepository {
  assertWorkerDatabaseContext(['organization']);
  return new AutomationRunRepository(databaseHandle);
}

/**
 * {@link AutomationRunRepository} bound to a retention handle (`runGlobalRetentionWorkerJob`) — the
 * 7-day check's cross-organization scan (read only), through the sweep arm in `USING`.
 */
export function createRetentionAutomationRunRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationRunRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new AutomationRunRepository(databaseHandle);
}
