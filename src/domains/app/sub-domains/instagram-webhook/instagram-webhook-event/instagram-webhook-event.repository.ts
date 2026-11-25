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
  setLocalDatabaseConfig,
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
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { instagram_webhook_events } from './instagram-webhook-event.schema.js';
import {
  INSTAGRAM_WEBHOOK_EVENT_WAITING_STATUSES,
  type InstagramWebhookEventIntakeGroup,
  type InstagramWebhookEventKind,
  type InstagramWebhookEventSkipReason,
} from './instagram-webhook-event.constants.js';
import type { InstagramWebhookEventListFilters } from './instagram-webhook-event.types.js';

/** One `app.instagram_webhook_events` row as Drizzle reads it. */
export type InstagramWebhookEventRow = typeof instagram_webhook_events.$inferSelect;

/**
 * A list row: the event, its channel account's public id (route 62's `channel_account_id`) and its
 * microsecond cursor timestamp.
 */
export type InstagramWebhookEventListRow = InstagramWebhookEventRow & {
  channel_account_public_id: string;
  cursor_created_at: string;
};

/** The account every event write is scoped by: its organization and its channel account. */
export interface InstagramWebhookEventAccountKey {
  /** `tenancy.organizations.id` of the owning organization. */
  organizationId: number;
  /** `app.channel_accounts.id` the events were saved for (feat-instagram-dm-sending § 5.B.3). */
  channelAccountId: number;
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
  /** WH9's key, at most 512 characters; its repeat guard is the key table (WH20). */
  eventKey: string;
  /** Set to store the event `skipped` with this reason; `null` stores it `received`. */
  skipReason: InstagramWebhookEventSkipReason | null;
  /** The event item as received (a JSON object) — stored only for a `received` row (WH22). */
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
 * One channel account the stuck-event pick-up hands back to processing (WH17): the two public ids
 * its processing job carries — never an internal id (queue rule § 3.1, WHC4).
 */
export interface InstagramWebhookStuckAccount {
  /** The account's organization — the job's `organizationPublicId` (K8). */
  organizationPublicId: string;
  /** `cha_…` — the job's `channelAccountPublicId`. */
  channelAccountPublicId: string;
  /** The kind group whose events wait — the intake job to add (WH5). */
  intakeGroup: InstagramWebhookEventIntakeGroup;
}

/** The `error_message` of an event whose attempts ran out (WH12, WH14). */
export const INSTAGRAM_WEBHOOK_EVENT_ATTEMPTS_EXHAUSTED_ERROR = 'processing_attempts_exhausted';

/** The longest `error_message` the column holds. */
const ERROR_MESSAGE_MAX_LENGTH = 2000;

/** The sort the list's cursor fingerprint names (route 62 has one order). */
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

/** Route 62's filters as SQL, the organization first (RLS plus the repository's own filter). */
function buildListConditions({
  organizationId,
  filters,
}: {
  organizationId: number;
  filters: InstagramWebhookEventListFilters;
}): SQL[] {
  const conditions: SQL[] = [eq(instagram_webhook_events.organization_id, organizationId)];
  if (filters.channelAccountPublicId !== undefined) {
    // An id of another organization (or none) resolves to NULL, so the page is empty (5.B.9).
    conditions.push(
      eq(
        instagram_webhook_events.channel_account_id,
        sql`(SELECT ${channel_accounts.id} FROM ${channel_accounts}
          WHERE ${channel_accounts.organization_id} = ${organizationId}
            AND ${channel_accounts.public_id} = ${filters.channelAccountPublicId})`,
      ),
    );
  }
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
 * The SHA-256 of route 62's filter set, bound into every cursor it mints (sec-U12) — `limit` and
 * `include_total` stay out, so a continuation may change the page size.
 */
function computeListFingerprint(filters: InstagramWebhookEventListFilters): string {
  return computeListFilterFingerprint({
    q: undefined,
    sort: LIST_SORT,
    order: 'desc',
    filters: {
      channel_account_id: filters.channelAccountPublicId ?? null,
      status: filters.status ?? null,
      event_kind: filters.eventKind ?? null,
      received_from: filters.receivedFrom ?? null,
      received_to: filters.receivedTo ?? null,
    },
  });
}

/**
 * The `400` of a cursor route 62 cannot continue (5.B.9): not minted here, or minted under other
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
    eq(instagram_webhook_events.channel_account_id, claim.channelAccountId),
    eq(instagram_webhook_events.id, claim.eventId),
    inArray(instagram_webhook_events.status, [...INSTAGRAM_WEBHOOK_EVENT_WAITING_STATUSES]),
    eq(instagram_webhook_events.attempt_count, claim.claimedAttemptCount),
  );
}

/**
 * Drizzle access to `app.instagram_webhook_events` (feat-instagram-dm-sending routes-final § 5.B.3,
 * 5.B.10, WHC11): the insert of a delivery's new events, the claim of a kind group's oldest waiting
 * event (a `MATERIALIZED` CTE), the guarded final marks (which clear the body, WH22) and the claim
 * release, intake's reads (the flood count, the owner's echoes, the waiting count), route 62's
 * keyset list, the stuck-event pick-up's read and the launch's clean-up (retired by the part drops
 * at ROUTE R49).
 *
 * @remarks
 * - **Algorithm:** every row statement names `organization_id` (and the channel account and the row
 *   id where it has them), so tenant isolation does not rest on RLS alone. The table is split by day
 *   (WH19): the repeat guard is `app.instagram_webhook_event_keys` — the store function inserts only
 *   the events whose key it just claimed there (WH9 step 6). The claim reads one kind group's head
 *   (oldest `received` / `queued`, by `created_at`, `id`) in a `MATERIALIZED` CTE and updates it
 *   only while no other run holds its lease — never skipping ahead for messages and Live, the
 *   oldest free row `SKIP LOCKED` for comments (WH11, S11). The try count the claim sets is its
 *   token: every later mark of that claim requires it.
 * - **Failure modes:** a cursor not minted here, or minted under other filters, is a `400` on
 *   `after`; guarded writes return `false` / `null` when the row is not in the state they require.
 * - **Side effects:** writes `app.instagram_webhook_events` only. Rows are created only by the
 *   store function, changed only by intake and go with their day part (5.B.10) — a contact erase
 *   leaves them (WH24), and route 62 never changes one.
 * - **Notes:** HTTP paths run inside the caller's `withAppDatabaseContext` (the receiver's
 *   `VERIFIED` scope, route 62's request scope); workers bind a handle through
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
   * Caps every later statement of the surrounding unit of work at `milliseconds` —
   * `set_config('statement_timeout', …, true)`, the transaction-local `SET LOCAL` (WH2, WHC2): the
   * webhook's store unit, so a slow Postgres answers inside Meta's 5-second budget.
   */
  async limitStatementTime(milliseconds: number): Promise<void> {
    await setLocalDatabaseConfig({
      databaseHandle: this.db(),
      key: 'statement_timeout',
      value: String(milliseconds),
    });
  }

  /**
   * Stores one account's new events in one `INSERT` (WH9 step 6): a row without a skip reason is
   * born `received` with its body, one with a skip reason `skipped`, final (`processed_at` set) and
   * without a body (WH22). The caller passes only the events whose key it just claimed in
   * `app.instagram_webhook_event_keys`, so a repeat never reaches here.
   */
  async insertEvents({
    organizationId,
    channelAccountId,
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
              channel_account_id: channelAccountId,
              instagram_user_id: event.instagramUserId,
              contact_instagram_user_id: event.contactInstagramUserId,
              event_kind: event.eventKind,
              event_key: event.eventKey,
              status: event.skipReason === null ? 'received' : 'skipped',
              skip_reason: event.skipReason,
              payload: event.skipReason === null ? event.payload : null,
              occurred_at: event.occurredAt,
              processed_at: event.skipReason === null ? null : databaseNowTimestamp,
              request_id: requestId,
            })),
          )
          .returning(),
    });
  }

  /**
   * Claims the oldest waiting event of one kind group of the account (WH11, WH12 step 1): when no
   * other run holds its lease (no claim in the last `claimLeaseMinutes`), adds one to its try count
   * and starts the lease — or, when it already used `maxProcessingAttempts`, marks it `failed`
   * (`processing_attempts_exhausted`, `next_attempt_at` = `retryAfterMinutes` later) instead.
   * Returns `null` when nothing of the group waits, or (strict order) its head is leased.
   *
   * @remarks
   * - **Algorithm:** a `MATERIALIZED` CTE reads the row once (`created_at`, `id`; served by
   *   `idx_instagram_webhook_events_pending`, which leads with `(channel_account_id, intake_group)`);
   *   the `UPDATE … FROM` re-checks status and lease on the row it locks, so two runs racing for one
   *   row claim it once. **Strict order** (`messages`, `live` — WH11): the group's head only, never
   *   skipping ahead. **`skipLocked`** (`comments`, scale review S11): the oldest row whose lease is
   *   free, `FOR UPDATE SKIP LOCKED`, so several comment-intake jobs of one account work side by
   *   side (her contact's lock keeps one person's events in order). The claimed row is read back
   *   through Drizzle (typed columns).
   * - **Notes:** the caller passes the intake constants — this method owns no policy number.
   */
  async claimOldestWaitingEvent({
    organizationId,
    channelAccountId,
    intakeGroup,
    isSkipLocked,
    maxProcessingAttempts,
    claimLeaseMinutes,
    retryAfterMinutes,
  }: InstagramWebhookEventAccountKey & {
    /** The kind group the job claims (WH11). */
    intakeGroup: InstagramWebhookEventIntakeGroup;
    /** `true` for the comment group (S11): the oldest free row, `SKIP LOCKED`; else the head. */
    isSkipLocked: boolean;
    /** A row that already used this many tries is failed instead of claimed. */
    maxProcessingAttempts: number;
    /** How long a claim holds the event (the "stuck" lease). */
    claimLeaseMinutes: number;
    /** An exhausted row's `next_attempt_at` is this many minutes later (WH12). */
    retryAfterMinutes: number;
  }): Promise<InstagramWebhookEventClaimResult | null> {
    const leaseFree = sql`(last_attempted_at IS NULL
              OR last_attempted_at <= now() - make_interval(mins => ${claimLeaseMinutes}))`;
    const pick = isSkipLocked
      ? sql`SELECT id, created_at
          FROM app.instagram_webhook_events
         WHERE organization_id = ${organizationId}
           AND channel_account_id = ${channelAccountId}
           AND intake_group = ${intakeGroup}
           AND status IN ('received', 'queued')
           AND ${leaseFree}
         ORDER BY created_at ASC, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      : sql`SELECT id, created_at
          FROM app.instagram_webhook_events
         WHERE organization_id = ${organizationId}
           AND channel_account_id = ${channelAccountId}
           AND intake_group = ${intakeGroup}
           AND status IN ('received', 'queued')
         ORDER BY created_at ASC, id ASC
         LIMIT 1`;
    const result = await this.db().execute(sql`
      WITH head AS MATERIALIZED (${pick})
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
             next_attempt_at = CASE WHEN head_event.attempt_count >= ${maxProcessingAttempts}
                                    THEN now() + make_interval(mins => ${retryAfterMinutes})
                                    ELSE head_event.next_attempt_at END,
             processed_at = CASE WHEN head_event.attempt_count >= ${maxProcessingAttempts}
                                 THEN now() ELSE head_event.processed_at END,
             updated_at = greatest(head_event.created_at, now())
        FROM head
       WHERE head_event.id = head.id
         AND head_event.created_at = head.created_at
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

  /**
   * How many of her message-group events (echoes aside) the account saved since `since` — the
   * inbound flood count (WH16, P63), served by `idx_instagram_webhook_events_flood`.
   */
  async countContactMessageEventsSince({
    organizationId,
    channelAccountId,
    contactInstagramUserId,
    since,
  }: InstagramWebhookEventAccountKey & {
    contactInstagramUserId: string;
    since: Date;
  }): Promise<number> {
    const [row] = await this.db()
      .select({ count: sql<number>`count(*)::int` })
      .from(instagram_webhook_events)
      .where(
        and(
          eq(instagram_webhook_events.organization_id, organizationId),
          eq(instagram_webhook_events.channel_account_id, channelAccountId),
          eq(instagram_webhook_events.contact_instagram_user_id, contactInstagramUserId),
          eq(instagram_webhook_events.intake_group, 'messages'),
          gte(instagram_webhook_events.created_at, since),
          sql`${instagram_webhook_events.event_kind} <> 'echo'`,
        ),
      );
    return Number(row?.count ?? 0);
  }

  /**
   * The Meta message ids (`mid`) of the echoes to her the account took in since `since` — the
   * owner's hand-typed messages the quiet time reads (WH10), from the rows' `echo:<mid>` keys (the
   * body is cleared once done, the key stays).
   */
  async listEchoMessageIdsSince({
    organizationId,
    channelAccountId,
    contactInstagramUserId,
    since,
  }: InstagramWebhookEventAccountKey & {
    contactInstagramUserId: string;
    since: Date;
  }): Promise<string[]> {
    const rows = await this.db()
      .select({ event_key: instagram_webhook_events.event_key })
      .from(instagram_webhook_events)
      .where(
        and(
          eq(instagram_webhook_events.organization_id, organizationId),
          eq(instagram_webhook_events.channel_account_id, channelAccountId),
          eq(instagram_webhook_events.contact_instagram_user_id, contactInstagramUserId),
          eq(instagram_webhook_events.intake_group, 'messages'),
          eq(instagram_webhook_events.event_kind, 'echo'),
          eq(instagram_webhook_events.status, 'processed'),
          gte(instagram_webhook_events.created_at, since),
        ),
      );
    return rows.flatMap((row) =>
      row.event_key.startsWith('echo:') ? [row.event_key.slice('echo:'.length)] : [],
    );
  }

  /**
   * How many events of one kind group of the account still wait, counted up to `cap` (WH11: over
   * `INSTAGRAM_INTAKE_ACCOUNT_SOFT_LIMIT` waiting comments, the comment intake runs at the lowest
   * priority).
   */
  async countWaitingEvents({
    organizationId,
    channelAccountId,
    intakeGroup,
    cap,
  }: InstagramWebhookEventAccountKey & {
    intakeGroup: InstagramWebhookEventIntakeGroup;
    cap: number;
  }): Promise<number> {
    const result = await this.db().execute(sql`
      SELECT count(*)::int AS count FROM (
        SELECT 1 FROM app.instagram_webhook_events
         WHERE organization_id = ${organizationId}
           AND channel_account_id = ${channelAccountId}
           AND intake_group = ${intakeGroup}
           AND status IN ('received', 'queued')
         LIMIT ${cap}
      ) AS waiting
    `);
    const [row] = rowsOf<{ count: number | string }>(result);
    return Number(row?.count ?? 0);
  }

  /**
   * Marks a claimed event `processed` (WH12 step 4) and clears its body in the same statement
   * (WH22). `false` when the claim no longer holds.
   */
  async markProcessed(claim: InstagramWebhookEventClaimKey): Promise<boolean> {
    const rows = await this.db()
      .update(instagram_webhook_events)
      .set({
        status: 'processed',
        payload: null,
        processed_at: databaseNowTimestamp,
        updated_at: eventUpdatedAtTimestamp,
      })
      .where(claimCondition(claim))
      .returning({ id: instagram_webhook_events.id });
    return rows.length > 0;
  }

  /**
   * Marks a claimed event `skipped` with its reason — the account's switch went off, or it is no
   * longer `connected`, while the event waited (WH12 step 2) — and clears its body (WH22). `false`
   * when the claim no longer holds.
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
        payload: null,
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
    retryAfterMinutes,
    ...claim
  }: InstagramWebhookEventClaimKey & {
    errorMessage: string;
    /** `next_attempt_at` this many minutes later (the hourly retry, WH12); `null` — never again. */
    retryAfterMinutes: number | null;
  }): Promise<boolean> {
    const rows = await this.db()
      .update(instagram_webhook_events)
      .set({
        status: 'failed',
        error_message: errorMessage.slice(0, ERROR_MESSAGE_MAX_LENGTH),
        next_attempt_at:
          retryAfterMinutes === null
            ? null
            : sql`now() + make_interval(mins => ${retryAfterMinutes})`,
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
   * The stuck-event pick-up's read across organizations (WH17, WC-12): the channel accounts — of
   * live organizations, read from `app.channel_accounts` (no Instagram account join, R17) — that have an event still `received` or `queued` more than
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
        channelAccountPublicId: channel_accounts.public_id,
        intakeGroup: sql<InstagramWebhookEventIntakeGroup>`${instagram_webhook_events.intake_group}`,
      })
      .from(instagram_webhook_events)
      .innerJoin(
        channel_accounts,
        and(
          eq(channel_accounts.organization_id, instagram_webhook_events.organization_id),
          eq(channel_accounts.id, instagram_webhook_events.channel_account_id),
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
      .groupBy(
        organizations.public_id,
        channel_accounts.public_id,
        instagram_webhook_events.intake_group,
      )
      .orderBy(sql`min(${instagram_webhook_events.created_at})`)
      .limit(limit);
  }

  /**
   * Route 62's page (WH23): the organization's events newest first by received time, then id,
   * filtered by channel account, status, kind and received window; `limit + 1` rows through
   * `finishKeysetPage`, the cursor bound to the filters; a capped count when asked. Each row carries
   * its channel account's public id.
   *
   * @remarks
   * Failure modes: an `after` this server did not mint, or minted under other filters, throws a
   * `400` on `after` (5.B.9) — never a silent restart. A `channel_account_id` of another
   * organization finds nothing (an empty page, not a `404`).
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
        channel_account_public_id: channel_accounts.public_id,
        cursor_created_at: cursorTimestampSelection(instagram_webhook_events.created_at),
      })
      .from(instagram_webhook_events)
      .innerJoin(
        channel_accounts,
        and(
          eq(channel_accounts.organization_id, instagram_webhook_events.organization_id),
          eq(channel_accounts.id, instagram_webhook_events.channel_account_id),
        ),
      )
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
