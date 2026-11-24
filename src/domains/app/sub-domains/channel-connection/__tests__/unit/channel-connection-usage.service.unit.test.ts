import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelConnectionUsageEntry,
  ChannelConnectionUsageStore,
  ChannelConnectionUsageTarget,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-usage.types.js';
import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import {
  CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS,
  CHANNEL_CONNECTION_USAGE_CACHE_TTL_SECONDS,
} from '@/shared/constants/ttl.constants.js';

/** An in-memory Redis that honours `NX` — a stub that always accepts would hide a DEL-based bug. */
const redisValues = new Map<string, string>();
const redisGet = vi.fn(async (key: string) => redisValues.get(key) ?? null);
const redisSet = vi.fn(async (key: string, value: string, ...flags: unknown[]) => {
  if (flags.includes('NX') && redisValues.has(key)) return null;
  redisValues.set(key, value);
  return 'OK';
});

vi.mock('@/infrastructure/cache/redis.client.js', () => ({
  redisConnection: {
    get: (key: string) => redisGet(key),
    set: (key: string, value: string, ...flags: unknown[]) => redisSet(key, value, ...flags),
  },
}));

const recordReadCacheRequest = vi.fn();
vi.mock('@/infrastructure/observability/metrics/prometheus-metrics.js', () => ({
  recordReadCacheRequest: (...args: unknown[]) => recordReadCacheRequest(...args),
}));

const { createChannelConnectionUsageService } = await import(
  '@/domains/app/sub-domains/channel-connection/channel-connection-usage.service.js'
);

const NOW = new Date('2026-11-24T10:00:00.000Z');
const ORGANIZATION = 'org_aaaaaaaaaaaaaaaaaaaaa';
const OTHER_ORGANIZATION = 'org_bbbbbbbbbbbbbbbbbbbbb';
const CONNECTION = 'chc_ccccccccccccccccccccc';

function targetOf(organizationPublicId: string): ChannelConnectionUsageTarget {
  return {
    scope: { organizationPublicId } as OrganizationPrincipalDatabaseScope,
    channelConnectionPublicId: CONNECTION,
  };
}

function entry(overrides: Partial<ChannelConnectionUsageEntry>): ChannelConnectionUsageEntry {
  return {
    assetId: '1784001',
    type: 'instagram',
    usagePercent: 10,
    waitUntil: null,
    readAt: new Date(NOW.getTime() - 1000),
    ...overrides,
  };
}

/** A Postgres stand-in keyed by organization and connection (R3 builds the real one). */
function buildStore() {
  const rows = new Map<string, ChannelConnectionUsageEntry[]>();
  const keyOf = (target: ChannelConnectionUsageTarget) =>
    `${target.scope.organizationPublicId}:${target.channelConnectionPublicId}`;
  const store: ChannelConnectionUsageStore = {
    readConnectionUsageEntries: vi.fn(async (target) => rows.get(keyOf(target)) ?? []),
    writeConnectionUsageEntries: vi.fn(async ({ entries, ...target }) => {
      rows.set(keyOf(target), [...entries]);
    }),
  };
  return { store, rows, keyOf };
}

beforeEach(() => {
  redisValues.clear();
  vi.clearAllMocks();
});

describe('readConnectionUsage — the pace before a Meta call', () => {
  it('is normal with no usage kept', async () => {
    const { store } = buildStore();
    const service = createChannelConnectionUsageService({ usageStore: store });
    await expect(
      service.readConnectionUsage({ ...targetOf(ORGANIZATION), now: NOW }),
    ).resolves.toEqual({ pace: 'normal', waitUntil: null, entries: [] });
  });

  it('slows at 80 % and waits at 95 % until the time Meta gave — the strictest entry wins', async () => {
    const { store, rows, keyOf } = buildStore();
    const waitUntil = new Date(NOW.getTime() + 15 * 60_000);
    rows.set(keyOf(targetOf(ORGANIZATION)), [
      entry({ usagePercent: 80 }),
      entry({ assetId: '1784002', usagePercent: 96, waitUntil }),
    ]);
    const service = createChannelConnectionUsageService({ usageStore: store });

    const all = await service.readConnectionUsage({ ...targetOf(ORGANIZATION), now: NOW });
    expect(all).toMatchObject({ pace: 'wait', waitUntil });

    const oneAsset = await service.readConnectionUsage({
      ...targetOf(ORGANIZATION),
      assetId: '1784001',
      now: NOW,
    });
    expect(oneAsset).toMatchObject({ pace: 'slow', waitUntil: null });
  });

  it('filters by use-case type (S13: per connection, asset and type)', async () => {
    const { store, rows, keyOf } = buildStore();
    rows.set(keyOf(targetOf(ORGANIZATION)), [
      entry({
        type: 'ads_management',
        usagePercent: 99,
        waitUntil: new Date(NOW.getTime() + 60_000),
      }),
      entry({ type: 'instagram', usagePercent: 20 }),
    ]);
    const service = createChannelConnectionUsageService({ usageStore: store });
    const usage = await service.readConnectionUsage({
      ...targetOf(ORGANIZATION),
      type: 'instagram',
      now: NOW,
    });
    expect(usage.pace).toBe('normal');
  });
});

