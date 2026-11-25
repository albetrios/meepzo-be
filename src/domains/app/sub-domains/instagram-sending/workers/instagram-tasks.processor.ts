import { type Job, UnrecoverableError } from 'bullmq';
import { parseJobDataOrDeadLetter } from '@/infrastructure/queue/dlq/poison-job.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { InstagramTaskHandler } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { INSTAGRAM_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import {
  type InstagramTaskJobData,
  instagramTaskJobDataSchema,
} from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.job.schema.js';
import {
  type InstagramTicketSendingGate,
  runInstagramTicket,
} from './instagram-send-ticket.processor.js';

/**
 * What the task worker needs: the sending gate and the registered task handlers by job name.
 *
 * @remarks
 * Notes: built by the worker registry from the worker composition root (`appDomain`).
 */
export interface InstagramTasksServices {
  sendingGate: InstagramTicketSendingGate;
  taskHandlers: Readonly<Record<string, InstagramTaskHandler>>;
}

/**
 * Processes one task on `instagram-tasks` (SN2): the handler its owner registered under the job name.
 *
 * @remarks
 * - **Algorithm:** finds the handler by `job.name`; validates `taskInput` with the handler's schema
 *   (a mismatch is dead-lettered at once); runs it under {@link runInstagramTicket} — with the
 *   `mayTakeTickets` gate when the task calls Meta (AC-17.21), and every unit of work in a database
 *   slot (AC-17.20).
 * - **Failure modes:** a job name with no handler is our fault → `UnrecoverableError` (dead letter at
 *   once, one alert) — no owner adds a task before its handler is registered (R40, R41, R46); a
 *   ticket that goes back throws `DelayedError`; the handler's errors propagate.
 * - **Side effects:** the handler's.
 * - **Notes:** the split into Meta-calling and database-heavy work with a per-organization cap is
 *   ROUTE row R46's (S19).
 */
export async function processInstagramTaskTicket({
  job,
  token,
  jobData,
  services,
}: {
  job: Job;
  token: string | undefined;
  jobData: InstagramTaskJobData;
  services: InstagramTasksServices;
}): Promise<void> {
  const handler = services.taskHandlers[job.name];
  if (handler === undefined) {
    logger.error(
      { jobId: job.id, jobName: job.name, organizationPublicId: jobData.organizationPublicId },
      'app.instagram_task.no_handler',
    );
    throw new UnrecoverableError(`instagram task ${job.name} has no handler`);
  }
  const { taskInput } = await parseJobDataOrDeadLetter({
    schema: instagramTaskJobDataSchema.extend({ taskInput: handler.inputSchema }),
    job,
    queueName: INSTAGRAM_TASKS_QUEUE_NAME,
  });
  await runInstagramTicket({
    job,
    token,
    queueName: INSTAGRAM_TASKS_QUEUE_NAME,
    gate: handler.callsMeta ? services.sendingGate : null,
    work: (context) =>
      handler.run({ organizationPublicId: jobData.organizationPublicId, taskInput, context }),
  });
}
