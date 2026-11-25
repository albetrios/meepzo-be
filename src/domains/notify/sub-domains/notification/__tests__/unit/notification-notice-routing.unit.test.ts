import { describe, expect, it, vi } from 'vitest';

const { sweepMock, weeklyMock, contactMock } = vi.hoisted(() => ({
  sweepMock: vi.fn(async () => ({ dueCount: 0, enqueuedCount: 0 })),
  weeklyMock: vi.fn(async (..._arguments: unknown[]) => ({ outcome: 'quiet' })),
  contactMock: vi.fn(async (..._arguments: unknown[]) => ({ outcome: 'sent', count: 3 })),
}));

vi.mock(
  '@/domains/notify/sub-domains/notification/workers/notification-weekly-summary.processor.js',
  () => ({
    runNotificationWeeklySummarySweepJob: sweepMock,
    processNotificationWeeklySummaryJob: weeklyMock,
  }),
);
vi.mock(
  '@/domains/notify/sub-domains/notification/workers/notification-contact-details.processor.js',
  () => ({
    processNotificationContactDetailsJob: contactMock,
  }),
);
vi.mock('@/infrastructure/queue/dlq/poison-job.util.js', () => ({
  parseJobDataOrDeadLetter: async ({ job }: { job: { data: unknown } }) => job.data,
}));

import { routeNotificationNoticeJob } from '@/domains/notify/sub-domains/notification/workers/notification.worker.js';

/** The notification worker routes the notices of 11.D by job name (UN12, UN13, R53). */
describe('notification worker — the notices of 11.D', () => {
  const port = { readWeeklySummary: vi.fn(), countContactsWithDetailsLeft: vi.fn() };

  it('routes the sweep, the summary and the note; leaves a dispatch to the worker', async () => {
    await routeNotificationNoticeJob({
      job: { name: 'sweep-weekly-summaries', data: {} },
      ports: {},
    });
    expect(sweepMock).toHaveBeenCalledTimes(1);

    const weekly = { organizationPublicId: 'org_x', weekStart: '2026-11-23' };
    await routeNotificationNoticeJob({
      job: { name: 'send-weekly-summary', data: weekly },
      ports: { weeklySummary: port },
    });
    expect(weeklyMock).toHaveBeenCalledWith({ jobData: weekly, port });

    const note = {
      organizationPublicId: 'org_x',
      channelAccountPublicId: 'cha_x',
      windowStartedAt: '2026-11-23T10:00:00.000Z',
    };
    const routed = await routeNotificationNoticeJob({
      job: { name: 'notification-contact-details', data: note },
      ports: { contactDetails: port },
    });
    expect(routed).toEqual({ isRouted: true, result: { outcome: 'sent', count: 3 } });

    expect(
      await routeNotificationNoticeJob({
        job: { name: 'dispatch-notification', data: {} },
        ports: {},
      }),
    ).toEqual({ isRouted: false });
  });

  it('skips a notice whose port the worker was not given', async () => {
    expect(
      await routeNotificationNoticeJob({
        job: {
          name: 'send-weekly-summary',
          data: { organizationPublicId: 'org_x', weekStart: '2026-11-23' },
        },
        ports: {},
      }),
    ).toEqual({ isRouted: true, result: { skipped: true } });
  });
});
