import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The 30-day clean-up's BullMQ worker (WH19, WHC15): queue, concurrency, processor, stall log. */

const workerState = vi.hoisted(() => ({
  queueName: undefined as string | undefined,
  processor: undefined as (() => Promise<unknown>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  onHandlers: {} as Record<string, (...args: unknown[]) => void>,
}));

const runRetentionJobMock = vi.hoisted(() => vi.fn());

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
  '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/workers/instagram-webhook-event-retention.processor.js',
  () => ({
    runInstagramWebhookEventRetentionJob: (...args: unknown[]) => runRetentionJobMock(...args),
  }),
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const WORKER_MODULE =
  '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/workers/instagram-webhook-event-retention.worker.js';

describe('instagram-webhook-event-retention.worker', () => {
  beforeEach(() => {
    workerState.queueName = undefined;
    workerState.processor = undefined;
    workerState.options = undefined;
    workerState.onHandlers = {};
    runRetentionJobMock.mockReset();
    runRetentionJobMock.mockResolvedValue({ deletedCount: 3, blockedCount: 0, hasMore: false });
  });

  it('creates the Worker on the instagram-webhook-event-retention queue with concurrency 1', async () => {
    const { createInstagramWebhookEventRetentionWorker } = await import(WORKER_MODULE);

    const handle = createInstagramWebhookEventRetentionWorker();

    expect(handle.queueName).toBe('instagram-webhook-event-retention');
    expect(workerState.queueName).toBe('instagram-webhook-event-retention');
    expect(workerState.options).toEqual(expect.objectContaining({ concurrency: 1 }));
  });

  it('runs the clean-up job for every scheduled job and returns its counts', async () => {
    const { createInstagramWebhookEventRetentionWorker } = await import(WORKER_MODULE);

    createInstagramWebhookEventRetentionWorker();
    const result = await workerState.processor?.();

    expect(runRetentionJobMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ deletedCount: 3, blockedCount: 0, hasMore: false });
  });

  it('logs a stalled warning with the queue name and job id', async () => {
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const { createInstagramWebhookEventRetentionWorker } = await import(WORKER_MODULE);

    createInstagramWebhookEventRetentionWorker();
    workerState.onHandlers.stalled?.('job-instagram-001');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { jobId: 'job-instagram-001', queue: 'instagram-webhook-event-retention' },
      'instagram-webhook-event-retention.stalled',
    );
  });

  it('propagates a failed clean-up to BullMQ', async () => {
    runRetentionJobMock.mockRejectedValue(new Error('clean-up failed'));
    const { createInstagramWebhookEventRetentionWorker } = await import(WORKER_MODULE);

    createInstagramWebhookEventRetentionWorker();

    await expect(workerState.processor?.()).rejects.toThrow('clean-up failed');
  });
});
