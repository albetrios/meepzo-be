import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, addBulkMock, warnMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  addBulkMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
    addBulk = addBulkMock;
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('@/infrastructure/queue/connection.js', () => ({
  getBullMQKeyPrefix: () => 'test:bull',
  getBullMQProducerConnectionOptions: () => ({}),
}));

vi.mock('@/infrastructure/observability/tracing/trace-context.util.js', () => ({
  captureTraceContextForPropagation: () => ({}),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: warnMock, error: vi.fn(), debug: vi.fn() },
}));

import {
  INSTAGRAM_ACCOUNT_DAILY_CHECK_JOB_NAME,
  buildInstagramAccountDailyCheckJobId,
  enqueueInstagramAccountDailyChecks,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-account-daily-check.queue.js';
import {
  INSTAGRAM_RECONNECT_NOTICE_JOB_NAME,
  buildInstagramReconnectNoticeJobId,
  enqueueInstagramReconnectNotice,
  enqueueInstagramReconnectNoticeBestEffort,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.queue.js';

/**
 * The two queues of launch R7: one daily check per account per UTC day (IA8, K8) and one reconnect
 * notice per account and break (IA9) — public ids only in the payload, the job ids that make both
 * safe to repeat.
 */

const ORGANIZATION_PUBLIC_ID = 'org_acmeshop00000000000001';
const ACCOUNT_PUBLIC_ID = 'iga_acmeshop00000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  addMock.mockResolvedValue(undefined);
  addBulkMock.mockResolvedValue([]);
});

describe('daily account check queue', () => {
  it('keys a check by account and UTC day: same day, same job; next day, a new one', () => {
    const morning = new Date('2026-11-21T04:00:00.000Z');
    const evening = new Date('2026-11-21T23:59:59.000Z');
    const nextDay = new Date('2026-11-22T04:00:00.000Z');
    const idOn = (checkedOn: Date) =>
      buildInstagramAccountDailyCheckJobId({
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        checkedOn,
      });

    expect(idOn(morning)).toBe(`instagram-account-daily-check-${ACCOUNT_PUBLIC_ID}-2026-11-21`);
    expect(idOn(evening)).toBe(idOn(morning));
    expect(idOn(nextDay)).not.toBe(idOn(morning));
    // BullMQ refuses a custom job id with a colon.
    expect(idOn(morning)).not.toContain(':');
  });

  it('adds one job per account with the organization in the payload (K8), in one call', async () => {
    const checkedOn = new Date('2026-11-21T04:00:00.000Z');

    await expect(
      enqueueInstagramAccountDailyChecks({
        targets: [
          {
            organizationPublicId: ORGANIZATION_PUBLIC_ID,
            instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
          },
        ],
        checkedOn,
      }),
    ).resolves.toBe(1);

    expect(addBulkMock).toHaveBeenCalledWith([
      {
        name: INSTAGRAM_ACCOUNT_DAILY_CHECK_JOB_NAME,
        data: {
          organizationPublicId: ORGANIZATION_PUBLIC_ID,
          instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        },
        opts: { jobId: `instagram-account-daily-check-${ACCOUNT_PUBLIC_ID}-2026-11-21` },
      },
    ]);
  });

  it('adds nothing for an empty page', async () => {
    await expect(
      enqueueInstagramAccountDailyChecks({ targets: [], checkedOn: new Date() }),
    ).resolves.toBe(0);
    expect(addBulkMock).not.toHaveBeenCalled();
  });
});

describe('reconnect notice queue', () => {
  const connectionBreak = {
    organizationPublicId: ORGANIZATION_PUBLIC_ID,
    instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
    connectionStatus: 'expired' as const,
    connectionStatusChangedAt: new Date('2026-11-21T04:00:01.250Z'),
  };

  it('keys a notice by account and the time it broke: one break, one notice', () => {
    expect(buildInstagramReconnectNoticeJobId(connectionBreak)).toBe(
      `instagram-reconnect-notice-${ACCOUNT_PUBLIC_ID}-${connectionBreak.connectionStatusChangedAt.getTime()}`,
    );
    const laterBreak = {
      ...connectionBreak,
      connectionStatusChangedAt: new Date('2026-12-02T09:30:00.000Z'),
    };
    expect(buildInstagramReconnectNoticeJobId(laterBreak)).not.toBe(
      buildInstagramReconnectNoticeJobId(connectionBreak),
    );
  });

  it('carries the organization, the account and the break — public ids and a time only', async () => {
    await enqueueInstagramReconnectNotice({ connectionBreak, requestId: 'request-1' });

    expect(addMock).toHaveBeenCalledWith(
      INSTAGRAM_RECONNECT_NOTICE_JOB_NAME,
      {
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        connectionStatus: 'expired',
        connectionStatusChangedAt: '2026-11-21T04:00:01.250Z',
        requestId: 'request-1',
      },
      { jobId: buildInstagramReconnectNoticeJobId(connectionBreak) },
    );
  });

  it('never lets a failed enqueue escape the best-effort path', async () => {
    addMock.mockRejectedValue(new Error('Redis refused the write'));

    await expect(enqueueInstagramReconnectNoticeBestEffort({ connectionBreak })).resolves.toBe(
      undefined,
    );
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ instagramAccountPublicId: ACCOUNT_PUBLIC_ID }),
      'app.instagram_account.reconnect_notice_enqueue_failed',
    );
  });
});
