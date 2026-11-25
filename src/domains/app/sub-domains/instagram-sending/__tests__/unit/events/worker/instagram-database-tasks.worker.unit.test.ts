import { describe, expect, it, vi } from 'vitest';

const { createInstagramTaskQueueWorkerMock } = vi.hoisted(() => ({
  createInstagramTaskQueueWorkerMock: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('@/domains/app/sub-domains/instagram-sending/workers/instagram-tasks.worker.js', () => ({
  createInstagramTaskQueueWorker: createInstagramTaskQueueWorkerMock,
}));
vi.mock('@/shared/config/worker-concurrency.util.js', () => ({
  getWorkerConcurrencyInstagramDatabaseTasks: () => 7,
}));

import { createInstagramDatabaseTasksWorker } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-database-tasks.worker.js';
import { INSTAGRAM_DATABASE_TASK_QUEUE } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-tasks.processor.js';
import { instagramDatabaseTaskJobDataSchema } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-database-tasks.job.schema.js';

/**
 * The database-heavy task worker (S19, ROUTE row R46): the shared task-queue worker built for
 * `instagram-database-tasks` — its queue kind (no Meta call, the per-organization cap), its job
 * schema and its own concurrency setting.
 */
describe('instagram-database-tasks.worker', () => {
  it('builds the shared task worker for the database-heavy queue with its concurrency', () => {
    const services = { work: {} } as never;

    const handle = createInstagramDatabaseTasksWorker(services);

    expect(handle).toBeDefined();
    expect(createInstagramTaskQueueWorkerMock).toHaveBeenCalledOnce();
    expect(createInstagramTaskQueueWorkerMock).toHaveBeenCalledWith({
      queue: INSTAGRAM_DATABASE_TASK_QUEUE,
      jobDataSchema: instagramDatabaseTaskJobDataSchema,
      concurrency: 7,
      services,
    });
    expect(INSTAGRAM_DATABASE_TASK_QUEUE.callsMeta).toBe(false);
  });
});
