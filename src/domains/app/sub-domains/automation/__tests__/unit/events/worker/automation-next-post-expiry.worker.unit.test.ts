import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The "next post" expiry's BullMQ worker (AU15, AUC8): queue, concurrency, processor, stall log. */

const workerState = vi.hoisted(() => ({
  queueName: undefined as string | undefined,
  processor: undefined as (() => Promise<unknown>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  onHandlers: {} as Record<string, (...args: unknown[]) => void>,
}));

const runExpiryJobMock = vi.hoisted(() => vi.fn());

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(function WorkerMock(queueName, processor, options) {
    workerState.queueName = queueName;
    workerState.processor = processor;
    workerState.options = options;
    return {
      on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        workerState.onHandlers[event] = handler;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock('@/infrastructure/queue/connection.js', () => ({
  getBullMQKeyPrefix: () => 'test:bull',
  getBullMQConnectionOptions: () => ({ host: 'redis.test' }),
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-options.js', () => ({
  getRetentionWorkerOptions: () => ({
    lockDuration: 120_000,
    stalledInterval: 30_000,
    maxStalledCount: 1,
  }),
  RETENTION_WORKER_CONCURRENCY: 1,
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-close.util.js', () => ({
  buildWorkerHandle: ({ worker, queueName }: { worker: unknown; queueName: string }) => ({
    worker,
    queueName,
    close: async () => undefined,
  }),
}));

vi.mock(
  '@/domains/app/sub-domains/automation/workers/automation-next-post-expiry.processor.js',
  () => ({
    runAutomationNextPostExpiryJob: (...args: unknown[]) => runExpiryJobMock(...args),
  }),
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const WORKER_MODULE =
  '@/domains/app/sub-domains/automation/workers/automation-next-post-expiry.worker.js';

describe('automation-next-post-expiry.worker', () => {
  beforeEach(() => {
    workerState.queueName = undefined;
    workerState.processor = undefined;
    workerState.options = undefined;
    workerState.onHandlers = {};
    runExpiryJobMock.mockReset();
    runExpiryJobMock.mockResolvedValue({ scanned: 2, expired: 2, failedOrganizationCount: 0 });
  });

  it('creates the Worker on the automation-next-post-expiry queue with concurrency 1', async () => {
    const { createAutomationNextPostExpiryWorker } = await import(WORKER_MODULE);

    const handle = createAutomationNextPostExpiryWorker();

    expect(handle.queueName).toBe('automation-next-post-expiry');
    expect(workerState.queueName).toBe('automation-next-post-expiry');
    expect(workerState.options).toEqual(expect.objectContaining({ concurrency: 1 }));
  });

  it('runs the expiry for every scheduled job and returns its counts', async () => {
    const { createAutomationNextPostExpiryWorker } = await import(WORKER_MODULE);

    createAutomationNextPostExpiryWorker();
    const result = await workerState.processor?.();

    expect(runExpiryJobMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ scanned: 2, expired: 2, failedOrganizationCount: 0 });
  });

  it('logs a stalled warning with the queue name and job id', async () => {
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const { createAutomationNextPostExpiryWorker } = await import(WORKER_MODULE);

    createAutomationNextPostExpiryWorker();
    workerState.onHandlers.stalled?.('job-expiry-001');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { jobId: 'job-expiry-001', queue: 'automation-next-post-expiry' },
      'automation-next-post-expiry.stalled',
    );
  });

  it('propagates a failed expiry to BullMQ', async () => {
    runExpiryJobMock.mockRejectedValue(new Error('expiry failed'));
    const { createAutomationNextPostExpiryWorker } = await import(WORKER_MODULE);

    createAutomationNextPostExpiryWorker();

    await expect(workerState.processor?.()).rejects.toThrow('expiry failed');
  });
});
