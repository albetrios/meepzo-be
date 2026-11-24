import {
  META_USAGE_DEFAULT_WAIT_MINUTES,
  META_USAGE_SLOW_PERCENT,
  META_USAGE_WAIT_PERCENT,
} from '@/shared/constants/instagram.constants.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';

/** The header Meta reports a business's use-case usage in, per asset id and type (MC19, S13). */
export const META_BUSINESS_USE_CASE_USAGE_HEADER = 'x-business-use-case-usage';
/** The header Meta reports the app's own usage in — shared by every customer (S13). */
export const META_APP_USAGE_HEADER = 'x-app-usage';

/** The highest percentage a usage reading can hold. */
const META_USAGE_MAX_PERCENT = 100;

/**
 * One entry of `X-Business-Use-Case-Usage` as Meta reports it: one asset id (the object key) and one
 * use-case type (`instagram`, `messenger`, `ads_management`, …) — kept per (connection, asset, type),
 * never merged into one number (S13, P97).
 */
export interface MetaBusinessUseCaseUsage {
  /** The asset id Meta keyed the entry by (the business or an Instagram account). */
  assetId: string;
  /** Meta's use-case `type`, lower-cased. */
  type: string;
  /** The highest of `call_count`, `total_cputime`, `total_time` — 0–100. */
  usagePercent: number;
  /**
   * When calls may go again: `estimated_time_to_regain_access` minutes after the reading, else
   * {@link META_USAGE_DEFAULT_WAIT_MINUTES} at ≥ {@link META_USAGE_WAIT_PERCENT}, else `null`.
   */
  waitUntil: Date | null;
}

/** What one Meta answer said about usage: the business entries and the app's own usage. */
export interface MetaGraphUsageReading {
  /** When the answer was read — an older reading never overwrites a newer one (MC19). */
  readAt: Date;
  /** Every entry of `X-Business-Use-Case-Usage`; empty when the header was absent or unreadable. */
  businessUseCases: MetaBusinessUseCaseUsage[];
  /** The app-level usage (`X-App-Usage`), or `null` when the header was absent or unreadable. */
  appUsagePercent: number | null;
}

/** The pace a caller keeps before its next Meta call (MC19, plan:L2353–L2360). */
export type MetaUsagePace = 'normal' | 'slow' | 'wait';

/** The pace and, for `wait`, until when. */
export interface MetaUsageDecision {
  pace: MetaUsagePace;
  /** Set only for `wait`. */
  waitUntil: Date | null;
}

/** `value` as a plain object, else `null`. */
function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A finite non-negative number from a JSON number, else `null`. */
function readPercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The highest of Meta's three counters, rounded up and capped at 100; `null` when none is given. */
function readHighestPercent(usage: Record<string, unknown>): number | null {
  const counters = [usage.call_count, usage.total_cputime, usage.total_time]
    .map(readPercent)
    .filter((percent): percent is number => percent !== null);
  if (counters.length === 0) return null;
  return Math.min(META_USAGE_MAX_PERCENT, Math.ceil(Math.max(...counters)));
}

