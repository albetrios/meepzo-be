import { and, eq, getTableColumns, inArray, isNull, notInArray, type SQL, sql } from 'drizzle-orm';
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
  buildSearchCondition,
  finishKeysetPage,
  resolveKeysetSort,
} from '@/shared/utils/http/list-query.util.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { segments } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.schema.js';
import type { SegmentConditions } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import {
  BROADCAST_ACTIVE_STATUSES,
  BROADCAST_CANCELLABLE_STATUSES,
  type BroadcastMode,
  type BroadcastStatus,
} from './broadcast.constants.js';
import type { BroadcastMessages } from './broadcast.dto.js';
import { broadcasts } from './broadcast.schema.js';
import type { BroadcastRepositoryListQuery } from './broadcast.types.js';

/** `updated_at` for every change of a broadcast — never before the row's `created_at`. */
const broadcastUpdatedAtTimestamp = databaseUpdatedAtTimestamp(broadcasts.created_at);

/** One `app.broadcasts` row as Drizzle reads it. */
export type BroadcastRow = typeof broadcasts.$inferSelect;

/** A broadcast with the public ids of its account, segment and button automation. */
export type BroadcastViewRow = BroadcastRow & {
  channel_account_public_id: string;
  segment_public_id: string | null;
  start_automation_public_id: string | null;
};

/** A list row: the view row and the cursor timestamp. */
export type BroadcastListRow = BroadcastViewRow & CursorTimestampRow;

/** One page of route 70 as the repository returns it. */
export interface BroadcastListPage {
  items: BroadcastListRow[];
  total: number | null;
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}

/** The two keys every single-broadcast statement names. */
export interface BroadcastKey {
  organizationId: number;
  broadcastId: number;
}

/** The draft fields route 73 writes (BC8). */
export interface BroadcastDraftValues {
  name?: string;
  segment_id?: number | null;
  conditions?: SegmentConditions | null;
  messages?: BroadcastMessages;
  start_automation_id?: number | null;
}

/** What route 75's send writes on the draft (BC10). */
export interface BroadcastSendValues {
  status: BroadcastStatus;
  mode: BroadcastMode;
  /** The copy of the audience — a segment's conditions, or the one-off ones. */
  conditions: SegmentConditions;
  scheduledAt: Date | null;
  endsAt: Date | null;
  /** Set for `now` and `when_chat_opens`; the start duty sets it for `scheduled` (R47). */
  isStarted: boolean;
}

/** The live-broadcast guard every read and write carries (BC4). */
const LIVE_BROADCAST = isNull(broadcasts.deleted_at);

/** The public ids every read returns, as scalar sub-selects (so `FOR UPDATE` locks the broadcast only). */
const BROADCAST_VIEW_COLUMNS = {
  ...getTableColumns(broadcasts),
  channel_account_public_id: sql<string>`(
    SELECT ${channel_accounts.public_id} FROM ${channel_accounts}
    WHERE ${channel_accounts.organization_id} = ${broadcasts.organization_id}
      AND ${channel_accounts.id} = ${broadcasts.channel_account_id}
  )`,
  segment_public_id: sql<string | null>`(
    SELECT ${segments.public_id} FROM ${segments}
    WHERE ${segments.organization_id} = ${broadcasts.organization_id}
      AND ${segments.id} = ${broadcasts.segment_id}
  )`,
  start_automation_public_id: sql<string | null>`(
    SELECT ${automations.public_id} FROM ${automations}
    WHERE ${automations.organization_id} = ${broadcasts.organization_id}
      AND ${automations.id} = ${broadcasts.start_automation_id}
  )`,
};

/** The single live broadcast `key` names. */
function liveBroadcastWhere({ organizationId, broadcastId }: BroadcastKey): SQL | undefined {
  return and(
    eq(broadcasts.organization_id, organizationId),
    eq(broadcasts.id, broadcastId),
    LIVE_BROADCAST,
  );
}

