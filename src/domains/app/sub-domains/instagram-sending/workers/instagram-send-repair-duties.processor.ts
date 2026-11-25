import { UnrecoverableError } from 'bullmq';
import {
  type RepairDutyContext,
  type RepairDutyGate,
  type RepairDutyOutcome,
  type RepairDutyRound,
  runRepairDutyRound,
} from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';
import {
  BROADCAST_END_DUTY_JOB_NAME,
  type BroadcastEndDutyServices,
  runBroadcastEndDuty,
} from '@/domains/app/sub-domains/broadcast/workers/broadcast-end.processor.js';
import {
  BROADCAST_START_DUTY_JOB_NAME,
  runBroadcastStartDuty,
} from '@/domains/app/sub-domains/broadcast/workers/broadcast-start.processor.js';
import type { BroadcastSendQueuePort } from '@/domains/app/sub-domains/broadcast/broadcast.types.js';
import { INSTAGRAM_SENDING_REPAIR_SETTINGS } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import { InstagramSendingRepairService } from '@/domains/app/sub-domains/instagram-sending/instagram-sending-repair.service.js';
import { InstagramSendGateService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-gate.service.js';
import type { InstagramMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.service.js';
import type { InstagramSendLaneService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.service.js';
import type { MessageMonthNoticeService } from '@/domains/app/sub-domains/instagram-sending/message-month-notice.service.js';
import { addMissingInstagramSendFastMessages } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-fast.queue.js';
import { addMissingInstagramSendLaneTurns } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-slow.queue.js';
import type { ChannelSendingPorts } from '@/domains/app/app.channel-ports.js';
import type { BroadcastRecipientService } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.service.js';
import { getInstagramDatabaseSlotLimiter } from './instagram-send-ticket.processor.js';

/**
 * The sending repair duties that ride the task queue `instagram-tasks` (feat-instagram-dm-sending
 * § 6 SN6, SNC5; P94), each its own repeat job, by job name: WC-13 lost turns, WC-14 stuck sends,
 * WC-15 the 7-day expiry, WC-17 closed windows, WC-18 the reply trim, WC-19 the paused cancel,
 * WC-20 the send counts, and 7's broadcast start and end (WC-28, WC-29).
 *
 * @remarks
 * Notes: each is its own scheduler in `scheduler.ts` (`instagram-<job name>`), every minute.
 */
export const INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES = {
  LOST_TURNS: 'repair-lost-turns',
  STUCK_SENDS: 'repair-stuck-sends',
  EXPIRY: 'repair-expiry',
  CLOSED_WINDOWS: 'repair-closed-windows',
  REPLY_TRIM: 'repair-reply-trim',
  PAUSED_CANCEL: 'repair-paused-cancel',
  COUNTS: 'repair-counts',
  BROADCAST_START: BROADCAST_START_DUTY_JOB_NAME,
  BROADCAST_END: BROADCAST_END_DUTY_JOB_NAME,
} as const;

/**
 * Every job name of {@link INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES}.
 *
 * @remarks
 * Notes: the task worker routes a job by it before it reads a task's payload.
 */
export const INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAME_SET: ReadonlySet<string> = new Set(
  Object.values(INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES),
);

/**
 * The cron of every one of them: every minute (SN6).
 *
 * @remarks
 * Notes: the tag pick-up and the open-run key repair use it too.
 */
export const INSTAGRAM_SEND_REPAIR_DUTY_CRON = '* * * * *';

/**
 * What the duties on `instagram-tasks` are built from (the worker composition root).
 *
 * @remarks
 * Notes: `broadcastSendQueue` is R46's port — absent, the start duty starts nothing.
 */
export interface InstagramSendRepairDutyServices {
  sendingGate: RepairDutyGate;
  repairService: InstagramSendingRepairService;
  broadcastSendQueue?: BroadcastSendQueuePort | undefined;
  broadcastEnd: BroadcastEndDutyServices;
}

/** The duty's work for its round, by job name. */
function dutyWork({
  duty,
  services,
}: {
  duty: string;
  services: InstagramSendRepairDutyServices;
}): ((context: RepairDutyContext) => Promise<RepairDutyOutcome>) | null {
  const repair = services.repairService;
  switch (duty) {
    case INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES.LOST_TURNS:
      return (context) => repair.repairLostTurns(context);
    case INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES.STUCK_SENDS:
      return (context) => repair.settleStuckSends(context);
    case INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES.EXPIRY:
      return (context) => repair.expireWaitingMessages(context);
    case INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES.CLOSED_WINDOWS:
      return (context) => repair.skipClosedWindows(context);
    case INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES.REPLY_TRIM:
      return (context) => repair.trimReplyBacklog(context);
    case INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES.PAUSED_CANCEL:
      return (context) => repair.cancelPausedAutomationMessages(context);
    case INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES.COUNTS:
      return (context) =>
        repair.keepSendCounts({
          ...context,
          isDailyCheck:
            context.now.getUTCHours() ===
              INSTAGRAM_SENDING_REPAIR_SETTINGS.dailyMonthCheckHourUtc &&
            context.now.getUTCMinutes() === 0,
        });
    case INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES.BROADCAST_START:
      return (context) =>
        runBroadcastStartDuty({
          context,
          sendQueue: services.broadcastSendQueue,
          runInDatabaseSlot: services.broadcastEnd.runInDatabaseSlot,
        });
    case INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES.BROADCAST_END:
      return (context) => runBroadcastEndDuty({ context, services: services.broadcastEnd });
    default:
      return null;
  }
}

/**
 * Runs one round of one sending repair duty (feat-instagram-dm-sending § 6 SN6, SNC5; P94; R37's
 * gate): the duty named by the job, after `mayTakeTickets`, until its 40 s budget is spent.
 *
 * @remarks
 * - **Algorithm:** the duty's work by `duty` (the job name), then `runRepairDutyRound` — the gate,
 *   the budget, the round time and backlog metrics.
 * - **Failure modes:** a job name no duty owns is our fault → `UnrecoverableError` (dead letter at
 *   once); the duty's errors propagate (the next minute's run starts afresh).
 * - **Side effects:** the duty's.
 * - **Notes:** the jobs carry no payload (cross-organization reads by ids, SN6); routed here by the
 *   task worker before a task's payload is read.
 */
export async function runInstagramSendRepairDuty({
  duty,
  services,
}: {
  duty: string;
  services: InstagramSendRepairDutyServices;
}): Promise<RepairDutyRound> {
  const work = dutyWork({ duty, services });
  if (work === null) {
    throw new UnrecoverableError(`instagram send repair duty ${duty} is not known`);
  }
  return runRepairDutyRound({ duty, run: work, gate: services.sendingGate });
}

/**
 * Builds the services of the duties on `instagram-tasks` from the worker composition root
 * (`appDomain`): the repair service over the message service, gate 1's count read, the queues'
 * "add missing" producers and the process's Instagram database limiter (SN24).
 *
 * @remarks
 * Algorithm: wiring only. Failure modes: none. Side effects: none. Notes: `broadcastSendQueue` is
 * R46's `BroadcastSendQueuePort` (`app.tasks.ts`); without it the start duty starts nothing.
 */
export function createInstagramSendRepairDutyServices({
  sendingGate,
  messageService,
  laneService,
  monthNotice,
  recipientService,
  sendingPorts,
  broadcastSendQueue,
}: {
  sendingGate: RepairDutyGate;
  messageService: Pick<InstagramMessageService, 'saveSendResult' | 'settleWaitingMessages'>;
  laneService: InstagramSendLaneService;
  monthNotice: MessageMonthNoticeService;
  recipientService: Pick<BroadcastRecipientService, 'skipBroadcastWaitingRecipients'>;
  sendingPorts: ChannelSendingPorts;
  broadcastSendQueue?: BroadcastSendQueuePort | undefined;
}): InstagramSendRepairDutyServices {
  const runInDatabaseSlot = <T>(callback: () => Promise<T>): Promise<T> =>
    getInstagramDatabaseSlotLimiter().runInSlot({ callback });
  return {
    sendingGate,
    repairService: new InstagramSendingRepairService({
      messageService,
      gateService: new InstagramSendGateService({ laneService, monthNotice }),
      addLaneTurns: addMissingInstagramSendLaneTurns,
      addFastMessages: addMissingInstagramSendFastMessages,
      runInDatabaseSlot,
    }),
    broadcastSendQueue,
    broadcastEnd: { recipientService, sendingPorts, runInDatabaseSlot },
  };
}
