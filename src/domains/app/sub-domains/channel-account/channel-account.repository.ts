import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  RESOURCE_QUOTA_LOCK_NAMESPACE,
  acquireResourceQuotaLock,
} from '@/infrastructure/database/resource-quota-lock.util.js';
import {
  databaseNowTimestamp,
  databaseUpdatedAtTimestamp,
} from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { channel_accounts } from './channel-account.schema.js';
import {
  CHANNEL_ACCOUNT_PLAN_STOP_REASON,
  CHANNEL_ACCOUNT_STATUS,
  type ChannelAccountChannel,
  type ChannelAccountPlanStopReason,
} from './channel-account.constants.js';

/** `updated_at` for every change of an account — never before the row's `created_at`. */
const accountUpdatedAtTimestamp = databaseUpdatedAtTimestamp(channel_accounts.created_at);

/** One organization's chooser counts — {@link ChannelAccountRepository.listOrganizationCountsForUser}. */
export interface OrganizationCountsRow {
  organizationPublicId: string;
  membersCount: number;
  channelAccountsCount: number;
  liveAutomationsCount: number;
}

/** One live channel account's week as {@link ChannelAccountRepository.readWeeklySummary} reads it. */
export interface ChannelAccountWeekRow {
  channelAccountPublicId: string;
  displayName: string;
  runsStarted: number;
  tappedRuns: number;
  directMessagesSent: number;
  newContacts: number;
  emailsCollected: number;
  phonesCollected: number;
  topAutomationName: string | null;
}

/** One `app.channel_accounts` row as Drizzle reads it. */
export type ChannelAccountRow = typeof channel_accounts.$inferSelect;

/** The two keys every account write is scoped by: its organization and its internal id. */
export interface ChannelAccountKey {
  /** `tenancy.organizations.id` of the owning organization. */
  organizationId: number;
  /** `app.channel_accounts.id`. */
  channelAccountId: number;
}

/** What the pick writes onto the account (routes-final § 1 MC7, CAC5). */
export interface ChannelAccountConnectValues {
  organizationId: number;
  channel: ChannelAccountChannel;
  channelConnectionId: number;
  providerAccountId: string;
  displayName: string;
  /** `auth.users.id` of the connecting user; `null` when the caller has none. */
  connectedByUserId: number | null;
}

/** The not-revoked condition every live read uses. */
const isLive = ne(channel_accounts.connection_status, CHANNEL_ACCOUNT_STATUS.REVOKED);

/** The "active" condition of the plan's count (CA9): not revoked and not `plan_downgrade`. */
const isActive = and(
  isLive,
  sql`${channel_accounts.plan_stop_reason} IS DISTINCT FROM ${CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_DOWNGRADE}`,
);

/**
 * Drizzle access to `app.channel_accounts` (routes-final § 1B.3, CAC1, CAC4): the pick's upsert, the
 * reads of routes 6–11 and of the connection's account port, the guarded status changes (CA4), the
 * pause and resume (CA7), the plan stop of route 11 (CA9) and the organization lock it shares with the
 * pick (MC7).
 *
 * @remarks
 * - **Algorithm:** every row statement names `organization_id` and, for a single row, its internal
 *   `id` or public id, so tenant isolation does not rest on RLS alone. The upsert keys on the unique
 *   `(organization_id, channel, provider_account_id)` index, so a pick brings a revoked row back.
 * - **Failure modes:** a pick racing another organization for the same provider account fails
 *   `idx_channel_accounts_provider_account_live` (23505) — the caller maps it.
 * - **Side effects:** writes `app.channel_accounts` only.
 * - **Notes:** status changes are guarded (`WHERE connection_status = …`), so the caller that gets
 *   `null` lost a race and does nothing more.
 */
