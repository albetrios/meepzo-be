import { type Job, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { parseJobDataOrDeadLetter } from '@/infrastructure/queue/dlq/poison-job.util.js';
import { returnTicketWithoutTry } from '@/infrastructure/queue/worker-runtime/worker-database-slot-limiter.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  INSTAGRAM_DATABASE_TASKS_PER_ORGANIZATION_MAX,
  INSTAGRAM_TASK_ORGANIZATION_CAP_DELAY_MILLISECONDS,
  INSTAGRAM_TASKS_PER_ORGANIZATION_MAX,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import type { InstagramTaskHandler } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { INSTAGRAM_DATABASE_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-database-tasks.queue.js';
import { INSTAGRAM_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import {
  type InstagramTicketSendingGate,
  runInstagramTicket,
} from './instagram-send-ticket.processor.js';

/**
 * One of the two task queues (scale review S19, P97): its name, whether its tasks call Meta, and
 * how many tasks of one organization one process works at once.
 *
 * @remarks
 * Notes: a handler registered for the other kind is refused on this queue (dead letter) — the
 * split only holds when every task runs on its own queue.
 */
export interface InstagramTaskQueueKind {
  queueName: string;
  callsMeta: boolean;
  organizationMax: number;
}

/**
 * `instagram-tasks`: the Meta-calling tasks (set-up, starter questions, uploads, profile reads).
 *
 * @remarks
 * Notes: behind the sending gate; at most `INSTAGRAM_TASKS_PER_ORGANIZATION_MAX` of one
 * organization per process.
 */
export const INSTAGRAM_META_TASK_QUEUE: InstagramTaskQueueKind = {
  queueName: INSTAGRAM_TASKS_QUEUE_NAME,
  callsMeta: true,
  organizationMax: INSTAGRAM_TASKS_PER_ORGANIZATION_MAX,
};

/**
 * `instagram-database-tasks`: the database-heavy tasks (bulk changes, counts, audiences, retry).
 *
 * @remarks
 * Notes: no sending gate (no Meta call); at most `INSTAGRAM_DATABASE_TASKS_PER_ORGANIZATION_MAX` of
 * one organization per process.
 */
export const INSTAGRAM_DATABASE_TASK_QUEUE: InstagramTaskQueueKind = {
  queueName: INSTAGRAM_DATABASE_TASKS_QUEUE_NAME,
  callsMeta: false,
  organizationMax: INSTAGRAM_DATABASE_TASKS_PER_ORGANIZATION_MAX,
};

/**
 * The per-organization cap of one task worker (S19): how many tasks of each organization this
 * process works now.
 *
 * @remarks
 * - **Algorithm:** an in-process count per organization public id; `tryTake` adds one while under
 *   the queue's maximum, `give` takes it back (and forgets an organization at 0).
 * - **Failure modes:** none.
 * - **Side effects:** the in-memory map only.
 * - **Notes:** per process, like the database limiter (SN24): with `n` worker processes an
 *   organization holds at most `n × max` places of the queue. One per worker (`create…Worker`).
 */
export class InstagramTaskOrganizationCap {
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Takes one place for the organization; `false` when it already holds the maximum. */
  tryTake(organizationPublicId: string): boolean {
    const held = this.inFlight.get(organizationPublicId) ?? 0;
    if (held >= this.max) return false;
    this.inFlight.set(organizationPublicId, held + 1);
    return true;
  }

  /** Gives one place back. */
  give(organizationPublicId: string): void {
    const held = (this.inFlight.get(organizationPublicId) ?? 1) - 1;
    if (held <= 0) this.inFlight.delete(organizationPublicId);
    else this.inFlight.set(organizationPublicId, held);
  }
}

/**
 * What a task worker needs: the sending gate, the registered task handlers by job name and its
 * per-organization cap.
 *
 * @remarks
 * Notes: built by the worker registry from the worker composition root (`appDomain`); the cap by
 * the worker. Without a cap (a unit test) no organization is held back.
 */
export interface InstagramTasksServices {
  sendingGate: InstagramTicketSendingGate;
  taskHandlers: Readonly<Record<string, InstagramTaskHandler>>;
  organizationCap?: InstagramTaskOrganizationCap | undefined;
}

/**
 * Processes one task (SN2, S19): the handler its owner registered under the job name, on the queue
 * of its kind, within its organization's cap.
 *
 * @remarks
 * - **Algorithm:** finds the handler by `job.name`; a handler of the other kind (Meta-calling on the
 *   database queue or the reverse) is refused; validates `taskInput` with the handler's schema (a
 *   mismatch is dead-lettered at once); the organization's cap — over it, the ticket goes back
 *   {@link INSTAGRAM_TASK_ORGANIZATION_CAP_DELAY_MILLISECONDS} later, no try used; then runs it
 *   under {@link runInstagramTicket} — with the `mayTakeTickets` gate when the task calls Meta
 *   (AC-17.21), every unit of work in a database slot (AC-17.20) — and gives the place back.
 * - **Failure modes:** a job name with no handler, or on the wrong queue, is our fault →
 *   `UnrecoverableError` (dead letter at once, one alert) — no owner adds a task before its handler
 *   is registered; a ticket that goes back throws `DelayedError`; the handler's errors propagate.
 * - **Side effects:** the handler's.
 * - **Notes:** `queue` defaults to the Meta-calling `instagram-tasks`.
 */
export async function processInstagramTaskTicket({
  job,
  token,
  jobData,
  services,
  queue = INSTAGRAM_META_TASK_QUEUE,
}: {
  job: Job;
  token: string | undefined;
  jobData: { organizationPublicId: string };
  services: InstagramTasksServices;
  queue?: InstagramTaskQueueKind;
}): Promise<void> {
  const { organizationPublicId } = jobData;
  const handler = services.taskHandlers[job.name];
  if (handler === undefined || handler.callsMeta !== queue.callsMeta) {
    logger.error(
      { jobId: job.id, jobName: job.name, organizationPublicId, queueName: queue.queueName },
      handler === undefined ? 'app.instagram_task.no_handler' : 'app.instagram_task.wrong_queue',
    );
    throw new UnrecoverableError(`instagram task ${job.name} has no handler on ${queue.queueName}`);
  }
  const { taskInput } = await parseJobDataOrDeadLetter({
    schema: z.object({ organizationPublicId: z.string(), taskInput: handler.inputSchema }),
    job,
    queueName: queue.queueName,
  });
  const cap = services.organizationCap;
  if (cap !== undefined && !cap.tryTake(organizationPublicId)) {
    if (token === undefined) throw new Error('instagram task held back without a lock token');
    await returnTicketWithoutTry({
      job,
      token,
      delayMilliseconds: INSTAGRAM_TASK_ORGANIZATION_CAP_DELAY_MILLISECONDS,
      logFields: { queueName: queue.queueName, organizationPublicId },
      logMessage: 'app.instagram_task.organization_cap',
    });
  }
  try {
    await runInstagramTicket({
      job,
      token,
      queueName: queue.queueName,
      gate: handler.callsMeta ? services.sendingGate : null,
      work: (context) => handler.run({ organizationPublicId, taskInput, context }),
    });
  } finally {
    cap?.give(organizationPublicId);
  }
}
