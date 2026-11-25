import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const workerState = vi.hoisted(() => ({
  processor: undefined as (() => Promise<unknown>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
}));

const runSessionCleanupJobMock = vi.fn();

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(function WorkerMock(_queueName, processor, options) {
    workerState.processor = processor;
    workerState.options = options;
    return {
      on: vi.fn(),
      close: vi.fn(),
    };
  }),
}));

vi.mock('@/infrastructure/queue/connection.js', () => ({
  getBullMQKeyPrefix: () => 'test:bull',
  getBullMQConnectionOptions: () => ({ host: 'redis.test' }),
  getBullMQProducerConnectionOptions: () => ({ host: 'redis.test', enableOfflineQueue: false }),
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-close.util.js', () => ({
  buildWorkerHandle: ({ worker, queueName }: { worker: unknown; queueName: string }) => ({
    worker,
    queueName,
    close: async () => undefined,
  }),
}));

vi.mock('@/domains/auth/sub-domains/auth-session/workers/session-cleanup.processor.js', () => ({
  runSessionCleanupJob: (...parameters: unknown[]) => runSessionCleanupJobMock(...parameters),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('session-cleanup.worker', () => {
  let createSessionCleanupWorker: typeof import('@/domains/auth/sub-domains/auth-session/workers/session-cleanup.worker.js').createSessionCleanupWorker;

  beforeAll(async () => {
    ({ createSessionCleanupWorker } = await import(
      '@/domains/auth/sub-domains/auth-session/workers/session-cleanup.worker.js'
    ));
  }, 60_000);

  beforeEach(() => {
    workerState.processor = undefined;
    workerState.options = undefined;
    runSessionCleanupJobMock.mockReset();
    runSessionCleanupJobMock.mockResolvedValue([
      { table: 'auth.sessions', deletedCount: 3, blockedCount: 0, stoppedBy: 'done' },
    ]);
  });

  it('runs the hourly session and trusted-device clean-up on the session-cleanup queue (WC-64)', async () => {
    const handle = createSessionCleanupWorker();
    const result = await workerState.processor?.();

    expect(handle.queueName).toBe('session-cleanup');
    expect(workerState.options).toEqual(expect.objectContaining({ concurrency: 1 }));
    expect(runSessionCleanupJobMock).toHaveBeenCalledOnce();
    expect(result).toEqual([
      { table: 'auth.sessions', deletedCount: 3, blockedCount: 0, stoppedBy: 'done' },
    ]);
  });
});
