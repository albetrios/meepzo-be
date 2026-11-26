import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  getContextFreeDatabase,
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
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_connections } from './channel-connection.schema.js';
import type { ChannelConnectionProvider } from './channel-connection-state.js';

/** The public ids one of the two organization resolvers (MC15) answered. */
function readOrganizationPublicIds(result: unknown): string[] {
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as Array<{
    organization_public_id: string;
  }>;
  return rows.map((row) => row.organization_public_id);
}

/** One connection the token check's sweep hands to the queue (MC10). */
export interface ChannelConnectionTokenCheckCandidate {
  id: number;
  channelConnectionPublicId: string;
  organizationPublicId: string;
}

/** `updated_at` for every change of a connection — never before the row's `created_at`. */
const connectionUpdatedAtTimestamp = databaseUpdatedAtTimestamp(channel_connections.created_at);

/** One `app.channel_connections` row as Drizzle reads it. */
export type ChannelConnectionRow = typeof channel_connections.$inferSelect;

/** The two keys every connection write is scoped by: its organization and its internal id. */
export interface ChannelConnectionKey {
  /** `tenancy.organizations.id` of the owning organization. */
  organizationId: number;
  /** `app.channel_connections.id`. */
  channelConnectionId: number;
}

/** What a callback writes onto the connection (routes-final § 1 MC5 step 5). */
export interface ChannelConnectionConnectValues {
  organizationId: number;
  provider: ChannelConnectionProvider;
  clientBusinessId: string;
  /** The `/me` `id` of the token — its Meta system user (F3); `null` when Meta named none. */
  providerUserId: string | null;
  configId: string;
  scopes: readonly string[];
  /** `auth.users.id` of the connecting user; `null` when the caller has none. */
  connectedByUserId: number | null;
}

/** The result of {@link ChannelConnectionRepository.upsertConnected}. */
export interface ChannelConnectionConnectResult {
  connection: ChannelConnectionRow;
  /** `true` when the organization had a row of this business before (a reconnect, MC5). */
  isReconnect: boolean;
}

/**
 * Drizzle access to `app.channel_connections` (routes-final § 1.3, MCC1): the callback's upsert, the
 * organization's connections, one by public id, the organization lock of the pick (MC7), revoke, the guarded break (MC11).
 *
 * @remarks
 * - **Algorithm:** every row statement names `organization_id` and, for a single row, its internal
 *   `id` or public id, so tenant isolation does not rest on RLS alone. The upsert keys on the unique
 *   `(organization_id, provider, client_business_id)` index, so a reconnect — revoked included —
 *   reuses the row and its public id (MC5); `xmax = 0` tells an insert from an update.
 * - **Failure modes:** none of its own; constraint failures propagate.
 * - **Side effects:** writes `app.channel_connections` only; never reads the token table (MC9).
 * - **Notes:** HTTP paths run inside the caller's `withAppDatabaseContext`; workers bind a handle
 *   through {@link createWorkerChannelConnectionRepository}.
 */
