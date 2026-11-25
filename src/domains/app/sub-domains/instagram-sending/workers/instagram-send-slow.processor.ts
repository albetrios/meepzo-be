import type { Job } from 'bullmq';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { InstagramLaneTurnWork } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { INSTAGRAM_SEND_SLOW_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-slow.queue.js';
import type { InstagramSendSlowJobData } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-slow.job.schema.js';
import {
  type InstagramTicketSendingGate,
  runInstagramTicket,
} from './instagram-send-ticket.processor.js';

/**
 * What the lane-turn worker needs: the sending gate and the lane turn's work (`null` until R42).
 *
 * @remarks
 * Notes: built by the worker registry from the worker composition root (`appDomain`).
 */
export interface InstagramSendSlowServices {
  sendingGate: InstagramTicketSendingGate;
  laneTurn: InstagramLaneTurnWork | null;
}

/**
 * Processes one lane turn's ticket on `instagram-send-slow` (SN2): the slow, reply or broadcast lane
 * of one account.
 *
 * @remarks
 * - **Algorithm:** with no lane-turn work wired yet (before ROUTE rows R42–R45) the ticket is logged
 *   and finished — no row is touched, so the lane stays as it was for the repair duty (R47). Else the
 *   ticket runs under {@link runInstagramTicket}: `mayTakeTickets` first (AC-17.21), every unit of
 *   work in a database slot (AC-17.20), then the work's `workLaneTurn` (claim, send, save, release).
 * - **Failure modes:** a ticket that goes back throws BullMQ's `DelayedError` (no try used); the
 *   work's errors propagate to the queue's one attempt and the dead letter.
 * - **Side effects:** the work's; an info log for an unwired ticket.
 * - **Notes:** never paused by the Instagram circuit — the lane's stops decide (SN2).
 */
export async function processInstagramSendSlowTicket({
  job,
  token,
  jobData,
  services,
}: {
  job: Job;
  token: string | undefined;
  jobData: InstagramSendSlowJobData;
  services: InstagramSendSlowServices;
}): Promise<void> {
  const { organizationPublicId, channelAccountPublicId, lane, turnNumber } = jobData;
  const { laneTurn } = services;
  if (laneTurn === null) {
    logger.info(
      { jobId: job.id, organizationPublicId, channelAccountPublicId, lane, turnNumber },
      'app.instagram_send.lane_turn.not_built',
    );
    return;
  }
  await runInstagramTicket({
    job,
    token,
    queueName: INSTAGRAM_SEND_SLOW_QUEUE_NAME,
    gate: services.sendingGate,
    work: (context) =>
      laneTurn.workLaneTurn({
        scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId }),
        ticket: { organizationPublicId, channelAccountPublicId, lane, turnNumber },
        context,
      }),
  });
}
