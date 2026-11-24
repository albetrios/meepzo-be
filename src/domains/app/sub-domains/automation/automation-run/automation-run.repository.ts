import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  sql,
} from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  type BatchDeleteResult,
  deleteInBatchesByCondition,
} from '@/infrastructure/database/utils/batch-delete.util.js';
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
import type { AutomationQueuedEntry, AutomationRunKey } from './automation-run.types.js';

/** `updated_at` for every change of a run — never before the row's `created_at`. */
const runUpdatedAtTimestamp = databaseUpdatedAtTimestamp(automation_runs.created_at);

/** One `app.automation_runs` row as Drizzle reads it. */
export type AutomationRunRow = typeof automation_runs.$inferSelect;

/** What a new run is born with (AU16, AU18): `running` at `keyword_match`. */
export interface AutomationRunInsertValues {
  organizationId: number;
  automationId: number;
  contactId: number;
  triggerType: AutomationTriggerType;
  triggerInstagramMediaId: string | null;
  triggerInstagramCommentId: string | null;
  triggerInstagramStoryId: string | null;
  triggerText: string | null;
  /** The event that starts it (AU19). */
  lastInstagramEventKey: string;
}

/** The columns one run change may set — every run write goes through {@link AutomationRunRepository.update}. */
export type AutomationRunChanges = PgUpdateSetSource<typeof automation_runs>;

/** One run that has waited since before the cutoff (AU25, WC-13) — a row of the hourly scan. */
export interface AutomationRunWaitExpiryCandidate {
  runId: number;
  organizationId: number;
  organizationPublicId: string;
}

/** The open-run guard: `running` or `waiting` (AU17). */
const OPEN_RUN = inArray(automation_runs.status, [...AUTOMATION_RUN_OPEN_STATUSES]);

/** A run still waiting since before `waitingSinceBefore` — the 7-day check's scan and its re-check (AU25). */
function waitingSince(waitingSinceBefore: Date): SQL {
  return and(
    eq(automation_runs.status, 'waiting'),
    lt(automation_runs.waiting_since_at, waitingSinceBefore),
  ) as SQL;
}

/**
 * Drizzle access to `app.automation_runs` (routes-final § 3.B.3, AUC10): the runs the run engine
 * starts, locks, moves and ends, the AU17 reads, the cancels of an automation delete (AU12), a
 * contact erase (AU26) and the 7-day wait (AU25), and run retention (D8).
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id`, so tenant isolation does not rest on
 *   RLS alone. A run moves under a `FOR UPDATE` lock taken by {@link lockById}; each change stamps
 *   `updated_at`. The one-open-run index (AU17) is the backstop for a race the engine's order
 *   rules out (D15).
 * - **Failure modes:** a value that breaks a `chk_automation_runs_*` CHECK throws Postgres 23514;
 *   a second open run of one automation × contact throws 23505 on `idx_automation_runs_one_open`.
 * - **Side effects:** writes `app.automation_runs` only.
 * - **Notes:** the engine and the 7-day wait's per-organization cancel bind a job handle
 *   ({@link createWorkerAutomationRunRepository}); the delete's and the erase's steps run inside
 *   the route's own unit of work (no handle); the 7-day wait's scan and run retention bind a
 *   retention handle ({@link createRetentionAutomationRunRepository}).
 */