export class ChannelConnectionRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Every connection of the organization, oldest first. */
  async listByOrganizationId({
    organizationId,
    includeRevoked,
  }: {
    organizationId: number;
    includeRevoked: boolean;
  }): Promise<ChannelConnectionRow[]> {
    return this.db()
      .select()
      .from(channel_connections)
      .where(
        and(
          eq(channel_connections.organization_id, organizationId),
          includeRevoked ? undefined : sql`${channel_connections.status} <> 'revoked'`,
        ),
      )
      .orderBy(asc(channel_connections.created_at), asc(channel_connections.id));
  }

  /** One connection of the organization by its public id, any status, or `null`. */
  async findByPublicId({
    organizationId,
    channelConnectionPublicId,
  }: {
    organizationId: number;
    channelConnectionPublicId: string;
  }): Promise<ChannelConnectionRow | null> {
    const rows = await this.db()
      .select()
      .from(channel_connections)
      .where(
        and(
          eq(channel_connections.organization_id, organizationId),
          eq(channel_connections.public_id, channelConnectionPublicId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Several connections of the organization by internal id, any status. */
  async findByIds({
    organizationId,
    channelConnectionIds,
  }: {
    organizationId: number;
    channelConnectionIds: readonly number[];
  }): Promise<ChannelConnectionRow[]> {
    if (channelConnectionIds.length === 0) return [];
    return this.db()
      .select()
      .from(channel_connections)
      .where(
        and(
          eq(channel_connections.organization_id, organizationId),
          inArray(channel_connections.id, [...channelConnectionIds]),
        ),
      );
  }

  /**
   * Inserts the connection, or — when this organization had this provider's business before, any
   * status — updates that row (MC5 step 5): `connected`, `config_id`, `scopes`,
   * `connected_by_user_id`, `connected_at`, `last_checked_at` = now, `last_check_error` and
   * `disconnected_at` cleared; `status_changed_at` moves only when the status changes.
   */
  async upsertConnected(
    values: ChannelConnectionConnectValues,
  ): Promise<ChannelConnectionConnectResult> {
    const connectedColumns = {
      config_id: values.configId,
      provider_user_id: values.providerUserId,
      status: 'connected',
      scopes: [...values.scopes],
      connected_by_user_id: values.connectedByUserId,
      connected_at: databaseNowTimestamp,
      last_checked_at: databaseNowTimestamp,
      last_check_error: null,
      disconnected_at: null,
    };
    const rows = await runInsertWithPublicIdentifierRetry({
      insert: () =>
        this.db()
          .insert(channel_connections)
          .values({
            public_id: generatePublicId('channelConnection'),
            organization_id: values.organizationId,
            provider: values.provider,
            client_business_id: values.clientBusinessId,
            ...connectedColumns,
          })
          .onConflictDoUpdate({
            target: [
              channel_connections.organization_id,
              channel_connections.provider,
              channel_connections.client_business_id,
            ],
            set: {
              ...connectedColumns,
              // A reconnect whose `/me` named no system user keeps the one already known (F3).
              provider_user_id: sql`COALESCE(EXCLUDED.provider_user_id, ${channel_connections.provider_user_id})`,
              status_changed_at: sql`CASE WHEN ${channel_connections.status} = 'connected' THEN ${channel_connections.status_changed_at} ELSE now() END`,
              updated_at: connectionUpdatedAtTimestamp,
            },
          })
          .returning({
            id: channel_connections.id,
            // A row the statement inserted has no deleting transaction yet.
            is_inserted: sql<boolean>`(xmax = 0)`,
          }),
    });
    const row = rows[0];
    if (row === undefined) throw new Error('channel connection upsert returned no row');
    const [connection] = await this.findByIds({
      organizationId: values.organizationId,
      channelConnectionIds: [row.id],
    });
    if (connection === undefined) throw new Error('channel connection upsert lost its row');
    return { connection, isReconnect: !row.is_inserted };
  }

  /**
   * "Disconnect business" and the last account leaving (MC8, CA8): `revoked`, `disconnected_at`,
   * `status_changed_at`. Returns the revoked row, or `null` when it was already revoked.
   */
  async revoke({
    organizationId,
    channelConnectionId,
  }: ChannelConnectionKey): Promise<ChannelConnectionRow | null> {
    const rows = await this.db()
      .update(channel_connections)
      .set({
        status: 'revoked',
        status_changed_at: databaseNowTimestamp,
        disconnected_at: databaseNowTimestamp,
        updated_at: connectionUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(channel_connections.organization_id, organizationId),
          eq(channel_connections.id, channelConnectionId),
          sql`${channel_connections.status} <> 'revoked'`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * The connections of this provider's business of the organization with this public id, any status,
   * oldest first — Meta's callbacks matched by business (MC15, P56), which know the organization only
   * by the public id the resolver returned; run inside that organization's verified scope.
   */
  async listByBusiness({
    organizationPublicId,
    provider,
    clientBusinessId,
  }: {
    organizationPublicId: string;
    provider: ChannelConnectionProvider;
    clientBusinessId: string;
  }): Promise<ChannelConnectionRow[]> {
    const organizationId = this.db()
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.public_id, organizationPublicId));
    return this.db()
      .select()
      .from(channel_connections)
      .where(
        and(
          inArray(channel_connections.organization_id, organizationId),
          eq(channel_connections.provider, provider),
          eq(channel_connections.client_business_id, clientBusinessId),
        ),
      )
      .orderBy(asc(channel_connections.id));
  }

  /**
   * The public ids of every organization with a channel account of this provider's channels and
   * provider account id, any status (MC15 (1), P56 — the SECURITY DEFINER
   * `app.resolve_organization_public_ids_for_provider_account`); empty when none. Context-free: it
   * returns public ids only and reads no other column of another organization's row.
   */
  async resolveOrganizationPublicIdsForProviderAccount({
    provider,
    providerAccountId,
  }: {
    provider: ChannelConnectionProvider;
    providerAccountId: string;
  }): Promise<string[]> {
    const result = await getContextFreeDatabase().execute(
      sql`SELECT organization_public_id FROM app.resolve_organization_public_ids_for_provider_account(${provider}, ${providerAccountId}) AS organization_public_id`,
    );
    return readOrganizationPublicIds(result);
  }

  /**
   * The public ids of every organization with a connection of this provider and
   * `client_business_id`, any status (MC15 (2), P56 — the SECURITY DEFINER
   * `app.resolve_organization_public_ids_for_provider_business`, over
   * `idx_channel_connections_provider_business`); empty when none. Context-free, public ids only.
   */
  async resolveOrganizationPublicIdsForProviderBusiness({
    provider,
    clientBusinessId,
  }: {
    provider: ChannelConnectionProvider;
    clientBusinessId: string;
  }): Promise<string[]> {
    const result = await getContextFreeDatabase().execute(
      sql`SELECT organization_public_id FROM app.resolve_organization_public_ids_for_provider_business(${provider}, ${clientBusinessId}) AS organization_public_id`,
    );
    return readOrganizationPublicIds(result);
  }

  /**
   * The one guarded way a connection leaves `connected` (MC11): `connected` → `error`, stamping
   * `status_changed_at` and `last_check_error` (Meta's codes only, never its text). Returns the
   * changed row, or `null` when it was not `connected` any more — the caller that gets `null` lost
   * the race and changes nothing else.
   */
  async markBroken({
    organizationId,
    channelConnectionId,
    lastCheckError,
  }: ChannelConnectionKey & { lastCheckError: string }): Promise<ChannelConnectionRow | null> {
    const rows = await this.db()
      .update(channel_connections)
      .set({
        status: 'error',
        status_changed_at: databaseNowTimestamp,
        last_check_error: lastCheckError,
        updated_at: connectionUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(channel_connections.organization_id, organizationId),
          eq(channel_connections.id, channelConnectionId),
          eq(channel_connections.status, 'connected'),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * One connection by its public id inside the job's organization (MC10's token check), any
   * status, or `null` — the organization is named by its public id, as the job carries it.
   */
  async findByPublicIdInOrganization({
    organizationPublicId,
    channelConnectionPublicId,
  }: {
    organizationPublicId: string;
    channelConnectionPublicId: string;
  }): Promise<ChannelConnectionRow | null> {
    const rows = await this.db()
      .select({ connection: channel_connections })
      .from(channel_connections)
      .innerJoin(organizations, eq(organizations.id, channel_connections.organization_id))
      .where(
        and(
          eq(organizations.public_id, organizationPublicId),
          eq(channel_connections.public_id, channelConnectionPublicId),
        ),
      )
      .limit(1);
    return rows[0]?.connection ?? null;
  }

  /**
   * The token check's stamp (MC10): `last_checked_at` = now and `last_check_error` (cleared on a
   * pass, Meta's codes only on a refused read, `token_expires_soon …` near the token's end) — only
   * while the connection is still `connected`; `scopes`, when given, replaces the granted
   * permissions (a permission Meta now refuses — P354). Returns whether a row was written.
   */
  async recordTokenCheck({
    organizationId,
    channelConnectionId,
    lastCheckError,
    scopes,
  }: ChannelConnectionKey & {
    lastCheckError: string | null;
    scopes?: readonly string[] | undefined;
  }): Promise<boolean> {
    const rows = await this.db()
      .update(channel_connections)
      .set({
        last_checked_at: databaseNowTimestamp,
        last_check_error: lastCheckError,
        ...(scopes === undefined ? {} : { scopes: [...scopes] }),
        updated_at: connectionUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(channel_connections.organization_id, organizationId),
          eq(channel_connections.id, channelConnectionId),
          eq(channel_connections.status, 'connected'),
        ),
      )
      .returning({ id: channel_connections.id });
    return rows.length > 0;
  }

  /**
   * One page of the `connected` connections of every live organization whose last token check is
   * older than `dueBefore` (or never ran), by id after `afterId` — the hourly sweep's
   * cross-organization read (MC10, `idx_channel_connections_check_due`). Runs only on a retention
   * handle ({@link createRetentionChannelConnectionRepository}): the sweep arm is in the policy's
   * `USING` only, so it reads every organization's row and can write none.
   */
  async listDueForTokenCheck({
    dueBefore,
    afterId,
    limit,
  }: {
    dueBefore: Date;
    afterId: number;
    limit: number;
  }): Promise<ChannelConnectionTokenCheckCandidate[]> {
    return this.db()
      .select({
        id: channel_connections.id,
        channelConnectionPublicId: channel_connections.public_id,
        organizationPublicId: organizations.public_id,
      })
      .from(channel_connections)
      .innerJoin(organizations, eq(organizations.id, channel_connections.organization_id))
      .where(
        and(
          eq(channel_connections.status, 'connected'),
          or(
            isNull(channel_connections.last_checked_at),
            lte(channel_connections.last_checked_at, dueBefore),
          ),
          isNull(organizations.deleted_at),
          gt(channel_connections.id, afterId),
        ),
      )
      .orderBy(asc(channel_connections.id))
      .limit(limit);
  }

  /**
   * The organization lock of the channel account limit (MC7, plan:L3553): a transaction-scoped
   * advisory lock on the organization id — two first connects of one organization have no row to
   * lock yet. Must run inside the transaction that counts and connects.
   */
  async lockOrganizationForAccountLimit(organizationId: number): Promise<void> {
    await acquireResourceQuotaLock({
      namespace: RESOURCE_QUOTA_LOCK_NAMESPACE.CHANNEL_ACCOUNT_LIMIT,
      key: organizationId,
      databaseHandle: this.db(),
    });
  }
}

/**
 * {@link ChannelConnectionRepository} bound to a job's organization handle — the daily token check
 * (MC10, ROUTE row R51) and every worker that resolves an account's connection.
 */
export function createWorkerChannelConnectionRepository(
  databaseHandle: WorkerDatabaseHandle,
): ChannelConnectionRepository {
  assertWorkerDatabaseContext(['organization']);
  return new ChannelConnectionRepository(databaseHandle);
}

/**
 * {@link ChannelConnectionRepository} bound to a retention maintenance handle — the token check's
 * hourly sweep across organizations (MC10), through the sweep arm the connection policy carries in
 * `USING` only.
 */
export function createRetentionChannelConnectionRepository(
  databaseHandle: WorkerDatabaseHandle,
): ChannelConnectionRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new ChannelConnectionRepository(databaseHandle);
}
