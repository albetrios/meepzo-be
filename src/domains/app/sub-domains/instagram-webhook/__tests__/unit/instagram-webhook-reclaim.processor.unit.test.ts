import { beforeEach, describe, expect, it, vi } from 'vitest';

const { retentionRepository, contextKinds, loggerMock } = vi.hoisted(() => ({
  retentionRepository: { listAccountsWithStuckEvents: vi.fn() },
  /** Which context each read ran in — a plain list, so the harness's mock reset never clears it. */
  contextKinds: [] as string[],
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-processor.util.js', () => ({
  runGlobalRetentionWorkerJob: (processor: (databaseHandle: unknown) => Promise<unknown>) => {
    contextKinds.push('global_retention_cleanup');
    return processor({ handle: 'retention' });
  },
}));

vi.mock(
  '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js',
  () => ({ createRetentionInstagramWebhookEventRepository: () => retentionRepository }),
);

vi.mock('@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js', () => ({
  enqueueInstagramWebhookAccountProcessing: vi.fn(),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({ logger: loggerMock }));

import { runInstagramWebhookReclaimJob } from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook-reclaim.processor.js';

/**
 * The stuck-event pick-up (routes-final § 4.A WH15, worker-changes WC-2): one read across
 * organizations under the retention context — 5 minutes, up to 100 accounts — then, with the
 * context closed, one processing add per account, each carrying its organization (K8).
 */

const STUCK = [
  {
    organizationPublicId: 'org_acmeshop0000000000001',
    instagramAccountPublicId: 'iga_acmeshop0000000000001',
  },
  {
    organizationPublicId: 'org_brightway000000000001',
    instagramAccountPublicId: 'iga_brightway000000000001',
  },
];

beforeEach(() => {
  contextKinds.length = 0;
  retentionRepository.listAccountsWithStuckEvents.mockReset();
  retentionRepository.listAccountsWithStuckEvents.mockResolvedValue(STUCK);
});

describe('runInstagramWebhookReclaimJob', () => {
  it('reads the accounts waiting 5 minutes, at most 100, under the retention context', async () => {
    const enqueue = vi.fn(async () => undefined);

    await runInstagramWebhookReclaimJob({ requestId: 'reclaim-job-1', enqueue });

    expect(contextKinds).toEqual(['global_retention_cleanup']);
    expect(retentionRepository.listAccountsWithStuckEvents).toHaveBeenCalledWith({
      stuckAfterMinutes: 5,
      limit: 100,
    });
  });

  it("adds each account's processing job with its organization, after the read", async () => {
    const enqueue = vi.fn(async () => {
      // The read's context is closed before the first add (no Redis call inside a unit of work).
      expect(contextKinds).toHaveLength(1);
    });

    const result = await runInstagramWebhookReclaimJob({ requestId: 'reclaim-job-1', enqueue });

    expect(enqueue.mock.calls).toEqual([
      [{ ...STUCK[0], requestId: 'reclaim-job-1' }],
      [{ ...STUCK[1], requestId: 'reclaim-job-1' }],
    ]);
    expect(result).toEqual({ listedCount: 2, addedCount: 2, failedAddCount: 0 });
  });

  it('logs a refused add and goes on — the account is found again next minute', async () => {
    const enqueue = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValueOnce(undefined);

    const result = await runInstagramWebhookReclaimJob({ enqueue });

    expect(result).toEqual({ listedCount: 2, addedCount: 1, failedAddCount: 1 });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      {
        organizationPublicId: STUCK[0]?.organizationPublicId,
        instagramAccountPublicId: STUCK[0]?.instagramAccountPublicId,
        errorName: 'Error',
      },
      'app.instagram_webhook.reclaim_enqueue_failed',
    );
  });

  it('adds nothing when no account waits', async () => {
    retentionRepository.listAccountsWithStuckEvents.mockResolvedValueOnce([]);
    const enqueue = vi.fn(async () => undefined);

    await expect(runInstagramWebhookReclaimJob({ enqueue })).resolves.toEqual({
      listedCount: 0,
      addedCount: 0,
      failedAddCount: 0,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('lets a failed read throw, so the job fails and the next minute reads again', async () => {
    retentionRepository.listAccountsWithStuckEvents.mockRejectedValueOnce(new Error('timeout'));
    const enqueue = vi.fn(async () => undefined);

    await expect(runInstagramWebhookReclaimJob({ enqueue })).rejects.toThrow('timeout');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
