import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createInstagramTaskQueueWorkerMock } = vi.hoisted(() => ({
  createInstagramTaskQueueWorkerMock: vi.fn(),
}));

vi.mock('@/domains/app/sub-domains/instagram-sending/workers/instagram-tasks.worker.js', () => ({
  createInstagramTaskQueueWorker: createInstagramTaskQueueWorkerMock,
}));

vi.mock('@/shared/config/worker-concurrency.util.js', () => ({
  getWorkerConcurrencyInstagramDatabaseTasks: () => 7,
}));

import { instagramDatabaseTaskJobDataSchema } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-database-tasks.job.schema.js';
import { INSTAGRAM_DATABASE_TASK_QUEUE } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-tasks.processor.js';
import { createInstagramDatabaseTasksWorker } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-database-tasks.worker.js';
import type { InstagramTasksServices } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-tasks.processor.js';

/**
 * The database-heavy task worker (scale review S19, ROUTE row R46): the shared task-queue worker on
 * `instagram-database-tasks`, its own concurrency setting, the queue kind that calls no Meta and
 * caps each organization.
 */
describe('createInstagramDatabaseTasksWorker', () => {
  beforeEach(() => {
    createInstagramTaskQueueWorkerMock.mockReset();
  });

  it('builds the shared task-queue worker for the database-heavy queue with its own concurrency', () => {
    const handle = { close: vi.fn() };
    createInstagramTaskQueueWorkerMock.mockReturnValue(handle);
    const services = { work: {} } as unknown as InstagramTasksServices;

    expect(createInstagramDatabaseTasksWorker(services)).toBe(handle);
    expect(createInstagramTaskQueueWorkerMock).toHaveBeenCalledWith({
      queue: INSTAGRAM_DATABASE_TASK_QUEUE,
      jobDataSchema: instagramDatabaseTaskJobDataSchema,
      concurrency: 7,
      services,
    });
  });

  it('runs a queue whose tasks call no Meta, at most a few of one organization at once', () => {
    expect(INSTAGRAM_DATABASE_TASK_QUEUE.queueName).toBe('instagram-database-tasks');
    expect(INSTAGRAM_DATABASE_TASK_QUEUE.callsMeta).toBe(false);
    expect(INSTAGRAM_DATABASE_TASK_QUEUE.organizationMax).toBeGreaterThan(0);
  });
});
