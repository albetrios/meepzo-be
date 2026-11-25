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

import type { InstagramTaskHandler } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import {
  INSTAGRAM_DATABASE_TASK_QUEUE,
  INSTAGRAM_META_TASK_QUEUE,
  InstagramTaskOrganizationCap,
  processInstagramTaskTicket,
} from '@/domains/app/sub-domains/instagram-sending/workers/instagram-tasks.processor.js';

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

describe('Instagram tasks on instagram-tasks and instagram-database-tasks (SN2, S19 — ROUTE rows R37, R46)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        queue: INSTAGRAM_DATABASE_TASK_QUEUE,
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
          queue: INSTAGRAM_DATABASE_TASK_QUEUE,
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('refuses a task on the queue of the other kind: the split holds (S19, R46)', async () => {
      const metaTask = handler(true);
      const databaseTask = handler(false);
      const services = {
        sendingGate: allowed,
        taskHandlers: { 'meta-task': metaTask, 'database-task': databaseTask },
      };
      await expect(
        processInstagramTaskTicket({
          job: fakeJob({ name: 'database-task', data: jobData }),
          token: 'lock',
          jobData,
          services,
          queue: INSTAGRAM_META_TASK_QUEUE,
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(
        processInstagramTaskTicket({
          job: fakeJob({ name: 'meta-task', data: jobData }),
          token: 'lock',
          jobData,
          services,
          queue: INSTAGRAM_DATABASE_TASK_QUEUE,
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(metaTask.run).not.toHaveBeenCalled();
      expect(databaseTask.run).not.toHaveBeenCalled();
    });

    it("holds an organization at its cap: its next task goes back, no try used; another organization's runs (S19, R46)", async () => {
      const databaseTask = handler(false);
      let release: () => void = () => {};
      databaseTask.run.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const services = {
        sendingGate: allowed,
        taskHandlers: { 'database-task': databaseTask },
        organizationCap: new InstagramTaskOrganizationCap(1),
      };
      const first = processInstagramTaskTicket({
        job: fakeJob({ name: 'database-task', data: jobData }),
        token: 'lock',
        jobData,
        services,
        queue: INSTAGRAM_DATABASE_TASK_QUEUE,
      });
      await vi.waitFor(() => expect(databaseTask.run).toHaveBeenCalledTimes(1));

      const heldJob = fakeJob({ name: 'database-task', data: jobData });
      await expect(
        processInstagramTaskTicket({
          job: heldJob,
          token: 'lock',
          jobData,
          services,
          queue: INSTAGRAM_DATABASE_TASK_QUEUE,
        }),
      ).rejects.toBeInstanceOf(DelayedError);
      expect(heldJob.moveToDelayed).toHaveBeenCalledTimes(1);
      expect(databaseTask.run).toHaveBeenCalledTimes(1);

      const otherData = { ...jobData, organizationPublicId: 'org_bbbbbbbbbbbbbbbbbbbbb' };
      await processInstagramTaskTicket({
        job: fakeJob({ name: 'database-task', data: otherData }),
        token: 'lock',
        jobData: otherData,
        services,
        queue: INSTAGRAM_DATABASE_TASK_QUEUE,
      });
      expect(databaseTask.run).toHaveBeenCalledTimes(2);

      release();
      await first;
      // The place came back: the organization's next task runs.
      await processInstagramTaskTicket({
        job: fakeJob({ name: 'database-task', data: jobData }),
        token: 'lock',
        jobData,
        services,
        queue: INSTAGRAM_DATABASE_TASK_QUEUE,
      });
      expect(databaseTask.run).toHaveBeenCalledTimes(3);
    });
  });
});