export class ChannelAccountRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** The organization's not-revoked accounts of these channels, oldest connected first (route 6). */
  async listLive({
    organizationId,
    channels,
  }: {
    organizationId: number;
    channels: readonly ChannelAccountChannel[];
  }): Promise<ChannelAccountRow[]> {
    if (channels.length === 0) return [];
    return this.db()
      .select()
      .from(channel_accounts)
      .where(
        and(
          eq(channel_accounts.organization_id, organizationId),
          inArray(channel_accounts.channel, [...channels]),
          isLive,
        ),
      )
      .orderBy(asc(channel_accounts.connected_at), asc(channel_accounts.id));
  }

  /** One account of the organization by its public id, any status; `null` when absent. */
  async findByPublicId({
    organizationId,
    channelAccountPublicId,
  }: {
    organizationId: number;
    channelAccountPublicId: string;
  }): Promise<ChannelAccountRow | null> {
    const rows = await this.db()
      .select()
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

  /** One account of the organization by its internal id, any status; `null` when absent. */
  async findById({
    organizationId,
    channelAccountId,
  }: ChannelAccountKey): Promise<ChannelAccountRow | null> {
    const rows = await this.db()
      .select()
      .from(channel_accounts)
      .where(
        and(
          eq(channel_accounts.organization_id, organizationId),
          eq(channel_accounts.id, channelAccountId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * One account of the organization by its internal id, locked `FOR UPDATE` until the unit ends —
   * the automation go-live's starter-question count (feat-instagram-dm-sending 4.A.10: the account
   * first, then the automation); `null` when absent.
   */
  async lockById({
    organizationId,
    channelAccountId,
  }: ChannelAccountKey): Promise<ChannelAccountRow | null> {
    const rows = await this.db()
      .select()
      .from(channel_accounts)
      .where(
        and(
          eq(channel_accounts.organization_id, organizationId),
          eq(channel_accounts.id, channelAccountId),
        ),
      )
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /** The organization's accounts by internal id, any status. */
  async findByIds({
    organizationId,
    channelAccountIds,
  }: {
    organizationId: number;
    channelAccountIds: readonly number[];
  }): Promise<ChannelAccountRow[]> {
    if (channelAccountIds.length === 0) return [];
    return this.db()
      .select()
      .from(channel_accounts)
      .where(
        and(
          eq(channel_accounts.organization_id, organizationId),
          inArray(channel_accounts.id, [...channelAccountIds]),
        ),
      );
  }

  /** The organization's accounts of a channel with these provider ids, any status. */
  async findByProviderAccountIds({
    organizationId,
    channel,
    providerAccountIds,
  }: {
    organizationId: number;
    channel: ChannelAccountChannel;
    providerAccountIds: readonly string[];
  }): Promise<ChannelAccountRow[]> {
    if (providerAccountIds.length === 0) return [];
    return this.db()
      .select()
      .from(channel_accounts)
      .where(
        and(
          eq(channel_accounts.organization_id, organizationId),
          eq(channel_accounts.channel, channel),
          inArray(channel_accounts.provider_account_id, [...providerAccountIds]),
        ),
      );
  }

  /** The not-revoked accounts of these connections, oldest connected first. */
  async listLiveByConnections({
    organizationId,
    channelConnectionIds,
  }: {
    organizationId: number;
    channelConnectionIds: readonly number[];
  }): Promise<ChannelAccountRow[]> {
    if (channelConnectionIds.length === 0) return [];
    return this.db()
      .select()
      .from(channel_accounts)
      .where(
        and(
          eq(channel_accounts.organization_id, organizationId),
          inArray(channel_accounts.channel_connection_id, [...channelConnectionIds]),
          isLive,
        ),
      )
      .orderBy(asc(channel_accounts.connected_at), asc(channel_accounts.id));
  }

  /** How many not-revoked accounts the organization has (the pick's count, MC7). */
  async countLive(organizationId: number): Promise<number> {
    const [row] = await this.db()
      .select({ count: sql<number>`count(*)::int` })
      .from(channel_accounts)
      .where(and(eq(channel_accounts.organization_id, organizationId), isLive));
    return row?.count ?? 0;
  }

  /**
   * The organization chooser's counts (route 132, feat-instagram-dm-sending UN5) for the given
   * organizations where the user holds an active membership: active members, accounts not revoked,
   * live automations. One call of the SECURITY DEFINER `app.list_organization_counts_for_user` — the
   * chooser runs in the user's context, where the organization-scoped policies show no app rows.
   */
  async listOrganizationCountsForUser({
    userPublicId,
    organizationPublicIds,
  }: {
    userPublicId: string;
    organizationPublicIds: readonly string[];
  }): Promise<OrganizationCountsRow[]> {
    if (organizationPublicIds.length === 0) return [];
    const organizationPublicIdValues = sql.join(
      organizationPublicIds.map((publicId) => sql`${publicId}`),
      sql`, `,
    );
    const result = await this.db().execute(
      sql`SELECT organization_public_id, members_count, channel_accounts_count, live_automations_count FROM app.list_organization_counts_for_user(${userPublicId}, ARRAY[${organizationPublicIdValues}]::text[])`,
    );
    return result.rows.map((row) => ({
      organizationPublicId: String(row.organization_public_id),
      membersCount: Number(row.members_count),
      channelAccountsCount: Number(row.channel_accounts_count),
      liveAutomationsCount: Number(row.live_automations_count),
    }));
  }

  /**
   * The weekly summary's numbers (feat-instagram-dm-sending UN12, WC-58) per live account of the
   * organization over `[since, until)`: runs started (by the run's start — the month parts are
   * pruned), runs with a button tap, DMs sent, new contacts (first seen), emails and phones saved,
   * and the automation with the most runs. One statement; every part names `organization_id`.
   */
  async readWeeklySummary({
    organizationId,
    since,
    until,
  }: {
    organizationId: number;
    since: Date;
    until: Date;
  }): Promise<ChannelAccountWeekRow[]> {
    const from = since.toISOString();
    const to = until.toISOString();
    const result = await this.db().execute(sql`
      WITH week_runs AS (
        SELECT r.id, r.automation_id, a.channel_account_id
        FROM app.automation_runs r
        JOIN app.automations a ON a.organization_id = r.organization_id AND a.id = r.automation_id
        WHERE r.organization_id = ${organizationId}
          AND r.started_at >= ${from}::timestamptz AND r.started_at < ${to}::timestamptz
      ),
      tapped_runs AS (
        SELECT DISTINCT e.automation_run_id
        FROM app.automation_run_events e
        WHERE e.organization_id = ${organizationId}
          AND e.automation_run_started_at >= ${from}::timestamptz
          AND e.automation_run_started_at < ${to}::timestamptz
          AND e.event_type IN ('hello_tapped', 'follow_tapped')
      )
      SELECT ca.public_id, ca.display_name,
        (SELECT count(*) FROM week_runs w WHERE w.channel_account_id = ca.id)::int AS runs_started,
        (SELECT count(*) FROM week_runs w JOIN tapped_runs t ON t.automation_run_id = w.id
          WHERE w.channel_account_id = ca.id)::int AS tapped_runs,
        (SELECT count(*) FROM app.instagram_messages m
          WHERE m.organization_id = ${organizationId} AND m.channel_account_id = ca.id
            AND m.status = 'sent' AND m.is_counted_as_direct_message
            AND m.sent_at >= ${from}::timestamptz AND m.sent_at < ${to}::timestamptz)::int AS direct_messages_sent,
        (SELECT count(*) FROM app.contacts c
          WHERE c.organization_id = ${organizationId} AND c.channel_account_id = ca.id
            AND c.deleted_at IS NULL
            AND c.first_seen_at >= ${from}::timestamptz AND c.first_seen_at < ${to}::timestamptz)::int AS new_contacts,
        (SELECT count(*) FROM app.contacts c
          WHERE c.organization_id = ${organizationId} AND c.channel_account_id = ca.id
            AND c.deleted_at IS NULL
            AND c.email_collected_at >= ${from}::timestamptz AND c.email_collected_at < ${to}::timestamptz)::int AS emails_collected,
        (SELECT count(*) FROM app.contacts c
          WHERE c.organization_id = ${organizationId} AND c.channel_account_id = ca.id
            AND c.deleted_at IS NULL
            AND c.phone_collected_at >= ${from}::timestamptz AND c.phone_collected_at < ${to}::timestamptz)::int AS phones_collected,
        (SELECT au.name FROM week_runs w
          JOIN app.automations au ON au.organization_id = ${organizationId} AND au.id = w.automation_id
          WHERE w.channel_account_id = ca.id
          GROUP BY au.id, au.name ORDER BY count(*) DESC, au.id LIMIT 1) AS top_automation_name
      FROM app.channel_accounts ca
      WHERE ca.organization_id = ${organizationId}
        AND ca.connection_status <> ${CHANNEL_ACCOUNT_STATUS.REVOKED}
      ORDER BY ca.id
    `);
    return result.rows.map((row) => ({
      channelAccountPublicId: String(row.public_id),
      displayName: String(row.display_name),
      runsStarted: Number(row.runs_started),
      tappedRuns: Number(row.tapped_runs),
      directMessagesSent: Number(row.direct_messages_sent),
      newContacts: Number(row.new_contacts),
      emailsCollected: Number(row.emails_collected),
      phonesCollected: Number(row.phones_collected),
      topAutomationName: row.top_automation_name === null ? null : String(row.top_automation_name),
    }));
  }

  /** How many accounts are active — not revoked, not `plan_downgrade` (route 11's count, CA9). */
  async countActive(organizationId: number): Promise<number> {
    const [row] = await this.db()
      .select({ count: sql<number>`count(*)::int` })
      .from(channel_accounts)
      .where(and(eq(channel_accounts.organization_id, organizationId), isActive));
    return row?.count ?? 0;
  }

  /** How many not-revoked accounts still use the connection. */
  async countLiveByConnection({
    organizationId,
    channelConnectionId,
  }: {
    organizationId: number;
    channelConnectionId: number;
  }): Promise<number> {
    const [row] = await this.db()
      .select({ count: sql<number>`count(*)::int` })
      .from(channel_accounts)
      .where(
        and(
          eq(channel_accounts.organization_id, organizationId),
          eq(channel_accounts.channel_connection_id, channelConnectionId),
          isLive,
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * Inserts the account, or — when this organization had this provider account before, any status —
   * brings that row back (MC7, AC-2.5): its connection, display name, `connected`, `connected_at`,
   * `connected_by_user_id`; clears `disconnected_at`. The pause, suspend, plan stop and automation
   * switch are kept (a reconnect never starts a plan-stopped account, D57).
   */
  async upsertConnected(values: ChannelAccountConnectValues): Promise<ChannelAccountRow> {
    const connectedColumns = {
      channel_connection_id: values.channelConnectionId,
      display_name: values.displayName,
      connection_status: CHANNEL_ACCOUNT_STATUS.CONNECTED,
      connected_by_user_id: values.connectedByUserId,
      connected_at: databaseNowTimestamp,
      disconnected_at: null,
    };
    const rows = await runInsertWithPublicIdentifierRetry({
      insert: () =>
        this.db()
          .insert(channel_accounts)
          .values({
            public_id: generatePublicId('channelAccount'),
            organization_id: values.organizationId,
            channel: values.channel,
            provider_account_id: values.providerAccountId,
            ...connectedColumns,
          })
          .onConflictDoUpdate({
            target: [
              channel_accounts.organization_id,
              channel_accounts.channel,
              channel_accounts.provider_account_id,
            ],
            set: { ...connectedColumns, updated_at: accountUpdatedAtTimestamp },
          })
          .returning(),
    });
    const row = rows[0];
    if (row === undefined) throw new Error('channel account upsert returned no row');
    return row;
  }

  /**
   * A reconnect (MC6): the not-revoked account moves to this connection and goes `connected`.
   * Returns the changed row, or `null` when the account is revoked.
   */
  async attachToConnection({
    organizationId,
    channelAccountId,
    channelConnectionId,
  }: ChannelAccountKey & { channelConnectionId: number }): Promise<ChannelAccountRow | null> {
    const rows = await this.db()
      .update(channel_accounts)
      .set({
        channel_connection_id: channelConnectionId,
        connection_status: CHANNEL_ACCOUNT_STATUS.CONNECTED,
        updated_at: accountUpdatedAtTimestamp,
      })
      .where(and(this.keyOf({ organizationId, channelAccountId }), isLive))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * The guarded break of CA4: `connected` → `error`. Returns the changed row, or `null` when the
   * account was not `connected` any more (another caller won the race, or it was revoked).
   */
  async markBroken(key: ChannelAccountKey): Promise<ChannelAccountRow | null> {
    const rows = await this.db()
      .update(channel_accounts)
      .set({
        connection_status: CHANNEL_ACCOUNT_STATUS.ERROR,
        updated_at: accountUpdatedAtTimestamp,
      })
      .where(
        and(
          this.keyOf(key),
          eq(channel_accounts.connection_status, CHANNEL_ACCOUNT_STATUS.CONNECTED),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Disconnects the account (CA8): `revoked`, `disconnected_at`. Returns the revoked row, or `null`
   * when it was already revoked.
   */
  async revoke(key: ChannelAccountKey): Promise<ChannelAccountRow | null> {
    const rows = await this.db()
      .update(channel_accounts)
      .set({
        connection_status: CHANNEL_ACCOUNT_STATUS.REVOKED,
        disconnected_at: databaseNowTimestamp,
        updated_at: accountUpdatedAtTimestamp,
      })
      .where(and(this.keyOf(key), isLive))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * The owner's pause (route 9, CA7): `paused_at` and `paused_by_user_id` set when not paused yet —
   * an already paused account keeps its first pause. Returns the row as it now stands, or `null`
   * when it is revoked.
   */
  async pause({
    pausedByUserId,
    ...key
  }: ChannelAccountKey & { pausedByUserId: number | null }): Promise<ChannelAccountRow | null> {
    await this.db()
      .update(channel_accounts)
      .set({
        paused_at: databaseNowTimestamp,
        paused_by_user_id: pausedByUserId,
        updated_at: accountUpdatedAtTimestamp,
      })
      .where(and(this.keyOf(key), isLive, sql`${channel_accounts.paused_at} IS NULL`));
    return this.findLiveById(key);
  }

  /**
   * Clears only the owner's pause (route 10, CA7) — the suspend and the plan stop stay. Returns the
   * row as it now stands, or `null` when it is revoked.
   */
  async resume(key: ChannelAccountKey): Promise<ChannelAccountRow | null> {
    await this.db()
      .update(channel_accounts)
      .set({ paused_at: null, paused_by_user_id: null, updated_at: accountUpdatedAtTimestamp })
      .where(and(this.keyOf(key), isLive, isNotNull(channel_accounts.paused_at)));
    return this.findLiveById(key);
  }

  /**
   * Sets the automation switch (P42, route 12 through the Instagram settings, IA12) — a repeat that
   * sets the same value writes nothing. Returns the row as it now stands, or `null` when it is
   * revoked.
   */
  async setAutomationEnabled({
    isAutomationEnabled,
    ...key
  }: ChannelAccountKey & { isAutomationEnabled: boolean }): Promise<ChannelAccountRow | null> {
    await this.db()
      .update(channel_accounts)
      .set({ is_automation_enabled: isAutomationEnabled, updated_at: accountUpdatedAtTimestamp })
      .where(
        and(
          this.keyOf(key),
          isLive,
          ne(channel_accounts.is_automation_enabled, isAutomationEnabled),
        ),
      );
    return this.findLiveById(key);
  }

  /**
   * Sets the plan stop's reason (CA3, CA9) — `null` clears it. Returns the changed row, or `null`
   * when the account is revoked.
   */
  async setPlanStop({
    reason,
    ...key
  }: ChannelAccountKey & {
    reason: ChannelAccountPlanStopReason | null;
  }): Promise<ChannelAccountRow | null> {
    const rows = await this.db()
      .update(channel_accounts)
      .set({
        plan_stop_reason: reason,
        plan_stopped_at: reason === null ? null : databaseNowTimestamp,
        updated_at: accountUpdatedAtTimestamp,
      })
      .where(and(this.keyOf(key), isLive))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * The organization's account-limit lock (MC7, CA9) — the one the pick takes, so a swap and a pick
   * never count at the same time. Held until the unit of work ends.
   */
  async lockOrganizationForAccountLimit(organizationId: number): Promise<void> {
    await acquireResourceQuotaLock({
      namespace: RESOURCE_QUOTA_LOCK_NAMESPACE.CHANNEL_ACCOUNT_LIMIT,
      key: organizationId,
      databaseHandle: this.db(),
    });
  }

  /** One not-revoked account by its internal id, or `null`. */
  private async findLiveById(key: ChannelAccountKey): Promise<ChannelAccountRow | null> {
    const row = await this.findById(key);
    return row === null || row.connection_status === CHANNEL_ACCOUNT_STATUS.REVOKED ? null : row;
  }

  /** The row condition of one account of the organization. */
  private keyOf({ organizationId, channelAccountId }: ChannelAccountKey) {
    return and(
      eq(channel_accounts.organization_id, organizationId),
      eq(channel_accounts.id, channelAccountId),
    );
  }
}

/**
 * {@link ChannelAccountRepository} bound to a job's organization handle — the workers that read or
 * break an account (the lane turn, intake, the token check — later rows).
 */
export function createWorkerChannelAccountRepository(
  databaseHandle: WorkerDatabaseHandle,
): ChannelAccountRepository {
  assertWorkerDatabaseContext(['organization']);
  return new ChannelAccountRepository(databaseHandle);
}
