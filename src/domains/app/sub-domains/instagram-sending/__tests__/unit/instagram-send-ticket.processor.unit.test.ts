import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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
import type {
  InstagramSendTicketContext,
  InstagramTaskHandler,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { runInstagramTicket } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-ticket.processor.js';
import { processInstagramSendSlowTicket } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-slow.processor.js';
import { processInstagramSendFastTicket } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-fast.processor.js';
import { processInstagramTaskTicket } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-tasks.processor.js';

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

const slowTicket = {
  organizationPublicId: 'org_aaaaaaaaaaaaaaaaaaaaa',
  channelAccountPublicId: 'cha_aaaaaaaaaaaaaaaaaaaaa',
  lane: 'slow' as const,
  turnNumber: 3,
};

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

  it('a lane turn with no work built yet is finished without asking the gate or touching a row', async () => {
    await processInstagramSendSlowTicket({
      job: fakeJob(),
      token: 'lock',
      jobData: slowTicket,
      services: { sendingGate: refused, laneTurn: null },
    });
    expect(refused.mayTakeTickets).not.toHaveBeenCalled();
  });

  it('hands a lane turn to its work with the ticket and a slot context', async () => {
    const workLaneTurn = vi.fn(async () => {});
    await processInstagramSendSlowTicket({
      job: fakeJob(),
      token: 'lock',
      jobData: slowTicket,
      services: { sendingGate: allowed, laneTurn: { workLaneTurn } },
    });
    expect(allowed.mayTakeTickets).toHaveBeenCalledTimes(1);
    expect(workLaneTurn).toHaveBeenCalledWith({
      ticket: slowTicket,
      scope: expect.objectContaining({ organizationPublicId: slowTicket.organizationPublicId }),
      context: {
        jobId: 'ticket-1',
        runInDatabaseSlot: expect.any(Function),
        returnTicket: expect.any(Function),
      },
    });
  });

  it('a fast message with no work built yet is finished; with work it is sent through it', async () => {
    const jobData = {
      organizationPublicId: 'org_aaaaaaaaaaaaaaaaaaaaa',
      channelAccountPublicId: 'cha_aaaaaaaaaaaaaaaaaaaaa',
      instagramMessagePublicId: 'igm_aaaaaaaaaaaaaaaaaaaaa',
      automationRunStartedAt: '2026-11-25T10:00:00.000Z',
      tries: 0,
    };
    await processInstagramSendFastTicket({
      job: fakeJob(),
      token: 'lock',
      jobData,
      services: { sendingGate: allowed, fastMessage: null },
    });
    expect(allowed.mayTakeTickets).not.toHaveBeenCalled();
    const sendFastMessage = vi.fn(async () => {});
    await processInstagramSendFastTicket({
      job: fakeJob(),
      token: 'lock',
      jobData,
      services: { sendingGate: allowed, fastMessage: { sendFastMessage } },
    });
    expect(sendFastMessage).toHaveBeenCalledWith({
      ticket: jobData,
      scope: expect.objectContaining({ organizationPublicId: jobData.organizationPublicId }),
      context: expect.objectContaining({ jobId: 'ticket-1' }),
    });
  });

  describe('tasks', () => {
    const jobData = {
      organizationPublicId: 'org_aaaaaaaaaaaaaaaaaaaaa',
      taskInput: { automationPublicId: 'aut_aaaaaaaaaaaaaaaaaaaaa' },
    };
    const handler = (
      callsMeta: boolean,
    ): InstagramTaskHandler & { run: ReturnType<typeof vi.fn> } => ({
      callsMeta,
      inputSchema: z.object({ automationPublicId: z.string().startsWith('aut_') }),
      run: vi.fn(async () => {}),
    });

    it('a job name with no handler is our fault: dead letter at once', async () => {
      await expect(
        processInstagramTaskTicket({
          job: fakeJob({ name: 'unknown-task', data: jobData }),
          token: 'lock',
          jobData,
          services: { sendingGate: allowed, taskHandlers: {} },
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('a Meta-calling task asks the gate first; a database task does not', async () => {
      const metaTask = handler(true);
      const databaseTask = handler(false);
      const services = {
        sendingGate: refused,
        taskHandlers: { 'meta-task': metaTask, 'database-task': databaseTask },
      };
      await expect(
        processInstagramTaskTicket({
          job: fakeJob({ name: 'meta-task', data: jobData }),
          token: 'lock',
          jobData,
          services,
        }),
      ).rejects.toBeInstanceOf(DelayedError);
      expect(metaTask.run).not.toHaveBeenCalled();

      await processInstagramTaskTicket({
        job: fakeJob({ name: 'database-task', data: jobData }),
        token: 'lock',
        jobData,
        services,
      });
      expect(databaseTask.run).toHaveBeenCalledWith({
        organizationPublicId: jobData.organizationPublicId,
        taskInput: jobData.taskInput,
        context: expect.objectContaining({ jobId: 'ticket-1' }),
      });
    });

    it("validates the task's input with its handler's schema", async () => {
      const badData = { ...jobData, taskInput: { automationPublicId: 'con_wrong' } };
      await expect(
        processInstagramTaskTicket({
          job: fakeJob({ name: 'database-task', data: badData }),
          token: 'lock',
          jobData: badData,
          services: { sendingGate: allowed, taskHandlers: { 'database-task': handler(false) } },
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });
  });
});
