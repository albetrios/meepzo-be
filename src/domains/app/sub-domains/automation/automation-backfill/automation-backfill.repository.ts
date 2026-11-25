import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  RESOURCE_QUOTA_LOCK_NAMESPACE,
  acquireResourceQuotaLock,
} from '@/infrastructure/database/resource-quota-lock.util.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { databaseUpdatedAtTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import {
  AUTOMATION_BACKFILL_LAST_ERROR_MAX_LENGTH,
  AUTOMATION_BACKFILL_OPEN_STATUSES,
  type AutomationBackfillFailReason,
} from './automation-backfill.constants.js';
import { automation_backfills } from './automation-backfill.schema.js';

/** One `app.automation_backfills` row as Drizzle reads it. */
export type AutomationBackfillRow = typeof automation_backfills.$inferSelect;

/** `updated_at` of a read's change: never before its `created_at`. */
const backfillUpdatedAtTimestamp = databaseUpdatedAtTimestamp(automation_backfills.created_at);

/** A read's organization and internal id. */
export interface AutomationBackfillKey {
  organizationId: number;
  automationBackfillId: number;
}

/**
 * The automation fields a past-comments read works from (AU32): which posts it reads and which
 * comments it counts as matched.
 */
export interface AutomationBackfillReadTarget {
  automationPublicId: string;
  /** `live` · `paused` · `draft`; `null` once the automation is deleted. */
  status: string | null;
  trigger_type: string;
  target_scope: string;
  target_instagram_media_id: string | null;
  target_starts_at: Date | null;
  target_ends_at: Date | null;
  keywords: string[];
  ad_id: string | null;
}

/** One account the watch wakes (AU32): its organization and account public ids. */
export interface AutomationBackfillStuckAccount {
  organizationPublicId: string;
  channelAccountPublicId: string;
}

/** A read's start (`started_at`) as the job carries it — equal to the column cut to milliseconds. */
function startedAtIs(startedAt: Date) {
  return sql`date_trunc('milliseconds', ${automation_backfills.started_at}) = ${startedAt.toISOString()}::timestamptz`;
}

/** The unique index route 38's race loser hits — one queued or reading read per automation. */
export const AUTOMATION_BACKFILL_OPEN_INDEX = 'idx_automation_backfills_open';

