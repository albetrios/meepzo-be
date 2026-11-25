import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/infrastructure/queue/dlq/poison-job.util.js', () => ({
  parseJobDataOrDeadLetter: async ({ schema, job }: { schema: z.ZodType; job: Job }) => {
    const parsed = schema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('bullmq.invalid_job_payload');
    return parsed.data;
  },
}));

import { WorkerDatabaseSlotLimiter } from '@/infrastructure/queue/worker-runtime/worker-database-slot-limiter.js';
import type { InstagramSendTicketContext } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { runInstagramTicket } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-ticket.processor.js';

/** A BullMQ job stand-in: its id, name, data and the move a ticket that goes back makes. */
function fakeJob({ name = 'job', data = {} }: { name?: string; data?: unknown } = {}) {
  return {
    id: 'ticket-1',
    name,
    data,
    moveToDelayed: vi.fn(async () => {}),
  } as unknown as Job & { moveToDelayed: ReturnType<typeof vi.fn> };
}

const allowed = { mayTakeTickets: vi.fn(async () => true) };
const refused = { mayTakeTickets: vi.fn(async () => false) };

describe('Instagram send and task tickets (SN2, SN7, SN24 — ROUTE row R37)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a server that may not take tickets puts the ticket back a minute later, no try used (AC-17.21)', async () => {
    const job = fakeJob();
    const work = vi.fn(async () => {});
    const before = Date.now();
    await expect(
      runInstagramTicket({ job, token: 'lock', queueName: 'q', gate: refused, work }),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(work).not.toHaveBeenCalled();
    const [delayedUntil] = job.moveToDelayed.mock.calls[0] as [number, string];
    expect(delayedUntil).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('runs every unit of work in a slot; with none free in time the ticket goes back (AC-17.20)', async () => {
    const limiter = new WorkerDatabaseSlotLimiter('test-ticket', 1);
    let release: () => void = () => {};
    const holder = limiter.runInSlot({
      callback: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const job = fakeJob();
    await expect(
      runInstagramTicket({
        job,
        token: 'lock',
        queueName: 'q',
        gate: allowed,
        limiter,
        work: (context: InstagramSendTicketContext) =>
          context.runInDatabaseSlot(async () => {
            throw new Error('must not run without a slot');
          }),
      }),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(limiter.inUse).toBe(1);
    release();
    await holder;

    // A free slot: the unit of work runs, and the slot is back afterwards.
    const ran = vi.fn(async () => {});
    await runInstagramTicket({
      job: fakeJob(),
      token: 'lock',
      queueName: 'q',
      gate: allowed,
      limiter,
      work: (context) => context.runInDatabaseSlot(ran),
    });
    expect(ran).toHaveBeenCalledTimes(1);
    expect(limiter.inUse).toBe(0);
  }, 10_000);
});
