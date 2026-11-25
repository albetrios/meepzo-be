import {
  and,
  arrayOverlaps,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  sql,
  type SQL,
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
import {
  type CursorTimestampRow,
  cursorTimestampSelection,
} from '@/shared/utils/http/pagination.util.js';
import {
  buildSearchCondition,
  finishKeysetPage,
  resolveKeysetSort,
} from '@/shared/utils/http/list-query.util.js';
import type { RecordDeleteReason } from '@/shared/constants/record-fields.constants.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import {
  AUTOMATION_LAST_TRIGGERED_UPDATE_SECONDS,
  type AutomationStatus,
  type AutomationTriggerType,
} from './automation.constants.js';
import { automations } from './automation.schema.js';
import type {
  AutomationRepositoryListQuery,
  AutomationWritableFields,
} from './automation.types.js';

/**
 * One account the "next post" linking sweep reads (WC-43, AUC3): its organization and account public
 * ids, its channel, and the earliest go-live of its waiting "my next post" automations — the oldest
 * publish time a post it links can have.
 */
export interface AutomationPostLinkingAccount {
  organizationPublicId: string;
  channelAccountPublicId: string;
  channel: string;
  postsSince: Date;
}

/** `updated_at` for every change of an automation — never before the row's `created_at`. */
const automationUpdatedAtTimestamp = databaseUpdatedAtTimestamp(automations.created_at);

/** One `app.automations` row as Drizzle reads it. */
export type AutomationRow = typeof automations.$inferSelect;

/** An automation row with its channel account's public id (`cha_…`). */
export type AutomationWithAccountRow = AutomationRow & {
  channel_account_public_id: string;
};

/**
 * An automation list row: the automation, its account's public id, the cursor timestamp
 * (`created_at`) and the `last_triggered_at` sort value as microsecond text (`null` when never
 * triggered).
 */
export type AutomationListRow = AutomationWithAccountRow &
  CursorTimestampRow & {
    cursor_last_triggered_at: string | null;
  };

/** One page of the automation list as the repository returns it. */
export interface AutomationListPage {
  items: AutomationListRow[];
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}

/** The two keys every single-automation statement names: its organization and its internal id. */
export interface AutomationKey {
  /** `tenancy.organizations.id`. */
  organizationId: number;
  /** `app.automations.id`. */
  automationId: number;
}

/** The account-wide keys of the go-live checks: the organization and the channel account. */
export interface AutomationAccountKey {
  organizationId: number;
  /** `app.channel_accounts.id`. */
  channelAccountId: number;
  /** The automation being checked — left out of every "another automation" read. */
  excludedAutomationId: number;
}

/** What a create inserts: the merged automation, its account and who created it (AU11). */
export interface AutomationInsertValues {
  organizationId: number;
  channelAccountId: number;
  channel: string;
  fields: AutomationWritableFields;
  /** `auth.users.id` of the caller; `null` for an API key. */
  createdByUserId: number | null;
}

/** What an action (go live, pause) writes besides the status (AU13, AU14). */
export interface AutomationStateChange {
  status: AutomationStatus;
  /** A `next` automation going live: the go-live time and `waiting` (AU20); absent leaves them. */
  nextPost?: { targetStartsAt: Date } | undefined;
  /** Pause + Cancel (AU14): `now()`; absent leaves it. */
  isCancelledBeforeNow?: boolean | undefined;
}

/** The other automation of an account a go-live check names: its public id and name. */
export interface AutomationNamedRow {
  public_id: string;
  name: string;
}

/** The live guard every route read and write carries: a deleted one is never seen (AU16). */
const LIVE_AUTOMATION = isNull(automations.deleted_at);

/** The join to the automation's own channel account, inside the same organization. */
const OWN_CHANNEL_ACCOUNT = and(
  eq(channel_accounts.organization_id, automations.organization_id),
  eq(channel_accounts.id, automations.channel_account_id),
);

/**
 * The internal id of the organization's channel account with this public id — `NULL` when there is
 * none, so a condition on it matches nothing (an unknown account is an empty page, AU10).
 */
