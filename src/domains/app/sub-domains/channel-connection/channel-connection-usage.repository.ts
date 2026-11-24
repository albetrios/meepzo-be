import { and, eq, sql } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { databaseUpdatedAtTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { channel_connections } from './channel-connection.schema.js';
import { channel_connection_usages } from './channel-connection-usage.schema.js';
import type { ChannelConnectionUsageEntry } from './channel-connection-usage.types.js';

/** `updated_at` for every change of a usage row — never before the row's `created_at`. */
const usageUpdatedAtTimestamp = databaseUpdatedAtTimestamp(channel_connection_usages.created_at);

/**
 * Drizzle access to `app.channel_connection_usages` (routes-final § 1 MC19 as refined by S13,
 * P107): every reading of one connection, and the upsert that keeps the newer reading per asset
 * and type.
 *
 * @remarks
 * - **Algorithm:** the connection is found by its public id inside the caller's organization (RLS
 *   and the organization id both); the upsert keys on
 *   `(organization_id, channel_connection_id, asset_id, usage_type)` and updates only when the new
 *   `read_at` is later — an older reading never overwrites a newer one.
 * - **Failure modes:** none of its own; an unknown connection reads `[]` and writes nothing.
 * - **Side effects:** writes `app.channel_connection_usages` only.
 * - **Notes:** runs inside the caller's `withAppDatabaseContext` (the usage service's Postgres
 *   store opens it).
 */
export class ChannelConnectionUsageRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** The connection's organization and internal id by its public id, or `null`. */
  private async findConnectionKey(
    channelConnectionPublicId: string,
  ): Promise<{ organizationId: number; channelConnectionId: number } | null> {
    const rows = await this.db()
      .select({
        organizationId: channel_connections.organization_id,
        channelConnectionId: channel_connections.id,
      })
      .from(channel_connections)
      .where(
        and(
          eq(channel_connections.public_id, channelConnectionPublicId),
          sql`${channel_connections.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Every reading of the connection; `[]` when it has none or is not this organization's. */
  async listEntries(channelConnectionPublicId: string): Promise<ChannelConnectionUsageEntry[]> {
    const key = await this.findConnectionKey(channelConnectionPublicId);
    if (key === null) return [];
    const rows = await this.db()
      .select({
        assetId: channel_connection_usages.asset_id,
        type: channel_connection_usages.usage_type,
        usagePercent: channel_connection_usages.usage_percent,
        waitUntil: channel_connection_usages.wait_until,
        readAt: channel_connection_usages.read_at,
      })
      .from(channel_connection_usages)
      .where(
        and(
          eq(channel_connection_usages.organization_id, key.organizationId),
          eq(channel_connection_usages.channel_connection_id, key.channelConnectionId),
        ),
      );
    return rows;
  }

  /** Upserts the readings, keeping the newer `read_at` per (asset, type). */
  async upsertEntries({
    channelConnectionPublicId,
    entries,
  }: {
    channelConnectionPublicId: string;
    entries: readonly ChannelConnectionUsageEntry[];
  }): Promise<void> {
    if (entries.length === 0) return;
    const key = await this.findConnectionKey(channelConnectionPublicId);
    if (key === null) return;
    await this.db()
      .insert(channel_connection_usages)
      .values(
        entries.map((entry) => ({
          organization_id: key.organizationId,
          channel_connection_id: key.channelConnectionId,
          asset_id: entry.assetId,
          usage_type: entry.type,
          usage_percent: Math.min(100, Math.max(0, Math.round(entry.usagePercent))),
          wait_until: entry.waitUntil,
          read_at: entry.readAt,
        })),
      )
      .onConflictDoUpdate({
        target: [
          channel_connection_usages.organization_id,
          channel_connection_usages.channel_connection_id,
          channel_connection_usages.asset_id,
          channel_connection_usages.usage_type,
        ],
        set: {
          usage_percent: sql`excluded.usage_percent`,
          wait_until: sql`excluded.wait_until`,
          read_at: sql`excluded.read_at`,
          updated_at: usageUpdatedAtTimestamp,
        },
        setWhere: sql`${channel_connection_usages.read_at} < excluded.read_at`,
      });
  }
}
