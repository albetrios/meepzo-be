import { beforeEach, describe, expect, it, vi } from 'vitest';

const { retentionRepository, workerRepository, contextKinds, loggerMock } = vi.hoisted(() => ({
  retentionRepository: { listAccountsWithStuckEvents: vi.fn(), listDueFailedEvents: vi.fn() },
  workerRepository: { retryDueFailedEvents: vi.fn() },
  /** Which context each read ran in — a plain list, so the harness's mock reset never clears it. */
  contextKinds: [] as string[],
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-processor.util.js', () => ({
  runGlobalRetentionWorkerJob: (processor: (databaseHandle: unknown) => Promise<unknown>) => {
    contextKinds.push('global_retention_cleanup');
    return processor({ handle: 'retention' });
  },
  runOrganizationScopedWorkerJob: ({
    job,
    processor,
  }: {
    job: { organizationPublicId: string };
    processor: (databaseHandle: unknown) => Promise<unknown>;
  }) => {
    contextKinds.push(`organization:${job.organizationPublicId}`);
    return processor({ handle: 'organization' });
  },
}));

vi.mock(
  '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js',
  () => ({
    createRetentionInstagramWebhookEventRepository: () => retentionRepository,
    createWorkerInstagramWebhookEventRepository: () => workerRepository,
  }),
);

vi.mock('@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js', () => ({
  enqueueInstagramWebhookIntake: vi.fn(),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({ logger: loggerMock }));

import { runInstagramWebhookReclaimJob } from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook-reclaim.processor.js';

/**
 * The stuck-event pick-up (feat-instagram-dm-sending § 5.A WH17, worker-changes WC-12): one read
 * across organizations under the retention context — arrived over 1 minute ago, no lease in 5, up
 * to 100 accounts — and the due `failed` events changed in their own organization's scope; then,
 * with every context closed, one intake add per account and kind group (K8).
 */

const STUCK = [
  {
    organizationPublicId: 'org_acmeshop0000000000001',
    channelAccountPublicId: 'cha_acmeshop0000000000001',
    intakeGroup: 'comments' as const,
  },
  {
    organizationPublicId: 'org_brightway000000000001',
    channelAccountPublicId: 'cha_brightway000000000001',
    intakeGroup: 'messages' as const,
  },
];

beforeEach(() => {
  contextKinds.length = 0;
  retentionRepository.listAccountsWithStuckEvents.mockReset();
  retentionRepository.listAccountsWithStuckEvents.mockResolvedValue(STUCK);
  retentionRepository.listDueFailedEvents.mockReset();
  retentionRepository.listDueFailedEvents.mockResolvedValue([]);
  workerRepository.retryDueFailedEvents.mockReset();
});

describe('runInstagramWebhookReclaimJob', () => {
  it('reads the accounts waiting over 1 minute with no lease in 5, at most 100, under the retention context', async () => {
    const enqueue = vi.fn(async () => undefined);

    await runInstagramWebhookReclaimJob({ requestId: 'reclaim-job-1', enqueue });

    expect(contextKinds).toEqual(['global_retention_cleanup', 'global_retention_cleanup']);
    expect(retentionRepository.listAccountsWithStuckEvents).toHaveBeenCalledWith({
      stuckAfterMinutes: 1,
      leaseMinutes: 5,
      limit: 100,
    });
    expect(retentionRepository.listDueFailedEvents).toHaveBeenCalledWith({ limit: 500 });
  });

  it('retries due failed events in their own organization, 7 days back, then adds their intake once', async () => {
    retentionRepository.listAccountsWithStuckEvents.mockResolvedValueOnce([STUCK[0]]);
    retentionRepository.listDueFailedEvents.mockResolvedValueOnce([
      {
        organizationPublicId: STUCK[0]?.organizationPublicId,
        channelAccountPublicId: STUCK[0]?.channelAccountPublicId,
        eventId: 11,
        createdAt: new Date('2026-11-24T10:00:00Z'),
      },
      {
        organizationPublicId: STUCK[1]?.organizationPublicId,
        channelAccountPublicId: STUCK[1]?.channelAccountPublicId,
        eventId: 12,
        createdAt: new Date('2026-11-24T11:00:00Z'),
      },
    ]);
    workerRepository.retryDueFailedEvents
      .mockResolvedValueOnce({ retried: [{ eventId: 11, intakeGroup: 'comments' }], endedCount: 0 })
      .mockResolvedValueOnce({ retried: [], endedCount: 1 });
    const enqueue = vi.fn(async () => undefined);
    const before = Date.now();

    const result = await runInstagramWebhookReclaimJob({ requestId: 'reclaim-job-1', enqueue });

    expect(contextKinds).toEqual([
      'global_retention_cleanup',
      'global_retention_cleanup',
      `organization:${STUCK[0]?.organizationPublicId}`,
      `organization:${STUCK[1]?.organizationPublicId}`,
    ]);
    const firstCall = workerRepository.retryDueFailedEvents.mock.calls[0]?.[0];
    expect(firstCall.events).toHaveLength(1);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(before - sevenDays - firstCall.retryUntilAfter.getTime()).toBeLessThanOrEqual(0);
    // The stuck account and the retried one are the same pair: one add.
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      listedCount: 1,
      addedCount: 1,
      failedAddCount: 0,
      retriedEventCount: 1,
      endedRetryCount: 1,
    });
  });

  it("adds each account's processing job with its organization, after the read", async () => {
    const enqueue = vi.fn(async () => {
      // Both reads' contexts are closed before the first add (no Redis call inside a unit of work).
      expect(contextKinds).toHaveLength(2);
    });

    const result = await runInstagramWebhookReclaimJob({ requestId: 'reclaim-job-1', enqueue });

    expect(enqueue.mock.calls).toEqual([
      [
        {
          organizationPublicId: STUCK[0]?.organizationPublicId,
          channelAccountPublicId: STUCK[0]?.channelAccountPublicId,
          intakeKind: 'comments',
          requestId: 'reclaim-job-1',
        },
      ],
      [
        {
          organizationPublicId: STUCK[1]?.organizationPublicId,
          channelAccountPublicId: STUCK[1]?.channelAccountPublicId,
          intakeKind: 'messages',
          requestId: 'reclaim-job-1',
        },
      ],
    ]);
    expect(result).toEqual({
      listedCount: 2,
      addedCount: 2,
      failedAddCount: 0,
      retriedEventCount: 0,
      endedRetryCount: 0,
    });
  });

  it('logs a refused add and goes on — the account is found again next minute', async () => {
    const enqueue = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValueOnce(undefined);

    const result = await runInstagramWebhookReclaimJob({ enqueue });

    expect(result).toEqual({
      listedCount: 2,
      addedCount: 1,
      failedAddCount: 1,
      retriedEventCount: 0,
      endedRetryCount: 0,
    });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      {
        organizationPublicId: STUCK[0]?.organizationPublicId,
        channelAccountPublicId: STUCK[0]?.channelAccountPublicId,
        intakeGroup: 'comments',
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
      retriedEventCount: 0,
      endedRetryCount: 0,
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
