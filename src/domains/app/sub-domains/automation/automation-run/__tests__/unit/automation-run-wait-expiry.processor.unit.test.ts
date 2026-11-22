import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The 7-day wait check's processor (routes-final § 3.B AU25, WC-13, D8) with the database mocked:
 * the scan runs under the retention context with the 500 batch and the cutoff `now - 7 days`, each
 * organization's cancel runs in its own job scope through the run service with its own runs, a
 * failing organization is counted and reported while the others go on. The SQL is in
 * `automation-run-wait-expiry.processor.db.unit.test.ts`.
 */

const { scan, runOrganizationJob, runRetentionJob, captureException, loggerInfo } = vi.hoisted(
  () => ({
    scan: vi.fn(),
    runOrganizationJob: vi.fn(),
    runRetentionJob: vi.fn(),
    captureException: vi.fn(),
    loggerInfo: vi.fn(),
  }),
);

vi.mock('@/infrastructure/queue/worker-runtime/worker-processor.util.js', () => ({
  runGlobalRetentionWorkerJob: runRetentionJob,
  runOrganizationScopedWorkerJob: runOrganizationJob,
}));

vi.mock('@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js', () => ({
  createRetentionAutomationRunRepository: () => ({ listWaitExpiryCandidates: scan }),
}));

vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({ captureException }));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const PROCESSOR_MODULE =
  '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-wait-expiry.processor.js';

const NOW = new Date('2026-11-22T10:00:00.000Z');
const CUTOFF = new Date('2026-11-15T10:00:00.000Z');
const HANDLE = { handle: 'organization' };

const cancelExpiredWaitingRuns = vi.fn();
const runService = { cancelExpiredWaitingRuns };

beforeEach(() => {
  scan.mockReset();
  cancelExpiredWaitingRuns.mockReset();
  captureException.mockReset();
  loggerInfo.mockReset();
  runRetentionJob.mockReset();
  runRetentionJob.mockImplementation(async (processor: (handle: unknown) => Promise<unknown>) =>
    processor({}),
  );
  runOrganizationJob.mockReset();
  runOrganizationJob.mockImplementation(
    async ({ processor }: { processor: (handle: unknown, job: unknown) => Promise<unknown> }) =>
      processor(HANDLE, {}),
  );
});

describe('runAutomationRunWaitExpiryJob', () => {
  it('scans 500 at most from `now - 7 days`, then cancels each organization in its own job scope', async () => {
    scan.mockResolvedValueOnce([
      { runId: 1, organizationId: 10, organizationPublicId: 'org_a' },
      { runId: 2, organizationId: 20, organizationPublicId: 'org_b' },
      { runId: 3, organizationId: 10, organizationPublicId: 'org_a' },
    ]);
    cancelExpiredWaitingRuns.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const { runAutomationRunWaitExpiryJob } = await import(PROCESSOR_MODULE);

    const result = await runAutomationRunWaitExpiryJob({ runService, now: NOW });

    expect(scan).toHaveBeenCalledWith({ waitingSinceBefore: CUTOFF, limit: 500 });
    expect(runOrganizationJob.mock.calls.map(([call]) => call.job)).toEqual([
      { organizationPublicId: 'org_a' },
      { organizationPublicId: 'org_b' },
    ]);
    expect(cancelExpiredWaitingRuns).toHaveBeenNthCalledWith(1, {
      databaseHandle: HANDLE,
      organizationId: 10,
      runIds: [1, 3],
      waitingSinceBefore: CUTOFF,
    });
    expect(cancelExpiredWaitingRuns).toHaveBeenNthCalledWith(2, {
      databaseHandle: HANDLE,
      organizationId: 20,
      runIds: [2],
      waitingSinceBefore: CUTOFF,
    });
    expect(result).toEqual({ scanned: 3, cancelled: 3, failedOrganizationCount: 0 });
    expect(loggerInfo).toHaveBeenCalledWith(
      { scanned: 3, cancelled: 3, failedOrganizationCount: 0 },
      'automation-run-wait-expiry.completed',
    );
  });

  it('counts the runs the re-check left alone as found, not cancelled', async () => {
    scan.mockResolvedValueOnce([
      { runId: 1, organizationId: 10, organizationPublicId: 'org_a' },
      { runId: 2, organizationId: 10, organizationPublicId: 'org_a' },
    ]);
    cancelExpiredWaitingRuns.mockResolvedValueOnce(1);
    const { runAutomationRunWaitExpiryJob } = await import(PROCESSOR_MODULE);

    expect(await runAutomationRunWaitExpiryJob({ runService, now: NOW })).toEqual({
      scanned: 2,
      cancelled: 1,
      failedOrganizationCount: 0,
    });
  });

  it('counts and reports a failing organization while the others still cancel', async () => {
    scan.mockResolvedValueOnce([
      { runId: 1, organizationId: 10, organizationPublicId: 'org_a' },
      { runId: 2, organizationId: 20, organizationPublicId: 'org_b' },
    ]);
    cancelExpiredWaitingRuns.mockRejectedValueOnce(new Error('deadlock')).mockResolvedValueOnce(1);
    const { runAutomationRunWaitExpiryJob } = await import(PROCESSOR_MODULE);

    const result = await runAutomationRunWaitExpiryJob({ runService, now: NOW });

    expect(result).toEqual({ scanned: 2, cancelled: 1, failedOrganizationCount: 1 });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          organizationId: 'org_a',
          tags: { source: 'automation-run-wait-expiry' },
        }),
      }),
    );
  });

  it('does nothing and logs nothing when no run waits past the limit', async () => {
    scan.mockResolvedValueOnce([]);
    const { runAutomationRunWaitExpiryJob } = await import(PROCESSOR_MODULE);

    expect(await runAutomationRunWaitExpiryJob({ runService, now: NOW })).toEqual({
      scanned: 0,
      cancelled: 0,
      failedOrganizationCount: 0,
    });
    expect(runOrganizationJob).not.toHaveBeenCalled();
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it('propagates a scan failure to BullMQ', async () => {
    scan.mockRejectedValueOnce(new Error('connection lost'));
    const { runAutomationRunWaitExpiryJob } = await import(PROCESSOR_MODULE);

    await expect(runAutomationRunWaitExpiryJob({ runService, now: NOW })).rejects.toThrow(
      'connection lost',
    );
  });
});
