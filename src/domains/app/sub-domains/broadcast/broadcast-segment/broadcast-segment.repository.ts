import {
  and,
  arrayContains,
  arrayOverlaps,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { countWithCap } from '@/infrastructure/database/utils/capped-count.util.js';
import { databaseUpdatedAtTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import {
  type CursorTimestampRow,
  cursorTimestampSelection,
} from '@/shared/utils/http/pagination.util.js';
import {
  buildContainsLikePattern,
  buildSearchCondition,
  finishKeysetPage,
  resolveKeysetSort,
} from '@/shared/utils/http/list-query.util.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { contact_activities } from '@/domains/app/sub-domains/contact/contact-activity.schema.js';
import { CONTACT_CHAT_WINDOW_MS } from '@/domains/app/sub-domains/contact/contact.constants.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { automation_runs } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { automation_comment_logs } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.schema.js';
import { AUTOMATION_RUN_OPEN_STATUSES } from '@/domains/app/sub-domains/automation/automation-run/automation-run.constants.js';
import {
  SEGMENT_AUDIENCE_COUNT_STATEMENT_TIMEOUT_MS,
  SEGMENT_AUTOMATION_RUN_LOOKBACK_DAYS,
  SEGMENT_BROADCAST_COOLDOWN_HOURS,
} from './broadcast-segment.constants.js';
import type { SegmentCondition, SegmentConditions } from './broadcast-segment.dto.js';
import { segments } from './broadcast-segment.schema.js';
import type {
  SegmentAudienceCount,
  SegmentRepositoryListQuery,
} from './broadcast-segment.types.js';

/** `updated_at` for every change of a segment — never before the row's `created_at`. */
const segmentUpdatedAtTimestamp = databaseUpdatedAtTimestamp(segments.created_at);

/** One `app.segments` row as Drizzle reads it. */
export type SegmentRow = typeof segments.$inferSelect;

/** A segment with its account's public id (`cha_…`), as every read returns it. */
export type SegmentViewRow = SegmentRow & { channel_account_public_id: string };

/** A list row: the view row and the cursor timestamp. */
export type SegmentListRow = SegmentViewRow & CursorTimestampRow;

/** One page of route 77 as the repository returns it. */
export interface SegmentListPage {
  items: SegmentListRow[];
  total: number | null;
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}

/** The organization's channel account a segment names: its internal id and channel. */
export interface SegmentChannelAccount {
  id: number;
  public_id: string;
  channel: string;
}

/** The two keys every single-segment statement names. */
export interface SegmentKey {
  organizationId: number;
  segmentId: number;
}

/**
 * The automations a tree names, as internal ids by public id (`aut_…`) — the builder reads runs by
 * internal id. An id missing from the map matches no run.
 */
export type SegmentAutomationIds = ReadonlyMap<string, number>;

/** A segment's account (for its public id). */
const SEGMENT_CHANNEL_ACCOUNT_JOIN = and(
  eq(channel_accounts.organization_id, segments.organization_id),
  eq(channel_accounts.id, segments.channel_account_id),
);

/** The live-segment guard every read and write carries (BC4). */
const LIVE_SEGMENT = isNull(segments.deleted_at);

/** The contact's activity row (1:1, S5) — the audience reads its times. */
const CONTACT_ACTIVITY_JOIN = and(
  eq(contact_activities.organization_id, contacts.organization_id),
  eq(contact_activities.contact_id, contacts.id),
);

/** `now()` less `days` days. */
function daysAgo(days: number): SQL {
  return sql`now() - make_interval(days => ${days}::int)`;
}

/** `now()` less `hours` hours. */
function hoursAgo(hours: number): SQL {
  return sql`now() - make_interval(hours => ${hours}::int)`;
}

/** The internal id of an `aut_…` the tree names; `0` (no row) when it is not the account's. */
function automationIdOf(automationIds: SegmentAutomationIds, publicId: string): number {
  return automationIds.get(publicId) ?? 0;
}

/** One of her runs of this automation started in the last 90 days, with `extra` (BC12). */
function runOfAutomation({
  automationId,
  extra,
}: {
  automationId: number;
  extra?: SQL | undefined;
}): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${automation_runs}
    WHERE ${automation_runs.organization_id} = ${contacts.organization_id}
      AND ${automation_runs.contact_id} = ${contacts.id}
      AND ${automation_runs.automation_id} = ${automationId}
      AND ${automation_runs.started_at} >= ${daysAgo(SEGMENT_AUTOMATION_RUN_LOOKBACK_DAYS)}
      ${extra === undefined ? sql`` : sql`AND ${extra}`}
  )`;
}

/** The `automation` condition over her runs of the last 90 days (BC12, BC13). */
function automationCondition({
  condition,
  automationIds,
}: {
  condition: Extract<SegmentCondition, { field: 'automation' }>;
  automationIds: SegmentAutomationIds;
}): SQL {
  const automationId = automationIdOf(automationIds, condition.automation_id);
  switch (condition.state) {
    case 'started':
      return runOfAutomation({ automationId });
    case 'finished':
      return runOfAutomation({ automationId, extra: sql`${automation_runs.status} = 'completed'` });
    case 'in_progress':
      return runOfAutomation({
        automationId,
        extra: inArray(automation_runs.status, [...AUTOMATION_RUN_OPEN_STATUSES]),
      });
    case 'never':
      return sql`NOT ${runOfAutomation({ automationId })}`;
    case 'tapped_hello':
      // The opening message's button, recorded on the comment log of the run (launch AU24).
      return sql`EXISTS (
        SELECT 1 FROM ${automation_comment_logs}
        WHERE ${automation_comment_logs.organization_id} = ${contacts.organization_id}
          AND ${automation_comment_logs.contact_id} = ${contacts.id}
          AND ${automation_comment_logs.automation_id} = ${automationId}
          AND ${automation_comment_logs.button_clicked_at} IS NOT NULL
          AND ${automation_comment_logs.created_at} >= ${daysAgo(SEGMENT_AUTOMATION_RUN_LOOKBACK_DAYS)}
      )`;
    case 'got_message':
      // The run records the highest list message it sent (`last_message_number`, R14), so message
      // N reached her when a run of the last 90 days got at least that far (P310, revised at R14).
      return runOfAutomation({
        automationId,
        extra: sql`${automation_runs.last_message_number} >= ${condition.message_number}`,
      });
  }
}

/** The `came_in` condition over her first run's columns (BC12, CT3). */
function cameInCondition({
  condition,
  automationIds,
}: {
  condition: Extract<SegmentCondition, { field: 'came_in' }>;
  automationIds: SegmentAutomationIds;
}): SQL | undefined {
  switch (condition.via) {
    case 'first_automation':
      return eq(contacts.first_automation_id, automationIdOf(automationIds, condition.value ?? ''));
    case 'ref':
      return and(
        eq(contacts.came_in_via, 'ref_link'),
        condition.value === undefined ? undefined : eq(contacts.came_in_ref, condition.value),
      );
    case 'starter_question':
      return eq(contacts.came_in_via, 'starter_question');
    case 'ad':
      return inArray(contacts.came_in_via, ['ad_comment', 'ad_message']);
    case 'story_mention':
      return eq(contacts.came_in_via, 'story_mention');
    case 'first_message':
      return eq(contacts.came_in_via, 'first_message');
  }
}

/**
 * The `commented` condition (BC12, BC13): any post and no keyword reads her activity row (the last
 * comment time, or her comment count when no window is named); a post, a keyword, or more than
 * one comment in a window counts her distinct comments in the comment logs.
 */
function commentedCondition(
  condition: Extract<SegmentCondition, { field: 'commented' }>,
): SQL | undefined {
  const atLeast = condition.at_least ?? 1;
  if (condition.post === 'any' && condition.keyword === undefined) {
    if (condition.days === undefined) return gte(contact_activities.comment_count, atLeast);
    if (atLeast === 1) return gte(contact_activities.last_comment_at, daysAgo(condition.days));
  }
  const filters = and(
    condition.post === 'any'
      ? undefined
      : eq(automation_comment_logs.instagram_media_id, condition.post),
    condition.days === undefined
      ? undefined
      : gte(automation_comment_logs.created_at, daysAgo(condition.days)),
    condition.keyword === undefined
      ? undefined
      : ilike(automation_comment_logs.comment_text, buildContainsLikePattern(condition.keyword)),
  );
  return sql`(
    SELECT count(DISTINCT ${automation_comment_logs.instagram_comment_id})
    FROM ${automation_comment_logs}
    WHERE ${automation_comment_logs.organization_id} = ${contacts.organization_id}
      AND ${automation_comment_logs.contact_id} = ${contacts.id}
      ${filters === undefined ? sql`` : sql`AND ${filters}`}
  ) >= ${atLeast}`;
}

/** The `active` condition: her last message, or her first seen, within the window (BC12). */
function activeCondition(
  condition: Extract<SegmentCondition, { field: 'active' }>,
): SQL | undefined {
  if (condition.last_message_within_hours !== undefined) {
    return gte(
      contact_activities.last_message_received_at,
      hoursAgo(condition.last_message_within_hours),
    );
  }
  if (condition.last_message_within_days !== undefined) {
    return gte(
      contact_activities.last_message_received_at,
      daysAgo(condition.last_message_within_days),
    );
  }
  return gte(contacts.first_seen_at, daysAgo(condition.first_seen_within_days ?? 0));
}

/** The `tags` condition: all of the tags, any of them, or none of them (BC12). */
function tagsCondition(condition: Extract<SegmentCondition, { field: 'tags' }>): SQL {
  if (condition.match === 'all') return arrayContains(contacts.tags, condition.values);
  if (condition.match === 'any') return arrayOverlaps(contacts.tags, condition.values);
  return not(arrayOverlaps(contacts.tags, condition.values));
}

/** The `details` condition (BC12). */
function detailsCondition(
  condition: Extract<SegmentCondition, { field: 'details' }>,
): SQL | undefined {
  switch (condition.has) {
    case 'email':
      return isNotNull(contacts.email);
    case 'phone':
      return isNotNull(contacts.phone);
    case 'neither':
      return and(isNull(contacts.email), isNull(contacts.phone));
    case 'follows_account':
      return eq(contacts.is_following_account, true);
  }
}

/** One condition of the tree as SQL over the contact and her activity row (BC13). */
function conditionSql({
  condition,
  automationIds,
}: {
  condition: SegmentCondition;
  automationIds: SegmentAutomationIds;
}): SQL {
  let built: SQL | undefined;
  switch (condition.field) {
    case 'tags':
      built = tagsCondition(condition);
      break;
    case 'automation':
      built = automationCondition({ condition, automationIds });
      break;
    case 'came_in':
      built = cameInCondition({ condition, automationIds });
      break;
    case 'commented':
      built = commentedCondition(condition);
      break;
    case 'active':
      built = activeCondition(condition);
      break;
    case 'details':
      built = detailsCondition(condition);
      break;
    case 'story_activity':
      built = gte(contact_activities.last_story_activity_at, daysAgo(condition.days));
      break;
    case 'no_broadcast':
      built = or(
        isNull(contact_activities.last_broadcast_at),
        lt(contact_activities.last_broadcast_at, daysAgo(condition.days)),
      );
      break;
  }
  // A comparison on a NULL time is NULL; inside NOT or OR that must read as "no match".
  const conditionSqlOrTrue = built ?? sql`true`;
  return sql`coalesce(${conditionSqlOrTrue}, false)`;
}

/** A group's items joined by its operator (BC12). */
function groupSql({
  group,
  automationIds,
}: {
  group: SegmentConditions | { op: 'and' | 'or'; items: SegmentCondition[] };
  automationIds: SegmentAutomationIds;
}): SQL {
  const parts = group.items.map((item) =>
    'field' in item
      ? conditionSql({ condition: item, automationIds })
      : groupSql({ group: item, automationIds }),
  );
  return sql`(${sql.join(parts, sql.raw(group.op === 'and' ? ' AND ' : ' OR '))})`;
}

/**
 * The audience of one account's conditions (BC13): its live contacts that match the tree, the
 * always-left-out ones excluded — opted out, paused (`automations_off_at`), deleted, and anyone who
 * got a broadcast in the last 24 hours (7.10).
 *
 * @remarks
 * Algorithm: one boolean expression over `app.contacts` inner-joined to its activity row (the
 * activity row exists exactly while the contact is live, S5); the `automation` and `commented`
 * fields read `app.automation_runs` and `app.automation_comment_logs` through `EXISTS` / a counted
 * sub-select keyed by the contact. Side effects: none. Notes: the broadcast audience job (WC-40,
 * ROUTE rows R22, R46) reads the same expression.
 */
export function buildSegmentAudienceCondition({
  organizationId,
  channelAccountId,
  conditions,
  automationIds,
}: {
  organizationId: number;
  channelAccountId: number;
  conditions: SegmentConditions;
  automationIds: SegmentAutomationIds;
}): SQL | undefined {
  return and(
    eq(contacts.organization_id, organizationId),
    eq(contacts.channel_account_id, channelAccountId),
    isNull(contacts.deleted_at),
    isNull(contacts.opted_out_at),
    isNull(contacts.automations_off_at),
    or(
      isNull(contact_activities.last_broadcast_at),
      lt(contact_activities.last_broadcast_at, hoursAgo(SEGMENT_BROADCAST_COOLDOWN_HOURS)),
    ),
    groupSql({ group: conditions, automationIds }),
  );
}

/** Every automation public id a tree names (the `automation` field and `came_in.first_automation`). */
export function segmentAutomationPublicIds(conditions: SegmentConditions): string[] {
  const ids = new Set<string>();
  const visit = (item: SegmentConditions['items'][number]): void => {
    if (!('field' in item)) {
      for (const inner of item.items) visit(inner);
      return;
    }
    if (item.field === 'automation') ids.add(item.automation_id);
    if (item.field === 'came_in' && item.via === 'first_automation' && item.value !== undefined) {
      ids.add(item.value);
    }
  };
  for (const item of conditions.items) visit(item);
  return [...ids];
}

/**
 * Drizzle access to `app.segments` (feat-instagram-dm-sending routes-final § 7.B — routes 77–82)
 * and the audience builder over the account's contacts (BC13).
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id`, and a single-segment statement its
 *   internal `id` too, so tenant isolation does not rest on RLS alone; every read and write carries
 *   `deleted_at IS NULL` (BC4). The list keysets on `(name, id)` or `(created_at, id)` through
 *   `finishKeysetPage`. The audience count runs under its own `SET LOCAL statement_timeout` (BC14).
 * - **Failure modes:** an audience count past {@link SEGMENT_AUDIENCE_COUNT_STATEMENT_TIMEOUT_MS} is
 *   cancelled (Postgres 57014) — the service sends it to the background; the transaction is then
 *   aborted, so the count runs in its own unit of work.
 * - **Side effects:** reads `app.channel_accounts` (the account), `app.automations` (keyed by
 *   `channel_account_id` since ROUTE row R13 — an automation is the account's), `app.contacts`,
 *   `app.contact_activities`, `app.automation_runs` and `app.automation_comment_logs` (the audience)
 *   — join-only uses inside the app domain; writes `app.segments` only.
 * - **Notes:** HTTP paths run inside the caller's `withAppDatabaseContext`.
 */
export class BroadcastSegmentRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** The organization's channel account with this public id (any status — BC5), or `null`. */
  async findChannelAccount({
    organizationId,
    channelAccountPublicId,
  }: {
    organizationId: number;
    channelAccountPublicId: string;
  }): Promise<SegmentChannelAccount | null> {
    const rows = await this.db()
      .select({
        id: channel_accounts.id,
        public_id: channel_accounts.public_id,
        channel: channel_accounts.channel,
      })
      .from(channel_accounts)
      .where(
        and(
          eq(channel_accounts.organization_id, organizationId),
          eq(channel_accounts.public_id, channelAccountPublicId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The account's automations among `automationPublicIds` (deleted ones too — their runs stay), as
   * internal ids by public id (BC12). An id of another account or organization is absent.
   */
  async findAccountAutomationIds({
    organizationId,
    channelAccountId,
    automationPublicIds,
  }: {
    organizationId: number;
    channelAccountId: number;
    automationPublicIds: readonly string[];
  }): Promise<Map<string, number>> {
    if (automationPublicIds.length === 0) return new Map();
    const rows = await this.db()
      .select({ id: automations.id, public_id: automations.public_id })
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.channel_account_id, channelAccountId),
          inArray(automations.public_id, [...automationPublicIds]),
        ),
      );
    return new Map(rows.map((row) => [row.public_id, row.id]));
  }

  /** One page of one account's live segments (route 77), with the capped total on the first page. */
  async list({
    organizationId,
    query,
  }: {
    organizationId: number;
    query: SegmentRepositoryListQuery;
  }): Promise<SegmentListPage> {
    const where = and(
      eq(segments.organization_id, organizationId),
      eq(segments.channel_account_id, query.channelAccountId),
      LIVE_SEGMENT,
      buildSearchCondition({ columns: [segments.name], q: query.q }),
    );
    const { orderBy, cursorCondition, sortValueFor, filterFingerprint } =
      resolveKeysetSort<SegmentListRow>({
        columns: {
          name: { column: segments.name, kind: 'text', getSortValue: (row) => row.name },
          created_at: { column: segments.created_at, kind: 'created_at' },
        },
        idColumn: segments.id,
        defaultSort: 'name',
        sort: query.sort,
        order: query.order,
        q: query.q,
        filters: { channel_account_id: query.channelAccountId },
        after: query.after,
      });
    const rows = (await this.db()
      .select({
        ...getTableColumns(segments),
        channel_account_public_id: channel_accounts.public_id,
        cursor_created_at: cursorTimestampSelection(segments.created_at),
      })
      .from(segments)
      .innerJoin(channel_accounts, SEGMENT_CHANNEL_ACCOUNT_JOIN)
      .where(and(where, cursorCondition))
      .orderBy(...orderBy)
      .limit(query.limit + 1)) as SegmentListRow[];
    const page = finishKeysetPage({
      rows,
      args: { limit: query.limit, sortValueFor, filterFingerprint },
    });
    const total =
      query.after === undefined
        ? await countWithCap({ database: this.db(), table: segments, where })
        : null;
    return { ...page, total };
  }

  /**
   * The organization's live segment with this public id and its account's public id (routes 79–82);
   * `null` when absent, deleted or another organization's. `lock` takes `FOR UPDATE` (edit, delete).
   */
  async findLiveByPublicId({
    organizationId,
    segmentPublicId,
    lock = false,
  }: {
    organizationId: number;
    segmentPublicId: string;
    lock?: boolean;
  }): Promise<SegmentViewRow | null> {
    // The account's public id as a scalar sub-select, so `FOR UPDATE` locks the segment row only.
    const query = this.db()
      .select({
        ...getTableColumns(segments),
        channel_account_public_id: sql<string>`(
          SELECT ${channel_accounts.public_id} FROM ${channel_accounts}
          WHERE ${SEGMENT_CHANNEL_ACCOUNT_JOIN}
        )`,
      })
      .from(segments)
      .where(
        and(
          eq(segments.organization_id, organizationId),
          eq(segments.public_id, segmentPublicId),
          LIVE_SEGMENT,
        ),
      )
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  /** Saves a new segment (route 78). */
  async insert({
    organizationId,
    channelAccount,
    name,
    conditions,
    createdByUserId,
  }: {
    organizationId: number;
    channelAccount: SegmentChannelAccount;
    name: string;
    conditions: SegmentConditions;
    createdByUserId: number | null;
  }): Promise<SegmentRow> {
    const rows = await runInsertWithPublicIdentifierRetry({
      insert: () =>
        this.db()
          .insert(segments)
          .values({
            public_id: generatePublicId('segment'),
            organization_id: organizationId,
            channel_account_id: channelAccount.id,
            channel: channelAccount.channel,
            name,
            conditions,
            created_by_user_id: createdByUserId,
            updated_by_user_id: createdByUserId,
          })
          .returning(),
    });
    const row = rows[0];
    if (row === undefined) throw new Error('segment insert returned no row');
    return row;
  }

  /** Writes a live segment's name and conditions (route 80, BC15); `null` when it was deleted. */
  async update({
    organizationId,
    segmentId,
    values,
    updatedByUserId,
  }: SegmentKey & {
    values: { name?: string; conditions?: SegmentConditions };
    updatedByUserId: number | null;
  }): Promise<SegmentRow | null> {
    const rows = await this.db()
      .update(segments)
      .set({
        ...values,
        updated_by_user_id: updatedByUserId,
        updated_at: segmentUpdatedAtTimestamp,
      })
      .where(
        and(eq(segments.organization_id, organizationId), eq(segments.id, segmentId), LIVE_SEGMENT),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Soft-deletes a live segment (route 81, BC4); `false` when it was not live. */
  async softDelete({
    organizationId,
    segmentId,
    updatedByUserId,
  }: SegmentKey & { updatedByUserId: number | null }): Promise<boolean> {
    const rows = await this.db()
      .update(segments)
      .set({
        deleted_at: sql`now()`,
        updated_by_user_id: updatedByUserId,
        updated_at: segmentUpdatedAtTimestamp,
      })
      .where(
        and(eq(segments.organization_id, organizationId), eq(segments.id, segmentId), LIVE_SEGMENT),
      )
      .returning({ id: segments.id });
    return rows.length > 0;
  }

  /**
   * Counts one account's audience (route 82, BC13, BC14): the contacts the conditions match and,
   * of them, those whose chat is open now (her last direct message within 24 hours less 15
   * minutes), under a {@link SEGMENT_AUDIENCE_COUNT_STATEMENT_TIMEOUT_MS} statement timeout.
   */
  async countAudience({
    organizationId,
    channelAccountId,
    conditions,
    automationIds,
  }: {
    organizationId: number;
    channelAccountId: number;
    conditions: SegmentConditions;
    automationIds: SegmentAutomationIds;
  }): Promise<SegmentAudienceCount> {
    await this.db().execute(
      sql`SET LOCAL statement_timeout = ${sql.raw(String(SEGMENT_AUDIENCE_COUNT_STATEMENT_TIMEOUT_MS))}`,
    );
    const chatOpenSince = sql`now() - make_interval(secs => ${CONTACT_CHAT_WINDOW_MS / 1000}::double precision)`;
    const rows = await this.db()
      .select({
        matched: sql<number>`count(*)::int`,
        can_receive_now: sql<number>`(count(*) FILTER (WHERE ${contact_activities.last_direct_message_received_at} >= ${chatOpenSince}))::int`,
        counted_at: sql<string>`now()`,
      })
      .from(contacts)
      .innerJoin(contact_activities, CONTACT_ACTIVITY_JOIN)
      .where(
        buildSegmentAudienceCondition({
          organizationId,
          channelAccountId,
          conditions,
          automationIds,
        }),
      );
    const row = rows[0];
    return {
      matched: row?.matched ?? 0,
      canReceiveNow: row?.can_receive_now ?? 0,
      countedAt: row === undefined ? new Date() : new Date(row.counted_at),
    };
  }
}
