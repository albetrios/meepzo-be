import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  upsertJobSchedulerMock,
  queueCloseMock,
  getJobSchedulersMock,
  removeJobSchedulerMock,
  loggerMock,
} = vi.hoisted(() => ({
  upsertJobSchedulerMock: vi.fn().mockResolvedValue(undefined),
  queueCloseMock: vi.fn().mockResolvedValue(undefined),
  // sec-Q: scheduler reconciliation reads existing schedulers from Redis and drops any
  // whose id is no longer in the canonical set (orphan rename/removal residue).
  getJobSchedulersMock: vi.fn().mockResolvedValue([]),
  removeJobSchedulerMock: vi.fn().mockResolvedValue(true),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    upsertJobScheduler = upsertJobSchedulerMock;
    close = queueCloseMock;
    getJobSchedulers = getJobSchedulersMock;
    removeJobScheduler = removeJobSchedulerMock;
  },
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({ logger: loggerMock }));

const TOMBSTONE_QUEUE_ORDER = [
  'upload-tombstone-retention',
  'organization-tombstone-retention',
  'webhook-tombstone-retention',
  'organization-notification-policy-tombstone-retention',
  'membership-tombstone-retention',
  'member-role-tombstone-retention',
  'organization-api-key-tombstone-retention',
  'user-tombstone-retention',
] as const;

describe('infrastructure queue scheduler', () => {
  beforeEach(() => {
    upsertJobSchedulerMock.mockClear();
    queueCloseMock.mockClear();
    getJobSchedulersMock.mockClear().mockResolvedValue([]);
    removeJobSchedulerMock.mockClear().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('getScheduledJobs returns audit, session, stripe retention, audit export, tombstone retention, membership invitation expiry, idempotency, dlq depth, mail sweeper, upload pending sweep, stripe reclaim, webhook delivery reclaim, and audit-outbox drain jobs', async () => {
    const { getScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    const scheduledJobs = getScheduledJobs();
    expect(scheduledJobs).toHaveLength(38);
    expect(scheduledJobs.map((job) => job.queueName)).toEqual([
      'audit-retention',
      'audit-outbox-drain',
      'notification-retention',
      'session-cleanup',
      'user-offboarding-reconcile',
      'organization-offboarding-reconcile',
      'stripe-webhook-event-retention',
      'audit-export',
      // Launch IA8: the daily Instagram account check's sweep rides its queue
      // (job `sweep-connected-instagram-accounts`).
      'instagram-account-daily-check',
      // feat-instagram-dm-sending WC-25 (R40): the 10-minute webhook subscription sweep rides it too
      // (job `sweep-instagram-webhook-subscriptions`).
      'instagram-account-daily-check',
      // feat-instagram-dm-sending WC-55 (R49): the partition upkeep's daily make and hourly drop —
      // webhook events and keys, attempts, messages, comment logs, run events and runs expire by
      // part drops (the launch's 03:00 webhook-event batch delete is retired, WHC15); R50: the
      // hourly clean-up of the plain app tables rides the same queue (WC-53, WC-54, WC-62)
      'app-partition-upkeep',
      'app-partition-upkeep',
      'app-partition-upkeep',
      // launch-2026-11-20-ujai D8 (AU25, AQ7): the hourly 7-day wait cancel, then the
      // deleted-automation purge (hourly at :47 since feat-instagram-dm-sending WC-47, P92); runs
      // and comment logs go by month-part drops since R14 (AU36)
      'automation-run-wait-expiry',
      'automation-tombstone-retention',
      'user-data-export-retention',
      ...TOMBSTONE_QUEUE_ORDER.slice(0, 5),
      // D84: invited memberships 7 days past their invitation's expiry free their seat
      'membership-invitation-expiry',
      ...TOMBSTONE_QUEUE_ORDER.slice(5),
      'webhook-delivery-attempt-retention',
      'idempotency-cardinality',
      'dlq-depth',
      'dlq-auto-retry',
      'commit-dispatch-recovery',
      'mail-outbox-sweeper',
      'upload-pending-sweep',
      'stripe-webhook-event-reclaim',
      'stripe-webhook-event-catchup',
      // The hourly seat reconcile rides the seat-sync queue (job `reconcile-subscription-seats`).
      'subscription-seat-sync',
      'webhook-delivery-reclaim',
      // The export lost-enqueue sweep rides the export queue (job `reclaim-pending-user-data-exports`).
      'user-data-export',
      // launch-2026-11-20-ujai WH15: the stuck-event pick-up rides the Instagram processing queue
      // (job `reclaim-instagram-webhook-events`), every minute.
      'instagram-webhook',
    ]);
  });

  it('tombstone retention jobs run in FK-safe order (uploads before organizations before users)', async () => {
    const { getScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    const scheduledJobs = getScheduledJobs();
    const tombstoneQueues = scheduledJobs
      .map((job) => job.queueName)
      .filter((name) => name.endsWith('-tombstone-retention'));
    // The deleted-automation purge (AQ7) runs with the app domain's clean-ups at 03:40 — after the
    // runs and comment logs pointing at an automation are gone, not in the 05:4x tombstone chain.
    expect(tombstoneQueues).toEqual(['automation-tombstone-retention', ...TOMBSTONE_QUEUE_ORDER]);
    const uploadIndex = tombstoneQueues.indexOf('upload-tombstone-retention');
    const organizationIndex = tombstoneQueues.indexOf('organization-tombstone-retention');
    const userIndex = tombstoneQueues.indexOf('user-tombstone-retention');
    expect(uploadIndex).toBeLessThan(organizationIndex);
    expect(organizationIndex).toBeLessThan(userIndex);
  });

  it('keeps the time-split parts: a daily make at 02:23 and an hourly drop at :37; no webhook-event batch delete remains (WC-55, WHC15)', async () => {
    const { getScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    const scheduledJobs = getScheduledJobs();
    expect(
      scheduledJobs.find(
        (scheduledJob) => scheduledJob.queueName === 'instagram-webhook-event-retention',
      ),
    ).toBeUndefined();
    expect(
      scheduledJobs
        .filter((scheduledJob) => scheduledJob.queueName === 'app-partition-upkeep')
        .map(({ schedulerId, jobName, cronPattern }) => ({ schedulerId, jobName, cronPattern })),
    ).toEqual([
      {
        schedulerId: 'daily-app-partition-make',
        jobName: 'make-app-partitions',
        cronPattern: '23 2 * * *',
      },
      {
        schedulerId: 'hourly-app-partition-drop',
        jobName: 'drop-expired-app-partitions',
        cronPattern: '37 * * * *',
      },
      {
        schedulerId: 'hourly-app-table-clean-up',
        jobName: 'clean-up-app-tables',
        cronPattern: '7 * * * *',
      },
    ]);
  });

  it('runs the plain-table clean-ups hourly within their time budget: app tables at :07, automations at :47, sessions and trusted devices at :12 (P92; WC-47, WC-53, WC-54, WC-62, WC-64)', async () => {
    const { getScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    const byQueue = (queueName: string) =>
      getScheduledJobs()
        .filter((scheduledJob) => scheduledJob.queueName === queueName)
        .map(({ schedulerId, cronPattern }) => ({ schedulerId, cronPattern }));
    expect(byQueue('automation-tombstone-retention')).toEqual([
      { schedulerId: 'hourly-automation-tombstone-cleanup', cronPattern: '47 * * * *' },
    ]);
    expect(byQueue('session-cleanup')).toEqual([
      { schedulerId: 'hourly-session-cleanup', cronPattern: expect.any(String) },
    ]);
  });

  it('picks up stuck Instagram webhook events every minute on the processing queue (WH15, WC-2)', async () => {
    const { getScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    const job = getScheduledJobs().find(
      (scheduledJob) => scheduledJob.queueName === 'instagram-webhook',
    );
    expect(job).toMatchObject({
      schedulerId: 'instagram-webhook-reclaim',
      jobName: 'reclaim-instagram-webhook-events',
      cronPattern: '* * * * *',
    });
  });

  it('schedules no "next post" expiry — a next post never expires (feat-instagram-dm-sending P12, AU20)', async () => {
    const { getScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    expect(
      getScheduledJobs().some(
        (scheduledJob) => scheduledJob.queueName === 'automation-next-post-expiry',
      ),
    ).toBe(false);
  });

  it('cancels runs waiting more than 7 days every hour (D8, routes-final § 3.B AU25)', async () => {
    const { getScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    const job = getScheduledJobs().find(
      (scheduledJob) => scheduledJob.queueName === 'automation-run-wait-expiry',
    );
    expect(job).toMatchObject({
      schedulerId: 'automation-run-wait-expiry-hourly',
      jobName: 'cancel-long-waiting-automation-runs',
      cronPattern: '0 * * * *',
    });
  });

  it('runs the deleted-automation clean-up hourly at :47 (WC-47, P92); no run or comment-log batch delete remains (D8, AU36)', async () => {
    const { getScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    const scheduledJobs = getScheduledJobs();
    const cronOf = (queueName: string) =>
      scheduledJobs.find((scheduledJob) => scheduledJob.queueName === queueName);
    expect(cronOf('automation-run-retention')).toBeUndefined();
    expect(cronOf('automation-comment-log-retention')).toBeUndefined();
    expect(cronOf('automation-tombstone-retention')).toMatchObject({
      schedulerId: 'hourly-automation-tombstone-cleanup',
      jobName: 'purge-old-deleted-automations',
      cronPattern: '47 * * * *',
    });
  });

  it('getScheduledJobs honors AUDIT_RETENTION_CRON from the environment', async () => {
    vi.stubEnv('AUDIT_RETENTION_CRON', '*/7 * * * *');
    const { getScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    const scheduledJobs = getScheduledJobs();
    expect(scheduledJobs.find((job) => job.queueName === 'audit-retention')?.cronPattern).toBe(
      '*/7 * * * *',
    );
  });

  it('sec-new-Q1: getScheduledJobs honors USER_DATA_EXPORT_RETENTION_CRON from the environment', async () => {
    vi.stubEnv('USER_DATA_EXPORT_RETENTION_CRON', '*/9 * * * *');
    const { getScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    const scheduledJobs = getScheduledJobs();
    expect(
      scheduledJobs.find((job) => job.queueName === 'user-data-export-retention')?.cronPattern,
    ).toBe('*/9 * * * *');
  });

  it('sec-new-Q1: getScheduledJobs honors COMMIT_DISPATCH_RECOVERY_CRON from the environment', async () => {
    vi.stubEnv('COMMIT_DISPATCH_RECOVERY_CRON', '*/11 * * * *');
    const { getScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    const scheduledJobs = getScheduledJobs();
    expect(
      scheduledJobs.find((job) => job.queueName === 'commit-dispatch-recovery')?.cronPattern,
    ).toBe('*/11 * * * *');
  });

  it('registerScheduledJobs registers only active queue names when filtered', async () => {
    vi.stubEnv('SCHEDULER_ENABLED', 'true');
    const { registerScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');

    await registerScheduledJobs({
      activeQueueNames: new Set(['mail-outbox-sweeper', 'audit-retention']),
    });

    expect(upsertJobSchedulerMock).toHaveBeenCalledTimes(2);
    const registeredQueues = upsertJobSchedulerMock.mock.calls.map((_call, index) => index);
    expect(registeredQueues).toHaveLength(2);
  });

  it('getScheduledJobs sets timezone on each job when SCHEDULER_TIMEZONE is set', async () => {
    vi.stubEnv('SCHEDULER_TIMEZONE', 'America/New_York');
    const { getScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    const scheduledJobs = getScheduledJobs();
    for (const job of scheduledJobs) {
      expect(job.timezone).toBe('America/New_York');
    }
  });

  it('registerScheduledJobs registers one repeatable job per cleanup queue when enabled', async () => {
    const { registerScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    const schedulerHandle = await registerScheduledJobs();
    expect(upsertJobSchedulerMock).toHaveBeenCalledTimes(38);
    // Each scheduled job opens one Queue for upsert (38) + the reconcile pass opens one Queue per
    // unique queue name (35 — the seat reconcile, the export reclaim, the Instagram daily-check
    // sweep and the Instagram stuck-event pick-up ride queues no other cron uses; the 10-minute
    // webhook subscription sweep shares the daily-check queue, R40; the partition upkeep's make and
    // drop and the plain-table clean-up share one queue, R49 and R50), each closed in
    // its own loop iteration. The upsert queues are closed as soon as registration ends — not held
    // open for the life of the process.
    expect(queueCloseMock).toHaveBeenCalledTimes(73);
    await schedulerHandle.close();
    expect(queueCloseMock).toHaveBeenCalledTimes(73);
  });

  it('registerScheduledJobs does not instantiate queues when SCHEDULER_ENABLED is false', async () => {
    vi.stubEnv('SCHEDULER_ENABLED', 'false');
    const { registerScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    const schedulerHandle = await registerScheduledJobs();
    expect(upsertJobSchedulerMock).not.toHaveBeenCalled();
    expect(queueCloseMock).not.toHaveBeenCalled();
    await schedulerHandle.close();
  });

  // A split worker service running with the scheduler off registers none of its queues' crons, and
  // no other process registers them for it: the mail outbox sweeper and the Stripe and webhook
  // reclaims then never run — silently, until lost work piles up.
  it('warns with the crons it leaves unregistered when the scheduler is off in a process that runs them', async () => {
    vi.stubEnv('SCHEDULER_ENABLED', 'false');
    loggerMock.warn.mockClear();
    const { registerScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');

    await registerScheduledJobs({
      activeQueueNames: new Set(['mail', 'mail-outbox-sweeper', 'webhook-delivery-reclaim']),
    });

    expect(upsertJobSchedulerMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      { queueNames: ['mail-outbox-sweeper', 'webhook-delivery-reclaim'] },
      'scheduler.disabled.crons_not_registered',
    );
  });

  it('stays quiet with the scheduler off in a process that runs no cron queue', async () => {
    vi.stubEnv('SCHEDULER_ENABLED', 'false');
    loggerMock.warn.mockClear();
    loggerMock.info.mockClear();
    const { registerScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');

    await registerScheduledJobs({ activeQueueNames: new Set(['mail', 'webhook-delivery']) });

    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith('scheduler.disabled');
  });

  it('registerScheduledJobs removes orphan schedulers whose id is not in the canonical set (sec-Q)', async () => {
    // A `schedulerId` rename or queue removal leaves the stale scheduler in Redis. Without
    // reconciliation, BullMQ keeps firing it forever — doubling cron rate after rename, or
    // firing into a worker-less queue after removal. The audit at boot only diffs in-code
    // state and would not detect this; the registry MUST read Redis state and drop orphans.
    getJobSchedulersMock.mockResolvedValue([
      { key: 'orphan-scheduler-id', name: 'orphan-job' },
      // A canonical id mixed in to verify it is NOT removed.
      { key: 'daily-audit-cleanup', name: 'audit-cleanup' },
    ]);

    const { registerScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    await registerScheduledJobs({
      activeQueueNames: new Set(['audit-retention']),
    });

    // Only the orphan is dropped, never a canonical scheduler.
    expect(removeJobSchedulerMock).toHaveBeenCalledWith('orphan-scheduler-id');
    expect(removeJobSchedulerMock).not.toHaveBeenCalledWith('daily-audit-cleanup');
  });

  it('alerts when the orphan-reconcile page hits the 1000-scheduler cap (EX-29)', async () => {
    // At the page cap the reconcile only sees the first 1000 schedulers and may silently miss
    // orphans beyond it — that degradation must be observable, not silent.
    loggerMock.error.mockClear();
    getJobSchedulersMock.mockResolvedValue(
      Array.from({ length: 1000 }, (_unused, index) => ({ key: `s${index}`, name: 'job' })),
    );

    const { registerScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
    await registerScheduledJobs({ activeQueueNames: new Set(['audit-retention']) });

    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1000 }),
      'scheduler.reconcile.page_limit_reached',
    );
  });
});
