import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Job, Queue, Worker } from 'bullmq';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { getDefaultWorkerOptions } from '@/infrastructure/queue/worker-runtime/worker-options.js';
import {
  runWithDatabaseSlotTicketReturn,
  WorkerDatabaseSlotLimiter,
} from '@/infrastructure/queue/worker-runtime/worker-database-slot-limiter.js';

/**
 * Against real BullMQ and Redis (AC-17.20, P91): with more tickets than database slots, a ticket
 * waits for a slot, and one that gets none in time goes back to the queue — `delayed`, with no try
 * used — and is worked once a slot is free; the slots held never exceed the limiter's size, whatever
 * the worker's job places.
 */
const SLOT_WAIT_MILLISECONDS = 200;
const RETRY_DELAY_MILLISECONDS = 300;

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('Integration: the database limiter puts tickets back (SN24)', () => {
  const connection = getBullMQConnectionOptions();
  let queue: Queue;
  let worker: Worker | null = null;

  beforeEach(async () => {
    queue = new Queue(`test-database-slots-${randomUUID()}`, {
      connection,
      prefix: getBullMQKeyPrefix(),
    });
    await queue.waitUntilReady();
  });

  afterEach(async () => {
    await worker?.close();
    worker = null;
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('never holds more slots than its size; a ticket with no slot in time goes back with no try used', async () => {
    const limiter = new WorkerDatabaseSlotLimiter(`test-${randomUUID()}`, 1);
    let holding = 0;
    let peakHolding = 0;
    const worked: string[] = [];
    worker = new Worker<{ label: string }>(
      queue.name,
      (job: Job<{ label: string }>, token) =>
        runWithDatabaseSlotTicketReturn({
          job,
          token,
          queueName: queue.name,
          retryDelayMilliseconds: RETRY_DELAY_MILLISECONDS,
          callback: () =>
            limiter.runInSlot({
              waitMilliseconds: SLOT_WAIT_MILLISECONDS,
              callback: async () => {
                holding += 1;
                peakHolding = Math.max(peakHolding, holding);
                // The first ticket holds its slot past the others' wait.
                const holdMilliseconds = job.data.label === 'first' ? 600 : 20;
                await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
                holding -= 1;
                worked.push(job.data.label);
              },
            }),
        }),
      { connection, prefix: getBullMQKeyPrefix(), concurrency: 4, ...getDefaultWorkerOptions() },
    );
    await worker.waitUntilReady();

    const first = await queue.add('ticket', { label: 'first' }, { attempts: 1 });
    await waitFor(async () => holding === 1, 5_000);
    const second = await queue.add('ticket', { label: 'second' }, { attempts: 1 });

    // The second ticket found no slot within the wait: it went back, delayed, its one try unspent.
    await waitFor(async () => (await second.getState()) === 'delayed', 5_000);
    expect((await queue.getJob(second.id as string))?.attemptsMade).toBe(0);

    // Once the slot is free it is worked — once, on its one attempt, never failed.
    await waitFor(
      async () =>
        (await first.getState()) === 'completed' && (await second.getState()) === 'completed',
      10_000,
    );
    expect(worked).toEqual(['first', 'second']);
    expect(peakHolding).toBe(1);
    const finished = await queue.getJob(second.id as string);
    expect(finished?.attemptsMade).toBe(1);
    expect(finished?.failedReason).toBeFalsy();
  }, 20_000);
});