/**
 * Drizzle access to `app.broadcasts` (feat-instagram-dm-sending routes-final § 7.A — routes 70–76):
 * the list, the reads, the draft writes and each status move as one guarded statement (BC9).
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id`, and a single-broadcast statement its
 *   internal `id` too, so tenant isolation does not rest on RLS alone; every read and write carries
 *   `deleted_at IS NULL` (BC4). Each transition is one `UPDATE … WHERE status IN (<from>)` — a row
 *   that left its status meanwhile is not touched (`null` / `false`). The list keysets on
 *   `(created_at, id)` or `(name, id)` through `finishKeysetPage`.
 * - **Failure modes:** none of its own; a CHECK violation would be a service bug.
 * - **Side effects:** writes `app.broadcasts` only; reads `app.channel_accounts`, `app.segments` and
 *   `app.automations` for their public ids and the button's live automation — join-only uses inside
 *   the app domain.
 * - **Notes:** HTTP paths run inside the caller's `withAppDatabaseContext`.
 */
export class BroadcastRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** One page of one account's live broadcasts (route 70), with the capped total on the first page. */
  async list({
    organizationId,
    query,
  }: {
    organizationId: number;
    query: BroadcastRepositoryListQuery;
  }): Promise<BroadcastListPage> {
    const where = and(
      eq(broadcasts.organization_id, organizationId),
      eq(broadcasts.channel_account_id, query.channelAccountId),
      LIVE_BROADCAST,
      query.statuses.length === 0 ? undefined : inArray(broadcasts.status, [...query.statuses]),
      query.mode === undefined ? undefined : eq(broadcasts.mode, query.mode),
      buildSearchCondition({ columns: [broadcasts.name], q: query.q }),
    );
    const { orderBy, cursorCondition, sortValueFor, filterFingerprint } =
      resolveKeysetSort<BroadcastListRow>({
        columns: {
          created_at: { column: broadcasts.created_at, kind: 'created_at' },
          name: { column: broadcasts.name, kind: 'text', getSortValue: (row) => row.name },
        },
        idColumn: broadcasts.id,
        defaultSort: 'created_at',
        sort: query.sort,
        order: query.order,
        q: query.q,
        filters: {
          channel_account_id: query.channelAccountId,
          status: query.statuses.join(','),
          mode: query.mode ?? null,
        },
        after: query.after,
      });
    const rows = (await this.db()
      .select({
        ...BROADCAST_VIEW_COLUMNS,
        cursor_created_at: cursorTimestampSelection(broadcasts.created_at),
      })
      .from(broadcasts)
      .where(and(where, cursorCondition))
      .orderBy(...orderBy)
      .limit(query.limit + 1)) as BroadcastListRow[];
    const page = finishKeysetPage({
      rows,
      args: { limit: query.limit, sortValueFor, filterFingerprint },
    });
    const total =
      query.after === undefined
        ? await countWithCap({ database: this.db(), table: broadcasts, where })
        : null;
    return { ...page, total };
  }

  /**
   * The organization's live broadcast with this public id (routes 72–76); `null` when absent,
   * deleted or another organization's. `lock` takes `FOR UPDATE` (every write).
   */
  async findLiveByPublicId({
    organizationId,
    broadcastPublicId,
    lock = false,
  }: {
    organizationId: number;
    broadcastPublicId: string;
    lock?: boolean;
  }): Promise<BroadcastViewRow | null> {
    const query = this.db()
      .select(BROADCAST_VIEW_COLUMNS)
      .from(broadcasts)
      .where(
        and(
          eq(broadcasts.organization_id, organizationId),
          eq(broadcasts.public_id, broadcastPublicId),
          LIVE_BROADCAST,
        ),
      )
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  /** The live broadcast `key` names, with its public ids (after a write). */
  async findLiveView(key: BroadcastKey): Promise<BroadcastViewRow | null> {
    const rows = await this.db()
      .select(BROADCAST_VIEW_COLUMNS)
      .from(broadcasts)
      .where(liveBroadcastWhere(key))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The internal id of a live automation of this account (`status = 'live'`, not deleted) — the
   * button's automation (BC8); `null` otherwise.
   */
  async findLiveAccountAutomationId({
    organizationId,
    channelAccountId,
    automationPublicId,
  }: {
    organizationId: number;
    channelAccountId: number;
    automationPublicId: string;
  }): Promise<number | null> {
    const rows = await this.db()
      .select({ id: automations.id })
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.channel_account_id, channelAccountId),
          eq(automations.public_id, automationPublicId),
          eq(automations.status, 'live'),
          isNull(automations.deleted_at),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /** Saves a new draft (route 71). */
  async insert({
    organizationId,
    channelAccount,
    name,
    values,
    createdByUserId,
  }: {
    organizationId: number;
    channelAccount: { id: number; channel: string };
    name: string;
    values: BroadcastDraftValues;
    createdByUserId: number | null;
  }): Promise<BroadcastRow> {
    const rows = await runInsertWithPublicIdentifierRetry({
      insert: () =>
        this.db()
          .insert(broadcasts)
          .values({
            public_id: generatePublicId('broadcast'),
            organization_id: organizationId,
            channel_account_id: channelAccount.id,
            channel: channelAccount.channel,
            name,
            segment_id: values.segment_id ?? null,
            conditions: values.conditions ?? null,
            messages: values.messages ?? [],
            start_automation_id: values.start_automation_id ?? null,
            created_by_user_id: createdByUserId,
            updated_by_user_id: createdByUserId,
          })
          .returning(),
    });
    const row = rows[0];
    if (row === undefined) throw new Error('broadcast insert returned no row');
    return row;
  }

  /** Writes a live draft's fields (route 73, BC8); `false` when it left `draft` or was deleted. */
  async updateDraft({
    organizationId,
    broadcastId,
    values,
    updatedByUserId,
  }: BroadcastKey & {
    values: BroadcastDraftValues;
    updatedByUserId: number | null;
  }): Promise<boolean> {
    const rows = await this.db()
      .update(broadcasts)
      .set({
        ...values,
        updated_by_user_id: updatedByUserId,
        updated_at: broadcastUpdatedAtTimestamp,
      })
      .where(
        and(liveBroadcastWhere({ organizationId, broadcastId }), eq(broadcasts.status, 'draft')),
      )
      .returning({ id: broadcasts.id });
    return rows.length > 0;
  }

  /**
   * Sends a live draft (route 75, BC10): its status and mode, the times, the copy of its audience;
   * `false` when it left `draft` or was deleted.
   */
  async markSent({
    organizationId,
    broadcastId,
    values,
    updatedByUserId,
  }: BroadcastKey & {
    values: BroadcastSendValues;
    updatedByUserId: number | null;
  }): Promise<boolean> {
    const rows = await this.db()
      .update(broadcasts)
      .set({
        status: values.status,
        mode: values.mode,
        conditions: values.conditions,
        scheduled_at: values.scheduledAt,
        ends_at: values.endsAt,
        started_at: values.isStarted ? sql`now()` : null,
        updated_by_user_id: updatedByUserId,
        updated_at: broadcastUpdatedAtTimestamp,
      })
      .where(
        and(liveBroadcastWhere({ organizationId, broadcastId }), eq(broadcasts.status, 'draft')),
      )
      .returning({ id: broadcasts.id });
    return rows.length > 0;
  }

  /**
   * Cancels a live broadcast by its owner (route 76, BC11) from `draft`, `scheduled`, `sending` or
   * `waiting_for_chats`; `false` when it is `done`, `cancelled` or deleted.
   */
  async cancelByOwner({
    organizationId,
    broadcastId,
    updatedByUserId,
  }: BroadcastKey & { updatedByUserId: number | null }): Promise<boolean> {
    const rows = await this.db()
      .update(broadcasts)
      .set({
        status: 'cancelled',
        cancelled_at: sql`now()`,
        cancel_reason: 'owner',
        updated_by_user_id: updatedByUserId,
        updated_at: broadcastUpdatedAtTimestamp,
      })
      .where(
        and(
          liveBroadcastWhere({ organizationId, broadcastId }),
          inArray(broadcasts.status, [...BROADCAST_CANCELLABLE_STATUSES]),
        ),
      )
      .returning({ id: broadcasts.id });
    return rows.length > 0;
  }

  /**
   * Cancels the organization's live `scheduled` and `waiting_for_chats` broadcasts because a move
   * down turned the plan's `broadcasts` switch off (BC9, WC-38, AC-9.11) — `cancel_reason`
   * `plan_feature_off`; drafts stay. Returns how many it cancelled.
   */
  async cancelForPlanFeatureOff(organizationId: number): Promise<number> {
    const rows = await this.db()
      .update(broadcasts)
      .set({
        status: 'cancelled',
        cancelled_at: sql`now()`,
        cancel_reason: 'plan_feature_off',
        updated_at: broadcastUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(broadcasts.organization_id, organizationId),
          LIVE_BROADCAST,
          inArray(broadcasts.status, ['scheduled', 'waiting_for_chats']),
        ),
      )
      .returning({ id: broadcasts.id });
    return rows.length;
  }

  /**
   * Soft-deletes a live broadcast that is not active (route 74, BC4, BC11); `false` when it is
   * `scheduled`, `sending`, `waiting_for_chats` or already deleted.
   */
  async softDelete({
    organizationId,
    broadcastId,
    updatedByUserId,
  }: BroadcastKey & { updatedByUserId: number | null }): Promise<boolean> {
    const rows = await this.db()
      .update(broadcasts)
      .set({
        deleted_at: sql`now()`,
        updated_by_user_id: updatedByUserId,
        updated_at: broadcastUpdatedAtTimestamp,
      })
      .where(
        and(
          liveBroadcastWhere({ organizationId, broadcastId }),
          notInArray(broadcasts.status, [...BROADCAST_ACTIVE_STATUSES]),
        ),
      )
      .returning({ id: broadcasts.id });
    return rows.length > 0;
  }

  /**
   * Sets `matched` of a live "when her chat opens" broadcast to the background count (BC10, WC-39 —
   * ROUTE row R46), only while it still waits for chats. Answers whether it changed.
   */
  async setWaitingMatched({
    organizationId,
    broadcastId,
    matched,
  }: {
    organizationId: number;
    broadcastId: number;
    matched: number;
  }): Promise<boolean> {
    const rows = await this.db()
      .update(broadcasts)
      .set({ matched })
      .where(
        and(
          eq(broadcasts.organization_id, organizationId),
          eq(broadcasts.id, broadcastId),
          eq(broadcasts.status, 'waiting_for_chats'),
          LIVE_BROADCAST,
        ),
      )
      .returning({ id: broadcasts.id });
    return rows.length > 0;
  }

  /**
   * Empties `segment_id` on the organization's live drafts that use this segment (BC17) — the
   * segment delete's step (route 81), in its transaction. Sent broadcasts keep theirs: their copy
   * of the conditions is what they send.
   */
  async clearDraftSegment({
    organizationId,
    segmentId,
  }: {
    organizationId: number;
    segmentId: number;
  }): Promise<number> {
    const rows = await this.db()
      .update(broadcasts)
      .set({ segment_id: null, updated_at: broadcastUpdatedAtTimestamp })
      .where(
        and(
          eq(broadcasts.organization_id, organizationId),
          eq(broadcasts.segment_id, segmentId),
          eq(broadcasts.status, 'draft'),
          LIVE_BROADCAST,
        ),
      )
      .returning({ id: broadcasts.id });
    return rows.length;
  }
}