describe('the Redis copy (be-read-cache-guard)', () => {
  it('a hit serves a value Postgres has since changed — the cache is read', async () => {
    const { store, rows, keyOf } = buildStore();
    rows.set(keyOf(targetOf(ORGANIZATION)), [entry({ usagePercent: 10 })]);
    const service = createChannelConnectionUsageService({ usageStore: store });
    await service.readConnectionUsage({ ...targetOf(ORGANIZATION), now: NOW });

    rows.set(keyOf(targetOf(ORGANIZATION)), [entry({ usagePercent: 90 })]);
    const usage = await service.readConnectionUsage({ ...targetOf(ORGANIZATION), now: NOW });

    expect(usage.entries[0]?.usagePercent).toBe(10);
    expect(store.readConnectionUsageEntries).toHaveBeenCalledTimes(1);
    expect(redisSet).toHaveBeenCalledWith(
      `app:meta_usage:${ORGANIZATION}:${CONNECTION}`,
      expect.any(String),
      'EX',
      CHANNEL_CONNECTION_USAGE_CACHE_TTL_SECONDS,
      'NX',
    );
  });

  it('the usage write (the recorder) tombstones the entry, so the next read sees it', async () => {
    const { store } = buildStore();
    const service = createChannelConnectionUsageService({ usageStore: store });
    await service.readConnectionUsage({ ...targetOf(ORGANIZATION), now: NOW });

    const record = service.buildUsageRecorder(targetOf(ORGANIZATION));
    await record({
      readAt: NOW,
      appUsagePercent: null,
      businessUseCases: [
        { assetId: '1784001', type: 'instagram', usagePercent: 85, waitUntil: null },
      ],
    });

    expect(store.writeConnectionUsageEntries).toHaveBeenCalledWith({
      ...targetOf(ORGANIZATION),
      entries: [
        { assetId: '1784001', type: 'instagram', usagePercent: 85, waitUntil: null, readAt: NOW },
      ],
    });
    expect(redisSet).toHaveBeenCalledWith(
      `app:meta_usage:${ORGANIZATION}:${CONNECTION}`,
      expect.any(String),
      'EX',
      CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS,
    );
    const usage = await service.readConnectionUsage({ ...targetOf(ORGANIZATION), now: NOW });
    expect(usage.pace).toBe('slow');
  });

  it('keeps two organizations apart with both warm', async () => {
    const { store, rows, keyOf } = buildStore();
    rows.set(keyOf(targetOf(ORGANIZATION)), [entry({ usagePercent: 10 })]);
    rows.set(keyOf(targetOf(OTHER_ORGANIZATION)), [entry({ usagePercent: 90 })]);
    const service = createChannelConnectionUsageService({ usageStore: store });
    for (let round = 0; round < 2; round += 1) {
      const mine = await service.readConnectionUsage({ ...targetOf(ORGANIZATION), now: NOW });
      const theirs = await service.readConnectionUsage({
        ...targetOf(OTHER_ORGANIZATION),
        now: NOW,
      });
      expect(mine.entries[0]?.usagePercent).toBe(10);
      expect(theirs.entries[0]?.usagePercent).toBe(90);
    }
  });

  it('falls back to Postgres when Redis is down — read and populate both fail', async () => {
    redisGet.mockRejectedValueOnce(new Error('redis down'));
    redisSet.mockRejectedValueOnce(new Error('redis down'));
    const { store, rows, keyOf } = buildStore();
    rows.set(keyOf(targetOf(ORGANIZATION)), [entry({ usagePercent: 81 })]);
    const service = createChannelConnectionUsageService({ usageStore: store });
    await expect(
      service.readConnectionUsage({ ...targetOf(ORGANIZATION), now: NOW }),
    ).resolves.toMatchObject({ pace: 'slow' });
  });

  it('treats a payload it did not write as a miss', async () => {
    redisValues.set(`app:meta_usage:${ORGANIZATION}:${CONNECTION}`, '[{"asset_id":1}]');
    const { store } = buildStore();
    const service = createChannelConnectionUsageService({ usageStore: store });
    await service.readConnectionUsage({ ...targetOf(ORGANIZATION), now: NOW });
    expect(store.readConnectionUsageEntries).toHaveBeenCalledOnce();
  });
});

describe('buildUsageRecorder', () => {
  it('writes the app-level usage once through its own store (S13)', async () => {
    const { store } = buildStore();
    const appUsageStore = { writeAppUsage: vi.fn(async () => undefined) };
    const service = createChannelConnectionUsageService({ usageStore: store, appUsageStore });
    await service.buildUsageRecorder(targetOf(ORGANIZATION))({
      readAt: NOW,
      appUsagePercent: 42,
      businessUseCases: [],
    });
    expect(appUsageStore.writeAppUsage).toHaveBeenCalledWith({ usagePercent: 42, readAt: NOW });
    expect(store.writeConnectionUsageEntries).not.toHaveBeenCalled();
  });

  it('never throws when the store fails', async () => {
    const { store } = buildStore();
    vi.mocked(store.writeConnectionUsageEntries).mockRejectedValueOnce(new Error('db down'));
    const service = createChannelConnectionUsageService({ usageStore: store });
    await expect(
      service.buildUsageRecorder(targetOf(ORGANIZATION))({
        readAt: NOW,
        appUsagePercent: null,
        businessUseCases: [{ assetId: 'a', type: 'instagram', usagePercent: 1, waitUntil: null }],
      }),
    ).resolves.toBeUndefined();
  });
});
