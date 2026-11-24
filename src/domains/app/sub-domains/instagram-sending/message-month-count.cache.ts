import {
  invalidateTombstonedCacheEntry,
  populateTombstonedCacheEntry,
  readTombstonedCacheEntry,
} from '@/infrastructure/cache/redis-tombstone-cache.util.js';
import { recordReadCacheRequest } from '@/infrastructure/observability/metrics/prometheus-metrics.js';
import {
  CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS,
  MESSAGE_MONTH_COUNT_CACHE_TTL_SECONDS,
} from '@/shared/constants/ttl.constants.js';
import type { MessageMonthCountRead } from './message-month-count.repository.js';

/** Logical key prefix (routes-final § 6 SN11). ioredis prepends the deployment prefix; never include it here. */
const MESSAGE_MONTH_COUNT_CACHE_PREFIX = 'app:message_month_count';

/** Metric label and log-event namespace for this cache. */
const MESSAGE_MONTH_COUNT_CACHE_NAME = 'app_message_month_count';

/** The JSON-safe stored shape — dates as `YYYY-MM-DD` text. */
interface StoredMessageMonthCount {
  month_start: string;
  resets_on: string;
  used: number;
}

/**
 * `app:message_month_count:<organization public id>` — keyed on the ORGANIZATION only.
 *
 * @remarks
 * `app.message_month_counts` is FORCE RLS on the organization arm (routes-final § 6.A.3), and the
 * month is the organization's (its time zone): one answer per organization, the same for every
 * member, so no user segment. The organization segment comes from the verified scope (the signed
 * `org` claim), never a request parameter.
 */
function buildMessageMonthCountCacheKey(organizationPublicId: string): string {
  return `${MESSAGE_MONTH_COUNT_CACHE_PREFIX}:${organizationPublicId}`;
}

/** The cached month, or `null` when the payload is not what {@link setCachedMessageMonthCount} wrote. */
function parseCachedMonth(cached: string): MessageMonthCountRead | null {
  try {
    const parsed = JSON.parse(cached) as Partial<StoredMessageMonthCount> | null;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.month_start !== 'string' ||
      typeof parsed.resets_on !== 'string' ||
      typeof parsed.used !== 'number'
    ) {
      return null;
    }
    return { monthStart: parsed.month_start, resetsOn: parsed.resets_on, used: parsed.used };
  } catch {
    return null;
  }
}

/**
 * Returns an organization's cached month count, or `null` on a miss (routes-final § 6 SN11).
 *
 * @remarks
 * - **Algorithm:** one Redis `GET` through the tombstone protocol; a payload that does not parse is
 *   a miss, never trusted.
 * - **Failure modes:** Redis errors surface as a miss (logged by the shared util) — the caller falls
 *   through to Postgres (fail open). Never throws.
 * - **Side effects:** increments `read_cache_requests_total{cache="app_message_month_count"}`.
 * - **Notes:** read after the route's authentication and permission check, with the verified
 *   organization scope's public id — this cache sits outside RLS.
 */
export async function getCachedMessageMonthCount(
  organizationPublicId: string,
): Promise<MessageMonthCountRead | null> {
  const cached = await readTombstonedCacheEntry({
    key: buildMessageMonthCountCacheKey(organizationPublicId),
    metricName: MESSAGE_MONTH_COUNT_CACHE_NAME,
  });
  const month = cached === null ? null : parseCachedMonth(cached);
  recordReadCacheRequest({
    cache: MESSAGE_MONTH_COUNT_CACHE_NAME,
    result: month === null ? 'miss' : 'hit',
  });
  return month;
}

/**
 * Caches an organization's month count read from Postgres.
 *
 * @remarks
 * - **Algorithm:** `SET … EX … NX` via the shared protocol, so an add's tombstone wins over a
 *   populate that read before the add landed.
 * - **Failure modes:** swallowed — the caller already has the count.
 * - **Side effects:** one short-lived Redis key.
 * - **Notes:** TTL is {@link MESSAGE_MONTH_COUNT_CACHE_TTL_SECONDS} (≤ 60 s, P5).
 */
export async function setCachedMessageMonthCount({
  organizationPublicId,
  month,
}: {
  organizationPublicId: string;
  month: MessageMonthCountRead;
}): Promise<void> {
  const stored: StoredMessageMonthCount = {
    month_start: month.monthStart,
    resets_on: month.resetsOn,
    used: month.used,
  };
  await populateTombstonedCacheEntry({
    key: buildMessageMonthCountCacheKey(organizationPublicId),
    value: JSON.stringify(stored),
    ttlSeconds: MESSAGE_MONTH_COUNT_CACHE_TTL_SECONDS,
    metricName: MESSAGE_MONTH_COUNT_CACHE_NAME,
  });
}

/**
 * Invalidates an organization's cached month count. Call AFTER the add committed.
 *
 * @remarks
 * - **Algorithm:** writes a tombstone (never `DEL`) for
 *   {@link CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS}, so an in-flight read cannot reinstate the
 *   older count.
 * - **Failure modes:** swallowed and logged; the old count then expires with the 10 s TTL. A meter a
 *   few seconds behind authorizes nothing (the claim reads the slots), so no Sentry report.
 * - **Side effects:** one short-lived Redis key.
 * - **Notes:** the one writer is `MessageMonthCountService.addMessages` (the send's claim, ROUTE row
 *   R42). The 13-month delete (WC-54) removes past months only, which no copy holds.
 */
export async function invalidateCachedMessageMonthCount(
  organizationPublicId: string,
): Promise<void> {
  await invalidateTombstonedCacheEntry({
    key: buildMessageMonthCountCacheKey(organizationPublicId),
    ttlSeconds: CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS,
    metricName: MESSAGE_MONTH_COUNT_CACHE_NAME,
  });
}
