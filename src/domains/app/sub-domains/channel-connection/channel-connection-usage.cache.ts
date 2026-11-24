import type { ChannelConnectionUsageEntry } from '@/domains/app/sub-domains/channel-connection/channel-connection-usage.types.js';
import {
  invalidateTombstonedCacheEntry,
  populateTombstonedCacheEntry,
  readTombstonedCacheEntry,
} from '@/infrastructure/cache/redis-tombstone-cache.util.js';
import { recordReadCacheRequest } from '@/infrastructure/observability/metrics/prometheus-metrics.js';
import {
  CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS,
  CHANNEL_CONNECTION_USAGE_CACHE_TTL_SECONDS,
} from '@/shared/constants/ttl.constants.js';

/** Logical key prefix (routes-final § 1 MC19). ioredis prepends the deployment prefix; never include it here. */
const CHANNEL_CONNECTION_USAGE_CACHE_PREFIX = 'app:meta_usage';

/** Metric label and log-event namespace for this cache. */
const CHANNEL_CONNECTION_USAGE_CACHE_NAME = 'app_meta_usage';

/** The JSON-safe stored shape of one entry — epoch milliseconds, never a `Date`. */
interface StoredChannelConnectionUsageEntry {
  asset_id: string;
  type: string;
  usage_percent: number;
  wait_until_ms: number | null;
  read_at_ms: number;
}

/**
 * `app:meta_usage:<organization public id>:<connection public id>` — keyed on the ORGANIZATION
 * first, then the connection.
 *
 * @remarks
 * The connection's rows are organization-owned: `app.channel_connections` is FORCE RLS on the
 * organization arm (routes-final § 1.3), so a connection is visible only inside its organization.
 * The organization segment comes from the verified scope (a request's or a job's), and the
 * connection segment from the connection row the caller already read inside that scope — never a
 * request parameter — so a key can only name a connection that scope may see. A connection
 * segment is needed (an organization has several connections, each with its own usage); dropping
 * the organization segment would let a guessed connection id read across tenants.
 */
function buildChannelConnectionUsageCacheKey({
  organizationPublicId,
  channelConnectionPublicId,
}: {
  organizationPublicId: string;
  channelConnectionPublicId: string;
}): string {
  return `${CHANNEL_CONNECTION_USAGE_CACHE_PREFIX}:${organizationPublicId}:${channelConnectionPublicId}`;
}

/** One stored entry back as a {@link ChannelConnectionUsageEntry}, or `null` when malformed. */
function readStoredEntry(value: unknown): ChannelConnectionUsageEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Partial<StoredChannelConnectionUsageEntry>;
  if (
    typeof entry.asset_id !== 'string' ||
    typeof entry.type !== 'string' ||
    typeof entry.usage_percent !== 'number' ||
    typeof entry.read_at_ms !== 'number' ||
    !(entry.wait_until_ms === null || typeof entry.wait_until_ms === 'number')
  ) {
    return null;
  }
  return {
    assetId: entry.asset_id,
    type: entry.type,
    usagePercent: entry.usage_percent,
    waitUntil: entry.wait_until_ms === null ? null : new Date(entry.wait_until_ms),
    readAt: new Date(entry.read_at_ms),
  };
}

/** The cached entries, or `null` when the payload is not what {@link setCachedChannelConnectionUsage} wrote. */
function parseCachedEntries(cached: string): ChannelConnectionUsageEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(cached);
    if (!Array.isArray(parsed)) return null;
    const entries = parsed.map(readStoredEntry);
    return entries.every((entry): entry is ChannelConnectionUsageEntry => entry !== null)
      ? entries
      : null;
  } catch {
    return null;
  }
}

/**
 * Returns a connection's cached Meta usage entries, or `null` on a miss (routes-final § 1 MC19).
 *
 * @remarks
 * - **Algorithm:** one Redis `GET` through the tombstone protocol; a payload that does not parse is
 *   a miss, never trusted.
 * - **Failure modes:** Redis errors surface as a miss (logged by the shared util) — the caller
 *   falls through to Postgres (fail open). Never throws.
 * - **Side effects:** increments `read_cache_requests_total{cache="app_meta_usage"}`.
 * - **Notes:** the caller passes the verified organization scope's public id and a connection it
 *   read inside that scope — this cache sits outside RLS.
 */
export async function getCachedChannelConnectionUsage(key: {
  organizationPublicId: string;
  channelConnectionPublicId: string;
}): Promise<ChannelConnectionUsageEntry[] | null> {
  const cached = await readTombstonedCacheEntry({
    key: buildChannelConnectionUsageCacheKey(key),
    metricName: CHANNEL_CONNECTION_USAGE_CACHE_NAME,
  });
  const entries = cached === null ? null : parseCachedEntries(cached);
  recordReadCacheRequest({
    cache: CHANNEL_CONNECTION_USAGE_CACHE_NAME,
    result: entries === null ? 'miss' : 'hit',
  });
  return entries;
}

/**
 * Caches a connection's usage entries read from Postgres.
 *
 * @remarks
 * - **Algorithm:** `SET … EX … NX` via the shared protocol, so a usage write's tombstone wins over a
 *   populate that read before the write landed.
 * - **Failure modes:** swallowed — the caller already has the entries.
 * - **Side effects:** one short-lived Redis key.
 * - **Notes:** TTL is {@link CHANNEL_CONNECTION_USAGE_CACHE_TTL_SECONDS} (≤ 60 s, P5); dates are
 *   stored as epoch milliseconds.
 */
export async function setCachedChannelConnectionUsage({
  organizationPublicId,
  channelConnectionPublicId,
  entries,
}: {
  organizationPublicId: string;
  channelConnectionPublicId: string;
  entries: readonly ChannelConnectionUsageEntry[];
}): Promise<void> {
  const stored: StoredChannelConnectionUsageEntry[] = entries.map((entry) => ({
    asset_id: entry.assetId,
    type: entry.type,
    usage_percent: entry.usagePercent,
    wait_until_ms: entry.waitUntil === null ? null : entry.waitUntil.getTime(),
    read_at_ms: entry.readAt.getTime(),
  }));
  await populateTombstonedCacheEntry({
    key: buildChannelConnectionUsageCacheKey({ organizationPublicId, channelConnectionPublicId }),
    value: JSON.stringify(stored),
    ttlSeconds: CHANNEL_CONNECTION_USAGE_CACHE_TTL_SECONDS,
    metricName: CHANNEL_CONNECTION_USAGE_CACHE_NAME,
  });
}

/**
 * Invalidates a connection's cached usage. Call AFTER the usage write landed.
 *
 * @remarks
 * - **Algorithm:** writes a tombstone (never `DEL`) for
 *   {@link CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS}, so an in-flight read cannot reinstate the
 *   older usage.
 * - **Failure modes:** swallowed and logged; the old usage then expires with the TTL. A pace a
 *   minute out of date is not a security fault, so no Sentry report.
 * - **Side effects:** one short-lived Redis key.
 * - **Notes:** the one writer is the usage service's recorder (after each Meta answer). A
 *   connection's revoke (route 5) leaves the entry to its TTL — nothing calls Meta on
 *   a revoked connection.
 */
export async function invalidateCachedChannelConnectionUsage(key: {
  organizationPublicId: string;
  channelConnectionPublicId: string;
}): Promise<void> {
  await invalidateTombstonedCacheEntry({
    key: buildChannelConnectionUsageCacheKey(key),
    ttlSeconds: CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS,
    metricName: CHANNEL_CONNECTION_USAGE_CACHE_NAME,
  });
}
