import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, createdQueues } = vi.hoisted(() => ({
  addMock: vi.fn(),
  /** Every Queue the module built — a plain list, so the harness's mock reset never clears it. */
  createdQueues: [] as Array<[string, unknown]>,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
    close = vi.fn().mockResolvedValue(undefined);
    constructor(name: string, options: unknown) {
      createdQueues.push([name, options]);
    }
  },
}));

vi.mock('@/infrastructure/queue/connection.js', () => ({
  getBullMQKeyPrefix: () => 'test:bull',
  getBullMQProducerConnectionOptions: () => ({}),
}));

vi.mock('@/infrastructure/observability/tracing/trace-context.util.js', () => ({
  captureTraceContextForPropagation: () => ({}),
}));

import {
  INSTAGRAM_TAG_EVENT_INTAKE_JOB_NAME,
  INSTAGRAM_WEBHOOK_INTAKE_JOB_NAMES,
  INSTAGRAM_WEBHOOK_QUEUE_NAME,
  enqueueInstagramTagEventIntake,
  enqueueInstagramWebhookIntake,
  instagramWebhookIntakeDeduplication,
} from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';

/**
 * The intake queue (feat-instagram-dm-sending § 5 WH5, WHC4): four job names — one per kind group
 * of an account, deduplicated `intake-<kind>-<cha_…>` with `keepLastIfActive` (comments up to four
 * slots, S11), at priorities 1 · 1 · 5 — and the tag-intake job per contact (S20); the organization
 * in the payload (K8); 5 attempts with growing waits from 5 s.
 */

const ORGANIZATION_PUBLIC_ID = 'org_acmeshop0000000000001';
const ACCOUNT_PUBLIC_ID = 'cha_acmeshop0000000000001';
const CONTACT_PUBLIC_ID = 'con_acmeshop0000000000001';

type AddCall = [string, Record<string, unknown>, Record<string, unknown>];

beforeEach(() => {
  addMock.mockReset();
  addMock.mockResolvedValue(undefined);
});

describe('instagram-webhook queue', () => {
  it('deduplicates per kind group and account, comment slots apart (WH5, S11)', () => {
    expect(
      instagramWebhookIntakeDeduplication({
        intakeKind: 'messages',
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      }),
    ).toEqual({ id: `intake-messages-${ACCOUNT_PUBLIC_ID}`, keepLastIfActive: true });
    expect(
      instagramWebhookIntakeDeduplication({
        intakeKind: 'comments',
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        slot: 2,
      }).id,
    ).toBe(`intake-comments-${ACCOUNT_PUBLIC_ID}-2`);
  });

  it.each([
    { intakeKind: 'messages', jobName: 'intake-messages', priority: 1 },
    { intakeKind: 'live', jobName: 'intake-live', priority: 1 },
    { intakeKind: 'comments', jobName: 'intake-comments', priority: 5 },
  ] as const)(
    'adds $jobName at priority $priority with a unique job id',
    async ({ intakeKind, jobName, priority }) => {
      await enqueueInstagramWebhookIntake({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        intakeKind,
        requestId: 'request-1',
      });
      await enqueueInstagramWebhookIntake({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        intakeKind,
        requestId: 'request-2',
      });

      const [name, jobData, options] = addMock.mock.calls[0] as AddCall;
      expect(name).toBe(jobName);
      expect(INSTAGRAM_WEBHOOK_INTAKE_JOB_NAMES[intakeKind]).toBe(jobName);
      expect(jobData).toEqual({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        intakeKind,
        requestId: 'request-1',
      });
      expect(options).toMatchObject({
        priority,
        deduplication: { id: `intake-${intakeKind}-${ACCOUNT_PUBLIC_ID}`, keepLastIfActive: true },
      });
      // A stable job id would let a retained job drop every later add — each add gets its own.
      expect((addMock.mock.calls[1] as AddCall)[2].jobId).not.toBe(options.jobId);
      expect(String(options.jobId)).not.toContain(':');
    },
  );

  it('takes the caller’s priority (a flooded account’s comments run at 10)', async () => {
    await enqueueInstagramWebhookIntake({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      intakeKind: 'comments',
      requestId: 'request-1',
      priority: 10,
      slot: 3,
    });

    expect((addMock.mock.calls[0] as AddCall)[2]).toMatchObject({
      priority: 10,
      deduplication: { id: `intake-comments-${ACCOUNT_PUBLIC_ID}-3` },
    });
  });

  it('adds one tag-intake job per contact at 5, deduplicated; a bulk piece at 10 without (WH15, S20)', async () => {
    await enqueueInstagramTagEventIntake({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      contactPublicIds: [CONTACT_PUBLIC_ID],
    });
    await enqueueInstagramTagEventIntake({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      contactPublicIds: [CONTACT_PUBLIC_ID, 'con_acmeshop0000000000002'],
    });

    const [name, jobData, options] = addMock.mock.calls[0] as AddCall;
    expect(name).toBe(INSTAGRAM_TAG_EVENT_INTAKE_JOB_NAME);
    expect(jobData).toEqual({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      contactPublicIds: [CONTACT_PUBLIC_ID],
    });
    expect(options).toMatchObject({
      priority: 5,
      deduplication: { id: `intake-tag-events-${CONTACT_PUBLIC_ID}`, keepLastIfActive: true },
    });
    const bulkOptions = (addMock.mock.calls[1] as AddCall)[2];
    expect(bulkOptions.priority).toBe(10);
    expect(bulkOptions.deduplication).toBeUndefined();
  });

  it('retries a job 5 times with exponential waits from 5 s and jitter (WH12)', async () => {
    await enqueueInstagramWebhookIntake({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      intakeKind: 'messages',
      requestId: 'request-1',
    });

    expect(createdQueues).toHaveLength(1);
    const [queueName, queueOptions] = createdQueues[0] as [
      string,
      { defaultJobOptions: Record<string, unknown>; prefix: string },
    ];
    expect(queueName).toBe(INSTAGRAM_WEBHOOK_QUEUE_NAME);
    expect(queueOptions.prefix).toBe('test:bull');
    expect(queueOptions.defaultJobOptions).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000, jitter: expect.any(Number) },
    });
  });

  it('refuses a payload without the organization before anything reaches Redis', async () => {
    await expect(
      enqueueInstagramWebhookIntake({
        organizationPublicId: '',
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        intakeKind: 'messages',
        requestId: 'request-1',
      }),
    ).rejects.toThrow();
    await expect(
      enqueueInstagramTagEventIntake({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        contactPublicIds: [],
      }),
    ).rejects.toThrow();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('propagates a Redis failure to the caller (the receiver logs it)', async () => {
    addMock.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(
      enqueueInstagramWebhookIntake({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        intakeKind: 'live',
        requestId: 'request-1',
      }),
    ).rejects.toThrow('redis unavailable');
  });
});
