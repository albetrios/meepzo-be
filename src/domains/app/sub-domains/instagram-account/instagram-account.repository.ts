import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
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
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { instagram_accounts } from './instagram-account.schema.js';

/** `updated_at` for every change of an account — never before the row's `created_at`. */
const accountUpdatedAtTimestamp = databaseUpdatedAtTimestamp(instagram_accounts.created_at);

/**
 * One Instagram account as every read returns it: the extension row (`app.instagram_accounts`) plus
 * the five columns of its channel account the Instagram side acts on (ROUTE row R6, 2.A.3) — the
 * account's one public id (`cha_…`, P47), its status, when it was connected and its connection.
 */
export type InstagramAccountRow = typeof instagram_accounts.$inferSelect & {
  /** `app.channel_accounts.public_id` — the account's one id (`cha_…`, P47). */
  public_id: string;
  /** `app.channel_accounts.connection_status` (`connected` · `error` · `revoked`, CA4). */
  connection_status: string;
  /** `app.channel_accounts.connected_at` — the latest pick or reconnect. */
  connected_at: Date;
  /** `app.channel_accounts.channel_connection_id` — the connection its token comes from. */
  channel_connection_id: number;
  /** `app.channel_accounts.is_automation_enabled` — the account's automation switch (P42). */
  is_automation_enabled: boolean;
};

/** The columns every account read returns: the extension row plus its channel account's five. */
const instagramAccountColumns = {
  ...getTableColumns(instagram_accounts),
  public_id: channel_accounts.public_id,
  connection_status: channel_accounts.connection_status,
  connected_at: channel_accounts.connected_at,
  channel_connection_id: channel_accounts.channel_connection_id,
  is_automation_enabled: channel_accounts.is_automation_enabled,
};

/** The join of an Instagram account to its channel account (1:1, same organization). */
const channelAccountJoin = and(
  eq(channel_accounts.organization_id, instagram_accounts.organization_id),
  eq(channel_accounts.id, instagram_accounts.channel_account_id),
);

/** The channel account is not revoked. */
const isChannelAccountLive = ne(channel_accounts.connection_status, 'revoked');

/** The two keys every account write is scoped by: its organization and its internal id. */
export interface InstagramAccountKey {
  /** `tenancy.organizations.id` of the owning organization. */
  organizationId: number;
  /** `app.instagram_accounts.id`. */
  instagramAccountId: number;
}

/**
 * What a pick writes onto the extension (routes-final § 1 MC7, § 2.A IA8): the channel account it
 * extends and the Instagram profile read at the pick.
 */
export interface InstagramAccountPickValues {
  organizationId: number;
  /** `app.channel_accounts.id` this row extends (1:1). */
  channelAccountId: number;
  instagramUserId: string;
  username: string;
  biography: string | null;
  website: string | null;
  profilePictureUrl: string | null;
  /** `business` · `creator`, or `null` when Meta did not tell (P120). */
  accountType: string | null;
  /** The private flag; `false` when Meta did not tell (P120). */
  isPrivate: boolean;
  followersCount: number;
  followsCount: number;
  mediaCount: number;
}

/**
 * One `connected` account as the daily sweep lists it (IA8): the keyset cursor and the two public
 * handles its per-organization job carries — never a bigserial in the job.
 */
export interface InstagramAccountDailyCheckCandidate {
  /** `app.instagram_accounts.id` — the sweep's keyset cursor only. */
  id: number;
  /** `cha_…` — the account's one id (P47). */
  instagramAccountPublicId: string;
  organizationPublicId: string;
}

/**
 * What the profile refresh writes back (IA8 step 2). A `null` username or count means Instagram
 * left it out, and the stored value is kept; a `null` text field means the account has none (a
 * removed bio), and is written as such.
 */
export interface InstagramAccountProfileRefreshValues {
  username: string | null;
  biography: string | null;
  website: string | null;
  profilePictureUrl: string | null;
  followersCount: number | null;
  followsCount: number | null;
  mediaCount: number | null;
}