export class AutomationRunRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Inserts a new `running` run at `keyword_match` (AU18) and returns it. */
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
            trigger_instagram_media_id: values.triggerInstagramMediaId,
            trigger_instagram_comment_id: values.triggerInstagramCommentId,
            trigger_instagram_story_id: values.triggerInstagramStoryId,
            trigger_text: values.triggerText,
            last_instagram_event_key: values.lastInstagramEventKey,
          })
          .returning(),
    });
    const row = rows[0];
    if (row === undefined) {
      throw new Error('automation run insert returned no row');
    }
    return row;
  }

  /** The run, locked `FOR UPDATE` until the unit of work ends; `null` when absent. */
  async lockById({ organizationId, runId }: AutomationRunKey): Promise<AutomationRunRow | null> {
    const rows = await this.db()
      .select()
      .from(automation_runs)
      .where(
        and(eq(automation_runs.organization_id, organizationId), eq(automation_runs.id, runId)),
      )
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /**
   * The contact's run with this public id, locked `FOR UPDATE` — a button click (AU16); `null`
   * when absent, another contact's or another organization's.
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
   * This automation's last run for the contact — the one AU17 reads (an open run is always the
   * last, since a new run starts only when none is open); `null` when there is none.
   */
  async findLatestRunOfAutomationForContact({
    organizationId,
    automationId,
    contactId,
  }: {
    organizationId: number;
    automationId: number;
    contactId: number;
  }): Promise<AutomationRunRow | null> {
    const rows = await this.db()
      .select()
      .from(automation_runs)
      .where(
        and(
          eq(automation_runs.organization_id, organizationId),
          eq(automation_runs.automation_id, automationId),
          eq(automation_runs.contact_id, contactId),
        ),
      )
      .orderBy(desc(automation_runs.started_at), desc(automation_runs.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The contact's `waiting` runs that wait for one of `waitingFor`, locked `FOR UPDATE`: email
   * waits first, then the oldest wait (AU16 — the run a DM answers; AU17 (1)).
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
        asc(automation_runs.waiting_since_at),
        asc(automation_runs.id),
      )
      .for('update');
  }

  /**
   * The contact's runs the event with this key last moved (AU19), oldest first — a retried event
   * resumes these instead of being applied again.
   */
  async findRunsMovedByEvent({
    organizationId,
    contactId,
    eventKey,
  }: {
    organizationId: number;
    contactId: number;
    eventKey: string;
  }): Promise<AutomationRunRow[]> {
    return this.db()
      .select()
      .from(automation_runs)
      .where(
        and(
          eq(automation_runs.organization_id, organizationId),
          eq(automation_runs.contact_id, contactId),
          eq(automation_runs.last_instagram_event_key, eventKey),
        ),
      )
      .orderBy(asc(automation_runs.started_at), asc(automation_runs.id));
  }

  /**
   * The automations of the contact's open runs, each once — what a unit of the engine and the
   * contact erase lock before any of those runs (AU12, D47). Reads
   * `idx_automation_runs_contact`.
   */
  async listOpenRunAutomationIds({
    organizationId,
    contactId,
  }: {
    organizationId: number;
    contactId: number;
  }): Promise<number[]> {
    const rows = await this.db()
      .selectDistinct({ automation_id: automation_runs.automation_id })
      .from(automation_runs)
      .where(
        and(
          eq(automation_runs.organization_id, organizationId),
          eq(automation_runs.contact_id, contactId),
          OPEN_RUN,
        ),
      );
    return rows.map((row) => row.automation_id);
  }

  /**
   * The organization's `running` runs the event with this key last moved, oldest first — the ones an
   * event that ends `failed` leaves behind (AU19, D47). Not locked: the caller locks the contact and
   * the automation first, then each run. Among the organization's open runs only
   * (`idx_automation_runs_one_open`).
   */
  async listRunningMovedByEvent({
    organizationId,
    eventKey,
  }: {
    organizationId: number;
    eventKey: string;
  }): Promise<AutomationRunRow[]> {
    return this.db()
      .select()
      .from(automation_runs)
      .where(
        and(
          eq(automation_runs.organization_id, organizationId),
          OPEN_RUN,
          eq(automation_runs.status, 'running'),
          eq(automation_runs.last_instagram_event_key, eventKey),
        ),
      )
      .orderBy(asc(automation_runs.id));
  }

  /** Writes `changes` to one run, stamping `updated_at`; returns the run, or `null` when absent. */
  async update({
    organizationId,
    runId,
    changes,
  }: AutomationRunKey & { changes: AutomationRunChanges }): Promise<AutomationRunRow | null> {
    const rows = await this.db()
      .update(automation_runs)
      .set({ ...changes, updated_at: runUpdatedAtTimestamp })
      .where(
        and(eq(automation_runs.organization_id, organizationId), eq(automation_runs.id, runId)),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Replaces a run's queued automations (AU21) — the caller checked the list's shape. */
  async replaceQueuedAutomations({
    organizationId,
    runId,
    entries,
  }: AutomationRunKey & {
    entries: readonly AutomationQueuedEntry[];
  }): Promise<AutomationRunRow | null> {
    return this.update({ organizationId, runId, changes: { queued_automations: [...entries] } });
  }

  /**
   * Cancels every `running` and `waiting` run matching `where` (AU12, AU25, AU26): `cancelled`
   * with its reason and time, the wait, the claim and the queued automations cleared. Returns the
   * cancelled runs' ids.
   */
  private async cancelOpenRuns({
    organizationId,
    reason,
    narrowing,
  }: {
    organizationId: number;
    reason: AutomationRunCancelReason;
    narrowing: SQL;
  }): Promise<number[]> {
    const rows = await this.db()
      .update(automation_runs)
      .set({
        status: 'cancelled',
        cancel_reason: reason,
        cancelled_at: databaseNowTimestamp,
        waiting_for: null,
        waiting_since_at: null,
        sending_message_kind: null,
        sending_started_at: null,
        queued_automations: [],
        last_step_at: databaseNowTimestamp,
        updated_at: runUpdatedAtTimestamp,
      })
      .where(and(eq(automation_runs.organization_id, organizationId), narrowing, OPEN_RUN))
      .returning({ id: automation_runs.id });
    return rows.map((row) => row.id);
  }

  /** Cancels the automation's open runs (`automation_deleted`, AU12); returns their ids. */
  async cancelOpenRunsOfAutomation({
    organizationId,
    automationId,
  }: {
    organizationId: number;
    automationId: number;
  }): Promise<number[]> {
    return this.cancelOpenRuns({
      organizationId,
      reason: 'automation_deleted',
      narrowing: eq(automation_runs.automation_id, automationId),
    });
  }

  /** Cancels the contact's open runs (`contact_deleted`, AU26); returns their ids. */
  async cancelOpenRunsOfContact({
    organizationId,
    contactId,
    reason = 'contact_deleted',
  }: {
    organizationId: number;
    contactId: number;
    /** `contact_deleted` (the erase) or the pause's `contact_excluded` / `opted_out` (CTC4). */
    reason?: Extract<
      AutomationRunCancelReason,
      'contact_deleted' | 'contact_excluded' | 'opted_out'
    >;
  }): Promise<number[]> {
    return this.cancelOpenRuns({
      organizationId,
      reason,
      narrowing: eq(automation_runs.contact_id, contactId),
    });
  }

  /**
   * Cancels the given runs of one organization that still wait since before `waitingSinceBefore`
   * (`wait_expired`, AU25, WC-13) — the scan's condition checked again in the same statement, so a
   * run that got its answer, moved on or was cancelled since the scan is left as it is. Returns
   * the cancelled runs' ids.
   *
   * @remarks
   * Takes the runs `FOR UPDATE SKIP LOCKED`: one that an event, a delete or an erase holds right now
   * is left to the next hour, so this cancel, which holds many runs without their automations, never
   * waits for one while another transaction waits for it (D47).
   */
  async cancelExpiredWaitingRuns({
    organizationId,
    runIds,
    waitingSinceBefore,
  }: {
    organizationId: number;
    runIds: readonly number[];
    waitingSinceBefore: Date;
  }): Promise<number[]> {
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
   * longest wait first (`idx_automation_runs_waiting_since`) — the 7-day check's
   * cross-organization scan (AU25, WC-13). A deleted organization's runs are left out: its own
   * scope no longer sees them, so they could not be cancelled and would keep their place in every
   * batch until its purge. Runs only on a retention handle
   * ({@link createRetentionAutomationRunRepository}): the sweep arm is in the policy's `USING`
   * only, so it reads every organization's runs and can change none.
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
      .where(and(waitingSince(waitingSinceBefore), isNull(organizations.deleted_at)))
      .orderBy(asc(automation_runs.waiting_since_at), asc(automation_runs.id))
      .limit(limit);
  }

  /**
   * Run retention (D8, AU25, WC-12): deletes every run that ended (`ended_at`) before `cutoff`, in
   * capped batches (`deleteInBatchesByCondition`). An open run has no `ended_at` and is never
   * removed — the status guard repeats it. Its run events go with it (`ON DELETE CASCADE`); its
   * comment logs stay with the run emptied (`ON DELETE SET NULL (automation_run_id)`, AU24). Needs
   * the retention context — bind it through {@link createRetentionAutomationRunRepository}.
   */
  async deleteEndedBefore(cutoff: Date): Promise<BatchDeleteResult> {
    return deleteInBatchesByCondition({
      databaseHandle: this.db(),
      table: automation_runs,
      idColumn: automation_runs.id,
      whereCondition: and(
        isNotNull(automation_runs.ended_at),
        lt(automation_runs.ended_at, cutoff),
        notInArray(automation_runs.status, [...AUTOMATION_RUN_OPEN_STATUSES]),
      ) as SQL,
      logContext: 'automation-run-retention',
      tableLabel: 'app.automation_runs',
    });
  }

  /**
   * Clears the personal data every run of the contact holds (AU26): `trigger_text` and the queued
   * automations (their trigger texts). Returns how many runs it changed.
   */
  async eraseContactCopies({
    organizationId,
    contactId,
  }: {
    organizationId: number;
    contactId: number;
  }): Promise<number> {
    const rows = await this.db()
      .update(automation_runs)
      .set({ trigger_text: null, queued_automations: [], updated_at: runUpdatedAtTimestamp })
      .where(
        and(
          eq(automation_runs.organization_id, organizationId),
          eq(automation_runs.contact_id, contactId),
        ),
      )
      .returning({ id: automation_runs.id });
    return rows.length;
  }
}

/**
 * {@link AutomationRunRepository} bound to a job's organization handle — the run engine's short
 * units of work (`withAppDatabaseContext` with the job's scope, AU19) and the 7-day wait's
 * per-organization cancel (`runOrganizationScopedWorkerJob`, AU25).
 */
export function createWorkerAutomationRunRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationRunRepository {
  assertWorkerDatabaseContext(['organization']);
  return new AutomationRunRepository(databaseHandle);
}

/**
 * {@link AutomationRunRepository} bound to a retention handle (`runGlobalRetentionWorkerJob`) — the
 * 7-day wait's cross-organization scan (read only) and run retention's delete, through the sweep
 * arm the policy carries in `USING` only.
 */
export function createRetentionAutomationRunRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationRunRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new AutomationRunRepository(databaseHandle);
}
