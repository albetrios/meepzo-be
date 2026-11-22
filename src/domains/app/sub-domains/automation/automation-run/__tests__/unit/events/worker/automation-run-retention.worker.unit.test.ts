import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Run retention's BullMQ worker (AU25, AUC12; WC-12): queue, concurrency, processor, stall log. */

const workerState = vi.hoisted(() => ({
  queueName: undefined as string | undefined,
  processor: undefined as (() => Promise<unknown>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  onHandlers: {} as Record<string, (...args: unknown[]) => void>,
}));

const runJobMock = vi.hoisted(() => vi.fn());

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
  '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-retention.processor.js',
  () => ({
    runAutomationRunRetentionJob: (...args: unknown[]) => runJobMock(...args),
  }),
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const WORKER_MODULE =
  '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-retention.worker.js';

describe('automation-run-retention.worker', () => {
  beforeEach(() => {
    workerState.queueName = undefined;
    workerState.processor = undefined;
    workerState.options = undefined;
    workerState.onHandlers = {};
    runJobMock.mockReset();
    runJobMock.mockResolvedValue({ deletedCount: 3, blockedCount: 0, hasMore: false });
  });

  it('creates the Worker on the automation-run-retention queue with concurrency 1', async () => {
    const { createAutomationRunRetentionWorker } = await import(WORKER_MODULE);

    const handle = createAutomationRunRetentionWorker();

    expect(handle.queueName).toBe('automation-run-retention');
    expect(workerState.queueName).toBe('automation-run-retention');
    expect(workerState.options).toEqual(expect.objectContaining({ concurrency: 1 }));
  });

  it('runs the retention for every scheduled job and returns its counts', async () => {
    const { createAutomationRunRetentionWorker } = await import(WORKER_MODULE);

    createAutomationRunRetentionWorker();
    const result = await workerState.processor?.();

    expect(runJobMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ deletedCount: 3, blockedCount: 0, hasMore: false });
  });

  it('logs a stalled warning with the queue name and job id', async () => {
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const { createAutomationRunRetentionWorker } = await import(WORKER_MODULE);

    createAutomationRunRetentionWorker();
    workerState.onHandlers.stalled?.('job-automation-run-retention-001');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { jobId: 'job-automation-run-retention-001', queue: 'automation-run-retention' },
      'automation-run-retention.stalled',
    );
  });

  it('propagates a failed run to BullMQ', async () => {
    runJobMock.mockRejectedValue(new Error('automation-run-retention failed'));
    const { createAutomationRunRetentionWorker } = await import(WORKER_MODULE);

    createAutomationRunRetentionWorker();

    await expect(workerState.processor?.()).rejects.toThrow('automation-run-retention failed');
  });
});
