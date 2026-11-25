import type { Job } from 'bullmq';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { InstagramFastMessageWork } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { INSTAGRAM_SEND_FAST_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-fast.queue.js';
import type { InstagramSendFastJobData } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-fast.job.schema.js';
import {
  type InstagramTicketSendingGate,
  runInstagramTicket,
} from './instagram-send-ticket.processor.js';

/**
 * What the fast-message worker needs: the sending gate and the fast send's work (`null` until R42).
 *
 * @remarks
 * Notes: built by the worker registry from the worker composition root (`appDomain`).
 */
export interface InstagramSendFastServices {
  sendingGate: InstagramTicketSendingGate;
  fastMessage: InstagramFastMessageWork | null;
}

/**
 * Processes one fast message's ticket on `instagram-send-fast` (SN2).
 *
 * @remarks
 * - **Algorithm:** with no fast-send work wired yet (before ROUTE rows R42 / R44) the ticket is
 *   logged and finished — the message stays `waiting` for the repair duty (R47). Else the ticket runs
 *   under {@link runInstagramTicket}: `mayTakeTickets` first (AC-17.21), every unit of work in a
 *   database slot (AC-17.20), then the work's `sendFastMessage`.
 * - **Failure modes:** a ticket that goes back throws BullMQ's `DelayedError` (no try used); the
 *   work's errors propagate to the queue's one attempt and the dead letter.
 * - **Side effects:** the work's; an info log for an unwired ticket.
 * - **Notes:** never paused by the Instagram circuit (SN2); the per-account and per-organization
 *   in-flight caps are the work's (R44, S21).
 */
export async function processInstagramSendFastTicket({
  job,
  token,
  jobData,
  services,
}: {
  job: Job;
  token: string | undefined;
  jobData: InstagramSendFastJobData;
  services: InstagramSendFastServices;
}): Promise<void> {
  const {
    organizationPublicId,
    channelAccountPublicId,
    instagramMessagePublicId,
    automationRunStartedAt,
    tries,
  } = jobData;
  const { fastMessage } = services;
  if (fastMessage === null) {
    logger.info(
      { jobId: job.id, organizationPublicId, channelAccountPublicId, instagramMessagePublicId },
      'app.instagram_send.fast_message.not_built',
    );
    return;
  }
  await runInstagramTicket({
    job,
    token,
    queueName: INSTAGRAM_SEND_FAST_QUEUE_NAME,
    gate: services.sendingGate,
    work: (context) =>
      fastMessage.sendFastMessage({
        ticket: {
          organizationPublicId,
          channelAccountPublicId,
          instagramMessagePublicId,
          automationRunStartedAt,
          tries,
        },
        context,
      }),
  });
}
