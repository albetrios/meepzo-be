import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The 30-day clean-up's processor (WH19) without a database: the cutoff is exactly 30 days before
 * `now`, the delete runs inside `runGlobalRetentionWorkerJob` through the retention-bound
 * repository, and the logs carry counts only. The database behaviour (older rows go, younger stay,
 * any status) is in `instagram-webhook-event-retention.processor.db.unit.test.ts`.
 */

const retentionState = vi.hoisted(() => ({
  databaseHandle: { kind: 'global-retention' },
  deleteReceivedBefore: vi.fn(),
  createRepository: vi.fn(),
  runGlobalRetentionWorkerJob: vi.fn(),
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-processor.util.js', () => ({
  runGlobalRetentionWorkerJob: (processor: (databaseHandle: unknown) => Promise<unknown>) =>
    retentionState.runGlobalRetentionWorkerJob(processor),
}));

vi.mock(
  '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js',
  () => ({
    createRetentionInstagramWebhookEventRepository: (databaseHandle: unknown) =>
      retentionState.createRepository(databaseHandle),
  }),
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('runInstagramWebhookEventRetentionJob', () => {
  beforeEach(() => {
    retentionState.deleteReceivedBefore.mockReset();
    retentionState.deleteReceivedBefore.mockResolvedValue({
      deletedCount: 4,
      blockedCount: 0,
      hasMore: false,
    });
    retentionState.createRepository.mockReset();
    retentionState.createRepository.mockReturnValue({
      deleteReceivedBefore: retentionState.deleteReceivedBefore,
    });
    retentionState.runGlobalRetentionWorkerJob.mockReset();
    retentionState.runGlobalRetentionWorkerJob.mockImplementation(
      (processor: (databaseHandle: unknown) => Promise<unknown>) =>
        processor(retentionState.databaseHandle),
    );
  });

  it('deletes through the retention repository everything received before now − 30 days', async () => {
    const { runInstagramWebhookEventRetentionJob } = await import(
      '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/workers/instagram-webhook-event-retention.processor.js'
    );
    const now = new Date('2026-11-21T03:00:00.000Z');

    const result = await runInstagramWebhookEventRetentionJob(now);

    expect(retentionState.runGlobalRetentionWorkerJob).toHaveBeenCalledOnce();
    expect(retentionState.createRepository).toHaveBeenCalledWith(retentionState.databaseHandle);
    expect(retentionState.deleteReceivedBefore).toHaveBeenCalledWith(
      new Date('2026-10-22T03:00:00.000Z'),
    );
    expect(result).toEqual({ deletedCount: 4, blockedCount: 0, hasMore: false });
  });

  it('logs the cutoff and the counts, never a payload', async () => {
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const { runInstagramWebhookEventRetentionJob } = await import(
      '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/workers/instagram-webhook-event-retention.processor.js'
    );

    await runInstagramWebhookEventRetentionJob(new Date('2026-11-21T03:00:00.000Z'));

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      { retentionDays: 30, cutoffDate: '2026-10-22T03:00:00.000Z' },
      'instagram-webhook-event-retention.starting',
    );
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      { deletedCount: 4, blockedCount: 0, hasMore: false, retentionDays: 30 },
      'instagram-webhook-event-retention.completed',
    );
  });

  it('propagates a database failure to the worker', async () => {
    retentionState.deleteReceivedBefore.mockRejectedValue(new Error('database unavailable'));
    const { runInstagramWebhookEventRetentionJob } = await import(
      '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/workers/instagram-webhook-event-retention.processor.js'
    );

    await expect(runInstagramWebhookEventRetentionJob()).rejects.toThrow('database unavailable');
  });
});
