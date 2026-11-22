import { and, asc, count, desc, eq, gt, inArray, lt } from 'drizzle-orm';
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

/** One comment × automation log as the comment's choice writes it (AU16, AU24). */
export interface AutomationCommentLogInsertValues {
  organizationId: number;
  automationId: number;
  automationName: string;
  /** The run it started; `null` when ignored. */
  automationRunId: number | null;
  contactId: number;
  instagramMediaId: string;
  instagramCommentId: string;
  commentText: string | null;
  commenterUsername: string | null;
  commenterInstagramUserId: string | null;
  overallStatus: Extract<AutomationCommentLogOverallStatus, 'started' | 'ignored'>;
  ignoredReason: AutomationCommentLogIgnoredReason | null;
}

/** The public-reply guard every reply-safety count reads (AU20). */
const SENT_PUBLIC_REPLY = eq(automation_comment_logs.public_reply_status, 'sent');

/**
 * Drizzle access to `app.automation_comment_logs` (routes-final § 3.B.3, AU24): the logs of one
 * comment's choice, their step results, the reply-safety counts (AU20), the erase of their
 * personal copies (AU26) and comment-log retention (D8).
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id`. The reply-safety reads use the partial
 *   indexes over `sent` public replies (`idx_automation_comment_logs_public_replies`,
 *   `…_automation_public_replies`); the erase matches by `contact_id` alone (every log carries it).
 * - **Failure modes:** a second log for one comment × automation throws 23505 on
 *   `idx_automation_comment_logs_automation_comment`; a broken CHECK throws 23514.
 * - **Side effects:** writes `app.automation_comment_logs` only.
 * - **Notes:** the engine binds a job handle ({@link createWorkerAutomationCommentLogRepository});
 *   the delete's and the erase's steps run inside the route's own unit of work; retention binds a
 *   retention handle ({@link createRetentionAutomationCommentLogRepository}).
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
              automation_run_id: value.automationRunId,
              contact_id: value.contactId,
              instagram_media_id: value.instagramMediaId,
              instagram_comment_id: value.instagramCommentId,
              comment_text: value.commentText,
              commenter_username: value.commenterUsername,
              commenter_instagram_user_id: value.commenterInstagramUserId,
              overall_status: value.overallStatus,
              ignored_reason: value.ignoredReason,
            })),
          )
          .returning(),
    });
  }

  /** Every log of one comment, oldest first — a retried comment finds its choice here (AU16). */
  async listForComment({
    organizationId,
    instagramCommentId,
  }: {
    organizationId: number;
    instagramCommentId: string;
  }): Promise<AutomationCommentLogRow[]> {
    return this.db()
      .select()
      .from(automation_comment_logs)
      .where(
        and(
          eq(automation_comment_logs.organization_id, organizationId),
          eq(automation_comment_logs.instagram_comment_id, instagramCommentId),
        ),
      )
      .orderBy(asc(automation_comment_logs.id));
  }

  /** The log a run writes its steps to; `null` off a comment run. */
  async findForRun({
    organizationId,
    runId,
  }: {
    organizationId: number;
    runId: number;
  }): Promise<AutomationCommentLogRow | null> {
    const rows = await this.db()
      .select()
      .from(automation_comment_logs)
      .where(
        and(
          eq(automation_comment_logs.organization_id, organizationId),
          eq(automation_comment_logs.automation_run_id, runId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The log of one comment × automation; `null` when there is none. */
  async findForAutomationComment({
    organizationId,
    automationId,
    instagramCommentId,
  }: {
    organizationId: number;
    automationId: number;
    instagramCommentId: string;
  }): Promise<AutomationCommentLogRow | null> {
    const rows = await this.db()
      .select()
      .from(automation_comment_logs)
      .where(
        and(
          eq(automation_comment_logs.organization_id, organizationId),
          eq(automation_comment_logs.automation_id, automationId),
          eq(automation_comment_logs.instagram_comment_id, instagramCommentId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Writes `changes` to one log, stamping `updated_at`; returns it, or `null` when absent. */
  async update({
    organizationId,
    commentLogId,
    changes,
  }: {
    organizationId: number;
    commentLogId: number;
    changes: AutomationCommentLogChanges;
  }): Promise<AutomationCommentLogRow | null> {
    const rows = await this.db()
      .update(automation_comment_logs)
      .set({ ...changes, updated_at: commentLogUpdatedAtTimestamp })
      .where(
        and(
          eq(automation_comment_logs.organization_id, organizationId),
          eq(automation_comment_logs.id, commentLogId),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Marks the logs of the given runs `cancelled`, the wait cleared (AU12, AU25, AU26); returns how
   * many.
   */
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
   * Clears the personal copies on every log of the contact (AU26): the comment text, the
   * commenter's username and Instagram id, the email and phone received. The Instagram ids of the
   * post and comment stay (the duplicate rule needs them). Returns how many logs it changed.
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

  /**
   * Comment-log retention (D8, AU25, WC-9): deletes every log written (`created_at`) before
   * `cutoff`, whatever its status and whether its run is still there, in capped batches
   * (`deleteInBatchesByCondition`, `idx_automation_comment_logs_created`). Needs the retention
   * context — bind it through {@link createRetentionAutomationCommentLogRepository}.
   */
  async deleteCreatedBefore(cutoff: Date): Promise<BatchDeleteResult> {
    return deleteInBatchesByCondition({
      databaseHandle: this.db(),
      table: automation_comment_logs,
      idColumn: automation_comment_logs.id,
      whereCondition: lt(automation_comment_logs.created_at, cutoff),
      logContext: 'automation-comment-log-retention',
      tableLabel: 'app.automation_comment_logs',
    });
  }

  /** Whether the comment already got a public reply from the account — reply safety's `duplicate` (AU20). */
  async hasSentPublicReply({
    organizationId,
    instagramCommentId,
  }: {
    organizationId: number;
    instagramCommentId: string;
  }): Promise<boolean> {
    const rows = await this.db()
      .select({ id: automation_comment_logs.id })
      .from(automation_comment_logs)
      .where(
        and(
          eq(automation_comment_logs.organization_id, organizationId),
          eq(automation_comment_logs.instagram_comment_id, instagramCommentId),
          SENT_PUBLIC_REPLY,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The organization's public replies sent after `since` — reply safety's `hour_limit` (AU20). */
  async countSentPublicRepliesSince({
    organizationId,
    since,
  }: {
    organizationId: number;
    since: Date;
  }): Promise<number> {
    const [row] = await this.db()
      .select({ total: count() })
      .from(automation_comment_logs)
      .where(
        and(
          eq(automation_comment_logs.organization_id, organizationId),
          SENT_PUBLIC_REPLY,
          gt(automation_comment_logs.public_reply_at, since),
        ),
      );
    return row?.total ?? 0;
  }

  /** When the organization's last public reply went; `null` when none — reply safety's `gap` (AU20). */
  async findLastSentPublicReplyAt({
    organizationId,
  }: {
    organizationId: number;
  }): Promise<Date | null> {
    const rows = await this.db()
      .select({ public_reply_at: automation_comment_logs.public_reply_at })
      .from(automation_comment_logs)
      .where(and(eq(automation_comment_logs.organization_id, organizationId), SENT_PUBLIC_REPLY))
      .orderBy(desc(automation_comment_logs.public_reply_at))
      .limit(1);
    return rows[0]?.public_reply_at ?? null;
  }

  /** The automation's last public reply text; `null` when it sent none (AU20: never repeated). */
  async findLastSentPublicReplyText({
    organizationId,
    automationId,
  }: {
    organizationId: number;
    automationId: number;
  }): Promise<string | null> {
    const rows = await this.db()
      .select({ public_reply_text: automation_comment_logs.public_reply_text })
      .from(automation_comment_logs)
      .where(
        and(
          eq(automation_comment_logs.organization_id, organizationId),
          eq(automation_comment_logs.automation_id, automationId),
          SENT_PUBLIC_REPLY,
        ),
      )
      .orderBy(desc(automation_comment_logs.public_reply_at))
      .limit(1);
    return rows[0]?.public_reply_text ?? null;
  }
}

/** {@link AutomationCommentLogRepository} bound to a job's organization handle — the run engine. */
export function createWorkerAutomationCommentLogRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationCommentLogRepository {
  assertWorkerDatabaseContext(['organization']);
  return new AutomationCommentLogRepository(databaseHandle);
}

/**
 * {@link AutomationCommentLogRepository} bound to a retention handle (`runGlobalRetentionWorkerJob`)
 * — comment-log retention's cross-organization delete, through the sweep arm the policy carries in
 * `USING` only.
 */
export function createRetentionAutomationCommentLogRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationCommentLogRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new AutomationCommentLogRepository(databaseHandle);
}
