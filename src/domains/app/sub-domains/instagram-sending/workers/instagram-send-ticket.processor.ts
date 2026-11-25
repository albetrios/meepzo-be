import type { Job } from 'bullmq';
import {
  getWorkerDatabaseSlotLimiter,
  returnTicketWithoutTry,
  runWithDatabaseSlotTicketReturn,
  type WorkerDatabaseSlotLimiter,
} from '@/infrastructure/queue/worker-runtime/worker-database-slot-limiter.js';
import { getWorkerInstagramDatabaseSlots } from '@/shared/config/worker-concurrency.util.js';
import {
  INSTAGRAM_DATABASE_SLOT_LIMITER_NAME,
  SENDING_REFUSED_TICKET_DELAY_MILLISECONDS,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import type { InstagramSendTicketContext } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';

/**
 * The sending-state read every send ticket and Meta-calling task asks first (SN7, AC-17.21).
 *
 * @remarks
 * Notes: `SendingStateService` implements it (its answer kept a minute per process).
 */
export interface InstagramTicketSendingGate {
  mayTakeTickets(): Promise<boolean>;
}

/**
 * The process's Instagram database limiter (SN24, P91): one per process, shared by the send, intake
 * and task workers, sized by `WORKER_INSTAGRAM_DATABASE_SLOTS`.
 *
 * @remarks
 * - **Algorithm:** `getWorkerDatabaseSlotLimiter` under {@link INSTAGRAM_DATABASE_SLOT_LIMITER_NAME}.
 * - **Failure modes:** none past the limiter's own size check.
 * - **Side effects:** creates the limiter on first use.
 * - **Notes:** intake (ROUTE row R38) takes its slots from the same limiter.
 */
export function getInstagramDatabaseSlotLimiter(): WorkerDatabaseSlotLimiter {
  return getWorkerDatabaseSlotLimiter({
    name: INSTAGRAM_DATABASE_SLOT_LIMITER_NAME,
    size: getWorkerInstagramDatabaseSlots(),
  });
}

/**
 * Runs one Instagram send or task ticket's work under the two rules every ticket keeps (SN7, SN24):
 * the server must be allowed to take tickets, and every unit of work holds a database slot.
 *
 * @remarks
 * - **Algorithm:** (1) when `gate` is given, `mayTakeTickets()` (its answer kept a minute per
 *   process); `false` → the ticket goes back {@link SENDING_REFUSED_TICKET_DELAY_MILLISECONDS} later,
 *   no try used. (2) The work runs with a context whose `runInDatabaseSlot` takes a slot of the
 *   process limiter (2 s wait); a slot miss that reaches here puts the ticket back, no try used
 *   (AC-17.20).
 * - **Failure modes:** BullMQ's `DelayedError` after a ticket went back; the work's other errors
 *   propagate (the queue's one attempt, then the dead letter).
 * - **Side effects:** the job move and a log line when a ticket goes back; the work's own.
 * - **Notes:** the work must catch a slot miss itself once an outside effect happened (a message
 *   sent) — the result save waits again rather than give the ticket back (R42).
 */
export async function runInstagramTicket({
  job,
  token,
  queueName,
  gate,
  limiter = getInstagramDatabaseSlotLimiter(),
  work,
}: {
  job: Job;
  token: string | undefined;
  queueName: string;
  gate: InstagramTicketSendingGate | null;
  limiter?: WorkerDatabaseSlotLimiter;
  work: (context: InstagramSendTicketContext) => Promise<void>;
}): Promise<void> {
  if (gate !== null && !(await gate.mayTakeTickets())) {
    // A worker always passes its lock token; without one the ticket cannot be moved, so it fails
    // (one attempt) rather than run on a server that may not send.
    if (token === undefined) throw new Error('instagram send ticket refused without a lock token');
    await returnTicketWithoutTry({
      job,
      token,
      delayMilliseconds: SENDING_REFUSED_TICKET_DELAY_MILLISECONDS,
      logFields: { queueName },
      logMessage: 'app.instagram_send.ticket_refused',
    });
  }
  const context: InstagramSendTicketContext = {
    jobId: job.id ?? queueName,
    runInDatabaseSlot: (callback) => limiter.runInSlot({ callback }),
    returnTicket: async (delayMilliseconds) => {
      if (token === undefined)
        throw new Error('instagram send ticket returned without a lock token');
      return returnTicketWithoutTry({
        job,
        token,
        delayMilliseconds,
        logFields: { queueName },
        logMessage: 'app.instagram_send.ticket_returned',
      });
    },
  };
  await runWithDatabaseSlotTicketReturn({ job, token, queueName, callback: () => work(context) });
}
