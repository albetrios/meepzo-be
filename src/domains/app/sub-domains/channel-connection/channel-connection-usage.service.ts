import {
  getCachedChannelConnectionUsage,
  invalidateCachedChannelConnectionUsage,
  setCachedChannelConnectionUsage,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-usage.cache.js';
import type {
  ChannelConnectionUsageEntry,
  ChannelConnectionUsageStore,
  ChannelConnectionUsageTarget,
  MetaAppUsageStore,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-usage.types.js';
import type { MetaGraphUsageRecorder } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  decideMetaUsagePace,
  type MetaUsageDecision,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-usage.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * Which entries of a connection a pace is read from: one asset and/or type, else all of them.
 *
 * @remarks
 * S13: Meta reports usage per asset and type, so a lane reads its own account's entries and
 * leaves a sibling account's hot asset out of its pace.
 */
export interface ReadConnectionUsageOptions extends ChannelConnectionUsageTarget {
  /** Only the entries of this asset id (e.g. the Instagram account a lane sends from). */
  assetId?: string | undefined;
  /** Only the entries of this use-case type (e.g. `instagram`). */
  type?: string | undefined;
  /** The clock; defaults to now. */
  now?: Date | undefined;
}

/**
 * A connection's usage read: its pace and the entries it was decided from.
 *
 * @remarks
 * The entries are returned for logging and the sending status; callers act on `pace` and
 * `waitUntil` only.
 */
export interface ConnectionUsage extends MetaUsageDecision {
  /** The matching entries; `[]` when none is kept — then the pace is `normal`. */
  entries: ChannelConnectionUsageEntry[];
}

/**
 * The usage service of the channel connection (routes-final § 1 MC19, MCC12).
 *
 * @remarks
 * Built by {@link createChannelConnectionUsageService}; ROUTE row R3 wires it into the app
 * container over the Postgres store.
 */
export interface ChannelConnectionUsageService {
  /**
   * The pace before a Meta call on this connection: the strictest of its matching entries
   * (`wait` over `slow` over `normal`) — every channel's engine calls it (MC19).
   */
  readConnectionUsage(options: ReadConnectionUsageOptions): Promise<ConnectionUsage>;
  /** The recorder the Meta client calls with each answer's usage on this connection. */
  buildUsageRecorder(target: ChannelConnectionUsageTarget): MetaGraphUsageRecorder;
}

/** The order of strictness of a pace. */
const PACE_STRICTNESS = { normal: 0, slow: 1, wait: 2 } as const;

/** The stricter of two decisions; between two waits, the later end. */
function stricterDecision({
  first,
  second,
}: {
  first: MetaUsageDecision;
  second: MetaUsageDecision;
}): MetaUsageDecision {
  if (PACE_STRICTNESS[first.pace] !== PACE_STRICTNESS[second.pace]) {
    return PACE_STRICTNESS[first.pace] > PACE_STRICTNESS[second.pace] ? first : second;
  }
  if (first.pace === 'wait' && second.waitUntil !== null && first.waitUntil !== null) {
    return second.waitUntil.getTime() > first.waitUntil.getTime() ? second : first;
  }
  return first;
}

/**
 * Builds the channel connection's usage service over its Postgres store (P32) and the Redis copy
 * (`channel-connection-usage.cache.ts`, P5).
 *
 * @remarks
 * - **Algorithm:** `readConnectionUsage` reads the cache (keyed by the verified organization scope
 *   and the connection), else the store, populates the cache, keeps the entries matching
 *   `assetId` / `type`, and returns the strictest pace ({@link decideMetaUsagePace} per entry).
 *   `buildUsageRecorder` returns the function the Meta client calls after each answer: it writes
 *   the business entries through the store (its own unit, never a send's transaction; the store
 *   keeps the newer reading per asset and type), tombstones the cache after the write, and writes
 *   the app-level usage through `appUsageStore` when one is given.
 * - **Failure modes:** a cache failure falls through to Postgres (fail open); a store read failure
 *   propagates (the caller decides — a sender retries); a recorder failure is logged and swallowed
 *   (the Meta client never fails a call on it).
 * - **Side effects:** Redis reads/writes; the store's writes.
 * - **Notes:** ROUTE row R3 builds the Postgres store on the connection table and wires this
 *   service into the app container; R18 adds the app-level store on `sending_states`; R20 and R42
 *   pass a recorder to every send and call `readConnectionUsage` at each lane turn (SN23).
 */
export function createChannelConnectionUsageService({
  usageStore,
  appUsageStore,
}: {
  usageStore: ChannelConnectionUsageStore;
  appUsageStore?: MetaAppUsageStore | undefined;
}): ChannelConnectionUsageService {
  async function readEntries(
    target: ChannelConnectionUsageTarget,
  ): Promise<ChannelConnectionUsageEntry[]> {
    const cacheKey = {
      organizationPublicId: target.scope.organizationPublicId,
      channelConnectionPublicId: target.channelConnectionPublicId,
    };
    const cached = await getCachedChannelConnectionUsage(cacheKey);
    if (cached !== null) return cached;
    const entries = await usageStore.readConnectionUsageEntries(target);
    await setCachedChannelConnectionUsage({ ...cacheKey, entries });
    return entries;
  }

  return {
    async readConnectionUsage({ assetId, type, now = new Date(), ...target }) {
      const entries = (await readEntries(target)).filter(
        (entry) =>
          (assetId === undefined || entry.assetId === assetId) &&
          (type === undefined || entry.type === type),
      );
      const decision = entries.reduce<MetaUsageDecision>(
        (strictest, entry) =>
          stricterDecision({
            first: strictest,
            second: decideMetaUsagePace({
              usagePercent: entry.usagePercent,
              waitUntil: entry.waitUntil,
              now,
            }),
          }),
        { pace: 'normal', waitUntil: null },
      );
      return { ...decision, entries };
    },

    buildUsageRecorder(target) {
      return async (reading) => {
        try {
          if (reading.businessUseCases.length > 0) {
            await usageStore.writeConnectionUsageEntries({
              ...target,
              entries: reading.businessUseCases.map((entry) => ({
                ...entry,
                readAt: reading.readAt,
              })),
            });
            await invalidateCachedChannelConnectionUsage({
              organizationPublicId: target.scope.organizationPublicId,
              channelConnectionPublicId: target.channelConnectionPublicId,
            });
          }
          if (reading.appUsagePercent !== null && appUsageStore !== undefined) {
            await appUsageStore.writeAppUsage({
              usagePercent: reading.appUsagePercent,
              readAt: reading.readAt,
            });
          }
        } catch (error) {
          logger.warn(
            {
              event: 'channel_connection.usage.record_failed',
              channel_connection_public_id: target.channelConnectionPublicId,
              error_name: (error as Error | null)?.name,
            },
            'Meta usage could not be written',
          );
        }
      };
    },
  };
}
