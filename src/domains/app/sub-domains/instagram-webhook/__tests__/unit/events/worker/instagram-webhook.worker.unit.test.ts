import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The event-processing worker's wiring (routes-final § 4.A WH5, WHC10–WHC11): the `instagram-webhook`
 * queue, provider-pausable on the `instagram` circuit, the family's concurrency, the payload
 * validated (poison dead-lettered) before the processor sees it, the trace propagated, and the
 * stuck-event pick-up routed on `job.name`.
 */

const workerState = vi.hoisted(() => ({
  queueName: undefined as string | undefined,
  provider: undefined as string | undefined,
  processor: undefined as ((job: unknown) => Promise<unknown>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  listeners: new Map<string, (...arguments_: unknown[]) => void>(),
}));

const { parseJobDataMock, processAccountJobMock, runReclaimJobMock, traceMock } = vi.hoisted(
  () => ({
    parseJobDataMock: vi.fn(),
    processAccountJobMock: vi.fn(),
    runReclaimJobMock: vi.fn(),
    traceMock: vi.fn(),
  }),
);

vi.mock('@/infrastructure/queue/worker-runtime/provider-outage-pause.util.js', () => ({
  createProviderPausableWorker: (options: {
    queueName: string;
    provider: string;
    processor: (job: unknown) => Promise<unknown>;
    workerOptions: Record<string, unknown>;
  }) => {
    workerState.queueName = options.queueName;
    workerState.provider = options.provider;
    workerState.processor = options.processor;
    workerState.options = options.workerOptions;
    return {
      on: (event: string, listener: (...arguments_: unknown[]) => void) => {
        workerState.listeners.set(event, listener);
      },
      close: vi.fn(),
    };
  },
}));

vi.mock('@/infrastructure/queue/connection.js', () => ({
  getBullMQKeyPrefix: () => 'test:bull',
  getBullMQConnectionOptions: () => ({ host: 'redis.test' }),
  getBullMQProducerConnectionOptions: () => ({ host: 'redis.test' }),
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-close.util.js', () => ({
  buildWorkerHandle: ({ worker, queueName }: { worker: unknown; queueName: string }) => ({
    worker,
    queueName,
    close: async () => undefined,
  }),
}));

vi.mock('@/infrastructure/queue/dlq/poison-job.util.js', () => ({
  parseJobDataOrDeadLetter: (...arguments_: unknown[]) => parseJobDataMock(...arguments_),
}));

vi.mock('@/infrastructure/observability/tracing/trace-context.util.js', () => ({
  captureTraceContextForPropagation: () => ({}),
  runWithPropagatedTraceContext: (...arguments_: unknown[]) => traceMock(...arguments_),
}));

vi.mock(
  '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook.processor.js',
  () => ({
    processInstagramWebhookAccountJob: (...arguments_: unknown[]) =>
      processAccountJobMock(...arguments_),
  }),
);

vi.mock(
  '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook-reclaim.processor.js',
  () => ({
    runInstagramWebhookReclaimJob: (...arguments_: unknown[]) => runReclaimJobMock(...arguments_),
  }),
);

vi.mock('@/shared/config/env.config.js', () => ({
  env: { WORKER_CONCURRENCY_INSTAGRAM: 6, WORKER_CONCURRENCY: 4, LOG_LEVEL: 'silent' },
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const JOB_DATA = {
  organizationPublicId: 'org_acmeshop0000000000001',
  channelAccountPublicId: 'cha_acmeshop0000000000001',
  requestId: 'delivery-1',
  traceparent: '00-trace-span-01',
};

const services = { automationRunService: {} } as never;

beforeEach(async () => {
  workerState.listeners.clear();
  parseJobDataMock.mockReset();
  parseJobDataMock.mockResolvedValue(JOB_DATA);
  processAccountJobMock.mockReset();
  processAccountJobMock.mockResolvedValue({ outcome: 'drained' });
  runReclaimJobMock.mockReset();
  runReclaimJobMock.mockResolvedValue({ listedCount: 0, addedCount: 0, failedAddCount: 0 });
  traceMock.mockReset();
  traceMock.mockImplementation(({ callback }: { callback: () => Promise<unknown> }) => callback());
  const { createInstagramWebhookWorker } = await import(
    '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook.worker.js'
  );
  createInstagramWebhookWorker(services);
});

describe('instagram-webhook.worker', () => {
  it('runs on the instagram-webhook queue, pausing for the instagram provider, at the family concurrency', () => {
    expect(workerState.queueName).toBe('instagram-webhook');
    expect(workerState.provider).toBe('meta');
    expect(workerState.options).toMatchObject({
      concurrency: 6,
      connection: { host: 'redis.test' },
    });
    expect(workerState.listeners.has('stalled')).toBe(true);
  });

  it('validates the payload, then processes the account job under its trace', async () => {
    const job = { id: 'job-7', name: 'process-instagram-webhook-events', data: JOB_DATA };

    await expect(workerState.processor?.(job)).resolves.toEqual({ outcome: 'drained' });

    expect(parseJobDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ job, queueName: 'instagram-webhook' }),
    );
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        carrier: { traceparent: '00-trace-span-01', tracestate: undefined },
        spanName: 'process-instagram-webhook-events',
      }),
    );
    expect(processAccountJobMock).toHaveBeenCalledWith({
      jobData: JOB_DATA,
      services,
      jobId: 'job-7',
    });
    expect(runReclaimJobMock).not.toHaveBeenCalled();
  });

  it('routes the stuck-event pick-up on its job name, without a payload', async () => {
    const job = { id: 'repeat:1', name: 'reclaim-instagram-webhook-events', data: {} };

    await workerState.processor?.(job);

    expect(runReclaimJobMock).toHaveBeenCalledWith({ requestId: 'repeat:1' });
    expect(parseJobDataMock).not.toHaveBeenCalled();
    expect(processAccountJobMock).not.toHaveBeenCalled();
  });

  it('never processes a poison payload — the dead-letter path throws first', async () => {
    parseJobDataMock.mockRejectedValueOnce(new Error('dead-lettered'));
    const job = { id: 'job-8', name: 'process-instagram-webhook-events', data: { bad: true } };

    await expect(workerState.processor?.(job)).rejects.toThrow('dead-lettered');
    expect(processAccountJobMock).not.toHaveBeenCalled();
  });
});