function channelAccountIdByPublicId({
  organizationId,
  channelAccountPublicId,
}: {
  organizationId: number;
  channelAccountPublicId: string;
}): SQL {
  return sql`(SELECT ${channel_accounts.id} FROM ${channel_accounts}
    WHERE ${channel_accounts.organization_id} = ${organizationId}
      AND ${channel_accounts.public_id} = ${channelAccountPublicId})`;
}

/** The columns a save writes from the merged automation — never the status, account or counters. */
function toWrittenColumns(fields: AutomationWritableFields) {
  return {
    name: fields.name,
    trigger_type: fields.trigger_type,
    also_start_from: [...fields.also_start_from],
    target_scope: fields.target_scope,
    target_instagram_media_id: fields.target_instagram_media_id,
    target_instagram_story_id: fields.target_instagram_story_id,
    target_starts_at: fields.target_starts_at,
    target_ends_at: fields.target_ends_at,
    keywords: [...fields.keywords],
    ref_code: fields.ref_code,
    starter_questions: [...fields.starter_questions],
    ad_id: fields.ad_id,
    trigger_tag: fields.trigger_tag,
    default_reply_mode: fields.default_reply_mode,
    is_public_reply_enabled: fields.is_public_reply_enabled,
    public_reply_texts: [...fields.public_reply_texts],
    is_public_reply_mention_enabled: fields.is_public_reply_mention_enabled,
    is_reply_like_person_enabled: fields.is_reply_like_person_enabled,
    public_reply_hour_limit: fields.public_reply_hour_limit,
    is_hide_comment_after_direct_message_enabled:
      fields.is_hide_comment_after_direct_message_enabled,
    steps: fields.steps,
  } satisfies PgUpdateSetSource<typeof automations>;
}

/**
 * Drizzle access to `app.automations` (feat-instagram-dm-sending routes-final § 4.A.3, AUC5–AUC8):
 * the list of one account (route 27), the read (29), the create, edit, actions and soft delete
 * (28, 30–34), the account-wide go-live reads (catch-all, starter questions, ref code, shared
 * keywords), the keyword test's candidates (35), "next post" linking, the contacts filter's id
 * lookup and the deleted-automation purge.
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id`, and a single-automation statement the
 *   internal `id` too, so tenant isolation does not rest on RLS alone. Every route read and write
 *   carries `deleted_at IS NULL`. The run engine (4.B, ROUTE row R14) reads its candidates, locks
 *   and the automation as it is now through {@link AutomationRepository.listRunCandidates},
 *   {@link AutomationRepository.lockForRunChanges} and {@link AutomationRepository.findByIdIncludingDeleted}.
 * - **Failure modes:** a value that breaks a `chk_automations_*` CHECK throws Postgres 23514; the
 *   unique `idx_automations_account_ref_code` throws 23505 — the service checks every rule first.
 * - **Side effects:** reads `app.channel_accounts` (the account's public id — a join-only use of
 *   sub-domain 1B's schema inside the same domain); writes `app.automations` only.
 * - **Notes:** HTTP paths run inside the caller's `withAppDatabaseContext`; the purge binds a
 *   retention handle ({@link createRetentionAutomationRepository}).
 */
