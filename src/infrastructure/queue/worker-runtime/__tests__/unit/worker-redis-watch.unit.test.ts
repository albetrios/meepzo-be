import { describe, expect, it, vi } from 'vitest';
import {
  WORKER_REDIS_MARKER_KEY,
  WORKER_REDIS_REBUILD_LOCK_KEY,
  runWorkerRedisWatchTick,
} from '@/infrastructure/queue/worker-runtime/worker-redis-watch.js';

/** A tiny in-memory Redis with the four commands the watch uses. */
function fakeRedis({ isDown = false }: { isDown?: boolean } = {}) {
  const store = new Map<string, string>();
  const client = {
    store,
    isDown,
    get: vi.fn(async (key: string) => {
      if (client.isDown) throw new Error('connection refused');
      return store.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string, ...flags: (string | number)[]) => {
      if (client.isDown) throw new Error('connection refused');
      if (flags.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
  return client;
}

/**
 * The "Redis lost" watch (feat-instagram-dm-sending WC-21, SN10, P7 — ROUTE row R48): each worker
 * process rebuilds the schedules and the quick counts from Postgres under one lock when Redis comes
 * back empty or new, and does nothing while Redis is intact or unreachable.
 */
describe('runWorkerRedisWatchTick', () => {
  it('does nothing while the marker is there', async () => {
    const redis = fakeRedis();
    redis.store.set(WORKER_REDIS_MARKER_KEY, 'marker');
    const rebuildSchedules = vi.fn(async () => {});
    expect(
      await runWorkerRedisWatchTick({ clients: [redis as never], rebuildSchedules, steps: [] }),
    ).toBe('intact');
    expect(rebuildSchedules).not.toHaveBeenCalled();
  });

  it('rebuilds once under the lock when Redis came back empty, then writes a fresh marker', async () => {
    const redis = fakeRedis();
    const order: string[] = [];
    const rebuildSchedules = vi.fn(async () => {
      order.push('schedules');
    });
    const step = { name: 'gate-one', run: vi.fn(async () => void order.push('gate-one')) };
    expect(
      await runWorkerRedisWatchTick({ clients: [redis as never], rebuildSchedules, steps: [step] }),
    ).toBe('rebuilt');
    expect(order).toEqual(['schedules', 'gate-one']);
    expect(redis.store.get(WORKER_REDIS_MARKER_KEY)).toBeDefined();
    expect(redis.store.has(WORKER_REDIS_REBUILD_LOCK_KEY)).toBe(false);
    // The next tick sees the marker: nothing again.
    expect(
      await runWorkerRedisWatchTick({ clients: [redis as never], rebuildSchedules, steps: [step] }),
    ).toBe('intact');
    expect(rebuildSchedules).toHaveBeenCalledTimes(1);
  });

  it('leaves the rebuild to the process holding the lock', async () => {
    const redis = fakeRedis();
    redis.store.set(WORKER_REDIS_REBUILD_LOCK_KEY, 'another-process');
    const rebuildSchedules = vi.fn(async () => {});
    expect(
      await runWorkerRedisWatchTick({ clients: [redis as never], rebuildSchedules, steps: [] }),
    ).toBe('rebuilt_elsewhere');
    expect(rebuildSchedules).not.toHaveBeenCalled();
  });

  it('a failed step writes no marker and frees the lock, so the next tick tries again', async () => {
    const redis = fakeRedis();
    const failing = {
      name: 'gate-one',
      run: vi.fn(async () => {
        throw new Error('postgres down');
      }),
    };
    expect(
      await runWorkerRedisWatchTick({
        clients: [redis as never],
        rebuildSchedules: async () => {},
        steps: [failing],
      }),
    ).toBe('unreachable');
    expect(redis.store.has(WORKER_REDIS_MARKER_KEY)).toBe(false);
    expect(redis.store.has(WORKER_REDIS_REBUILD_LOCK_KEY)).toBe(false);
  });

  it('waits while Redis does not answer', async () => {
    const redis = fakeRedis({ isDown: true });
    const rebuildSchedules = vi.fn(async () => {});
    expect(
      await runWorkerRedisWatchTick({ clients: [redis as never], rebuildSchedules, steps: [] }),
    ).toBe('unreachable');
    expect(rebuildSchedules).not.toHaveBeenCalled();
  });
});