/**
 * Drizzle access to `app.instagram_accounts`, the 1:1 Instagram extension of a channel account
 * (routes-final § 2.A.3, IAC6): the organization's live accounts, the pick's upsert, the webhook
 * stamp and its clearing on a revoke, the profile refresh and erase, the locked accounts of one
 * Instagram id for Meta's callbacks and of the whole organization for its delete (D54), the daily
 * check's sweep page, and the two SECURITY DEFINER resolvers (IA6).
 *
 * @remarks
 * - **Algorithm:** every read joins the channel account (1:1, same organization) for the account's
 *   one public id, status, `connected_at` and connection — the extension keeps none of them (ROUTE
 *   row R6). Every row statement names both `organization_id` and, for a single row, the internal
 *   `id`, so tenant isolation does not rest on RLS alone. The pick's upsert keys on the unique
 *   `(organization_id, instagram_user_id)` index, so a revoked account comes back with its settings.
 * - **Failure modes:** none of its own; constraint failures propagate. Guarded updates return
 *   `null` / `false` when the channel account is not in the state they require.
 * - **Side effects:** writes `app.instagram_accounts` only; the status moves are the channel
 *   account repository's (CA4, CA8); never reads the token table (MC9).
 * - **Notes:** HTTP paths run inside the caller's `withAppDatabaseContext`; workers bind a handle
 *   through {@link createWorkerInstagramAccountRepository} or
 *   {@link createRetentionInstagramAccountRepository}. The resolvers run through the context-free
 *   accessor — they read as their owner whatever the caller's settings.
 */