export class AutomationRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /**
   * One page of one account's live automations (route 27, AU10): the status and kind filters, `q`
   * over the name (trigram index), the keyset sort — `created_at`, `name`, `last_triggered_at`
   * nulls last both ways.
   */
  async list({
    organizationId,
    query,
  }: {
    organizationId: number;
    query: AutomationRepositoryListQuery;
  }): Promise<AutomationListPage> {
    const where = and(
      eq(automations.organization_id, organizationId),
      eq(
        automations.channel_account_id,
        channelAccountIdByPublicId({
          organizationId,
          channelAccountPublicId: query.channelAccountPublicId,
        }),
      ),
      LIVE_AUTOMATION,
      query.statuses.length === 0 ? undefined : inArray(automations.status, query.statuses),
      query.triggerTypes.length === 0
        ? undefined
        : inArray(automations.trigger_type, query.triggerTypes),
      buildSearchCondition({ columns: [automations.name], q: query.q }),
    );
    const { orderBy, cursorCondition, sortValueFor, filterFingerprint } =
      resolveKeysetSort<AutomationListRow>({
        columns: {
          created_at: { column: automations.created_at, kind: 'created_at' },
          name: { column: automations.name, kind: 'text', getSortValue: (row) => row.name },
          last_triggered_at: {
            column: automations.last_triggered_at,
            kind: 'created_at',
            nulls: 'last',
            getSortValue: (row) => row.cursor_last_triggered_at,
          },
        },
        idColumn: automations.id,
        defaultSort: 'created_at',
        sort: query.sort,
        order: query.order,
        q: query.q,
        filters: {
          channel_account_id: query.channelAccountPublicId,
          status: query.statuses.join(','),
          trigger_type: query.triggerTypes.join(','),
        },
        after: query.after,
      });
    const rows = (await this.db()
      .select({
        ...getTableColumns(automations),
        channel_account_public_id: channel_accounts.public_id,
        cursor_created_at: cursorTimestampSelection(automations.created_at),
        cursor_last_triggered_at: cursorTimestampSelection(automations.last_triggered_at) as SQL<
          string | null
        >,
      })
      .from(automations)
      .innerJoin(channel_accounts, OWN_CHANNEL_ACCOUNT)
      .where(and(where, cursorCondition))
      .orderBy(...orderBy)
      .limit(query.limit + 1)) as AutomationListRow[];
    return finishKeysetPage({
      rows,
      args: { limit: query.limit, sortValueFor, filterFingerprint },
    });
  }

  /** How many live automations one account has (route 27's `meta.totals.live_count`, AU10). */
  async countLiveOfAccount({
    organizationId,
    channelAccountPublicId,
  }: {
    organizationId: number;
    channelAccountPublicId: string;
  }): Promise<{ channelAccountId: number | null; liveCount: number }> {
    const accounts = await this.db()
      .select({ id: channel_accounts.id })
      .from(channel_accounts)
      .where(
        and(
          eq(channel_accounts.organization_id, organizationId),
          eq(channel_accounts.public_id, channelAccountPublicId),
        ),
      )
      .limit(1);
    const channelAccountId = accounts[0]?.id ?? null;
    if (channelAccountId === null) return { channelAccountId, liveCount: 0 };
    const [row] = await this.db()
      .select({ count: sql<number>`count(*)::int` })
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.channel_account_id, channelAccountId),
          eq(automations.status, 'live'),
          LIVE_AUTOMATION,
        ),
      );
    return { channelAccountId, liveCount: row?.count ?? 0 };
  }

  /**
   * The organization's live automation with this public id and its account's public id (route 29);
   * `null` when absent, deleted or another organization's.
   */
  async findLiveByPublicId({
    organizationId,
    automationPublicId,
  }: {
    organizationId: number;
    automationPublicId: string;
  }): Promise<AutomationWithAccountRow | null> {
    const rows = await this.db()
      .select({
        ...getTableColumns(automations),
        channel_account_public_id: channel_accounts.public_id,
      })
      .from(automations)
      .innerJoin(channel_accounts, OWN_CHANNEL_ACCOUNT)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.public_id, automationPublicId),
          LIVE_AUTOMATION,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The organization's live automation with this public id, locked `FOR UPDATE` for an edit, an
   * action or a delete (routes 30–34) — the automation row only; a unit of the run engine that holds
   * it `FOR KEY SHARE` is waited for (D47). `null` when absent, deleted or another organization's.
   */
  async lockLiveByPublicId({
    organizationId,
    automationPublicId,
  }: {
    organizationId: number;
    automationPublicId: string;
  }): Promise<AutomationWithAccountRow | null> {
    // A scalar subquery, not a join: the lock is a plain `FOR UPDATE` on the one table in FROM.
    const rows = await this.db()
      .select({
        ...getTableColumns(automations),
        channel_account_public_id: sql<string>`(${this.db()
          .select({ public_id: channel_accounts.public_id })
          .from(channel_accounts)
          .where(OWN_CHANNEL_ACCOUNT)})`,
      })
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.public_id, automationPublicId),
          LIVE_AUTOMATION,
        ),
      )
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /** Inserts a new `draft` (routes 28, 34) with its account and creator; returns the row. */
  async insert(values: AutomationInsertValues): Promise<AutomationRow> {
    const rows = await runInsertWithPublicIdentifierRetry({
      insert: () =>
        this.db()
          .insert(automations)
          .values({
            ...toWrittenColumns(values.fields),
            public_id: generatePublicId('automation'),
            organization_id: values.organizationId,
            channel_account_id: values.channelAccountId,
            channel: values.channel,
            status: 'draft',
            created_by_user_id: values.createdByUserId,
            updated_by_user_id: values.createdByUserId,
          })
          .returning(),
    });
    const row = rows[0];
    if (row === undefined) {
      throw new Error('automation insert returned no row');
    }
    return row;
  }

  /**
   * Writes the merged automation over a live one (route 30) with the "next post" state it leaves,
   * stamping the editor and `updated_at`; the status, account and counters are never touched. A fixed text clears the automatic stop when
   * `isStopCleared` (AU12). `null` when it was deleted meanwhile.
   */
  async update({
    organizationId,
    automationId,
    fields,
    updatedByUserId,
    isStopCleared,
    nextPost,
  }: AutomationKey & {
    fields: AutomationWritableFields;
    updatedByUserId: number | null;
    isStopCleared: boolean;
    /** The "next post" state the save leaves (AU20): `waiting` / `linked` on a live or paused `next`. */
    nextPost: { status: string | null; linkedAt: Date | null };
  }): Promise<AutomationRow | null> {
    const rows = await this.db()
      .update(automations)
      .set({
        ...toWrittenColumns(fields),
        next_post_status: nextPost.status,
        next_post_linked_at: nextPost.linkedAt,
        ...(isStopCleared ? { stopped_reason: null, stopped_at: null } : {}),
        updated_by_user_id: updatedByUserId,
        updated_at: automationUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.id, automationId),
          LIVE_AUTOMATION,
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * An action's write (routes 32, 33 — AU13, AU14): the new status, a `next` automation's go-live
   * time and `waiting`, Pause + Cancel's `cancelled_before_at = now()`, the actor as last editor.
   * `null` when it was deleted meanwhile.
   */
  async changeState({
    organizationId,
    automationId,
    change,
    updatedByUserId,
  }: AutomationKey & {
    change: AutomationStateChange;
    updatedByUserId: number | null;
  }): Promise<AutomationRow | null> {
    const rows = await this.db()
      .update(automations)
      .set({
        status: change.status,
        ...(change.nextPost === undefined
          ? {}
          : {
              target_starts_at: change.nextPost.targetStartsAt,
              target_ends_at: null,
              next_post_status: 'waiting',
              next_post_linked_at: null,
              target_instagram_media_id: null,
            }),
        ...(change.isCancelledBeforeNow === true
          ? { cancelled_before_at: databaseNowTimestamp }
          : {}),
        updated_by_user_id: updatedByUserId,
        updated_at: automationUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.id, automationId),
          LIVE_AUTOMATION,
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Soft-deletes a live automation (route 31, AU16): `deleted_at`, the optional reason and note, the
   * caller as last editor. `null` when it was already deleted.
   */
  async softDelete({
    organizationId,
    automationId,
    reason,
    note,
    updatedByUserId,
  }: AutomationKey & {
    reason: RecordDeleteReason | null;
    note: string | null;
    updatedByUserId: number | null;
  }): Promise<AutomationRow | null> {
    const rows = await this.db()
      .update(automations)
      .set({
        deleted_at: databaseNowTimestamp,
        delete_reason: reason,
        delete_note: note,
        updated_by_user_id: updatedByUserId,
        updated_at: automationUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.id, automationId),
          LIVE_AUTOMATION,
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** The account's other live automation of one catch-all way to start (go-live check 10), oldest first. */
  async findOtherLiveOfTriggerType({
    organizationId,
    channelAccountId,
    excludedAutomationId,
    triggerType,
  }: AutomationAccountKey & {
    triggerType: AutomationTriggerType;
  }): Promise<AutomationNamedRow | null> {
    const rows = await this.db()
      .select({ public_id: automations.public_id, name: automations.name })
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.channel_account_id, channelAccountId),
          eq(automations.status, 'live'),
          eq(automations.trigger_type, triggerType),
          LIVE_AUTOMATION,
          ne(automations.id, excludedAutomationId),
        ),
      )
      .orderBy(asc(automations.created_at), asc(automations.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** The starter questions of the account's other live automations (go-live check 8, D42). */
  async listOtherLiveStarterQuestions({
    organizationId,
    channelAccountId,
    excludedAutomationId,
  }: AutomationAccountKey): Promise<string[]> {
    const rows = await this.db()
      .select({ questions: automations.starter_questions })
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.channel_account_id, channelAccountId),
          eq(automations.status, 'live'),
          eq(automations.trigger_type, 'starter_question'),
          LIVE_AUTOMATION,
          ne(automations.id, excludedAutomationId),
        ),
      );
    return rows.flatMap((row) => row.questions);
  }

  /**
   * The account's live starter-question automations with their questions, oldest first — the whole
   * ice-breaker list the starter-question sync writes (WC-31, IA6).
   */
  async listLiveStarterQuestionAutomations({
    organizationId,
    channelAccountId,
  }: Omit<AutomationAccountKey, 'excludedAutomationId'>): Promise<
    Array<{ publicId: string; questions: string[] }>
  > {
    return this.db()
      .select({ publicId: automations.public_id, questions: automations.starter_questions })
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.channel_account_id, channelAccountId),
          eq(automations.status, 'live'),
          eq(automations.trigger_type, 'starter_question'),
          LIVE_AUTOMATION,
        ),
      )
      .orderBy(asc(automations.created_at), asc(automations.id));
  }

  /** The account's other automation holding this `ref_code`, drafts included (D43); `null` when none. */
  async findOtherWithRefCode({
    organizationId,
    channelAccountId,
    excludedAutomationId,
    refCode,
  }: Omit<AutomationAccountKey, 'excludedAutomationId'> & {
    excludedAutomationId: number | null;
    refCode: string;
  }): Promise<AutomationNamedRow | null> {
    const rows = await this.db()
      .select({ public_id: automations.public_id, name: automations.name })
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.channel_account_id, channelAccountId),
          eq(automations.ref_code, refCode),
          LIVE_AUTOMATION,
          excludedAutomationId === null ? undefined : ne(automations.id, excludedAutomationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The account's other live automations sharing a keyword (the go-live warning, D39). */
  async listOtherLiveSharingKeywords({
    organizationId,
    channelAccountId,
    excludedAutomationId,
    keywords,
  }: AutomationAccountKey & { keywords: readonly string[] }): Promise<
    (AutomationNamedRow & { keywords: string[] })[]
  > {
    if (keywords.length === 0) return [];
    return this.db()
      .select({
        public_id: automations.public_id,
        name: automations.name,
        keywords: automations.keywords,
      })
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.channel_account_id, channelAccountId),
          eq(automations.status, 'live'),
          LIVE_AUTOMATION,
          ne(automations.id, excludedAutomationId),
          arrayOverlaps(automations.keywords, [...keywords]),
        ),
      )
      .orderBy(asc(automations.created_at), asc(automations.id));
  }

  /** The account's live automations, oldest first — the keyword test's match order (route 35, AU17). */
  async listLiveOfAccount({
    organizationId,
    channelAccountId,
  }: {
    organizationId: number;
    channelAccountId: number;
  }): Promise<AutomationRow[]> {
    return this.db()
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.channel_account_id, channelAccountId),
          eq(automations.status, 'live'),
          LIVE_AUTOMATION,
        ),
      )
      .orderBy(asc(automations.created_at), asc(automations.id));
  }

  /**
   * Links a new post to every live, waiting "next post" automation of the post's account that went
   * live at or before its publish time (AU20, P12 — no end date), unless an automation of that
   * account targeted the post before this statement. One conditional `UPDATE`: a linked automation
   * never links again. Returns the linked automations' public ids.
   */
  async linkNextPost({
    organizationId,
    channelAccountPublicId,
    instagramMediaId,
    publishedAt,
  }: {
    organizationId: number;
    channelAccountPublicId: string;
    instagramMediaId: string;
    publishedAt: Date;
  }): Promise<string[]> {
    const accountId = channelAccountIdByPublicId({ organizationId, channelAccountPublicId });
    const rows = await this.db()
      .update(automations)
      .set({
        next_post_status: 'linked',
        target_instagram_media_id: instagramMediaId,
        next_post_linked_at: databaseNowTimestamp,
        updated_at: automationUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.channel_account_id, accountId),
          eq(automations.status, 'live'),
          eq(automations.next_post_status, 'waiting'),
          LIVE_AUTOMATION,
          lte(automations.target_starts_at, publishedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM ${automations} AS targeted
            WHERE targeted.organization_id = ${organizationId}
              AND targeted.channel_account_id = ${accountId}
              AND targeted.target_instagram_media_id = ${instagramMediaId}
              AND targeted.deleted_at IS NULL
          )`,
        ),
      )
      .returning({ public_id: automations.public_id });
    return rows.map((row) => row.public_id);
  }

  /**
   * The organization's automation with this public id, deleted ones included — the contacts list's
   * filter (CT5, its runs stay); `null` when absent or another organization's.
   */
  async findByPublicIdIncludingDeleted({
    organizationId,
    automationPublicId,
  }: {
    organizationId: number;
    automationPublicId: string;
  }): Promise<AutomationRow | null> {
    const rows = await this.db()
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.public_id, automationPublicId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The run engine's candidates (4.B): the account's live automations that are not stopped
   * (`stopped_reason`, AU3 — a stopped one sends nothing until fixed), oldest first; the engine
   * matches in memory (an account holds few).
   */
  async listRunCandidates({
    organizationId,
    channelAccountId,
  }: {
    organizationId: number;
    channelAccountId: number;
  }): Promise<AutomationRow[]> {
    return this.db()
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.channel_account_id, channelAccountId),
          eq(automations.status, 'live'),
          LIVE_AUTOMATION,
          isNull(automations.stopped_reason),
        ),
      )
      .orderBy(asc(automations.created_at), asc(automations.id));
  }

  /** The organization's automation with this internal id, deleted ones included; `null` when absent. */
  async findByIdIncludingDeleted({
    organizationId,
    automationId,
  }: AutomationKey): Promise<AutomationRow | null> {
    const rows = await this.db()
      .select()
      .from(automations)
      .where(and(eq(automations.organization_id, organizationId), eq(automations.id, automationId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Locks automations `FOR KEY SHARE`, by id ascending, until the unit ends — what the run engine,
   * the contact erase and pause take before they lock or change a run of them (D47: the contact,
   * then the automation, then its runs). Nothing to lock is a no-op.
   */
  async lockForRunChanges({
    organizationId,
    automationIds,
  }: {
    organizationId: number;
    automationIds: readonly number[];
  }): Promise<void> {
    if (automationIds.length === 0) return;
    await this.db()
      .select({ id: automations.id })
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          inArray(automations.id, [...automationIds]),
        ),
      )
      .orderBy(asc(automations.id))
      .for('key share');
  }

  /**
   * The automation a run is about to start on, locked `FOR KEY SHARE` until the unit ends — proof it
   * is still live and not stopped; `null` otherwise: nothing starts.
   */
  async lockLiveForRunStart({
    organizationId,
    automationId,
  }: AutomationKey): Promise<AutomationRow | null> {
    const rows = await this.db()
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.id, automationId),
          eq(automations.status, 'live'),
          LIVE_AUTOMATION,
          isNull(automations.stopped_reason),
        ),
      )
      .limit(1)
      .for('key share');
    return rows[0] ?? null;
  }

  /**
   * Moves `last_triggered_at` to now when a run starts — only when over 60 s old
   * (`AUTOMATION_LAST_TRIGGERED_UPDATE_SECONDS`, AU19); `updated_at` is left as it is.
   */
  async markRunStarted({ organizationId, automationId }: AutomationKey): Promise<void> {
    await this.db()
      .update(automations)
      .set({ last_triggered_at: databaseNowTimestamp })
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.id, automationId),
          sql`(${automations.last_triggered_at} IS NULL OR ${automations.last_triggered_at} < now() - make_interval(secs => ${AUTOMATION_LAST_TRIGGERED_UPDATE_SECONDS}))`,
        ),
      );
  }

  /**
   * The "next post" linking sweep's read across organizations (WC-43, AUC3): the connected channel
   * accounts of live organizations with a live waiting "my next post" automation
   * (`idx_automations_next_post_waiting`) — each once, with the earliest go-live among them.
   * Needs the retention context ({@link createRetentionAutomationRepository}): the sweep arm is in
   * the policies' `USING`, so it reads every organization's rows and can change none.
   */
  async listAccountsForPostLinking({
    limit,
  }: {
    limit: number;
  }): Promise<AutomationPostLinkingAccount[]> {
    const rows = await this.db()
      .select({
        organizationPublicId: organizations.public_id,
        channelAccountPublicId: channel_accounts.public_id,
        channel: channel_accounts.channel,
        postsSince: sql<string>`min(${automations.target_starts_at})`,
      })
      .from(automations)
      .innerJoin(channel_accounts, OWN_CHANNEL_ACCOUNT)
      .innerJoin(organizations, eq(organizations.id, automations.organization_id))
      .where(
        and(
          LIVE_AUTOMATION,
          eq(automations.status, 'live'),
          eq(automations.next_post_status, 'waiting'),
          isNotNull(automations.target_starts_at),
          eq(channel_accounts.connection_status, 'connected'),
          isNull(organizations.deleted_at),
        ),
      )
      .groupBy(
        organizations.public_id,
        channel_accounts.public_id,
        channel_accounts.channel,
        channel_accounts.id,
      )
      .orderBy(channel_accounts.id)
      .limit(limit);
    return rows.map((row) => ({ ...row, postsSince: new Date(row.postsSince) }));
  }

  /**
   * The deleted-automation purge (WC-47): deletes every automation deleted before `cutoff`, in
   * capped batches (`idx_automations_tombstoned`). Counts and reply states go by cascade, the two
   * contact keys are set null; one a run or a comment log still points at (`RESTRICT`) is skipped
   * and counted `blockedCount`. Needs the retention context ({@link createRetentionAutomationRepository}).
   */
  async deleteTombstonedBefore(cutoff: Date): Promise<BatchDeleteResult> {
    return deleteInBatchesByCondition({
      databaseHandle: this.db(),
      table: automations,
      idColumn: automations.id,
      whereCondition: and(
        isNotNull(automations.deleted_at),
        lt(automations.deleted_at, cutoff),
      ) as SQL,
      logContext: 'automation-tombstone-retention',
      tableLabel: 'app.automations',
    });
  }
}

/** {@link AutomationRepository} bound to a job's organization handle (`runOrganizationScopedWorkerJob`). */
export function createWorkerAutomationRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationRepository {
  assertWorkerDatabaseContext(['organization']);
  return new AutomationRepository(databaseHandle);
}

/**
 * {@link AutomationRepository} bound to a retention handle (`runGlobalRetentionWorkerJob`) — the
 * deleted-automation purge, which deletes (the sweep arm is in the policy's `USING` only).
 */
export function createRetentionAutomationRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new AutomationRepository(databaseHandle);
}
