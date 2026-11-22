import {
  and,
  arrayOverlaps,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
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
import { countWithCap } from '@/infrastructure/database/utils/capped-count.util.js';
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
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { automations } from './automation.schema.js';
import type { AutomationMergedFields, AutomationRepositoryListQuery } from './automation.types.js';

/** `updated_at` for every change of a automation — never before the row's `created_at`. */
const automationUpdatedAtTimestamp = databaseUpdatedAtTimestamp(automations.created_at);

/** One `app.automations` row as Drizzle reads it. */
export type AutomationRow = typeof automations.$inferSelect;

/** An automation row with its Instagram account's public id (`iga_…`, AU27). */
export type AutomationWithAccountRow = AutomationRow & {
  instagram_account_public_id: string;
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
  total: number | null;
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

/** What a create inserts: the merged automation, its account and who created it (AU7, AU27). */
export interface AutomationInsertValues {
  organizationId: number;
  instagramAccountId: number;
  fields: AutomationMergedFields;
  /** `auth.users.id` of the caller; `null` for an API key. */
  createdByUserId: number | null;
}

/** The other live, waiting automation a save's "next post" window clashes with (AU9). */
export interface AutomationNextPostOverlap {
  public_id: string;
  name: string;
  keywords: string[];
  next_post_starts_at: Date;
  next_post_ends_at: Date;
}

/** One automation whose "next post" window ended while it still waited (AU15, WC-6). */
export interface AutomationNextPostExpiryCandidate {
  automationId: number;
  organizationId: number;
  organizationPublicId: string;
}

/** The live-automation guard every route read and write carries: a deleted one is never seen (AU12). */
const LIVE_AUTOMATION = isNull(automations.deleted_at);

/** The join to the automation's own account, inside the same organization (AU27). */
const OWN_INSTAGRAM_ACCOUNT = and(
  eq(instagram_accounts.organization_id, automations.organization_id),
  eq(instagram_accounts.id, automations.instagram_account_id),
);

/**
 * The internal id of the organization's Instagram account with this public id — `NULL` when there
 * is none, so a condition on it matches nothing (an unknown filter value is an empty page, AU13).
 */
function instagramAccountIdByPublicId({
  organizationId,
  instagramAccountPublicId,
}: {
  organizationId: number;
  instagramAccountPublicId: string;
}): SQL {
  return sql`(SELECT ${instagram_accounts.id} FROM ${instagram_accounts}
    WHERE ${instagram_accounts.organization_id} = ${organizationId}
      AND ${instagram_accounts.public_id} = ${instagramAccountPublicId})`;
}

/** The columns a save writes from the merged automation (AU7) — never the counters or the account. */
function toWrittenColumns(fields: AutomationMergedFields) {
  return {
    name: fields.name,
    status: fields.status,
    trigger_type: fields.trigger_type,
    target_scope: fields.target_scope,
    target_instagram_media_id: fields.target_instagram_media_id,
    target_instagram_story_id: fields.target_instagram_story_id,
    next_post_starts_at: fields.next_post_starts_at,
    next_post_ends_at: fields.next_post_ends_at,
    next_post_status: fields.next_post_status,
    next_post_linked_at: fields.next_post_linked_at,
    is_dm_keyword_trigger_enabled: fields.is_dm_keyword_trigger_enabled,
    keywords: [...fields.keywords],
    tags: [...fields.tags],
    is_public_reply_enabled: fields.is_public_reply_enabled,
    public_reply_texts: [...fields.public_reply_texts],
    is_opening_message_enabled: fields.is_opening_message_enabled,
    opening_message: fields.opening_message,
    is_follow_required: fields.is_follow_required,
    follow_request_message: fields.follow_request_message,
    is_email_collection_enabled: fields.is_email_collection_enabled,
    email_request_message: fields.email_request_message,
    is_phone_collection_enabled: fields.is_phone_collection_enabled,
    phone_request_message: fields.phone_request_message,
    final_message: fields.final_message,
  } satisfies PgUpdateSetSource<typeof automations>;
}

/**
 * Drizzle access to `app.automations` (routes-final § 3.A.3, AUC5–AUC8): the list (route 11), the
 * read (13), the create, edit and soft delete (12, 14, 15), the "next post" overlap check, the
 * linking sub-domain 4 calls, the 15-minute expiry, the deleted-automation purge (AQ7), and the
 * run engine's reads, locks and counters (3.B —
 * the account's live candidates, an automation as it is now, the locks taken before a run's (AU12),
 * `last_triggered_at` and `completed_run_count`, AU10, AU16) and the contacts filter's id lookup
 * (CT5).
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id`, and a single-automation statement the
 *   internal `id` too, so tenant isolation does not rest on RLS alone. Every route read and write
 *   carries `deleted_at IS NULL` — a deleted automation is never seen or changed — and returns the
 *   changed row, or `null` when there was none. Linking and the expiry are one conditional
 *   `UPDATE` each (`next_post_status = 'waiting'`), so repeating them changes nothing.
 * - **Failure modes:** a value that breaks a `chk_automations_*` CHECK throws Postgres 23514 — the
 *   service checks every rule first.
 * - **Side effects:** reads `app.instagram_accounts` (the account's public id — a join-only use of
 *   sub-domain 1's schema inside the same domain) and `tenancy.organizations` (the expiry scan's
 *   organization public ids); writes `app.automations` only.
 * - **Notes:** HTTP paths run inside the caller's `withAppDatabaseContext`; the expiry's
 *   per-organization change binds a job handle ({@link createWorkerAutomationRepository}); its
 *   scan and the purge a retention handle ({@link createRetentionAutomationRepository}).
 */
export class AutomationRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /**
   * One page of the organization's live automations (route 11, AU13, AQ9): the filters, `q` over
   * the name (trigram index), the keyset sort — `created_at` as a timestamp keyset, `name` as a
   * text keyset, `last_triggered_at` as a nulls-last timestamp keyset (never-triggered last both
   * ways) and `completed_run_count` as an integer keyset — and, on the first page, the capped
   * total.
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
      LIVE_AUTOMATION,
      ...this.listFilterConditions({ organizationId, query }),
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
          completed_run_count: {
            column: automations.completed_run_count,
            kind: 'integer',
            getSortValue: (row) => String(row.completed_run_count),
          },
        },
        idColumn: automations.id,
        defaultSort: 'created_at',
        sort: query.sort,
        order: query.order,
        q: query.q,
        filters: {
          status: query.status ?? null,
          trigger_type: query.triggerType ?? null,
          target_scope: query.targetScope ?? null,
          next_post_status: query.nextPostStatus ?? null,
          instagram_account_id: query.instagramAccountPublicId ?? null,
        },
        after: query.after,
      });
    const rows = (await this.db()
      .select({
        ...getTableColumns(automations),
        instagram_account_public_id: instagram_accounts.public_id,
        // The created_at sort keysets on its own column; every other sort on sort_value.
        cursor_created_at: cursorTimestampSelection(automations.created_at),
        // NULL for a never-triggered automation — the nulls-last sort's value-less rows.
        cursor_last_triggered_at: cursorTimestampSelection(automations.last_triggered_at) as SQL<
          string | null
        >,
      })
      .from(automations)
      .innerJoin(instagram_accounts, OWN_INSTAGRAM_ACCOUNT)
      .where(and(where, cursorCondition))
      .orderBy(...orderBy)
      .limit(query.limit + 1)) as AutomationListRow[];
    const page = finishKeysetPage({
      rows,
      args: { limit: query.limit, sortValueFor, filterFingerprint },
    });
    const total =
      query.after === undefined
        ? await countWithCap({ database: this.db(), table: automations, where })
        : null;
    return { ...page, total };
  }

  /** The list's filters (AU13, AU27) as conditions; an absent filter adds none. */
  private listFilterConditions({
    organizationId,
    query,
  }: {
    organizationId: number;
    query: AutomationRepositoryListQuery;
  }): (SQL | undefined)[] {
    return [
      query.status === undefined ? undefined : eq(automations.status, query.status),
      query.triggerType === undefined ? undefined : eq(automations.trigger_type, query.triggerType),
      query.targetScope === undefined ? undefined : eq(automations.target_scope, query.targetScope),
      query.nextPostStatus === undefined
        ? undefined
        : eq(automations.next_post_status, query.nextPostStatus),
      // An unknown account id resolves to NULL, so the page is empty (AU27, as contacts CT13).
      query.instagramAccountPublicId === undefined
        ? undefined
        : eq(
            automations.instagram_account_id,
            instagramAccountIdByPublicId({
              organizationId,
              instagramAccountPublicId: query.instagramAccountPublicId,
            }),
          ),
      buildSearchCondition({ columns: [automations.name], q: query.q }),
    ];
  }

  /**
   * The organization's live automation with this public id and its account's public id (route
   * 13); `null` when absent, deleted or another organization's.
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
        instagram_account_public_id: instagram_accounts.public_id,
      })
      .from(automations)
      .innerJoin(instagram_accounts, OWN_INSTAGRAM_ACCOUNT)
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
   * The organization's live automation with this public id, locked for an edit or a delete
   * (routes 14, 15) — `FOR UPDATE` of the automation row only, so a racing save or link waits and
   * then sees the change; a unit of the run engine or a contact erase that holds the automation
   * ({@link lockForRunChanges}, {@link lockLiveForRunStart}) is waited for, and one that comes later
   * waits (AU12). `null` when absent, deleted or another organization's.
   */
  async lockLiveByPublicId({
    organizationId,
    automationPublicId,
  }: {
    organizationId: number;
    automationPublicId: string;
  }): Promise<AutomationWithAccountRow | null> {
    // The account's public id comes from a scalar subquery, not a join: Postgres takes
    // `FOR UPDATE OF` only an unqualified relation name, and Drizzle writes `of` schema-qualified,
    // so the lock is a plain `FOR UPDATE` on the one table in FROM — the automation row alone.
    const rows = await this.db()
      .select({
        ...getTableColumns(automations),
        instagram_account_public_id: sql<string>`(${this.db()
          .select({ public_id: instagram_accounts.public_id })
          .from(instagram_accounts)
          .where(OWN_INSTAGRAM_ACCOUNT)})`,
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

  /** Inserts a new automation (route 12) with its account and creator; returns the row. */
  async insert(values: AutomationInsertValues): Promise<AutomationRow> {
    const rows = await runInsertWithPublicIdentifierRetry({
      insert: () =>
        this.db()
          .insert(automations)
          .values({
            ...toWrittenColumns(values.fields),
            public_id: generatePublicId('automation'),
            organization_id: values.organizationId,
            instagram_account_id: values.instagramAccountId,
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
   * Writes the merged automation over a live one (route 14), stamping the editor and `updated_at`;
   * the account and the counters are never touched (AU10, AU27). `null` when it was deleted
   * meanwhile.
   */
  async update({
    organizationId,
    automationId,
    fields,
    updatedByUserId,
  }: AutomationKey & {
    fields: AutomationMergedFields;
    updatedByUserId: number | null;
  }): Promise<AutomationRow | null> {
    const rows = await this.db()
      .update(automations)
      .set({
        ...toWrittenColumns(fields),
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
   * Soft-deletes a live automation (route 15, AU12): `deleted_at`, the reason and the note, the
   * caller as last editor. Returns the row, or `null` when it was already deleted.
   */
  async softDelete({
    organizationId,
    automationId,
    reason,
    note,
    updatedByUserId,
  }: AutomationKey & {
    reason: RecordDeleteReason;
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

  /**
   * The oldest other live, waiting "next post" automation of the same Instagram account whose
   * window overlaps `[startsAt, endsAt)` (`start < other end AND other start < end`) and that
   * shares a keyword — or where either side has none (AU9, AU27). `null` when there is none.
   *
   * @remarks
   * Runs under the organization's `AUTOMATION_NEXT_POST` advisory lock, with the save that follows
   * (the caller takes it), so two saves never both pass. Reads `idx_automations_next_post_waiting`.
   */
  async findNextPostOverlap({
    organizationId,
    instagramAccountId,
    excludedAutomationId,
    startsAt,
    endsAt,
    keywords,
  }: {
    organizationId: number;
    instagramAccountId: number;
    /** The automation being saved (an edit); `null` on a create. */
    excludedAutomationId: number | null;
    startsAt: Date;
    endsAt: Date;
    keywords: readonly string[];
  }): Promise<AutomationNextPostOverlap | null> {
    // Either side without keywords answers every comment, so it clashes with any keyword set.
    const keywordClash =
      keywords.length === 0
        ? undefined
        : or(
            sql`cardinality(${automations.keywords}) = 0`,
            arrayOverlaps(automations.keywords, [...keywords]),
          );
    const rows = await this.db()
      .select({
        public_id: automations.public_id,
        name: automations.name,
        keywords: automations.keywords,
        next_post_starts_at: automations.next_post_starts_at,
        next_post_ends_at: automations.next_post_ends_at,
      })
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.instagram_account_id, instagramAccountId),
          eq(automations.status, 'live'),
          eq(automations.next_post_status, 'waiting'),
          LIVE_AUTOMATION,
          excludedAutomationId === null ? undefined : ne(automations.id, excludedAutomationId),
          lt(automations.next_post_starts_at, endsAt),
          gt(automations.next_post_ends_at, startsAt),
          keywordClash,
        ),
      )
      .orderBy(asc(automations.created_at), asc(automations.id))
      .limit(1);
    const row = rows[0];
    if (row?.next_post_starts_at == null || row.next_post_ends_at == null) return null;
    return {
      public_id: row.public_id,
      name: row.name,
      keywords: row.keywords,
      next_post_starts_at: row.next_post_starts_at,
      next_post_ends_at: row.next_post_ends_at,
    };
  }

  /**
   * Links a new post to every live, waiting "next post" automation of the post's Instagram account
   * whose window holds its publish time (`start <= published_at < end`), unless an automation of
   * that account targeted the post before this statement (AU15, AQ4). One conditional `UPDATE`:
   * a linked automation never links again. Returns the linked automations' public ids.
   *
   * @remarks
   * The `NOT EXISTS` reads the statement's snapshot, so two waiting automations may link the same
   * post (AQ4) while one linked earlier keeps it. An unknown account public id links nothing.
   */
  async linkNextPost({
    organizationId,
    instagramAccountPublicId,
    instagramMediaId,
    publishedAt,
  }: {
    organizationId: number;
    instagramAccountPublicId: string;
    instagramMediaId: string;
    publishedAt: Date;
  }): Promise<string[]> {
    const accountId = instagramAccountIdByPublicId({ organizationId, instagramAccountPublicId });
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
          eq(automations.instagram_account_id, accountId),
          eq(automations.status, 'live'),
          eq(automations.next_post_status, 'waiting'),
          LIVE_AUTOMATION,
          lte(automations.next_post_starts_at, publishedAt),
          gt(automations.next_post_ends_at, publishedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM ${automations} AS targeted
            WHERE targeted.organization_id = ${organizationId}
              AND targeted.instagram_account_id = ${accountId}
              AND targeted.target_instagram_media_id = ${instagramMediaId}
              AND targeted.deleted_at IS NULL
          )`,
        ),
      )
      .returning({ public_id: automations.public_id });
    return rows.map((row) => row.public_id);
  }

  /**
   * The account's live automations (`status = 'live'`, not deleted), oldest first (`created_at`,
   * then `id`) — the candidates of one event for the run engine (AU16, AU27): one trigger type, or
   * every type with the DM keyword trigger on (a DM, AU16). Reads `idx_automations_live_triggers`.
   */
  async listLiveAutomationsOfAccount({
    organizationId,
    instagramAccountId,
    triggerType,
    isDmKeywordTriggerRequired,
  }: {
    organizationId: number;
    instagramAccountId: number;
    /** One trigger type; `null` = every type. */
    triggerType: AutomationRow['trigger_type'] | null;
    /** Only the automations a DM may start (`is_dm_keyword_trigger_enabled`). */
    isDmKeywordTriggerRequired: boolean;
  }): Promise<AutomationRow[]> {
    return this.db()
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.instagram_account_id, instagramAccountId),
          eq(automations.status, 'live'),
          LIVE_AUTOMATION,
          triggerType === null ? undefined : eq(automations.trigger_type, triggerType),
          isDmKeywordTriggerRequired
            ? eq(automations.is_dm_keyword_trigger_enabled, true)
            : undefined,
        ),
      )
      .orderBy(asc(automations.created_at), asc(automations.id));
  }

  /**
   * The organization's automation with this internal id, deleted ones included — the run engine
   * reads it as it is now at every step (AU14); `null` when absent.
   */
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
   * The organization's automation with this public id, deleted ones included — a queued entry, a
   * button click (AU16, AU21) and the contacts list's filter (CT5, its runs stay); `null` when
   * absent or another organization's.
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
   * Locks automations `FOR KEY SHARE`, by id, until the unit of work ends — what the run engine and
   * the contact erase take before they lock or change any run of them (AU12, D47).
   *
   * @remarks
   * The one lock order of a delete, an erase and the engine is the contact, the automation, then its
   * runs. Without this lock a unit holding a run still reaches for the automation later — the
   * counters (AU10), and the reference check of a run or a log changed twice in one transaction,
   * which Postgres makes `FOR KEY SHARE` — while the delete holds the automation and waits for the
   * run. `FOR KEY SHARE` blocks the edit's and the delete's `FOR UPDATE` only: units of the engine
   * never block each other here, and the counters' updates go through. Nothing to lock is a no-op.
   */
  async lockForRunChanges({
    organizationId,
    automationIds,
  }: {
    organizationId: number;
    /** `app.automations.id` of each — deleted ones included. */
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
   * The automation a run is about to start on, locked `FOR KEY SHARE` until the unit of work ends —
   * proof that it is still live (`status = 'live'`, not deleted): a delete or an edit in progress is
   * waited for, and the conditions are read again after it (AU12, D47). `null` when it was deleted
   * or turned off meanwhile, or is absent: nothing starts. A delete that comes after the lock waits
   * for the unit and then finds the run it started.
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
        ),
      )
      .limit(1)
      .for('key share');
    return rows[0] ?? null;
  }

  /**
   * Stamps `last_triggered_at = now()` when a run starts (AU10). A counter of the engine, not an
   * edit: `updated_at` is left as it is, so a person's `expected_updated_at` (AU11) does not go
   * stale every time the automation runs.
   */
  async markRunStarted({ organizationId, automationId }: AutomationKey): Promise<void> {
    await this.db()
      .update(automations)
      .set({ last_triggered_at: databaseNowTimestamp })
      .where(
        and(eq(automations.organization_id, organizationId), eq(automations.id, automationId)),
      );
  }

  /**
   * `completed_run_count = completed_run_count + 1` in SQL, in the completion's unit of work
   * (AU10) — never read-modify-write; `updated_at` is left as it is (see {@link markRunStarted}).
   */
  async incrementCompletedRunCount({ organizationId, automationId }: AutomationKey): Promise<void> {
    await this.db()
      .update(automations)
      .set({ completed_run_count: sql`${automations.completed_run_count} + 1` })
      .where(
        and(eq(automations.organization_id, organizationId), eq(automations.id, automationId)),
      );
  }

  /**
   * Up to `limit` waiting "next post" automations of every organization whose window ended before
   * `endedBefore`, oldest end first (AU15, WC-6) — the expiry's cross-organization scan. A deleted
   * organization's are left out: its own scope no longer sees them, so they could not be changed and
   * would keep their place in every batch until its purge. Runs only on a retention handle
   * ({@link createRetentionAutomationRepository}): the sweep arm is in the policy's `USING` only, so
   * it reads every organization's rows and can write none.
   */
  async listNextPostExpiryCandidates({
    endedBefore,
    limit,
  }: {
    endedBefore: Date;
    limit: number;
  }): Promise<AutomationNextPostExpiryCandidate[]> {
    const rows = await this.db()
      .select({
        automationId: automations.id,
        organizationId: automations.organization_id,
        organizationPublicId: organizations.public_id,
      })
      .from(automations)
      .innerJoin(organizations, eq(organizations.id, automations.organization_id))
      .where(
        and(
          eq(automations.next_post_status, 'waiting'),
          LIVE_AUTOMATION,
          lt(automations.next_post_ends_at, endedBefore),
          isNull(organizations.deleted_at),
        ),
      )
      .orderBy(asc(automations.next_post_ends_at), asc(automations.id))
      .limit(limit);
    return rows;
  }

  /**
   * Marks the given automations of one organization `expired` when they still wait and their
   * window ended before `endedBefore` (AU15, WC-6) — the same conditional `WHERE` as the scan, so a
   * repeat, a link or an edit in between changes nothing. Returns how many expired.
   */
  async expireNextPostWindows({
    organizationId,
    automationIds,
    endedBefore,
  }: {
    organizationId: number;
    automationIds: readonly number[];
    endedBefore: Date;
  }): Promise<number> {
    if (automationIds.length === 0) return 0;
    const rows = await this.db()
      .update(automations)
      .set({ next_post_status: 'expired', updated_at: automationUpdatedAtTimestamp })
      .where(
        and(
          eq(automations.organization_id, organizationId),
          inArray(automations.id, [...automationIds]),
          eq(automations.next_post_status, 'waiting'),
          LIVE_AUTOMATION,
          lt(automations.next_post_ends_at, endedBefore),
        ),
      )
      .returning({ id: automations.id });
    return rows.length;
  }

  /**
   * The deleted-automation purge (AQ7, AU25, WC-15): deletes every automation deleted before
   * `cutoff`, in capped batches (`deleteInBatchesByCondition`, `idx_automations_tombstoned`). One
   * a run or a comment log still points at (`RESTRICT`) is skipped by the batch delete's per-row
   * fallback and counted `blockedCount` — the next day tries it again. A live automation is never
   * touched. Needs the retention context — bind it through
   * {@link createRetentionAutomationRepository}.
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

/**
 * {@link AutomationRepository} bound to a job's organization handle
 * (`runOrganizationScopedWorkerJob`) — the expiry's per-organization change.
 */
export function createWorkerAutomationRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationRepository {
  assertWorkerDatabaseContext(['organization']);
  return new AutomationRepository(databaseHandle);
}

/**
 * {@link AutomationRepository} bound to a retention handle (`runGlobalRetentionWorkerJob`) — the
 * expiry's cross-organization scan, which reads and never writes, and the deleted-automation
 * purge, which deletes (the sweep arm is in the policy's `USING` only).
 */
export function createRetentionAutomationRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new AutomationRepository(databaseHandle);
}
