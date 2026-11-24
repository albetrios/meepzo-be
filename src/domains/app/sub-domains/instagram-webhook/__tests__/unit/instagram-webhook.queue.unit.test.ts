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
  INSTAGRAM_WEBHOOK_PROCESS_JOB_NAME,
  INSTAGRAM_WEBHOOK_QUEUE_NAME,
  enqueueInstagramWebhookAccountProcessing,
  instagramWebhookAccountProcessingDeduplication,
} from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';

/**
 * The event-processing queue (routes-final § 4.A WH5, WHC10): one job per account at a time — the
 * per-account deduplication with `keepLastIfActive` and a unique job id — the organization in the
 * payload (K8), 5 attempts with growing waits from 5 s.
 */

const ORGANIZATION_PUBLIC_ID = 'org_acmeshop0000000000001';
const ACCOUNT_PUBLIC_ID = 'cha_acmeshop0000000000001';

beforeEach(() => {
  addMock.mockReset();
  addMock.mockResolvedValue(undefined);
});

describe('instagram-webhook queue', () => {
  it('deduplicates per account and keeps one follow-up while a job runs (WH5)', () => {
    expect(instagramWebhookAccountProcessingDeduplication(ACCOUNT_PUBLIC_ID)).toEqual({
      id: `instagram-webhook-events-${ACCOUNT_PUBLIC_ID}`,
      keepLastIfActive: true,
    });
    expect(instagramWebhookAccountProcessingDeduplication('cha_other000000000000001').id).not.toBe(
      instagramWebhookAccountProcessingDeduplication(ACCOUNT_PUBLIC_ID).id,
    );
  });

  it('adds the account job with the organization, a unique job id and the deduplication', async () => {
    await enqueueInstagramWebhookAccountProcessing({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      requestId: 'request-1',
    });
    await enqueueInstagramWebhookAccountProcessing({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      requestId: 'request-2',
    });

    expect(addMock).toHaveBeenCalledTimes(2);
    const [jobName, jobData, options] = addMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { jobId: string; deduplication: unknown },
    ];
    expect(jobName).toBe(INSTAGRAM_WEBHOOK_PROCESS_JOB_NAME);
    expect(jobData).toEqual({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      requestId: 'request-1',
    });
    expect(options.jobId).toMatch(new RegExp(`^instagram-webhook-events-${ACCOUNT_PUBLIC_ID}-`));
    // A stable job id would let a retained job drop every later add — each add gets its own.
    const secondOptions = addMock.mock.calls[1]?.[2] as { jobId: string } | undefined;
    expect(secondOptions?.jobId).not.toBe(options.jobId);
    expect(options.jobId).not.toContain(':');
    expect(options.deduplication).toEqual({
      id: `instagram-webhook-events-${ACCOUNT_PUBLIC_ID}`,
      keepLastIfActive: true,
    });
  });

  it('retries a job 5 times with exponential waits from 5 s and jitter (WH14)', async () => {
    await enqueueInstagramWebhookAccountProcessing({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
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
      removeOnComplete: { count: expect.any(Number), age: expect.any(Number) },
      removeOnFail: { count: expect.any(Number), age: expect.any(Number) },
    });
  });

  it('refuses a payload without the organization before anything reaches Redis', async () => {
    await expect(
      enqueueInstagramWebhookAccountProcessing({
        organizationPublicId: '',
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        requestId: 'request-1',
      }),
    ).rejects.toThrow();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('propagates a Redis failure to the caller (the receiver logs it, WH10)', async () => {
    addMock.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(
      enqueueInstagramWebhookAccountProcessing({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        requestId: 'request-1',
      }),
    ).rejects.toThrow('redis unavailable');
  });
});
