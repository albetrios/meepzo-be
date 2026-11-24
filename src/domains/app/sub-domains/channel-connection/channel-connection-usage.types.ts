import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';

/**
 * Meta's usage of one (connection, asset, type) as the connection keeps it (routes-final § 1 MC19,
 * S13): the highest percentage Meta reported, when calls may go again, and when it was read.
 */
export interface ChannelConnectionUsageEntry {
  /** The asset id Meta keyed the entry by (`X-Business-Use-Case-Usage`). */
  assetId: string;
  /** Meta's use-case type, lower-cased. */
  type: string;
  /** 0–100. */
  usagePercent: number;
  /** Set at ≥ 95 % or when Meta named a time to regain access; else `null`. */
  waitUntil: Date | null;
  /** When the answer was read — the store keeps the newest reading per (asset, type). */
  readAt: Date;
}

/** Which connection a usage read or write is about, inside the verified organization scope. */
export interface ChannelConnectionUsageTarget {
  /** The verified organization scope (a request's or a job's) — the cache key is built from it. */
  scope: OrganizationPrincipalDatabaseScope;
  /** The connection's public id, read from its row (never a request parameter). */
  channelConnectionPublicId: string;
}

/**
 * Where a connection's usage is held in Postgres (P32: Postgres holds it, Redis is a copy) — the
 * port of routes-final § 1 MC19 / MCC12.
 *
 * @remarks
 * Implemented by `createChannelConnectionUsagePostgresStore` over `app.channel_connection_usages` (S13:
 * one row per connection, asset and type). `writeConnectionUsageEntries` runs in its own unit of work (never inside a
 * send's transaction) and keeps the newer `readAt` per (asset, type) — an older reading never
 * overwrites a newer one.
 */
export interface ChannelConnectionUsageStore {
  /** Every entry of the connection, or `[]` when none is kept (or the connection is not this organization's). */
  readConnectionUsageEntries(
    target: ChannelConnectionUsageTarget,
  ): Promise<ChannelConnectionUsageEntry[]>;
  /** Upserts the entries, keeping the newer reading per (asset, type). */
  writeConnectionUsageEntries(
    options: ChannelConnectionUsageTarget & { entries: readonly ChannelConnectionUsageEntry[] },
  ): Promise<void>;
}

/**
 * Where Meta's app-level usage is held — once for the whole app, in `app.sending_states` (S13,
 * P97), since every customer shares it. Implemented by the row that builds `sending_states`
 * (routes-final § 6, ROUTE row R18); optional until then.
 */
export interface MetaAppUsageStore {
  /** Records the app-level usage, keeping the newer reading. */
  writeAppUsage(options: { usagePercent: number; readAt: Date }): Promise<void>;
}
