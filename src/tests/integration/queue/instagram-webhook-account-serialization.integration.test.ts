import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Job, Queue, Worker } from 'bullmq';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { getDefaultWorkerOptions } from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { instagramWebhookIntakeDeduplication } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';

/**
 * Against real BullMQ and Redis, with the deduplication the Instagram event-processing enqueue uses
 * (routes-final § 4.A WH5, WHC10): one account's processing never runs twice at once, on any
 * replica — so its events, read oldest first from Postgres, run strictly in order — while different
 * accounts run side by side, and events stored mid-run are picked up by exactly one follow-up job.
 */
type ProcessingTestJob = { instagramAccountPublicId: string; label: string };

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('Integration: Instagram event processing runs one job per account at a time', () => {
  const connection = getBullMQConnectionOptions();
  const workers: Worker[] = [];
  let queue: Queue<ProcessingTestJob>;

  beforeEach(async () => {
    queue = new Queue<ProcessingTestJob>(`test-instagram-webhook-${randomUUID()}`, {
      connection,
      prefix: getBullMQKeyPrefix(),
    });
    await queue.waitUntilReady();
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.close()));
    await queue.obliterate({ force: true });
    await queue.close();
  });

  function addProcessing(instagramAccountPublicId: string, label: string) {
    return queue.add(
      'process-instagram-webhook-events',
      { instagramAccountPublicId, label },
      {
        jobId: `instagram-webhook-events-${instagramAccountPublicId}-${randomUUID()}`,
        deduplication: instagramWebhookIntakeDeduplication({
          intakeKind: 'messages',
          channelAccountPublicId: instagramAccountPublicId,
        }),
      },
    );
  }

  it("collapses a burst of deliveries into one job while the account's job waits", async () => {
    await addProcessing('iga_burst', 'first');
    await addProcessing('iga_burst', 'second');
    await addProcessing('iga_burst', 'pick-up');
    await addProcessing('iga_other', 'other');

    const waiting = await queue.getJobs(['waiting']);
    expect(waiting.map((job) => job.data.label).sort()).toEqual(['first', 'other']);
  });

  it('never runs one account twice at once across two workers, runs other accounts side by side, and follows up once', async () => {
    const runs: string[] = [];
    const runningByAccount = new Map<string, number>();
    let mostRunningForOneAccount = 0;
    let mostRunningOverall = 0;
    let running = 0;
    let releaseFirstRun: () => void = () => {};
    const firstRunHeld = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });

    // Two replicas with four slots each: plenty of room to run one account twice.
    for (let replica = 0; replica < 2; replica += 1) {
      workers.push(
        new Worker<ProcessingTestJob>(
          queue.name,
          async (job: Job<ProcessingTestJob>) => {
            const account = job.data.instagramAccountPublicId;
            const accountRunning = (runningByAccount.get(account) ?? 0) + 1;
            runningByAccount.set(account, accountRunning);
            mostRunningForOneAccount = Math.max(mostRunningForOneAccount, accountRunning);
            running += 1;
            mostRunningOverall = Math.max(mostRunningOverall, running);
            runs.push(job.data.label);
            if (job.data.label === 'first') await firstRunHeld;
            running -= 1;
            runningByAccount.set(account, (runningByAccount.get(account) ?? 1) - 1);
          },
          {
            connection,
            prefix: getBullMQKeyPrefix(),
            concurrency: 4,
            ...getDefaultWorkerOptions(),
          },
        ),
      );
    }
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));

    await addProcessing('iga_live', 'first');
    await waitFor(() => runs.length === 1, 5_000);

    // Events arrive while the account's job runs: no second job for it may start now…
    await addProcessing('iga_live', 'stored-mid-run');
    await addProcessing('iga_live', 'stored-mid-run-again');
    // …while another account runs at once, beside it.
    await addProcessing('iga_neighbour', 'neighbour');
    await waitFor(() => runs.includes('neighbour'), 5_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runs).toEqual(['first', 'neighbour']);
    expect(mostRunningOverall).toBe(2);

    // …and exactly one follow-up runs once the first job finishes.
    releaseFirstRun();
    await waitFor(() => runs.length === 3, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runs).toEqual(['first', 'neighbour', 'stored-mid-run-again']);
    expect(mostRunningForOneAccount).toBe(1);
  }, 20_000);
});
