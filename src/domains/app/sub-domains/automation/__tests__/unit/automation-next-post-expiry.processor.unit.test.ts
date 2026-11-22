import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "next post" expiry's processor (routes-final § 3.A AU15, WC-6, D9) with the database mocked:
 * the scan runs under the retention context with the 500 batch and the tick's time, each
 * organization's change runs in its own job scope with its own automations, a failing organization
 * is counted and reported while the others go on. The SQL is in
 * `automation.repository.db.unit.test.ts`.
 */

const { scan, expire, runOrganizationJob, runRetentionJob, captureException, loggerInfo } =
  vi.hoisted(() => ({
    scan: vi.fn(),
    expire: vi.fn(),
    runOrganizationJob: vi.fn(),
    runRetentionJob: vi.fn(),
    captureException: vi.fn(),
    loggerInfo: vi.fn(),
  }));

vi.mock('@/infrastructure/queue/worker-runtime/worker-processor.util.js', () => ({
  runGlobalRetentionWorkerJob: runRetentionJob,
  runOrganizationScopedWorkerJob: runOrganizationJob,
}));

vi.mock('@/domains/app/sub-domains/automation/automation.repository.js', () => ({
  createRetentionAutomationRepository: () => ({ listNextPostExpiryCandidates: scan }),
  createWorkerAutomationRepository: () => ({ expireNextPostWindows: expire }),
}));

vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({ captureException }));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const NOW = new Date('2026-11-21T12:15:00.000Z');

beforeEach(() => {
  scan.mockReset();
  expire.mockReset();
  captureException.mockReset();
  loggerInfo.mockReset();
  runRetentionJob.mockReset();
  runRetentionJob.mockImplementation(async (processor: (handle: unknown) => Promise<unknown>) =>
    processor({}),
  );
  runOrganizationJob.mockReset();
  runOrganizationJob.mockImplementation(
    async ({ processor }: { processor: (handle: unknown, job: unknown) => Promise<unknown> }) =>
      processor({}, {}),
  );
});

describe('runAutomationNextPostExpiryJob', () => {
  it('scans 500 at most, then expires each organization in its own job scope', async () => {
    scan.mockResolvedValueOnce([
      { automationId: 1, organizationId: 10, organizationPublicId: 'org_a' },
      { automationId: 2, organizationId: 20, organizationPublicId: 'org_b' },
      { automationId: 3, organizationId: 10, organizationPublicId: 'org_a' },
    ]);
    expire.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const { runAutomationNextPostExpiryJob } = await import(
      '@/domains/app/sub-domains/automation/workers/automation-next-post-expiry.processor.js'
    );

    const result = await runAutomationNextPostExpiryJob({ now: NOW });

    expect(scan).toHaveBeenCalledWith({ endedBefore: NOW, limit: 500 });
    expect(runOrganizationJob.mock.calls.map(([call]) => call.job)).toEqual([
      { organizationPublicId: 'org_a' },
      { organizationPublicId: 'org_b' },
    ]);
    expect(expire).toHaveBeenNthCalledWith(1, {
      organizationId: 10,
      automationIds: [1, 3],
      endedBefore: NOW,
    });
    expect(expire).toHaveBeenNthCalledWith(2, {
      organizationId: 20,
      automationIds: [2],
      endedBefore: NOW,
    });
    expect(result).toEqual({ scanned: 3, expired: 3, failedOrganizationCount: 0 });
    expect(loggerInfo).toHaveBeenCalledWith(
      { scanned: 3, expired: 3, failedOrganizationCount: 0 },
      'automation-next-post-expiry.completed',
    );
  });

  it('counts and reports a failing organization while the others still expire', async () => {
    scan.mockResolvedValueOnce([
      { automationId: 1, organizationId: 10, organizationPublicId: 'org_a' },
      { automationId: 2, organizationId: 20, organizationPublicId: 'org_b' },
    ]);
    expire.mockRejectedValueOnce(new Error('deadlock')).mockResolvedValueOnce(1);
    const { runAutomationNextPostExpiryJob } = await import(
      '@/domains/app/sub-domains/automation/workers/automation-next-post-expiry.processor.js'
    );

    const result = await runAutomationNextPostExpiryJob({ now: NOW });

    expect(result).toEqual({ scanned: 2, expired: 1, failedOrganizationCount: 1 });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('does nothing and logs nothing when no window ended', async () => {
    scan.mockResolvedValueOnce([]);
    const { runAutomationNextPostExpiryJob } = await import(
      '@/domains/app/sub-domains/automation/workers/automation-next-post-expiry.processor.js'
    );

    expect(await runAutomationNextPostExpiryJob({ now: NOW })).toEqual({
      scanned: 0,
      expired: 0,
      failedOrganizationCount: 0,
    });
    expect(runOrganizationJob).not.toHaveBeenCalled();
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it('propagates a scan failure to BullMQ', async () => {
    scan.mockRejectedValueOnce(new Error('connection lost'));
    const { runAutomationNextPostExpiryJob } = await import(
      '@/domains/app/sub-domains/automation/workers/automation-next-post-expiry.processor.js'
    );

    await expect(runAutomationNextPostExpiryJob({ now: NOW })).rejects.toThrow('connection lost');
  });
});
