import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared partition upkeep's BullMQ worker (feat-instagram-dm-sending WC-55, WHC13): queue,
 * concurrency, the job name → mode routing, the pass at worker start, the stall log.
 */

const workerState = vi.hoisted(() => ({
  queueName: undefined as string | undefined,
  processor: undefined as ((job: { name: string }) => Promise<unknown>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  onHandlers: {} as Record<string, (...args: unknown[]) => void>,
}));

const runUpkeepJobMock = vi.hoisted(() => vi.fn());

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

vi.mock('@/domains/app/workers/app-partition-upkeep.processor.js', () => ({
  runAppPartitionUpkeepJob: (...args: unknown[]) => runUpkeepJobMock(...args),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const WORKER_MODULE = '@/domains/app/workers/app-partition-upkeep.worker.js';

describe('app-partition-upkeep.worker', () => {
  beforeEach(() => {
    workerState.queueName = undefined;
    workerState.processor = undefined;
    workerState.options = undefined;
    workerState.onHandlers = {};
    runUpkeepJobMock.mockReset();
    runUpkeepJobMock.mockResolvedValue([]);
  });

  it('creates the Worker on the app-partition-upkeep queue with concurrency 1', async () => {
    const { createAppPartitionUpkeepWorker } = await import(WORKER_MODULE);

    const handle = createAppPartitionUpkeepWorker();

    expect(handle.queueName).toBe('app-partition-upkeep');
    expect(workerState.queueName).toBe('app-partition-upkeep');
    expect(workerState.options).toEqual(expect.objectContaining({ concurrency: 1 }));
  });

  it('makes the coming parts once when it starts (WC-55: "and when a server starts")', async () => {
    const { createAppPartitionUpkeepWorker } = await import(WORKER_MODULE);

    createAppPartitionUpkeepWorker();

    expect(runUpkeepJobMock).toHaveBeenCalledExactlyOnceWith({ mode: 'make' });
  });

  it('logs a failed start pass without throwing — the schedules try again', async () => {
    runUpkeepJobMock.mockRejectedValueOnce(new Error('database unavailable'));
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const { createAppPartitionUpkeepWorker } = await import(WORKER_MODULE);

    expect(() => createAppPartitionUpkeepWorker()).not.toThrow();
    await vi.waitFor(() =>
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        { error: 'database unavailable' },
        'app-partition-upkeep.start_pass_failed',
      ),
    );
  });

  it('runs the hourly job in drop mode and the daily job in make mode', async () => {
    const { createAppPartitionUpkeepWorker } = await import(WORKER_MODULE);
    createAppPartitionUpkeepWorker();
    runUpkeepJobMock.mockClear();

    await workerState.processor?.({ name: 'drop-expired-app-partitions' });
    await workerState.processor?.({ name: 'make-app-partitions' });

    expect(runUpkeepJobMock.mock.calls).toEqual([[{ mode: 'drop' }], [{ mode: 'make' }]]);
  });

  it('logs a stalled warning with the queue name and job id', async () => {
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const { createAppPartitionUpkeepWorker } = await import(WORKER_MODULE);

    createAppPartitionUpkeepWorker();
    workerState.onHandlers.stalled?.('job-partition-upkeep');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { jobId: 'job-partition-upkeep', queue: 'app-partition-upkeep' },
      'app-partition-upkeep.stalled',
    );
  });

  it('propagates a failed run to BullMQ', async () => {
    const { createAppPartitionUpkeepWorker } = await import(WORKER_MODULE);
    createAppPartitionUpkeepWorker();
    runUpkeepJobMock.mockRejectedValue(new Error('upkeep failed'));

    await expect(workerState.processor?.({ name: 'drop-expired-app-partitions' })).rejects.toThrow(
      'upkeep failed',
    );
  });
});