/**
 * Drizzle access to `app.automation_backfills` (feat-instagram-dm-sending routes-final § 4.C.3):
 * route 38's insert, route 39's read and the automation's open read; the read job's account lock,
 * start, counters and end, and the watch's read across organizations (ROUTE row R41).
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

  /**
   * Takes the account's read lock for the rest of the transaction (AU32): one read at a time per
   * account — the start of a read checks and changes the account's rows under it.
   */
  async lockAccountReads({
    organizationId,
    channelAccountId,
  }: {
    organizationId: number;
    channelAccountId: number;
  }): Promise<void> {
    await acquireResourceQuotaLock({
      namespace: RESOURCE_QUOTA_LOCK_NAMESPACE.AUTOMATION_BACKFILL_READ,
      key: `${organizationId}:${channelAccountId}`,
      databaseHandle: this.db(),
    });
  }

  /** The account's `reading` read; `null` when none runs. */
  async findReadingByAccount({
    organizationId,
    channelAccountId,
  }: {
    organizationId: number;
    channelAccountId: number;
  }): Promise<AutomationBackfillRow | null> {
    const rows = await this.db()
      .select()
      .from(automation_backfills)
      .where(
        and(
          eq(automation_backfills.organization_id, organizationId),
          eq(automation_backfills.channel_account_id, channelAccountId),
          eq(automation_backfills.status, 'reading'),
        ),
      )
      .orderBy(asc(automation_backfills.created_at), asc(automation_backfills.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** The account's oldest `queued` read (`idx_automation_backfills_account_queued`); `null` when none. */
  async findOldestQueuedByAccount({
    organizationId,
    channelAccountId,
  }: {
    organizationId: number;
    channelAccountId: number;
  }): Promise<AutomationBackfillRow | null> {
    const rows = await this.db()
      .select()
      .from(automation_backfills)
      .where(
        and(
          eq(automation_backfills.organization_id, organizationId),
          eq(automation_backfills.channel_account_id, channelAccountId),
          eq(automation_backfills.status, 'queued'),
        ),
      )
      .orderBy(asc(automation_backfills.created_at), asc(automation_backfills.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Moves a `queued` or `reading` read to `reading` from the start (AU32): `started_at` now, the
   * counters back to 0 (a read started again counts again). Returns the row, or `null` when it is no
   * longer open.
   */
  async startReading({
    organizationId,
    automationBackfillId,
  }: AutomationBackfillKey): Promise<AutomationBackfillRow | null> {
    const rows = await this.db()
      .update(automation_backfills)
      .set({
        status: 'reading',
        started_at: sql`clock_timestamp()`,
        posts_read: 0,
        found: 0,
        matched: 0,
        queued_count: 0,
        last_error: null,
        updated_at: sql`greatest(${automation_backfills.created_at}, clock_timestamp())`,
      })
      .where(
        and(
          eq(automation_backfills.organization_id, organizationId),
          eq(automation_backfills.id, automationBackfillId),
          inArray(automation_backfills.status, [...AUTOMATION_BACKFILL_OPEN_STATUSES]),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Adds one post's numbers to a `reading` read of this start and marks the page (`updated_at` —
   * what the watch reads). Answers `false` when the read ended or was started again meanwhile.
   */
  async addReadProgress({
    organizationId,
    automationBackfillId,
    startedAt,
    postsRead,
    found,
    matched,
    queuedCount,
  }: AutomationBackfillKey & {
    startedAt: Date;
    postsRead: number;
    found: number;
    matched: number;
    queuedCount: number;
  }): Promise<boolean> {
    const rows = await this.db()
      .update(automation_backfills)
      .set({
        posts_read: sql`${automation_backfills.posts_read} + ${postsRead}`,
        found: sql`${automation_backfills.found} + ${found}`,
        matched: sql`${automation_backfills.matched} + ${matched}`,
        queued_count: sql`${automation_backfills.queued_count} + ${queuedCount}`,
        updated_at: sql`greatest(${automation_backfills.created_at}, clock_timestamp())`,
      })
      .where(
        and(
          eq(automation_backfills.organization_id, organizationId),
          eq(automation_backfills.id, automationBackfillId),
          eq(automation_backfills.status, 'reading'),
          startedAtIs(startedAt),
        ),
      )
      .returning({ id: automation_backfills.id });
    return rows.length > 0;
  }

  /**
   * Ends a `reading` read of this start: `done`, or `failed` with its reason and a code-only error
   * (cut to the column). Returns the row, or `null` when it already ended or was started again.
   */
  async finishReading({
    organizationId,
    automationBackfillId,
    startedAt,
    failure,
  }: AutomationBackfillKey & {
    startedAt: Date;
    /** `null` → `done`. */
    failure: { reason: AutomationBackfillFailReason; lastError: string | null } | null;
  }): Promise<AutomationBackfillRow | null> {
    const rows = await this.db()
      .update(automation_backfills)
      .set({
        status: failure === null ? 'done' : 'failed',
        fail_reason: failure?.reason ?? null,
        last_error: failure?.lastError?.slice(0, AUTOMATION_BACKFILL_LAST_ERROR_MAX_LENGTH) ?? null,
        done_at: sql`clock_timestamp()`,
        updated_at: sql`greatest(${automation_backfills.created_at}, clock_timestamp())`,
      })
      .where(
        and(
          eq(automation_backfills.organization_id, organizationId),
          eq(automation_backfills.id, automationBackfillId),
          eq(automation_backfills.status, 'reading'),
          startedAtIs(startedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Ends every open read of the organization — of the given accounts, or all — `failed` ·
   * `plan_feature_off` (a move down that turns `past_comments` off, WC-38). Returns the rows.
   */
  async failOpenForPlanFeatureOff({
    organizationId,
    channelAccountIds,
  }: {
    organizationId: number;
    /** `undefined` → every account of the organization. */
    channelAccountIds?: readonly number[] | undefined;
  }): Promise<AutomationBackfillRow[]> {
    return this.db()
      .update(automation_backfills)
      .set({
        status: 'failed',
        fail_reason: 'plan_feature_off',
        last_error: null,
        done_at: sql`clock_timestamp()`,
        updated_at: backfillUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(automation_backfills.organization_id, organizationId),
          inArray(automation_backfills.status, [...AUTOMATION_BACKFILL_OPEN_STATUSES]),
          channelAccountIds === undefined
            ? undefined
            : inArray(automation_backfills.channel_account_id, [...channelAccountIds]),
        ),
      )
      .returning();
  }

  /**
   * The automation fields a read works from (AU32), deleted ones included (`status` `null`); `null`
   * when the automation row is gone.
   */
  async findReadTarget({
    organizationId,
    automationId,
  }: {
    organizationId: number;
    automationId: number;
  }): Promise<AutomationBackfillReadTarget | null> {
    const rows = await this.db()
      .select({
        automationPublicId: automations.public_id,
        status: sql<
          string | null
        >`CASE WHEN ${automations.deleted_at} IS NULL THEN ${automations.status} END`,
        trigger_type: automations.trigger_type,
        target_scope: automations.target_scope,
        target_instagram_media_id: automations.target_instagram_media_id,
        target_starts_at: automations.target_starts_at,
        target_ends_at: automations.target_ends_at,
        keywords: automations.keywords,
        ad_id: automations.ad_id,
      })
      .from(automations)
      .where(and(eq(automations.organization_id, organizationId), eq(automations.id, automationId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The watch's read across organizations (AU32): the accounts with a `reading` read whose last page
   * is older than `stuckReadBefore`, or a `queued` one older than `stuckQueuedBefore`
   * (`idx_automation_backfills_watch`), of live organizations — once per account, at most `limit`.
   * Runs only on a retention handle ({@link createRetentionAutomationBackfillRepository}).
   */
  async listAccountsWithStuckReads({
    stuckReadBefore,
    stuckQueuedBefore,
    limit,
  }: {
    stuckReadBefore: Date;
    stuckQueuedBefore: Date;
    limit: number;
  }): Promise<AutomationBackfillStuckAccount[]> {
    return this.db()
      .selectDistinct({
        organizationPublicId: organizations.public_id,
        channelAccountPublicId: channel_accounts.public_id,
      })
      .from(automation_backfills)
      .innerJoin(organizations, eq(organizations.id, automation_backfills.organization_id))
      .innerJoin(
        channel_accounts,
        and(
          eq(channel_accounts.organization_id, automation_backfills.organization_id),
          eq(channel_accounts.id, automation_backfills.channel_account_id),
        ),
      )
      .where(
        and(
          isNull(organizations.deleted_at),
          or(
            and(
              eq(automation_backfills.status, 'reading'),
              lt(automation_backfills.updated_at, stuckReadBefore),
            ),
            and(
              eq(automation_backfills.status, 'queued'),
              lt(automation_backfills.updated_at, stuckQueuedBefore),
            ),
          ),
        ),
      )
      .limit(limit);
  }
}

/**
 * {@link AutomationBackfillRepository} bound to a retention handle (`runGlobalRetentionWorkerJob`) —
 * the watch, which reads every organization's open reads (the sweep arm is in the policy's `USING`).
 */
export function createRetentionAutomationBackfillRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationBackfillRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new AutomationBackfillRepository(databaseHandle);
}