export class InstagramAccountRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /**
   * The organization's oldest-connected not-revoked account (`connected` or `error`), or `null`
   * when it has none — the singular launch routes' account until their rows name it in the path.
   */
  async findLiveByOrganizationId(organizationId: number): Promise<InstagramAccountRow | null> {
    const [row] = await this.listLiveByOrganizationId(organizationId);
    return row ?? null;
  }

  /** The organization's not-revoked accounts, oldest connected first (the team delete, IAC5). */
  async listLiveByOrganizationId(organizationId: number): Promise<InstagramAccountRow[]> {
    return this.db()
      .select(instagramAccountColumns)
      .from(instagram_accounts)
      .innerJoin(channel_accounts, channelAccountJoin)
      .where(and(eq(instagram_accounts.organization_id, organizationId), isChannelAccountLive))
      .orderBy(asc(channel_accounts.connected_at), asc(instagram_accounts.id));
  }

  /**
   * The Instagram rows of these channel accounts (the 1:1 extension), any status — the channel
   * account's reads (routes 6–11) and its account port.
   */
  async findByChannelAccountIds({
    organizationId,
    channelAccountIds,
  }: {
    organizationId: number;
    channelAccountIds: readonly number[];
  }): Promise<InstagramAccountRow[]> {
    if (channelAccountIds.length === 0) return [];
    return this.db()
      .select(instagramAccountColumns)
      .from(instagram_accounts)
      .innerJoin(channel_accounts, channelAccountJoin)
      .where(
        and(
          eq(instagram_accounts.organization_id, organizationId),
          inArray(instagram_accounts.channel_account_id, [...channelAccountIds]),
        ),
      );
  }

  /** One account of the organization by its internal id, any status; `null` when absent. */
  async findById(key: InstagramAccountKey): Promise<InstagramAccountRow | null> {
    const rows = await this.db()
      .select(instagramAccountColumns)
      .from(instagram_accounts)
      .innerJoin(channel_accounts, channelAccountJoin)
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
   * Inserts the extension, or — when this organization had this Instagram account before — updates
   * that row (the pick, MC7): its channel account, the profile, the account type and private flag,
   * `profile_synced_at`; clears `profile_erased_at`. `webhook_subscribed_at` and
   * `starter_questions_set_at` are kept (a revoke has already emptied the first). Returns the row
   * read back with its channel account.
   */
  async upsertAtPick(values: InstagramAccountPickValues): Promise<InstagramAccountRow> {
    const pickedColumns = {
      channel_account_id: values.channelAccountId,
      username: values.username,
      biography: values.biography,
      website: values.website,
      profile_picture_url: values.profilePictureUrl,
      account_type: values.accountType,
      is_private: values.isPrivate,
      followers_count: values.followersCount,
      follows_count: values.followsCount,
      media_count: values.mediaCount,
      profile_synced_at: databaseNowTimestamp,
      profile_erased_at: null,
    };
    const rows = await this.db()
      .insert(instagram_accounts)
      .values({
        organization_id: values.organizationId,
        instagram_user_id: values.instagramUserId,
        ...pickedColumns,
      })
      .onConflictDoUpdate({
        target: [instagram_accounts.organization_id, instagram_accounts.instagram_user_id],
        set: { ...pickedColumns, updated_at: accountUpdatedAtTimestamp },
      })
      .returning({ id: instagram_accounts.id });
    const inserted = rows[0];
    if (inserted === undefined) throw new Error('instagram account upsert returned no row');
    const account = await this.findById({
      organizationId: values.organizationId,
      instagramAccountId: inserted.id,
    });
    if (account === null) throw new Error('instagram account upsert read back no row');
    return account;
  }

  /**
   * The extension's side of a revoke (CA8, IA14): the webhook stamp emptied — a new pick subscribes
   * again. Profile kept. Returns whether a stamp was cleared.
   */
  async clearWebhookSubscription(key: InstagramAccountKey): Promise<boolean> {
    const rows = await this.db()
      .update(instagram_accounts)
      .set({ webhook_subscribed_at: null, updated_at: accountUpdatedAtTimestamp })
      .where(
        and(
          eq(instagram_accounts.organization_id, key.organizationId),
          eq(instagram_accounts.id, key.instagramAccountId),
          isNotNull(instagram_accounts.webhook_subscribed_at),
        ),
      )
      .returning({ id: instagram_accounts.id });
    return rows.length > 0;
  }

  /**
   * Erases a revoked account's Instagram profile (Meta's data deletion, IA20, and the organization's
   * delete, D54): username, biography, website and picture emptied, account type and counts
   * cleared, `profile_erased_at` stamped. Returns the erased row, or `null` when its channel account
   * is not revoked or the profile is already erased — so a repeat changes nothing (a pick clears
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
        biography: null,
        website: null,
        profile_picture_url: null,
        account_type: null,
        is_private: false,
        followers_count: 0,
        follows_count: 0,
        media_count: 0,
        profile_erased_at: databaseNowTimestamp,
        updated_at: accountUpdatedAtTimestamp,
      })
      .from(channel_accounts)
      .where(
        and(
          channelAccountJoin,
          eq(instagram_accounts.organization_id, organizationId),
          eq(instagram_accounts.id, instagramAccountId),
          eq(channel_accounts.connection_status, 'revoked'),
          isNull(instagram_accounts.profile_erased_at),
        ),
      )
      .returning(instagramAccountColumns);
    return rows[0] ?? null;
  }

  /**
   * Every account of the organization with this public id whose channel account carries this
   * provider account id (for Meta: the Instagram user id), any status, oldest first, locked until the
   * unit ends — Meta's deauthorize and data-deletion callbacks matched by account (routes-final § 1
   * MC15, P56), which know the organization only by the public id the resolver returned.
   *
   * @remarks
   * Runs in that organization's own scope. A soft-deleted organization's rows are not seen there (its
   * own scope hides them, `organizations_tenant_isolation`) — nothing is left to erase in them: the
   * organization's delete erased them before it was soft-deleted (D54). The lock (`FOR NO KEY
   * UPDATE`) is taken on the extension rows at the read, so a pick in between waits (D53). Normally
   * one row: an organization holds one row per Instagram account.
   */
  async lockByProviderAccountInOrganization({
    organizationPublicId,
    providerAccountId,
  }: {
    organizationPublicId: string;
    providerAccountId: string;
  }): Promise<InstagramAccountRow[]> {
    // Subqueries, not joins: the lock must take the extension rows only.
    const organizationId = this.db()
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.public_id, organizationPublicId));
    const channelAccountIds = this.db()
      .select({ id: channel_accounts.id })
      .from(channel_accounts)
      .where(
        and(
          inArray(channel_accounts.organization_id, organizationId),
          eq(channel_accounts.channel, 'instagram'),
          eq(channel_accounts.provider_account_id, providerAccountId),
        ),
      );
    const locked = await this.db()
      .select({ id: instagram_accounts.id })
      .from(instagram_accounts)
      .where(
        and(
          inArray(instagram_accounts.organization_id, organizationId),
          inArray(instagram_accounts.channel_account_id, channelAccountIds),
        ),
      )
      .orderBy(asc(instagram_accounts.id))
      .for('no key update');
    return this.readLockedRows(locked);
  }

  /**
   * Every not-revoked account of these connections of the organization, oldest first, locked until
   * the unit ends — Meta's callbacks matched by business (routes-final § 1 MC15, P56: a business
   * match reaches every not-revoked channel account of that connection).
   */
  async lockLiveByConnections({
    organizationId,
    channelConnectionIds,
  }: {
    organizationId: number;
    channelConnectionIds: readonly number[];
  }): Promise<InstagramAccountRow[]> {
    if (channelConnectionIds.length === 0) return [];
    const channelAccountIds = this.db()
      .select({ id: channel_accounts.id })
      .from(channel_accounts)
      .where(
        and(
          eq(channel_accounts.organization_id, organizationId),
          inArray(channel_accounts.channel_connection_id, [...channelConnectionIds]),
          ne(channel_accounts.connection_status, 'revoked'),
        ),
      );
    const locked = await this.db()
      .select({ id: instagram_accounts.id })
      .from(instagram_accounts)
      .where(
        and(
          eq(instagram_accounts.organization_id, organizationId),
          inArray(instagram_accounts.channel_account_id, channelAccountIds),
        ),
      )
      .orderBy(asc(instagram_accounts.id))
      .for('no key update');
    return this.readLockedRows(locked);
  }

  /**
   * Every account of the organization, any status, oldest first, locked until the unit ends — the
   * organization delete's erase (D54, IAC5). A pick racing it waits for the unit.
   */
  async lockByOrganizationId(organizationId: number): Promise<InstagramAccountRow[]> {
    const locked = await this.db()
      .select({ id: instagram_accounts.id })
      .from(instagram_accounts)
      .where(eq(instagram_accounts.organization_id, organizationId))
      .orderBy(asc(instagram_accounts.id))
      .for('no key update');
    return this.readLockedRows(locked);
  }

  /**
   * The rows of accounts the caller just locked, with their channel account, oldest first (a join
   * cannot carry `FOR NO KEY UPDATE OF` a schema-qualified table, so the lock takes the extension
   * rows alone and this reads them back in the same unit).
   */
  private async readLockedRows(
    locked: ReadonlyArray<{ id: number }>,
  ): Promise<InstagramAccountRow[]> {
    if (locked.length === 0) return [];
    return this.db()
      .select(instagramAccountColumns)
      .from(instagram_accounts)
      .innerJoin(channel_accounts, channelAccountJoin)
      .where(
        inArray(
          instagram_accounts.id,
          locked.map((row) => row.id),
        ),
      )
      .orderBy(asc(instagram_accounts.id));
  }

  /**
   * Stamps `webhook_subscribed_at` after `subscribed_apps` succeeded (IA6 (1)). Skips an account
   * whose channel account is revoked — a disconnect in between wins. Returns whether a row was
   * stamped.
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
      .from(channel_accounts)
      .where(
        and(
          channelAccountJoin,
          eq(instagram_accounts.organization_id, organizationId),
          eq(instagram_accounts.id, instagramAccountId),
          isChannelAccountLive,
        ),
      )
      .returning({ id: instagram_accounts.id });
    return rows.length > 0;
  }

  /**
   * One account by its public id (the channel account's, `cha_…`), any status, only when it belongs
   * to the organization with this public id — the daily check's and the reconnect notice's read
   * (their jobs carry public ids only); `null` otherwise.
   */
  async findByPublicIdInOrganization({
    organizationPublicId,
    instagramAccountPublicId,
  }: {
    organizationPublicId: string;
    instagramAccountPublicId: string;
  }): Promise<InstagramAccountRow | null> {
    const rows = await this.db()
      .select(instagramAccountColumns)
      .from(instagram_accounts)
      .innerJoin(channel_accounts, channelAccountJoin)
      .innerJoin(organizations, eq(organizations.id, instagram_accounts.organization_id))
      .where(
        and(
          eq(organizations.public_id, organizationPublicId),
          eq(channel_accounts.public_id, instagramAccountPublicId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * One page of the `connected` accounts of every live organization, by id after `afterId` — the
   * daily sweep's cross-organization read (IA8). Runs only on a retention handle
   * ({@link createRetentionInstagramAccountRepository}): the sweep arm is in the `USING` of both the
   * extension's and the channel account's policies, so it reads every organization's rows and can
   * write none.
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
        instagramAccountPublicId: channel_accounts.public_id,
        organizationPublicId: organizations.public_id,
      })
      .from(instagram_accounts)
      .innerJoin(channel_accounts, channelAccountJoin)
      .innerJoin(organizations, eq(organizations.id, instagram_accounts.organization_id))
      .where(
        and(
          eq(channel_accounts.connection_status, 'connected'),
          isNull(organizations.deleted_at),
          gt(instagram_accounts.id, afterId),
        ),
      )
      .orderBy(asc(instagram_accounts.id))
      .limit(limit);
  }

  /**
   * Writes the profile refresh (IA8 step 2) and stamps `profile_synced_at` — only while the channel
   * account is not revoked and the row is still the same Instagram account. A username or count
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
        biography: profile.biography,
        website: profile.website,
        profile_picture_url: profile.profilePictureUrl,
        ...(profile.followersCount === null ? {} : { followers_count: profile.followersCount }),
        ...(profile.followsCount === null ? {} : { follows_count: profile.followsCount }),
        ...(profile.mediaCount === null ? {} : { media_count: profile.mediaCount }),
        profile_synced_at: databaseNowTimestamp,
        updated_at: accountUpdatedAtTimestamp,
      })
      .from(channel_accounts)
      .where(
        and(
          channelAccountJoin,
          eq(instagram_accounts.organization_id, organizationId),
          eq(instagram_accounts.id, instagramAccountId),
          eq(instagram_accounts.instagram_user_id, instagramUserId),
          isChannelAccountLive,
        ),
      )
      .returning({ id: instagram_accounts.id });
    return rows.length > 0;
  }

  /**
   * The public id of the organization whose NOT-revoked Instagram channel account has this
   * Instagram user id, or `null` (IA6 — `app.resolve_organization_public_id_for_instagram_user`,
   * over `app.channel_accounts` since ROUTE row R6). Reads no other column of another organization's
   * row.
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
