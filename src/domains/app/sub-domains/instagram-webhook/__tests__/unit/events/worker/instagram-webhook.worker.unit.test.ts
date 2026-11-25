import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The intake worker's wiring (feat-instagram-dm-sending § 5 WH5, WH25, WHC4, WHC16): the
 * `instagram-webhook` queue on a **plain** BullMQ worker (never provider-pausable), the family's
 * concurrency, each payload validated (poison dead-lettered) before its processor sees it, the trace
 * propagated, the process's database limiter passed on, and the job names routed: the three kind
 * groups, the tag intake and the stuck-event pick-up.
 */

const workerState = vi.hoisted(() => ({
  queueName: undefined as string | undefined,
  processor: undefined as ((job: unknown) => Promise<unknown>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  listeners: new Map<string, (...arguments_: unknown[]) => void>(),
  providerPausableCalls: 0,
}));

const { parseJobDataMock, intakeJobMock, tagIntakeJobMock, runReclaimJobMock, traceMock } =
  vi.hoisted(() => ({
    parseJobDataMock: vi.fn(),
    intakeJobMock: vi.fn(),
    tagIntakeJobMock: vi.fn(),
    runReclaimJobMock: vi.fn(),
    traceMock: vi.fn(),
  }));

vi.mock('bullmq', () => ({
  Worker: class {
    constructor(
      queueName: string,
      processor: (job: unknown) => Promise<unknown>,
      options: Record<string, unknown>,
    ) {
      workerState.queueName = queueName;
      workerState.processor = processor;
      workerState.options = options;
    }
    on(event: string, listener: (...arguments_: unknown[]) => void) {
      workerState.listeners.set(event, listener);
    }
    close = vi.fn();
  },
}));

vi.mock('@/infrastructure/queue/worker-runtime/provider-outage-pause.util.js', () => ({
  createProviderPausableWorker: () => {
    workerState.providerPausableCalls += 1;
    throw new Error('intake must never be provider-pausable (WH25)');
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
  '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook-intake.processor.js',
  () => ({
    processInstagramWebhookIntakeJob: (...arguments_: unknown[]) => intakeJobMock(...arguments_),
  }),
);

vi.mock(
  '@/domains/app/sub-domains/instagram-webhook/workers/instagram-tag-event-intake.processor.js',
  () => ({
    processInstagramTagEventIntakeJob: (...arguments_: unknown[]) =>
      tagIntakeJobMock(...arguments_),
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
  intakeKind: 'comments',
  requestId: 'delivery-1',
  traceparent: '00-trace-span-01',
};

const TAG_JOB_DATA = {
  organizationPublicId: 'org_acmeshop0000000000001',
  contactPublicIds: ['con_acmeshop0000000000001'],
};

const enqueueProfileRead = vi.fn();
const services = {
  intake: { automationRunService: {} },
  tagIntake: { automationRunService: {} },
  enqueueProfileRead,
} as never;
const limiter = { runInSlot: vi.fn() } as never;

beforeEach(async () => {
  workerState.listeners.clear();
  parseJobDataMock.mockReset();
  parseJobDataMock.mockResolvedValue(JOB_DATA);
  intakeJobMock.mockReset();
  intakeJobMock.mockResolvedValue({ outcome: 'drained' });
  tagIntakeJobMock.mockReset();
  tagIntakeJobMock.mockResolvedValue({ doneCount: 1 });
  runReclaimJobMock.mockReset();
  runReclaimJobMock.mockResolvedValue({ listedCount: 0, addedCount: 0, failedAddCount: 0 });
  traceMock.mockReset();
  traceMock.mockImplementation(({ callback }: { callback: () => Promise<unknown> }) => callback());
  const { createInstagramWebhookWorker } = await import(
    '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook.worker.js'
  );
  createInstagramWebhookWorker({ services, limiter });
});

describe('instagram-webhook.worker', () => {
  it('runs a plain worker on the instagram-webhook queue at the family concurrency — never paused by an outage', () => {
    expect(workerState.queueName).toBe('instagram-webhook');
    expect(workerState.providerPausableCalls).toBe(0);
    expect(workerState.options).toMatchObject({
      concurrency: 6,
      connection: { host: 'redis.test' },
      prefix: 'test:bull',
    });
    expect(workerState.listeners.has('stalled')).toBe(true);
  });

  it.each(['intake-messages', 'intake-live', 'intake-comments'])(
    'validates %s and runs the kind group’s intake under its trace, with the limiter',
    async (name) => {
      const job = { id: 'job-7', name, data: JOB_DATA };

      await expect(workerState.processor?.(job)).resolves.toEqual({ outcome: 'drained' });

      expect(parseJobDataMock).toHaveBeenCalledWith(
        expect.objectContaining({ job, queueName: 'instagram-webhook' }),
      );
      expect(traceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          carrier: { traceparent: '00-trace-span-01', tracestate: undefined },
          spanName: name,
        }),
      );
      expect(intakeJobMock).toHaveBeenCalledWith({
        jobData: JOB_DATA,
        services: (services as { intake: unknown }).intake,
        jobId: 'job-7',
        enqueueProfileRead,
        limiter,
      });
      expect(tagIntakeJobMock).not.toHaveBeenCalled();
    },
  );

  it('routes intake-tag-events to the tag intake', async () => {
    parseJobDataMock.mockResolvedValueOnce(TAG_JOB_DATA);
    const job = { id: 'job-9', name: 'intake-tag-events', data: TAG_JOB_DATA };

    await workerState.processor?.(job);

    expect(tagIntakeJobMock).toHaveBeenCalledWith({
      jobData: TAG_JOB_DATA,
      services: (services as { tagIntake: unknown }).tagIntake,
      jobId: 'job-9',
      limiter,
    });
    expect(intakeJobMock).not.toHaveBeenCalled();
  });

  it('routes the stuck-event pick-up on its job name, without a payload', async () => {
    const job = { id: 'repeat:1', name: 'reclaim-instagram-webhook-events', data: {} };

    await workerState.processor?.(job);

    expect(runReclaimJobMock).toHaveBeenCalledWith({ requestId: 'repeat:1' });
    expect(parseJobDataMock).not.toHaveBeenCalled();
    expect(intakeJobMock).not.toHaveBeenCalled();
  });

  it('never processes a poison payload — the dead-letter path throws first', async () => {
    parseJobDataMock.mockRejectedValueOnce(new Error('dead-lettered'));
    const job = { id: 'job-8', name: 'intake-messages', data: { bad: true } };

    await expect(workerState.processor?.(job)).rejects.toThrow('dead-lettered');
    expect(intakeJobMock).not.toHaveBeenCalled();
  });
});
