import {
  populateTombstonedCacheEntry,
  readTombstonedCacheEntry,
} from '@/infrastructure/cache/redis-tombstone-cache.util.js';
import { recordReadCacheRequest } from '@/infrastructure/observability/metrics/prometheus-metrics.js';
import { SEGMENT_COUNT_CACHE_TTL_SECONDS } from '@/shared/constants/ttl.constants.js';
import type { SegmentAudienceCount } from './broadcast-segment.types.js';

/** Logical key prefix (routes-final § 7.B BC14). ioredis prepends the deployment prefix; never include it here. */
const SEGMENT_COUNT_CACHE_PREFIX = 'app:segment_count';

/** Metric label and log-event namespace for this cache. */
const SEGMENT_COUNT_CACHE_NAME = 'app_segment_count';

/** The JSON-safe stored shape — the time as ISO text. */
interface StoredSegmentCount {
  matched: number;
  can_receive_now: number;
  counted_at: string;
}

/** What one copy is about: the verified organization, the account and the conditions' hash. */
export interface SegmentCountCacheKey {
  /** `org_…` — from the verified scope (the signed `org` claim, or the job's organization). */
  organizationPublicId: string;
  /** `cha_…` — an account of that organization, read back before the copy is read or written. */
  channelAccountPublicId: string;
  /** The SHA-256 of the conditions (64 hex characters). */
  conditionsHash: string;
}

/**
 * `app:segment_count:<organization public id>:<account public id>:<conditions hash>`.
 *
 * @remarks
 * `app.contacts` / `app.contact_activities` are FORCE RLS on the organization arm, and the count is
 * the organization's (every member with the route's permission sees the same number), so the key's
 * scope segment is the ORGANIZATION from the verified scope — no user segment. The account and the
 * hash narrow the answer; the account is read back inside the organization before either read or
 * write, so a foreign account id can never name another organization's entry (the organization
 * segment already separates them).
 */
function buildSegmentCountCacheKey({
  organizationPublicId,
  channelAccountPublicId,
  conditionsHash,
}: SegmentCountCacheKey): string {
  return `${SEGMENT_COUNT_CACHE_PREFIX}:${organizationPublicId}:${channelAccountPublicId}:${conditionsHash}`;
}

/** The cached count, or `null` when the payload is not what {@link setCachedSegmentCount} wrote. */
function parseCachedCount(cached: string): SegmentAudienceCount | null {
  try {
    const parsed = JSON.parse(cached) as Partial<StoredSegmentCount> | null;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.matched !== 'number' ||
      typeof parsed.can_receive_now !== 'number' ||
      typeof parsed.counted_at !== 'string'
    ) {
      return null;
    }
    return {
      matched: parsed.matched,
      canReceiveNow: parsed.can_receive_now,
      countedAt: new Date(parsed.counted_at),
    };
  } catch {
    return null;
  }
}

/**
 * Returns the background count of one account's conditions, or `null` on a miss (BC14).
 *
 * @remarks
 * - **Algorithm:** one Redis `GET` through the tombstone protocol; a payload that does not parse is
 *   a miss, never trusted.
 * - **Failure modes:** Redis errors surface as a miss (logged by the shared util) — route 82 then
 *   counts inline in Postgres (fail open). Never throws.
 * - **Side effects:** increments `read_cache_requests_total{cache="app_segment_count"}`.
 * - **Notes:** read after the route's authentication, permission check, team check, account read
 *   and `segments` feature check, with the verified organization scope's public id — this cache sits
 *   outside RLS.
 */
export async function getCachedSegmentCount(
  key: SegmentCountCacheKey,
): Promise<SegmentAudienceCount | null> {
  const cached = await readTombstonedCacheEntry({
    key: buildSegmentCountCacheKey(key),
    metricName: SEGMENT_COUNT_CACHE_NAME,
  });
  const count = cached === null ? null : parseCachedCount(cached);
  recordReadCacheRequest({
    cache: SEGMENT_COUNT_CACHE_NAME,
    result: count === null ? 'miss' : 'hit',
  });
  return count;
}

/**
 * Caches one account's count of one set of conditions, counted in Postgres by the `segment-count`
 * task (WC-39).
 *
 * @remarks
 * - **Algorithm:** `SET … EX … NX` via the shared protocol: a copy already there stays until its
 *   TTL (a second count of the same conditions within the minute adds nothing).
 * - **Failure modes:** swallowed — the next ask counts again.
 * - **Side effects:** one short-lived Redis key.
 * - **Notes:** TTL {@link SEGMENT_COUNT_CACHE_TTL_SECONDS} (60 s, BC14, P5). There is no
 *   invalidation: every contact write (routes 20–23, intake, the bulk job, the erase) moves the
 *   count and none can name the hash, so a copy may be up to 60 s behind — a preview number,
 *   authorizing nothing (be-read-cache-guard check 10); the send always builds its audience from
 *   Postgres (WC-40).
 */
export async function setCachedSegmentCount({
  key,
  count,
}: {
  key: SegmentCountCacheKey;
  count: SegmentAudienceCount;
}): Promise<void> {
  const stored: StoredSegmentCount = {
    matched: count.matched,
    can_receive_now: count.canReceiveNow,
    counted_at: count.countedAt.toISOString(),
  };
  await populateTombstonedCacheEntry({
    key: buildSegmentCountCacheKey(key),
    value: JSON.stringify(stored),
    ttlSeconds: SEGMENT_COUNT_CACHE_TTL_SECONDS,
    metricName: SEGMENT_COUNT_CACHE_NAME,
  });
}
