import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import {
  REPAIR_DUTY_PIECE_SIZE,
  type RepairDutyContext,
  type RepairDutyOutcome,
  runRepairDutyPieces,
} from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';
import {
  runGlobalRetentionWorkerJob,
  runOrganizationScopedWorkerJob,
  type WorkerDatabaseHandle,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { notifyOrganizationKind } from '@/domains/notify/sub-domains/notification/notification-notice.service.js';
import type { ChannelSendingPorts } from '@/domains/app/app.channel-ports.js';
import type { ChannelAccountChannel } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import {
  type BroadcastDutyRow,
  BroadcastRepository,
} from '@/domains/app/sub-domains/broadcast/broadcast.repository.js';
import type { BroadcastRecipientService } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.service.js';

/**
 * The job name of the end duty (WC-29), one repeat job of its own (P94).
 *
 * @remarks
 * Notes: scheduled every minute on the task queue `instagram-tasks` (`scheduler.ts`).
 */
export const BROADCAST_END_DUTY_JOB_NAME = 'repair-broadcast-end';

/**
 * What the end duty is built from.
 *
 * @remarks
 * Notes: `notifyDone` defaults to notify's `notifyOrganizationKind`; tests pass a fake.
 */
export interface BroadcastEndDutyServices {
  recipientService: Pick<BroadcastRecipientService, 'skipBroadcastWaitingRecipients'>;
  sendingPorts: ChannelSendingPorts;
  runInDatabaseSlot<T>(callback: () => Promise<T>): Promise<T>;
  notifyDone?: typeof notifyOrganizationKind | undefined;
}

/** A cancelled broadcast's piece: its waiting recipients skipped, their waiting messages cancelled. */
async function settleCancelledPiece({
  broadcast,
  databaseHandle,
  services,
}: {
  broadcast: BroadcastDutyRow;
  databaseHandle: WorkerDatabaseHandle;
  services: BroadcastEndDutyServices;
}): Promise<{ done: number; isFull: boolean }> {
  const organizationId = Number(broadcast.organization_id);
  const broadcastId = Number(broadcast.broadcast_id);
  const reason =
    broadcast.cancel_reason === 'plan_feature_off' ? 'plan_feature_off' : 'broadcast_cancelled';
  const skipped = await services.recipientService.skipBroadcastWaitingRecipients({
    databaseHandle,
    organizationId,
    broadcastId,
    reason,
    limit: REPAIR_DUTY_PIECE_SIZE,
  });
  const port = services.sendingPorts[broadcast.channel as ChannelAccountChannel];
  const cancelled =
    (await port?.cancelWaitingMessages({
      databaseHandle,
      organizationId,
      by: 'broadcast',
      id: broadcastId,
      reason,
      limit: REPAIR_DUTY_PIECE_SIZE,
    })) ?? 0;
  return {
    done: skipped + cancelled,
    isFull: skipped === REPAIR_DUTY_PIECE_SIZE || cancelled === REPAIR_DUTY_PIECE_SIZE,
  };
}

/** A finished broadcast's `done` and its in-app notice ("broadcast done", UN kind 12). */
async function endFinished({
  broadcast,
  databaseHandle,
  services,
}: {
  broadcast: BroadcastDutyRow;
  databaseHandle: WorkerDatabaseHandle;
  services: BroadcastEndDutyServices;
}): Promise<number> {
  const done = await new BroadcastRepository(databaseHandle).markDone({
    organizationId: Number(broadcast.organization_id),
    broadcastId: Number(broadcast.broadcast_id),
  });
  if (done === null) return 0;
  await (services.notifyDone ?? notifyOrganizationKind)({
    scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId: broadcast.organization_public_id }),
    type: 'broadcast.done',
    copy: { key: 'broadcastDone', values: { broadcastName: done.name, sentCount: done.sent } },
    dedupeKey: `broadcast-done:${done.public_id}`,
    actionPath: `/broadcasts/${done.public_id}`,
    subjectUserId: done.created_by_user_id,
    data: { sent: done.sent },
  });
  return 1;
}

/**
 * Ends broadcasts (feat-instagram-dm-sending § 7.A BC7, BC11, BCC7; WC-29; P94; AC-9.6, AC-9.7): a
 * sending broadcast whose audience is built with nobody waiting, and a "when her chat opens" one
 * past its end with nobody waiting, become `done` with the in-app "broadcast done" notice; a
 * cancelled one has its waiting recipients `skipped` and their waiting messages `cancelled`
 * (`broadcast_cancelled`, or `plan_feature_off` for the plan's cancel) in pieces of 500 until the
 * budget is spent — sent ones stay sent.
 *
 * @remarks
 * - **Algorithm:** keyset pieces of the broadcasts with end work, read across organizations (the
 *   retention arm); each settled in its own organization's job scope — the cancelled piece through
 *   `skipBroadcastWaitingRecipients` and the channel's `cancelWaitingMessages` (the port), the end
 *   through the guarded `markDone` and notify's `notifyOrganizationKind` (keyed
 *   `broadcast-done:<brc_…>`, so a repeat tells nobody twice) in that commit.
 * - **Failure modes:** an organization's failure is logged; its broadcast stays due for the next
 *   minute. A cancelled broadcast with more than a piece left is read again next round.
 * - **Side effects:** recipients, messages, the broadcasts' status and numbers, notices.
 * - **Notes:** safe to run twice — every write is guarded on `waiting` or the status. Until a
 *   cancelled broadcast is settled the broadcast lane skips its messages (R45).
 */
export async function runBroadcastEndDuty({
  context,
  services,
}: {
  context: RepairDutyContext;
  services: BroadcastEndDutyServices;
}): Promise<RepairDutyOutcome> {
  return runRepairDutyPieces<number>({
    context,
    runPiece: async (cursor) => {
      const toEnd = await services.runInDatabaseSlot(() =>
        runGlobalRetentionWorkerJob((databaseHandle) =>
          new BroadcastRepository(databaseHandle).listToEnd({
            now: context.now,
            afterBroadcastId: cursor ?? 0,
            limit: REPAIR_DUTY_PIECE_SIZE,
          }),
        ),
      );
      let done = 0;
      let isFull = false;
      for (const broadcast of toEnd) {
        if (context.isBudgetSpent()) break;
        try {
          const outcome = await services.runInDatabaseSlot(() =>
            runOrganizationScopedWorkerJob({
              job: { organizationPublicId: broadcast.organization_public_id },
              processor: async (databaseHandle) =>
                broadcast.status === 'cancelled'
                  ? settleCancelledPiece({ broadcast, databaseHandle, services })
                  : {
                      done: await endFinished({ broadcast, databaseHandle, services }),
                      isFull: false,
                    },
            }),
          );
          done += outcome.done;
          if (outcome.isFull) isFull = true;
        } catch (error) {
          logger.warn(
            {
              error,
              organizationPublicId: broadcast.organization_public_id,
              broadcastPublicId: broadcast.broadcast_public_id,
            },
            'app.broadcast.end_failed',
          );
        }
      }
      const last = toEnd.at(-1);
      const isLastPiece = last === undefined || toEnd.length < REPAIR_DUTY_PIECE_SIZE;
      // A cancelled broadcast with more than a piece left: read again from the start, while the
      // budget lasts.
      const restart = isFull ? 0 : null;
      return {
        done,
        size: isFull ? REPAIR_DUTY_PIECE_SIZE : toEnd.length,
        nextCursor: isLastPiece ? restart : Number(last.broadcast_id),
      };
    },
  });
}
