import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The 7-day wait check's BullMQ worker (AU25, AUC12): queue, concurrency, the run service handed to the processor, stall log. */

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
  '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-wait-expiry.processor.js',
  () => ({
    runAutomationRunWaitExpiryJob: (...args: unknown[]) => runJobMock(...args),
  }),
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const WORKER_MODULE =
  '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-wait-expiry.worker.js';

const runService = { cancelExpiredWaitingRuns: vi.fn() };

describe('automation-run-wait-expiry.worker', () => {
  beforeEach(() => {
    workerState.queueName = undefined;
    workerState.processor = undefined;
    workerState.options = undefined;
    workerState.onHandlers = {};
    runJobMock.mockReset();
    runJobMock.mockResolvedValue({ scanned: 2, cancelled: 2, failedOrganizationCount: 0 });
  });

  it('creates the Worker on the automation-run-wait-expiry queue with concurrency 1', async () => {
    const { createAutomationRunWaitExpiryWorker } = await import(WORKER_MODULE);

    const handle = createAutomationRunWaitExpiryWorker({ runService });

    expect(handle.queueName).toBe('automation-run-wait-expiry');
    expect(workerState.queueName).toBe('automation-run-wait-expiry');
    expect(workerState.options).toEqual(expect.objectContaining({ concurrency: 1 }));
  });

  it('runs the check with the run service for every scheduled job and returns its counts', async () => {
    const { createAutomationRunWaitExpiryWorker } = await import(WORKER_MODULE);

    createAutomationRunWaitExpiryWorker({ runService });
    const result = await workerState.processor?.();

    expect(runJobMock).toHaveBeenCalledOnce();
    expect(runJobMock).toHaveBeenCalledWith({ runService });
    expect(result).toEqual({ scanned: 2, cancelled: 2, failedOrganizationCount: 0 });
  });

  it('logs a stalled warning with the queue name and job id', async () => {
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const { createAutomationRunWaitExpiryWorker } = await import(WORKER_MODULE);

    createAutomationRunWaitExpiryWorker({ runService });
    workerState.onHandlers.stalled?.('job-automation-run-wait-expiry-001');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { jobId: 'job-automation-run-wait-expiry-001', queue: 'automation-run-wait-expiry' },
      'automation-run-wait-expiry.stalled',
    );
  });

  it('propagates a failed run to BullMQ', async () => {
    runJobMock.mockRejectedValue(new Error('automation-run-wait-expiry failed'));
    const { createAutomationRunWaitExpiryWorker } = await import(WORKER_MODULE);

    createAutomationRunWaitExpiryWorker({ runService });

    await expect(workerState.processor?.()).rejects.toThrow('automation-run-wait-expiry failed');
  });
});
