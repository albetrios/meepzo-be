import { DelayedError, type Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getWorkerDatabaseSlotLimiter,
  runWithDatabaseSlotTicketReturn,
  WorkerDatabaseSlotLimiter,
  WorkerDatabaseSlotUnavailableError,
} from '@/infrastructure/queue/worker-runtime/worker-database-slot-limiter.js';

/** A promise and the function that settles it — a unit of work the test finishes by hand. */
function deferred(): { promise: Promise<void>; finish: () => void } {
  let finish: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

describe('WorkerDatabaseSlotLimiter (SN24, P91)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never lets more units of work hold a slot than its size', async () => {
    const limiter = new WorkerDatabaseSlotLimiter('test-cap', 2);
    let holding = 0;
    let peak = 0;
    const unit = () =>
      limiter.runInSlot({
        waitMilliseconds: 1_000,
        callback: async () => {
          holding += 1;
          peak = Math.max(peak, holding);
          await new Promise((resolve) => setTimeout(resolve, 10));
          holding -= 1;
        },
      });
    await Promise.all(Array.from({ length: 10 }, unit));
    expect(peak).toBe(2);
    expect(limiter.inUse).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  it('hands a released slot to the oldest waiter first', async () => {
    const limiter = new WorkerDatabaseSlotLimiter('test-order', 1);
    const first = deferred();
    const order: string[] = [];
    const holder = limiter.runInSlot({ callback: () => first.promise });
    const second = limiter.runInSlot({ callback: async () => void order.push('second') });
    const third = limiter.runInSlot({ callback: async () => void order.push('third') });
    expect(limiter.waiting).toBe(2);
    first.finish();
    await Promise.all([holder, second, third]);
    expect(order).toEqual(['second', 'third']);
  });

  it('gives up after the wait, leaves the line, and the held slot is unaffected', async () => {
    vi.useFakeTimers();
    const limiter = new WorkerDatabaseSlotLimiter('test-wait', 1);
    const first = deferred();
    const holder = limiter.runInSlot({ callback: () => first.promise });
    const waiting = limiter.runInSlot({ callback: async () => 'never' });
    const outcome = expect(waiting).rejects.toBeInstanceOf(WorkerDatabaseSlotUnavailableError);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(limiter.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(limiter.waiting).toBe(0);
    expect(limiter.inUse).toBe(1);
    first.finish();
    await holder;
    expect(limiter.inUse).toBe(0);
  });

  it('releases the slot when the unit of work fails', async () => {
    const limiter = new WorkerDatabaseSlotLimiter('test-failure', 1);
    await expect(
      limiter.runInSlot({
        callback: async () => {
          throw new Error('database down');
        },
      }),
    ).rejects.toThrow('database down');
    expect(limiter.inUse).toBe(0);
  });

  it('keeps one limiter per name in a process', () => {
    const first = getWorkerDatabaseSlotLimiter({ name: 'test-shared', size: 4 });
    expect(getWorkerDatabaseSlotLimiter({ name: 'test-shared', size: 4 })).toBe(first);
    expect(getWorkerDatabaseSlotLimiter({ name: 'test-shared', size: 9 }).size).toBe(4);
    expect(() => new WorkerDatabaseSlotLimiter('test-zero', 0)).toThrow();
  });
});

describe('runWithDatabaseSlotTicketReturn (AC-17.20)', () => {
  function fakeJob(): Job & { moveToDelayed: ReturnType<typeof vi.fn> } {
    return { id: 'ticket-1', moveToDelayed: vi.fn(async () => {}) } as unknown as Job & {
      moveToDelayed: ReturnType<typeof vi.fn>;
    };
  }

  it('puts the ticket back, delayed, with no try used, when no slot came free', async () => {
    const job = fakeJob();
    const before = Date.now();
    await expect(
      runWithDatabaseSlotTicketReturn({
        job,
        token: 'lock-token',
        queueName: 'instagram-send-slow',
        retryDelayMilliseconds: 5_000,
        callback: async () => {
          throw new WorkerDatabaseSlotUnavailableError('instagram-database', 2_000);
        },
      }),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [delayedUntil, token] = job.moveToDelayed.mock.calls[0] as [number, string];
    expect(token).toBe('lock-token');
    expect(delayedUntil).toBeGreaterThanOrEqual(before + 5_000);
  });

  it('lets every other error through unchanged', async () => {
    const job = fakeJob();
    await expect(
      runWithDatabaseSlotTicketReturn({
        job,
        token: 'lock-token',
        queueName: 'instagram-send-slow',
        callback: async () => {
          throw new Error('meta refused');
        },
      }),
    ).rejects.toThrow('meta refused');
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
