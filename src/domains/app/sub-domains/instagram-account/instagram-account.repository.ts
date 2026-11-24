import { and, asc, eq, getTableColumns, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  getContextFreeDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import {
  databaseNowTimestamp,
  databaseUpdatedAtTimestamp,
} from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { instagram_accounts } from './instagram-account.schema.js';
import type { InstagramAccountBrokenConnectionStatus } from './instagram-account.constants.js';

/** `updated_at` for every change of a account — never before the row's `created_at`. */
const accountUpdatedAtTimestamp = databaseUpdatedAtTimestamp(instagram_accounts.created_at);

/** One `app.instagram_accounts` row as Drizzle reads it. */
export type InstagramAccountRow = typeof instagram_accounts.$inferSelect;

/** The two keys every account write is scoped by: its organization and its internal id. */
export interface InstagramAccountKey {
  /** `tenancy.organizations.id` of the owning organization. */
  organizationId: number;
  /** `app.instagram_accounts.id`. */
  instagramAccountId: number;
}

/**
 * What a pick writes onto the account (feat-instagram-dm-sending routes-final § 1 MC7): the
 * connection it came through, its profile, the connection's granted scopes and who connected it.
 */
export interface InstagramAccountConnectValues {
  organizationId: number;
  /** `app.channel_connections.id` the account came through (P111). */
  channelConnectionId: number;
  instagramUserId: string;
  instagramAppUserId: string;
  username: string;
  name: string | null;
  biography: string | null;
  website: string | null;
  profilePictureUrl: string | null;
  followersCount: number;
  followsCount: number;
  mediaCount: number;
  scopes: readonly string[];
  /** `auth.users.id` of the connecting user; `null` when the caller has none. */
  connectedByUserId: number | null;
}

/** The result of {@link InstagramAccountRepository.upsertConnected}. */
export interface InstagramAccountConnectResult {
  account: InstagramAccountRow;
  /** `true` when the row was inserted — the organization never had this Instagram account. */
  isNewConnection: boolean;
}

/**
 * One `connected` account as the daily sweep lists it (IA8): the keyset cursor and the two public
 * handles its per-organization job carries — never a bigserial in the job.
 */
export interface InstagramAccountDailyCheckCandidate {
  /** `app.instagram_accounts.id` — the sweep's keyset cursor only. */
  id: number;
  instagramAccountPublicId: string;
  organizationPublicId: string;
}

/**
 * What the daily check writes back from `/me` (IA8 step 2). A `null` username or count means
 * Instagram left it out, and the stored value is kept; a `null` text field means the account has
 * none (a removed bio), and is written as such.
 */
export interface InstagramAccountProfileRefreshValues {
  username: string | null;
  name: string | null;
  biography: string | null;
  website: string | null;
  profilePictureUrl: string | null;
  followersCount: number | null;
  followsCount: number | null;
  mediaCount: number | null;
}

/**
 * Drizzle access to `app.instagram_accounts` (routes-final § 1.A.3, IAC11): the organization's
 * live account, the connect upsert, the guarded status change, revoke, the profile erase, the locked
 * accounts of one app-scoped id for Meta's callbacks (IA19, IA20) and of the whole organization for
 * its delete (D54), the webhook-subscription stamp, the daily check's sweep page, expiry copy and
 * profile refresh (IA8), and the two SECURITY DEFINER resolvers (IA6).
 *
 * @remarks
 * - **Algorithm:** every row statement names both `organization_id` and, for a single row, the
 *   internal `id`, so tenant isolation does not rest on RLS alone. The connect upsert keys on the
 *   unique `(organization_id, instagram_user_id)` index, so a reconnect — revoked included — reuses
 *   the row and keeps its public id and settings (IA11); `xmax = 0` tells an insert from an update.
 * - **Failure modes:** a connect that breaks one of the two live-row unique indexes
 *   (`INSTAGRAM_ACCOUNT_UNIQUE_INDEXES`) throws Postgres 23505 with that index as the
 *   constraint name — the caller maps it to the matching 409. Guarded updates return `null` when
 *   the row is not in the state they require.
 * - **Side effects:** writes `app.instagram_accounts` only; never reads the token table (IA5).
 * - **Notes:** HTTP paths run inside the caller's `withAppDatabaseContext`; workers bind a handle
 *   through {@link createWorkerInstagramAccountRepository} or
 *   {@link createRetentionInstagramAccountRepository}. The resolvers run through
 *   the context-free accessor — they read as their owner whatever the caller's settings.
 */
export class InstagramAccountRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /**
   * The organization's oldest-connected not-revoked account — `connected`, `expired` or `error`
   * (IA13) — or `null` when it has none (only revoked rows, or no row at all). The launch's
   * singular routes read it until ROUTE row R5 names the account in the path (CA2).
   */
  async findLiveByOrganizationId(organizationId: number): Promise<InstagramAccountRow | null> {
    const rows = await this.db()
      .select()
      .from(instagram_accounts)
      .where(
        and(
          eq(instagram_accounts.organization_id, organizationId),
          ne(instagram_accounts.connection_status, 'revoked'),
        ),
      )
      .orderBy(asc(instagram_accounts.connected_at), asc(instagram_accounts.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** How many not-revoked accounts the organization has (the pick's plan count, MC7). */
  async countLiveByOrganizationId(organizationId: number): Promise<number> {
    const rows = await this.db()
      .select({ count: sql<number>`count(*)::int` })
      .from(instagram_accounts)
      .where(
        and(
          eq(instagram_accounts.organization_id, organizationId),
          ne(instagram_accounts.connection_status, 'revoked'),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /** How many not-revoked accounts still use the connection (CA8: its token goes with the last). */
  async countLiveByConnection({
    organizationId,
    channelConnectionId,
  }: {
    organizationId: number;
    channelConnectionId: number;
  }): Promise<number> {
    const rows = await this.db()
      .select({ count: sql<number>`count(*)::int` })
      .from(instagram_accounts)
      .where(
        and(
          eq(instagram_accounts.organization_id, organizationId),
          eq(instagram_accounts.channel_connection_id, channelConnectionId),
          ne(instagram_accounts.connection_status, 'revoked'),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /** The not-revoked accounts of these connections, oldest connected first. */
  async listLiveByConnections({
    organizationId,
    channelConnectionIds,
  }: {
    organizationId: number;
    channelConnectionIds: readonly number[];
  }): Promise<InstagramAccountRow[]> {
    if (channelConnectionIds.length === 0) return [];
    return this.db()
      .select()
      .from(instagram_accounts)
      .where(
        and(
          eq(instagram_accounts.organization_id, organizationId),
          inArray(instagram_accounts.channel_connection_id, [...channelConnectionIds]),
          ne(instagram_accounts.connection_status, 'revoked'),
        ),
      )
      .orderBy(asc(instagram_accounts.connected_at), asc(instagram_accounts.id));
  }

  /** The organization's accounts, any status, with these Instagram user ids. */
  async findByInstagramUserIds({
    organizationId,
    instagramUserIds,
  }: {
    organizationId: number;
    instagramUserIds: readonly string[];
  }): Promise<InstagramAccountRow[]> {
    if (instagramUserIds.length === 0) return [];
    return this.db()
      .select()
      .from(instagram_accounts)
      .where(
        and(
          eq(instagram_accounts.organization_id, organizationId),
          inArray(instagram_accounts.instagram_user_id, [...instagramUserIds]),
        ),
      );
  }

  /**
   * A reconnect (MC6): the not-revoked account moves to this connection and goes `connected`
   * (`expired` / `error` → `connected`; `connection_status_changed_at` moves only when the status
   * changes). Returns the changed row, or `null` when the account is revoked.
   */
  async attachToConnection({
    organizationId,
    instagramAccountId,
    channelConnectionId,
  }: InstagramAccountKey & { channelConnectionId: number }): Promise<InstagramAccountRow | null> {
    const rows = await this.db()
      .update(instagram_accounts)
      .set({
        channel_connection_id: channelConnectionId,
        connection_status: 'connected',
        connection_status_changed_at: sql`CASE WHEN ${instagram_accounts.connection_status} = 'connected' THEN ${instagram_accounts.connection_status_changed_at} ELSE now() END`,
        updated_at: accountUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(instagram_accounts.organization_id, organizationId),
          eq(instagram_accounts.id, instagramAccountId),
          ne(instagram_accounts.connection_status, 'revoked'),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** One account of the organization by its internal id, any status; `null` when absent. */
  async findById(key: InstagramAccountKey): Promise<InstagramAccountRow | null> {
    const rows = await this.db()
      .select()
      .from(instagram_accounts)
      .where(
        and(
          eq(instagram_accounts.organization_id, key.organizationId),
          eq(instagram_accounts.id, key.instagramAccountId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Inserts the account, or — when this organization had this Instagram account before, any
   * status — updates that row (IA11; the pick, MC7): its connection, the profile and scopes,
   * `connected`, `connected_at`, `profile_synced_at` and `connected_by_user_id`; clears
   * `disconnected_at` and `profile_erased_at`. `connection_status_changed_at` moves only when the
   * status changes. `webhook_subscribed_at` is kept (a revoke has already emptied it).
   */
  async upsertConnected(
    values: InstagramAccountConnectValues,
  ): Promise<InstagramAccountConnectResult> {
    const connectedColumns = {
      channel_connection_id: values.channelConnectionId,
      instagram_app_user_id: values.instagramAppUserId,
      username: values.username,
      name: values.name,
      biography: values.biography,
      website: values.website,
      profile_picture_url: values.profilePictureUrl,
      followers_count: values.followersCount,
      follows_count: values.followsCount,
      media_count: values.mediaCount,
      scopes: [...values.scopes],
      connection_status: 'connected',
      token_expires_at: null,
      connected_by_user_id: values.connectedByUserId,
      connected_at: databaseNowTimestamp,
      disconnected_at: null,
      profile_synced_at: databaseNowTimestamp,
      profile_erased_at: null,
    };
    const rows = await runInsertWithPublicIdentifierRetry({
      insert: () =>
        this.db()
          .insert(instagram_accounts)
          .values({
            public_id: generatePublicId('instagramAccount'),
            organization_id: values.organizationId,
            instagram_user_id: values.instagramUserId,
            ...connectedColumns,
          })
          .onConflictDoUpdate({
            target: [instagram_accounts.organization_id, instagram_accounts.instagram_user_id],
            set: {
              ...connectedColumns,
              connection_status_changed_at: sql`CASE WHEN ${instagram_accounts.connection_status} = 'connected' THEN ${instagram_accounts.connection_status_changed_at} ELSE now() END`,
              updated_at: accountUpdatedAtTimestamp,
            },
          })
          .returning({
            ...getTableColumns(instagram_accounts),
            // A row the statement inserted has no deleting transaction yet.
            is_inserted: sql<boolean>`(xmax = 0)`,
          }),
    });
    const row = rows[0];
    if (row === undefined) {
      throw new Error('instagram account upsert returned no row');
    }
    const { is_inserted: isInserted, ...account } = row;
    return { account, isNewConnection: isInserted };
  }

  /**
   * The guarded status change of IA9: `connected` → `expired` | `error`, stamping
   * `connection_status_changed_at`. Returns the changed row, or `null` when the account was not
   * `connected` any more — the caller that gets `null` lost the race and enqueues nothing.
   */
  async markConnectionBroken({
    organizationId,
    instagramAccountId,
    connectionStatus,
  }: InstagramAccountKey & {
    connectionStatus: InstagramAccountBrokenConnectionStatus;
  }): Promise<InstagramAccountRow | null> {
    const rows = await this.db()
      .update(instagram_accounts)
      .set({
        connection_status: connectionStatus,
        connection_status_changed_at: databaseNowTimestamp,
        updated_at: accountUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(instagram_accounts.organization_id, organizationId),
          eq(instagram_accounts.id, instagramAccountId),
          eq(instagram_accounts.connection_status, 'connected'),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Disconnects the account (IA14): `revoked`, `disconnected_at`, and the token's expiry copy and
   * the webhook stamp emptied; profile kept. Returns the revoked row, or `null` when it was already
   * revoked. The connection's token goes with its last account (the account service, CA8).
   */
  async revoke({
    organizationId,
    instagramAccountId,
  }: InstagramAccountKey): Promise<InstagramAccountRow | null> {
    const rows = await this.db()
      .update(instagram_accounts)
      .set({
        connection_status: 'revoked',
        connection_status_changed_at: databaseNowTimestamp,
        disconnected_at: databaseNowTimestamp,
        token_expires_at: null,
        webhook_subscribed_at: null,
        updated_at: accountUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(instagram_accounts.organization_id, organizationId),
          eq(instagram_accounts.id, instagramAccountId),
          ne(instagram_accounts.connection_status, 'revoked'),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Erases a revoked account's Instagram profile (Meta's data deletion, IA20, and the organization's
   * delete, D54): username, name, biography, website and picture emptied, counts zeroed, scopes
   * cleared, `profile_erased_at` stamped. Returns the erased row, or `null` when the account is not
   * revoked or its profile is already erased — so a repeat changes nothing (a reconnect clears
   * `profile_erased_at`, so a later deletion erases again).
   */
  async eraseProfile({
    organizationId,
    instagramAccountId,
  }: InstagramAccountKey): Promise<InstagramAccountRow | null> {
    const rows = await this.db()
      .update(instagram_accounts)
      .set({
        username: null,
        name: null,
        biography: null,
        website: null,
        profile_picture_url: null,
        followers_count: 0,
        follows_count: 0,
        media_count: 0,
        scopes: [],
        profile_erased_at: databaseNowTimestamp,
        updated_at: accountUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(instagram_accounts.organization_id, organizationId),
          eq(instagram_accounts.id, instagramAccountId),
          eq(instagram_accounts.connection_status, 'revoked'),
          isNull(instagram_accounts.profile_erased_at),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Every account of the organization with this public id that carries this app-scoped Instagram
   * id, any status, oldest first, locked until the unit ends — Meta's deauthorize and data-deletion
   * callbacks (IA19, IA20), which know the organization only by the public id the resolver returned
   * (IA6).
   *
   * @remarks
   * Runs in that organization's own scope. A soft-deleted organization's rows are not seen there (its
   * own scope hides them, `organizations_tenant_isolation`) — nothing is left to erase in them: the
   * organization's delete erased them before it was soft-deleted (D54). The lock is the one the
   * change takes anyway (`FOR NO KEY UPDATE`), taken at the read, so the read `connected_at` is the
   * one the change acts on: a reconnect in between waits (D53). Normally one row: an organization
   * holds one row per Instagram account (IA11).
   */
  async lockByInstagramAppUserInOrganization({
    organizationPublicId,
    instagramAppUserId,
  }: {
    organizationPublicId: string;
    instagramAppUserId: string;
  }): Promise<InstagramAccountRow[]> {
    // A subquery, not a join: the lock must take the account rows only, never the organization's.
    const organizationId = this.db()
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.public_id, organizationPublicId));
    return this.db()
      .select()
      .from(instagram_accounts)
      .where(
        and(
          inArray(instagram_accounts.organization_id, organizationId),
          eq(instagram_accounts.instagram_app_user_id, instagramAppUserId),
        ),
      )
      .orderBy(asc(instagram_accounts.id))
      .for('no key update');
  }

  /**
   * Every account of the organization, any status, oldest first, locked until the unit ends — the
   * organization delete's erase (D54). A connect racing it waits for the unit.
   */
  async lockByOrganizationId(organizationId: number): Promise<InstagramAccountRow[]> {
    return this.db()
      .select()
      .from(instagram_accounts)
      .where(eq(instagram_accounts.organization_id, organizationId))
      .orderBy(asc(instagram_accounts.id))
      .for('no key update');
  }

  /**
   * Stamps `webhook_subscribed_at` after `subscribed_apps` succeeded (IA12 step 5). Skips a
   * revoked account — a disconnect in between wins. Returns whether a row was stamped.
   */
  async recordWebhookSubscribed({
    organizationId,
    instagramAccountId,
  }: InstagramAccountKey): Promise<boolean> {
    const rows = await this.db()
      .update(instagram_accounts)
      .set({
        webhook_subscribed_at: databaseNowTimestamp,
        updated_at: accountUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(instagram_accounts.organization_id, organizationId),
          eq(instagram_accounts.id, instagramAccountId),
          ne(instagram_accounts.connection_status, 'revoked'),
        ),
      )
      .returning({ id: instagram_accounts.id });
    return rows.length > 0;
  }

  /**
   * One account by its public id, any status, only when it belongs to the organization with this
   * public id — the daily check's and the reconnect notice's read (their jobs carry public ids
   * only); `null` otherwise.
   */
  async findByPublicIdInOrganization({
    organizationPublicId,
    instagramAccountPublicId,
  }: {
    organizationPublicId: string;
    instagramAccountPublicId: string;
  }): Promise<InstagramAccountRow | null> {
    const rows = await this.db()
      .select(getTableColumns(instagram_accounts))
      .from(instagram_accounts)
      .innerJoin(organizations, eq(organizations.id, instagram_accounts.organization_id))
      .where(
        and(
          eq(organizations.public_id, organizationPublicId),
          eq(instagram_accounts.public_id, instagramAccountPublicId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * One page of the `connected` accounts of every live organization, by id after `afterId` — the
   * daily sweep's cross-organization read (IA8). Runs only on a retention handle
   * ({@link createRetentionInstagramAccountRepository}): the sweep arm is in the account policy's
   * `USING`, so it reads every organization's row and can write none.
   */
  async listConnectedForDailyCheck({
    afterId,
    limit,
  }: {
    afterId: number;
    limit: number;
  }): Promise<InstagramAccountDailyCheckCandidate[]> {
    return this.db()
      .select({
        id: instagram_accounts.id,
        instagramAccountPublicId: instagram_accounts.public_id,
        organizationPublicId: organizations.public_id,
      })
      .from(instagram_accounts)
      .innerJoin(organizations, eq(organizations.id, instagram_accounts.organization_id))
      .where(
        and(
          eq(instagram_accounts.connection_status, 'connected'),
          isNull(organizations.deleted_at),
          gt(instagram_accounts.id, afterId),
        ),
      )
      .orderBy(asc(instagram_accounts.id))
      .limit(limit);
  }

  /**
   * Writes the daily check's `/me` refresh (IA8 step 2) and stamps `profile_synced_at` — only while
   * the account is not revoked and is still the same Instagram account. A username or count
   * Instagram left out keeps its stored value. Returns whether a row was written.
   */
  async recordProfileRefresh({
    organizationId,
    instagramAccountId,
    instagramUserId,
    profile,
  }: InstagramAccountKey & {
    instagramUserId: string;
    profile: InstagramAccountProfileRefreshValues;
  }): Promise<boolean> {
    const rows = await this.db()
      .update(instagram_accounts)
      .set({
        ...(profile.username === null ? {} : { username: profile.username }),
        name: profile.name,
        biography: profile.biography,
        website: profile.website,
        profile_picture_url: profile.profilePictureUrl,
        ...(profile.followersCount === null ? {} : { followers_count: profile.followersCount }),
        ...(profile.followsCount === null ? {} : { follows_count: profile.followsCount }),
        ...(profile.mediaCount === null ? {} : { media_count: profile.mediaCount }),
        profile_synced_at: databaseNowTimestamp,
        updated_at: accountUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(instagram_accounts.organization_id, organizationId),
          eq(instagram_accounts.id, instagramAccountId),
          eq(instagram_accounts.instagram_user_id, instagramUserId),
          ne(instagram_accounts.connection_status, 'revoked'),
        ),
      )
      .returning({ id: instagram_accounts.id });
    return rows.length > 0;
  }

  /**
   * The public id of the organization whose NOT-revoked account has this Instagram user id, or
   * `null` (IA6 — `app.resolve_organization_public_id_for_instagram_user`). Reads no other column
   * of another organization's row.
   */
  async resolveOrganizationPublicIdForInstagramUser(
    instagramUserId: string,
  ): Promise<string | null> {
    const result = await getContextFreeDatabase().execute(
      sql`SELECT app.resolve_organization_public_id_for_instagram_user(${instagramUserId}) AS organization_public_id`,
    );
    const rows = ((result as { rows?: unknown[] }).rows ?? result) as Array<{
      organization_public_id: string | null;
    }>;
    return rows[0]?.organization_public_id ?? null;
  }

  /**
   * The public ids of every organization holding a row of this app-scoped id, any status (IA6 —
   * `app.resolve_organization_public_ids_for_instagram_app_user`); empty when none.
   */
  async resolveOrganizationPublicIdsForInstagramAppUser(
    instagramAppUserId: string,
  ): Promise<string[]> {
    const result = await getContextFreeDatabase().execute(
      sql`SELECT organization_public_id FROM app.resolve_organization_public_ids_for_instagram_app_user(${instagramAppUserId}) AS organization_public_id`,
    );
    const rows = ((result as { rows?: unknown[] }).rows ?? result) as Array<{
      organization_public_id: string;
    }>;
    return rows.map((row) => row.organization_public_id);
  }
}

/**
 * {@link InstagramAccountRepository} bound to a job's organization handle (a job-minted organization
 * scope, or `runOrganizationScopedWorkerJob`) — event processing, the
 * daily check's per-organization job, the reconnect notice.
 */
export function createWorkerInstagramAccountRepository(
  databaseHandle: WorkerDatabaseHandle,
): InstagramAccountRepository {
  assertWorkerDatabaseContext(['organization']);
  return new InstagramAccountRepository(databaseHandle);
}

/**
 * {@link InstagramAccountRepository} bound to a retention maintenance handle — the daily sweep's
 * cross-organization read of the `connected` accounts (IA8), through the sweep arm the account
 * policy carries in `USING` only.
 */
export function createRetentionInstagramAccountRepository(
  databaseHandle: WorkerDatabaseHandle,
): InstagramAccountRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new InstagramAccountRepository(databaseHandle);
}
