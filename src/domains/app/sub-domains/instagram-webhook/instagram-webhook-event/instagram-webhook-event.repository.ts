import {
  and,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
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
import { countWithCap } from '@/infrastructure/database/utils/capped-count.util.js';
import { fieldValidationError } from '@/shared/errors/index.js';
import {
  computeListFilterFingerprint,
  finishKeysetPage,
} from '@/shared/utils/http/list-query.util.js';
import {
  buildDescendingCreatedAtIdCursorCondition,
  cursorTimestampSelection,
  parseListCursor,
} from '@/shared/utils/http/pagination.util.js';
import {
  databaseNowTimestamp,
  databaseUpdatedAtTimestamp,
} from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { instagram_webhook_events } from './instagram-webhook-event.schema.js';
import {
  INSTAGRAM_WEBHOOK_EVENT_WAITING_STATUSES,
  type InstagramWebhookEventKind,
  type InstagramWebhookEventSkipReason,
} from './instagram-webhook-event.constants.js';
import type { InstagramWebhookEventListFilters } from './instagram-webhook-event.types.js';

/** One `app.instagram_webhook_events` row as Drizzle reads it. */
export type InstagramWebhookEventRow = typeof instagram_webhook_events.$inferSelect;

/** A list row: the event plus its microsecond cursor timestamp. */
export type InstagramWebhookEventListRow = InstagramWebhookEventRow & { cursor_created_at: string };

/** The account every event write is scoped by: its organization and its internal id. */
export interface InstagramWebhookEventAccountKey {
  /** `tenancy.organizations.id` of the owning organization. */
  organizationId: number;
  /** `app.instagram_accounts.id` the events were delivered for. */
  instagramAccountId: number;
}

/**
 * One event as the receiver (4.A) stores it (WH9, WH10): its kind, key and item. A `skipReason`
 * makes the row born `skipped` (final at once); without one it is born `received`.
 */
export interface NewInstagramWebhookEvent {
  /** The delivery entry's `id` — the account's webhook user id; digits only. */
  instagramUserId: string;
  /** The sender (an echo: the recipient), or `null` when the item names nobody else. */
  contactInstagramUserId: string | null;
  eventKind: InstagramWebhookEventKind;
  /** WH9's key, at most 512 characters, unique per account. */
  eventKey: string;
  /** Set to store the event `skipped` with this reason; `null` stores it `received`. */
  skipReason: InstagramWebhookEventSkipReason | null;
  /** The event item as received (a JSON object). */
  payload: Record<string, unknown>;
  /** Meta's own time: the item's `timestamp`, else the entry's `time`; `null` when neither. */
  occurredAt: Date | null;
}

/**
 * A claimed event (WH12): its account, its internal id and the attempt count the claim set. The
 * attempt count is the claim's token — a mark or release applies only while the row still carries
 * it, so a run whose 5-minute lease ran out (and another run claimed the event again) changes
 * nothing.
 */
export interface InstagramWebhookEventClaimKey extends InstagramWebhookEventAccountKey {
  /** `app.instagram_webhook_events.id`. */
  eventId: number;
  /** `attempt_count` as the claim left it. */
  claimedAttemptCount: number;
}

/** What {@link InstagramWebhookEventRepository.claimOldestWaitingEvent} did to the account's head. */
export type InstagramWebhookEventClaimResult =
  /** The head is claimed: one more attempt, the lease started. */
  | { outcome: 'claimed'; event: InstagramWebhookEventRow }
  /** The head had used every attempt: it is now `failed` (`processing_attempts_exhausted`). */
  | { outcome: 'exhausted'; event: InstagramWebhookEventRow };

/**
 * One Instagram account the stuck-event pick-up hands back to processing (WH15): the two public ids
 * its processing job carries — never an internal id (queue rule § 3.1).
 */
export interface InstagramWebhookStuckAccount {
  /** The account's organization — the job's `organizationPublicId` (K8). */
  organizationPublicId: string;
  /** `cha_…`. */
  instagramAccountPublicId: string;
}

/** The `error_message` of an event whose attempts ran out (WH12, WH14). */
export const INSTAGRAM_WEBHOOK_EVENT_ATTEMPTS_EXHAUSTED_ERROR = 'processing_attempts_exhausted';

/** The longest `error_message` the column holds. */
const ERROR_MESSAGE_MAX_LENGTH = 2000;

/** The sort the list's cursor fingerprint names (route 18 has one order). */
const LIST_SORT = 'received_at';

/**
 * `updated_at` for every change of an event: Postgres `now()`, never before the row's
 * `created_at`. `now()` is the transaction's start time, and a processing transaction that began
 * before the receiver's insert committed still sees the row (READ COMMITTED) — a plain `now()` would
 * then land before `created_at` and break `chk_instagram_webhook_events_updated`.
 */
const eventUpdatedAtTimestamp = databaseUpdatedAtTimestamp(instagram_webhook_events.created_at);

/** The rows of a raw `execute()` result. */
function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

/** Route 18's filters as SQL, the organization first (RLS plus the repository's own filter). */
function buildListConditions({
  organizationId,
  filters,
}: {
  organizationId: number;
  filters: InstagramWebhookEventListFilters;
}): SQL[] {
  const conditions: SQL[] = [eq(instagram_webhook_events.organization_id, organizationId)];
  if (filters.status !== undefined) {
    conditions.push(eq(instagram_webhook_events.status, filters.status));
  }
  if (filters.eventKind !== undefined) {
    conditions.push(eq(instagram_webhook_events.event_kind, filters.eventKind));
  }
  if (filters.receivedFrom !== undefined) {
    conditions.push(gte(instagram_webhook_events.created_at, new Date(filters.receivedFrom)));
  }
  if (filters.receivedTo !== undefined) {
    conditions.push(lt(instagram_webhook_events.created_at, new Date(filters.receivedTo)));
  }
  return conditions;
}

/**
 * The SHA-256 of route 18's filter set, bound into every cursor it mints (sec-U12) — `limit` and
 * `include_total` stay out, so a continuation may change the page size.
 */
function computeListFingerprint(filters: InstagramWebhookEventListFilters): string {
  return computeListFilterFingerprint({
    q: undefined,
    sort: LIST_SORT,
    order: 'desc',
    filters: {
      status: filters.status ?? null,
      event_kind: filters.eventKind ?? null,
      received_from: filters.receivedFrom ?? null,
      received_to: filters.receivedTo ?? null,
    },
  });
}

/**
 * The `400` of a cursor route 18 cannot continue (4.B.9): not minted here, or minted under other
 * filters. Named on `after`.
 */
function invalidCursorError() {
  return fieldValidationError({
    field: 'after',
    messageKey: 'errors:validation.invalidPagination',
  });
}

/** The guard every claim-bound write carries: the row, still waiting, still this claim's. */
function claimCondition(claim: InstagramWebhookEventClaimKey): SQL | undefined {
  return and(
    eq(instagram_webhook_events.organization_id, claim.organizationId),
    eq(instagram_webhook_events.instagram_account_id, claim.instagramAccountId),
    eq(instagram_webhook_events.id, claim.eventId),
    inArray(instagram_webhook_events.status, [...INSTAGRAM_WEBHOOK_EVENT_WAITING_STATUSES]),
    eq(instagram_webhook_events.attempt_count, claim.claimedAttemptCount),
  );
}

/**
 * Drizzle access to `app.instagram_webhook_events` (routes-final § 4.B.3, 4.B.10, WHC12): the
 * store of a delivery's events (`ON CONFLICT DO NOTHING`), the `queued` mark, the claim of an
 * account's oldest waiting event (a `MATERIALIZED` CTE), the guarded final marks and the claim
 * release, route 18's keyset list, the stuck-event pick-up's read (WH15) and the 30-day clean-up.
 *
 * @remarks
 * - **Algorithm:** every row statement names `organization_id` (and the account and the row id
 *   where it has them), so tenant isolation does not rest on RLS alone. The store keys on the unique
 *   `(organization_id, instagram_account_id, event_key)` index, so a repeat delivery inserts
 *   nothing. The claim reads the account's head (oldest `received` / `queued`, by `created_at`,
 *   `id`) in a `MATERIALIZED` CTE and updates it only while no other run holds its lease — never
 *   skipping ahead, so one account's events run strictly in order (WQ3). The attempt count the
 *   claim sets is its token: every later mark of that claim requires it.
 * - **Failure modes:** a cursor not minted here, or minted under other filters, is a `400` on
 *   `after`; guarded writes return `false` / `null` when the row is not in the state they require.
 * - **Side effects:** writes `app.instagram_webhook_events` only. Rows are created only by the
 *   receiver, changed only by processing and deleted only by the clean-up (4.B.10) — a contact
 *   erase leaves them (WH18), and route 18 never changes one.
 * - **Notes:** HTTP paths run inside the caller's `withAppDatabaseContext` (the receiver's
 *   `VERIFIED` scope, route 18's request scope); workers bind a handle through
 *   {@link createWorkerInstagramWebhookEventRepository} (processing, under the job's organization
 *   scope its worker mints) or {@link createRetentionInstagramWebhookEventRepository} (the
 *   clean-up's retention context). The repository never mints a scope itself.
 */
export class InstagramWebhookEventRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /**
   * Stores a delivery entry's events for one account in one `INSERT … ON CONFLICT DO NOTHING`
   * (WH10): a row without a skip reason is born `received`, one with a skip reason `skipped` and
   * final (`processed_at` set). Returns only the rows this statement inserted — a repeat delivery
   * returns none of its already-stored events.
   */
  async insertEvents({
    organizationId,
    instagramAccountId,
    requestId,
    events,
  }: InstagramWebhookEventAccountKey & {
    /** The delivery's request id, or `null`. */
    requestId: string | null;
    events: readonly NewInstagramWebhookEvent[];
  }): Promise<InstagramWebhookEventRow[]> {
    if (events.length === 0) return [];
    return runInsertWithPublicIdentifierRetry({
      insert: () =>
        this.db()
          .insert(instagram_webhook_events)
          .values(
            events.map((event) => ({
              public_id: generatePublicId('instagramWebhookEvent'),
              organization_id: organizationId,
              instagram_account_id: instagramAccountId,
              instagram_user_id: event.instagramUserId,
              contact_instagram_user_id: event.contactInstagramUserId,
              event_kind: event.eventKind,
              event_key: event.eventKey,
              status: event.skipReason === null ? 'received' : 'skipped',
              skip_reason: event.skipReason,
              payload: event.payload,
              occurred_at: event.occurredAt,
              processed_at: event.skipReason === null ? null : databaseNowTimestamp,
              request_id: requestId,
            })),
          )
          .onConflictDoNothing({
            target: [
              instagram_webhook_events.organization_id,
              instagram_webhook_events.instagram_account_id,
              instagram_webhook_events.event_key,
            ],
          })
          .returning(),
    });
  }

  /**
   * Turns the account's just-stored `received` rows `queued` once their processing job was added
   * (WH10). Rows a claim or a mark moved on in between stay as they are. Returns how many turned.
   */
  async markQueued({
    organizationId,
    instagramAccountId,
    eventIds,
  }: InstagramWebhookEventAccountKey & { eventIds: readonly number[] }): Promise<number> {
    if (eventIds.length === 0) return 0;
    const rows = await this.db()
      .update(instagram_webhook_events)
      .set({ status: 'queued', updated_at: eventUpdatedAtTimestamp })
      .where(
        and(
          eq(instagram_webhook_events.organization_id, organizationId),
          eq(instagram_webhook_events.instagram_account_id, instagramAccountId),
          inArray(instagram_webhook_events.id, [...eventIds]),
          eq(instagram_webhook_events.status, 'received'),
        ),
      )
      .returning({ id: instagram_webhook_events.id });
    return rows.length;
  }

  /**
   * Claims the account's oldest waiting event (WH12 step 1): when no other run holds its lease (no
   * claim in the last `claimLeaseMinutes`), adds one to its attempt count and starts the lease — or,
   * when it already used `maxProcessingAttempts`, marks it `failed` (`processing_attempts_exhausted`)
   * instead. Returns `null` when the account has no waiting event, or its head is leased by another
   * run (the head is never skipped — strict order, WQ3).
   *
   * @remarks
   * - **Algorithm:** a `MATERIALIZED` CTE reads the head once (`created_at`, `id`; served by
   *   `idx_instagram_webhook_events_pending`); the `UPDATE … FROM` re-checks status and lease on
   *   the row it locks, so two runs racing for one head claim it once. The claimed row is read back
   *   through Drizzle (typed columns).
   * - **Notes:** the caller passes the processing constants (WHC10) — this method owns no policy
   *   number.
   */
  async claimOldestWaitingEvent({
    organizationId,
    instagramAccountId,
    maxProcessingAttempts,
    claimLeaseMinutes,
  }: InstagramWebhookEventAccountKey & {
    /** A head that already used this many attempts is failed instead of claimed. */
    maxProcessingAttempts: number;
    /** How long a claim holds the event (the "stuck" lease, WH15). */
    claimLeaseMinutes: number;
  }): Promise<InstagramWebhookEventClaimResult | null> {
    const result = await this.db().execute(sql`
      WITH head AS MATERIALIZED (
        SELECT id
          FROM app.instagram_webhook_events
         WHERE organization_id = ${organizationId}
           AND instagram_account_id = ${instagramAccountId}
           AND status IN ('received', 'queued')
         ORDER BY created_at ASC, id ASC
         LIMIT 1
      )
      UPDATE app.instagram_webhook_events AS head_event
         SET attempt_count = CASE WHEN head_event.attempt_count >= ${maxProcessingAttempts}
                                  THEN head_event.attempt_count ELSE head_event.attempt_count + 1 END,
             last_attempted_at = CASE WHEN head_event.attempt_count >= ${maxProcessingAttempts}
                                      THEN head_event.last_attempted_at ELSE now() END,
             status = CASE WHEN head_event.attempt_count >= ${maxProcessingAttempts}
                           THEN 'failed' ELSE head_event.status END,
             error_message = CASE WHEN head_event.attempt_count >= ${maxProcessingAttempts}
                                  THEN ${INSTAGRAM_WEBHOOK_EVENT_ATTEMPTS_EXHAUSTED_ERROR}
                                  ELSE head_event.error_message END,
             processed_at = CASE WHEN head_event.attempt_count >= ${maxProcessingAttempts}
                                 THEN now() ELSE head_event.processed_at END,
             updated_at = greatest(head_event.created_at, now())
        FROM head
       WHERE head_event.id = head.id
         AND head_event.organization_id = ${organizationId}
         AND head_event.status IN ('received', 'queued')
         AND (head_event.last_attempted_at IS NULL
              OR head_event.last_attempted_at <= now() - make_interval(mins => ${claimLeaseMinutes}))
      RETURNING head_event.id, head_event.status
    `);
    const [claimed] = rowsOf<{ id: number | string; status: string }>(result);
    if (claimed === undefined) return null;
    const rows = await this.db()
      .select()
      .from(instagram_webhook_events)
      .where(
        and(
          eq(instagram_webhook_events.organization_id, organizationId),
          eq(instagram_webhook_events.id, Number(claimed.id)),
        ),
      )
      .limit(1);
    const event = rows[0];
    if (event === undefined) {
      throw new Error('claimed instagram webhook event could not be read back');
    }
    return claimed.status === 'failed'
      ? { outcome: 'exhausted', event }
      : { outcome: 'claimed', event };
  }

  /** Marks a claimed event `processed` (WH12 step 4). `false` when the claim no longer holds. */
  async markProcessed(claim: InstagramWebhookEventClaimKey): Promise<boolean> {
    const rows = await this.db()
      .update(instagram_webhook_events)
      .set({
        status: 'processed',
        processed_at: databaseNowTimestamp,
        updated_at: eventUpdatedAtTimestamp,
      })
      .where(claimCondition(claim))
      .returning({ id: instagram_webhook_events.id });
    return rows.length > 0;
  }

  /**
   * Marks a claimed event `skipped` with its reason — the account's switch went off, or it is no
   * longer `connected`, while the event waited (WH12 step 2). `false` when the claim no longer
   * holds.
   */
  async markSkipped({
    skipReason,
    ...claim
  }: InstagramWebhookEventClaimKey & {
    skipReason: InstagramWebhookEventSkipReason;
  }): Promise<boolean> {
    const rows = await this.db()
      .update(instagram_webhook_events)
      .set({
        status: 'skipped',
        skip_reason: skipReason,
        processed_at: databaseNowTimestamp,
        updated_at: eventUpdatedAtTimestamp,
      })
      .where(claimCondition(claim))
      .returning({ id: instagram_webhook_events.id });
    return rows.length > 0;
  }

  /**
   * Marks a claimed event `failed` with its error (WH14): a code and a short reason
   * (`instagram_api:<code>/<subcode>`), never payload text — cut to the column's 2000 characters.
   * `false` when the claim no longer holds.
   */
  async markFailed({
    errorMessage,
    ...claim
  }: InstagramWebhookEventClaimKey & { errorMessage: string }): Promise<boolean> {
    const rows = await this.db()
      .update(instagram_webhook_events)
      .set({
        status: 'failed',
        error_message: errorMessage.slice(0, ERROR_MESSAGE_MAX_LENGTH),
        processed_at: databaseNowTimestamp,
        updated_at: eventUpdatedAtTimestamp,
      })
      .where(claimCondition(claim))
      .returning({ id: instagram_webhook_events.id });
    return rows.length > 0;
  }

  /**
   * Gives a claim back, so the next run claims the event at once (WH14): the lease ends, and —
   * unless `isAttemptSpent` — the attempt count goes back down. An Instagram outage (open circuit)
   * spends no attempt; a temporary failure keeps its attempt and only ends the lease, so the job's
   * backoff retry (5 s, then growing) claims the event again instead of waiting out the 5-minute
   * lease. `false` when the claim no longer holds.
   */
  async releaseClaim({
    isAttemptSpent = false,
    ...claim
  }: InstagramWebhookEventClaimKey & {
    /** `true` keeps the attempt this claim added (a temporary failure); default `false` gives it back. */
    isAttemptSpent?: boolean;
  }): Promise<boolean> {
    const rows = await this.db()
      .update(instagram_webhook_events)
      .set({
        ...(isAttemptSpent
          ? {}
          : { attempt_count: sql`GREATEST(${instagram_webhook_events.attempt_count} - 1, 0)` }),
        last_attempted_at: null,
        updated_at: eventUpdatedAtTimestamp,
      })
      .where(claimCondition(claim))
      .returning({ id: instagram_webhook_events.id });
    return rows.length > 0;
  }

  /**
   * The stuck-event pick-up's read across organizations (WH15, WC-2): the Instagram accounts — of
   * live organizations — that have an event still `received` or `queued` more than
   * `stuckAfterMinutes` after it arrived and not claimed in as long, oldest waiting first, at most
   * `limit` accounts. Runs only on a retention handle
   * ({@link createRetentionInstagramWebhookEventRepository}): the sweep arm is in the policies'
   * `USING`, so it reads every organization's rows and can change none.
   *
   * @remarks
   * Served by `idx_instagram_webhook_events_pending` (only waiting rows are in it). Returns public
   * ids only — the jobs the pick-up adds carry nothing else.
   */
  async listAccountsWithStuckEvents({
    stuckAfterMinutes,
    limit,
  }: {
    /** "Stuck": arrived, and last claimed, more than this many minutes ago. */
    stuckAfterMinutes: number;
    /** Most accounts one run hands back. */
    limit: number;
  }): Promise<InstagramWebhookStuckAccount[]> {
    const stuckBefore = sql`now() - make_interval(mins => ${stuckAfterMinutes})`;
    return this.db()
      .select({
        organizationPublicId: organizations.public_id,
        // The account's one id is its channel account's (`cha_…`, P47) since ROUTE row R6.
        instagramAccountPublicId: channel_accounts.public_id,
      })
      .from(instagram_webhook_events)
      .innerJoin(
        instagram_accounts,
        and(
          eq(instagram_accounts.organization_id, instagram_webhook_events.organization_id),
          eq(instagram_accounts.id, instagram_webhook_events.instagram_account_id),
        ),
      )
      .innerJoin(
        channel_accounts,
        and(
          eq(channel_accounts.organization_id, instagram_accounts.organization_id),
          eq(channel_accounts.id, instagram_accounts.channel_account_id),
        ),
      )
      .innerJoin(organizations, eq(organizations.id, instagram_webhook_events.organization_id))
      .where(
        and(
          inArray(instagram_webhook_events.status, [...INSTAGRAM_WEBHOOK_EVENT_WAITING_STATUSES]),
          lte(instagram_webhook_events.created_at, stuckBefore),
          or(
            isNull(instagram_webhook_events.last_attempted_at),
            lte(instagram_webhook_events.last_attempted_at, stuckBefore),
          ),
          isNull(organizations.deleted_at),
        ),
      )
      .groupBy(organizations.public_id, channel_accounts.public_id)
      .orderBy(sql`min(${instagram_webhook_events.created_at})`)
      .limit(limit);
  }

  /**
   * Route 18's page (WH17): the organization's events newest first by received time, then id,
   * filtered by status, kind and received window; `limit + 1` rows through `finishKeysetPage`, the
   * cursor bound to the filters; a capped count when asked.
   *
   * @remarks
   * Failure modes: an `after` this server did not mint, or minted under other filters, throws a
   * `400` on `after` (4.B.9) — never a silent restart.
   */
  async listByOrganization({
    organizationId,
    filters,
  }: {
    organizationId: number;
    filters: InstagramWebhookEventListFilters;
  }): Promise<{
    items: InstagramWebhookEventListRow[];
    total: number | null;
    limit: number;
    has_more: boolean;
    next_cursor: string | null;
  }> {
    const filterFingerprint = computeListFingerprint(filters);
    const cursor = parseListCursor(filters.after);
    const hasAfter = filters.after !== undefined && filters.after.length > 0;
    if (hasAfter && (cursor === null || cursor.filter_fingerprint !== filterFingerprint)) {
      throw invalidCursorError();
    }

    const filterConditions = buildListConditions({ organizationId, filters });
    const cursorCondition = buildDescendingCreatedAtIdCursorCondition({
      createdAtColumn: instagram_webhook_events.created_at,
      idColumn: instagram_webhook_events.id,
      cursor,
    });
    const pageConditions =
      cursorCondition === undefined ? filterConditions : [...filterConditions, cursorCondition];

    const rowsPromise = this.db()
      .select({
        ...getTableColumns(instagram_webhook_events),
        cursor_created_at: cursorTimestampSelection(instagram_webhook_events.created_at),
      })
      .from(instagram_webhook_events)
      .where(and(...pageConditions))
      .orderBy(desc(instagram_webhook_events.created_at), desc(instagram_webhook_events.id))
      .limit(filters.limit + 1);
    const totalPromise = filters.includeTotal
      ? countWithCap({
          database: this.db(),
          table: instagram_webhook_events,
          where: and(...filterConditions),
        })
      : Promise.resolve(null);

    const [rows, total] = await Promise.all([rowsPromise, totalPromise]);
    return finishKeysetPage({
      rows,
      args: { limit: filters.limit, total, filterFingerprint },
    });
  }

  /**
   * The 30-day clean-up (WH19): deletes every event received before `cutoff`, whatever its status,
   * in capped batches (`deleteInBatchesByCondition`). Needs the retention context (the table's
   * `USING` sweep arm) — bind it through {@link createRetentionInstagramWebhookEventRepository}.
   */
  async deleteReceivedBefore(cutoff: Date): Promise<BatchDeleteResult> {
    return deleteInBatchesByCondition({
      databaseHandle: this.db(),
      table: instagram_webhook_events,
      idColumn: instagram_webhook_events.id,
      whereCondition: lt(instagram_webhook_events.created_at, cutoff),
      logContext: 'instagram-webhook-event-retention',
      tableLabel: 'app.instagram_webhook_events',
    });
  }
}

/**
 * {@link InstagramWebhookEventRepository} bound to a job's organization handle (a job-minted
 * organization scope, or `runOrganizationScopedWorkerJob`) — event processing's claim and marks
 * (WH12–WH14).
 */
export function createWorkerInstagramWebhookEventRepository(
  databaseHandle: WorkerDatabaseHandle,
): InstagramWebhookEventRepository {
  assertWorkerDatabaseContext(['organization']);
  return new InstagramWebhookEventRepository(databaseHandle);
}

/**
 * {@link InstagramWebhookEventRepository} bound to a retention maintenance handle
 * (`runGlobalRetentionWorkerJob`) — the cross-organization reads and deletes through the sweep arm
 * the policy carries in `USING` only: the 30-day clean-up (WH19) and the stuck-event pick-up (WH15).
 */
export function createRetentionInstagramWebhookEventRepository(
  databaseHandle: WorkerDatabaseHandle,
): InstagramWebhookEventRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new InstagramWebhookEventRepository(databaseHandle);
}
