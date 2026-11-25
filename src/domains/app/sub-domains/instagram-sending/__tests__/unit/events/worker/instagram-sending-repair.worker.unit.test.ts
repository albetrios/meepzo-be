import { beforeEach, describe, expect, it, vi } from 'vitest';

const { workerInstances, repairDutyMock, watchDutyMock, warnMock } = vi.hoisted(() => ({
  workerInstances: [] as Array<{
    queueName: string;
    processor: (job: { name: string }) => Promise<unknown>;
    options: Record<string, unknown>;
  }>,
  repairDutyMock: vi.fn(),
  watchDutyMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Worker: class {
    constructor(
      queueName: string,
      processor: (job: { name: string }) => Promise<unknown>,
      options: Record<string, unknown>,
    ) {
      workerInstances.push({ queueName, processor, options });
    }
    on = vi.fn();
    close = vi.fn();
  },
}));
vi.mock('@/infrastructure/queue/connection.js', () => ({
  getBullMQConnectionOptions: () => ({}),
  getBullMQKeyPrefix: () => 'test:bull',
}));
vi.mock('@/infrastructure/queue/worker-runtime/worker-close.util.js', () => ({
  buildWorkerHandle: ({ queueName }: { queueName: string }) => ({ queueName, close: vi.fn() }),
}));
vi.mock('@/infrastructure/queue/worker-runtime/worker-options.js', () => ({
  getRetentionWorkerOptions: () => ({ lockDuration: 1 }),
}));
vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: warnMock, error: vi.fn(), debug: vi.fn() },
}));
vi.mock(
  '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-repair.processor.js',
  () => ({
    runInstagramSendingRepairDuty: repairDutyMock,
  }),
);
vi.mock(
  '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-watch.processor.js',
  () => ({
    isInstagramSendingWatchDuty: (name: string) => name === 'outage-check',
    runInstagramSendingWatchDuty: watchDutyMock,
  }),
);

import { createInstagramSendingRepairWorker } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-repair.worker.js';
import { INSTAGRAM_SENDING_REPAIR_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-repair.constants.js';
import { INSTAGRAM_SENDING_REPAIR_CONCURRENCY } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-watch.constants.js';

/**
 * The sending repair worker (§ 6 SN6, P94 — ROUTE rows R52, R48): one job per duty, routed by the
 * job name to a watch duty or a repair duty, the duties in parallel.
 */
describe('instagram-sending-repair.worker', () => {
  beforeEach(() => {
    workerInstances.length = 0;
    vi.clearAllMocks();
    repairDutyMock.mockResolvedValue({ duty: 'repair' });
    watchDutyMock.mockResolvedValue({ duty: 'watch' });
  });

  it('runs a repair duty by its job name, through the given database slot', async () => {
    const runInDatabaseSlot = vi.fn();
    createInstagramSendingRepairWorker({ runInDatabaseSlot });
    const [instance] = workerInstances;

    expect(instance?.queueName).toBe(INSTAGRAM_SENDING_REPAIR_QUEUE_NAME);
    expect(instance?.options.concurrency).toBe(INSTAGRAM_SENDING_REPAIR_CONCURRENCY);
    await expect(instance?.processor({ name: 'repair-month-wake' })).resolves.toEqual({
      duty: 'repair',
    });
    expect(repairDutyMock).toHaveBeenCalledWith({ duty: 'repair-month-wake', runInDatabaseSlot });
    expect(watchDutyMock).not.toHaveBeenCalled();
  });

  it('runs a watch duty with the watch dependencies, and logs one when they are not wired', async () => {
    const watch = { sendingStateService: {} } as never;
    createInstagramSendingRepairWorker({ watch });
    await expect(workerInstances[0]?.processor({ name: 'outage-check' })).resolves.toEqual({
      duty: 'watch',
    });
    expect(watchDutyMock).toHaveBeenCalledWith({ duty: 'outage-check', dependencies: watch });

    createInstagramSendingRepairWorker();
    await expect(workerInstances[1]?.processor({ name: 'outage-check' })).resolves.toBeNull();
    expect(warnMock).toHaveBeenCalledWith(
      { duty: 'outage-check' },
      'app.instagram_watch.not_wired',
    );
    expect(repairDutyMock).not.toHaveBeenCalled();
  });
});