/** A header's JSON value, or `null` when absent or not an object. */
function parseHeaderObject({
  headers,
  name,
}: {
  headers: Headers;
  name: string;
}): Record<string, unknown> | null {
  const raw = headers.get(name);
  if (raw === null || raw.length === 0) return null;
  try {
    return readObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** When a business entry's calls may go again (see {@link MetaBusinessUseCaseUsage.waitUntil}). */
function readWaitUntil({
  entry,
  usagePercent,
  readAt,
}: {
  entry: Record<string, unknown>;
  usagePercent: number;
  readAt: Date;
}): Date | null {
  const regainMinutes = readPercent(entry.estimated_time_to_regain_access);
  if (regainMinutes !== null && regainMinutes > 0) {
    return new Date(readAt.getTime() + regainMinutes * MILLISECONDS_PER_MINUTE);
  }
  if (usagePercent >= META_USAGE_WAIT_PERCENT) {
    return new Date(readAt.getTime() + META_USAGE_DEFAULT_WAIT_MINUTES * MILLISECONDS_PER_MINUTE);
  }
  return null;
}

/** Every readable entry of `X-Business-Use-Case-Usage`. */
function readBusinessUseCases({
  headers,
  readAt,
}: {
  headers: Headers;
  readAt: Date;
}): MetaBusinessUseCaseUsage[] {
  const byAsset = parseHeaderObject({ headers, name: META_BUSINESS_USE_CASE_USAGE_HEADER });
  if (byAsset === null) return [];
  const entries: MetaBusinessUseCaseUsage[] = [];
  for (const [assetId, assetEntries] of Object.entries(byAsset)) {
    if (!Array.isArray(assetEntries)) continue;
    for (const rawEntry of assetEntries) {
      const entry = readObject(rawEntry);
      if (entry === null || typeof entry.type !== 'string' || entry.type.length === 0) continue;
      const usagePercent = readHighestPercent(entry);
      if (usagePercent === null) continue;
      entries.push({
        assetId,
        type: entry.type.toLowerCase(),
        usagePercent,
        waitUntil: readWaitUntil({ entry, usagePercent, readAt }),
      });
    }
  }
  return entries;
}

/**
 * Reads Meta's usage headers of one answer — a success or an error (routes-final § 1 MC19, S13).
 *
 * @remarks
 * - **Algorithm:** `X-Business-Use-Case-Usage` (JSON: asset id → list of `{ type, call_count,
 *   total_cputime, total_time, estimated_time_to_regain_access }`) gives one entry per asset and
 *   type with the highest of the three counters (rounded up, capped at 100) and its wait time;
 *   `X-App-Usage` (`{ call_count, total_cputime, total_time }`) gives the app-level percentage.
 * - **Failure modes:** none — an absent, empty or malformed header reads as nothing; an entry
 *   without a type or any counter is skipped.
 * - **Side effects:** none (pure).
 * - **Notes:** `null` when the answer carries neither header, so "a missing header changes
 *   nothing" (MCC12).
 */
export function parseMetaGraphUsage({
  headers,
  readAt,
}: {
  headers: Headers;
  readAt: Date;
}): MetaGraphUsageReading | null {
  const businessUseCases = readBusinessUseCases({ headers, readAt });
  const appUsage = parseHeaderObject({ headers, name: META_APP_USAGE_HEADER });
  const appUsagePercent = appUsage === null ? null : readHighestPercent(appUsage);
  if (businessUseCases.length === 0 && appUsagePercent === null) return null;
  return { readAt, businessUseCases, appUsagePercent };
}

/**
 * The pace before a Meta call, from one usage figure (routes-final § 1 MC19, plan:L2353–L2360).
 *
 * @remarks
 * - **Algorithm:** a `waitUntil` still ahead of `now` → `wait`; else ≥
 *   {@link META_USAGE_SLOW_PERCENT} → `slow`; else `normal`. A `waitUntil` that has passed means
 *   Meta gave access back, so it never waits again on an old reading.
 * - **Failure modes:** none (pure).
 * - **Side effects:** none.
 * - **Notes:** ≥ {@link META_USAGE_WAIT_PERCENT} always carries a `waitUntil` from
 *   {@link parseMetaGraphUsage}, so the wait rule needs no second threshold here.
 */
export function decideMetaUsagePace({
  usagePercent,
  waitUntil,
  now,
}: {
  usagePercent: number;
  waitUntil: Date | null;
  now: Date;
}): MetaUsageDecision {
  if (waitUntil !== null && waitUntil.getTime() > now.getTime()) {
    return { pace: 'wait', waitUntil };
  }
  if (usagePercent >= META_USAGE_SLOW_PERCENT) return { pace: 'slow', waitUntil: null };
  return { pace: 'normal', waitUntil: null };
}
