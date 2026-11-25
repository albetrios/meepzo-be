import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { databaseUpdatedAtTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import type {
  AutomationCommentLogIgnoredReason,
  AutomationCommentLogOverallStatus,
} from './automation-run.constants.js';
import { automation_comment_logs } from './automation-comment-log.schema.js';

/** `updated_at` for every change of a comment log — never before the row's `created_at`. */
const commentLogUpdatedAtTimestamp = databaseUpdatedAtTimestamp(automation_comment_logs.created_at);

/** One `app.automation_comment_logs` row as Drizzle reads it. */
export type AutomationCommentLogRow = typeof automation_comment_logs.$inferSelect;

/** The columns one comment-log change may set. */
export type AutomationCommentLogChanges = PgUpdateSetSource<typeof automation_comment_logs>;

/** One comment and automation log as the comment's choice writes it (AU23, AU28). */
export interface AutomationCommentLogInsertValues {
  organizationId: number;
  automationId: number;
  automationName: string;
  /** The run it started, with its start month; `null` when ignored. */
  automationRun: { id: number; startedAt: Date } | null;
  contactId: number;
  mediaId: string;
  commentId: string;
  commentOccurredAt: Date;
  commentText: string | null;
  commenterUsername: string | null;
  commenterUserId: string | null;
  overallStatus: Extract<AutomationCommentLogOverallStatus, 'started' | 'ignored'>;
  ignoredReason: AutomationCommentLogIgnoredReason | null;
}

/** The run a log belongs to — its id and start month (a copy, AU36). */
export interface AutomationCommentLogRunKey {
  organizationId: number;
  runId: number;
  runStartedAt: Date;
}

/**
 * Drizzle access to `app.automation_comment_logs` (routes-final § 4.B.3, AU28): the logs of one
 * comment's choice, their step results, the erase of their personal copies.
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id`. The table is split by month of
 *   `created_at` (AU36): a comment's logs are read in the last two month parts (`since`), the one log
 *   rule is the engine's under the contact lock; a run's log by the run's id and start (a copy, no
 *   reference).
 * - **Failure modes:** a broken CHECK throws 23514.
 * - **Side effects:** writes `app.automation_comment_logs` only. Parts are dropped by the shared
 *   upkeep (ROUTE row R49), never row by row.
 */
export class AutomationCommentLogRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Inserts the logs of one comment's choice in one statement; returns them. */
  async insertMany(
    values: readonly AutomationCommentLogInsertValues[],
  ): Promise<AutomationCommentLogRow[]> {
    if (values.length === 0) return [];
    return runInsertWithPublicIdentifierRetry({
      insert: () =>
        this.db()
          .insert(automation_comment_logs)
          .values(
            values.map((value) => ({
              public_id: generatePublicId('automationCommentLog'),
              organization_id: value.organizationId,
              automation_id: value.automationId,
              automation_name: value.automationName,
              automation_run_id: value.automationRun?.id ?? null,
              automation_run_started_at: value.automationRun?.startedAt ?? null,
              contact_id: value.contactId,
              instagram_media_id: value.mediaId,
              instagram_comment_id: value.commentId,
              comment_occurred_at: value.commentOccurredAt,
              comment_text: value.commentText,
              commenter_username: value.commenterUsername,
              commenter_instagram_user_id: value.commenterUserId,
              overall_status: value.overallStatus,
              ignored_reason: value.ignoredReason,
            })),
          )
          .returning(),
    });
  }

  /**
   * Every log of one comment written since `since`, oldest first — a retried comment finds its
   * choice here, and the duplicate public reply rule reads it (AU28: the last two month parts).
   */
  async listForComment({
    organizationId,
    commentId,
    since,
  }: {
    organizationId: number;
    commentId: string;
    since: Date;
  }): Promise<AutomationCommentLogRow[]> {
    return this.db()
      .select()
      .from(automation_comment_logs)
      .where(
        and(
          eq(automation_comment_logs.organization_id, organizationId),
          eq(automation_comment_logs.instagram_comment_id, commentId),
          gte(automation_comment_logs.created_at, since),
        ),
      )
      .orderBy(asc(automation_comment_logs.created_at), asc(automation_comment_logs.id));
  }

  /** The log a run writes its steps to; `null` off a comment run. */
  async findForRun({
    organizationId,
    runId,
    runStartedAt,
  }: AutomationCommentLogRunKey): Promise<AutomationCommentLogRow | null> {
    const rows = await this.db()
      .select()
      .from(automation_comment_logs)
      .where(
        and(
          eq(automation_comment_logs.organization_id, organizationId),
          eq(automation_comment_logs.automation_run_id, runId),
          eq(automation_comment_logs.automation_run_started_at, runStartedAt),
          // A run's log is written in its start commit, so it lives in that month's part or later.
          gte(automation_comment_logs.created_at, runStartedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Writes `changes` to the log of one run, stamping `updated_at`; returns it, or `null`. */
  async updateForRun({
    changes,
    ...key
  }: AutomationCommentLogRunKey & {
    changes: AutomationCommentLogChanges;
  }): Promise<AutomationCommentLogRow | null> {
    const rows = await this.db()
      .update(automation_comment_logs)
      .set({ ...changes, updated_at: commentLogUpdatedAtTimestamp })
      .where(
        and(
          eq(automation_comment_logs.organization_id, key.organizationId),
          eq(automation_comment_logs.automation_run_id, key.runId),
          eq(automation_comment_logs.automation_run_started_at, key.runStartedAt),
          gte(automation_comment_logs.created_at, key.runStartedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Marks the logs of the given runs `cancelled`, the wait cleared; returns how many. */
  async markRunsCancelled({
    organizationId,
    runIds,
  }: {
    organizationId: number;
    runIds: readonly number[];
  }): Promise<number> {
    if (runIds.length === 0) return 0;
    const rows = await this.db()
      .update(automation_comment_logs)
      .set({
        overall_status: 'cancelled',
        waiting_for: null,
        updated_at: commentLogUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(automation_comment_logs.organization_id, organizationId),
          inArray(automation_comment_logs.automation_run_id, [...runIds]),
        ),
      )
      .returning({ id: automation_comment_logs.id });
    return rows.length;
  }

  /**
   * Clears the personal copies on every log of the contact: the comment text, the commenter's
   * username and id, the email and phone received. The post and comment ids stay (the duplicate rule
   * needs them). Returns how many logs it changed.
   */
  async eraseContactCopies({
    organizationId,
    contactId,
  }: {
    organizationId: number;
    contactId: number;
  }): Promise<number> {
    const rows = await this.db()
      .update(automation_comment_logs)
      .set({
        comment_text: null,
        commenter_username: null,
        commenter_instagram_user_id: null,
        email_received: null,
        phone_received: null,
        updated_at: commentLogUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(automation_comment_logs.organization_id, organizationId),
          eq(automation_comment_logs.contact_id, contactId),
        ),
      )
      .returning({ id: automation_comment_logs.id });
    return rows.length;
  }
}

/** {@link AutomationCommentLogRepository} bound to a job's organization handle — the run engine. */
export function createWorkerAutomationCommentLogRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationCommentLogRepository {
  assertWorkerDatabaseContext(['organization']);
  return new AutomationCommentLogRepository(databaseHandle);
}
