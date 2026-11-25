import {
  REPAIR_DUTY_PIECE_SIZE,
  type RepairDutyContext,
  type RepairDutyOutcome,
  runRepairDutyPieces,
} from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';
import {
  runGlobalRetentionWorkerJob,
  runOrganizationScopedWorkerJob,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { BroadcastRepository } from '@/domains/app/sub-domains/broadcast/broadcast.repository.js';
import type { BroadcastSendQueuePort } from '@/domains/app/sub-domains/broadcast/broadcast.types.js';

/**
 * The job name of the start duty (WC-28), one repeat job of its own (P94).
 *
 * @remarks
 * Notes: scheduled every minute on the task queue `instagram-tasks` (`scheduler.ts`).
 */
export const BROADCAST_START_DUTY_JOB_NAME = 'repair-broadcast-start';

/**
 * Starts scheduled broadcasts at their time (feat-instagram-dm-sending § 7.A BC7, BCC7; WC-28; P94):
 * a due `scheduled` broadcast becomes `sending` with `started_at`, and its audience build is added
 * with the same job as route 75's "now" (`enqueueBroadcastAudience`, the first piece).
 *
 * @remarks
 * - **Algorithm:** keyset pieces of {@link REPAIR_DUTY_PIECE_SIZE} due broadcasts read across
 *   organizations (`idx_broadcasts_scheduled_at`, the retention arm); each moves in its own
 *   organization's job scope (the guarded `startScheduled`), then — after that commit — its
 *   audience task; until the round's budget is spent.
 * - **Failure modes:** without the send queue (R46's `BroadcastSendQueuePort`) nothing starts — a
 *   started broadcast with no audience build would wait for ever; an organization's failure is
 *   logged, its broadcast stays due for the next minute; a failed add is logged — the audience job
 *   is keyed by the broadcast, so the owner's view shows it `sending` with no recipients until the
 *   next add (the task's own retries).
 * - **Side effects:** the broadcasts, the audience tasks.
 * - **Notes:** safe to run twice — a started broadcast is no longer `scheduled`. `runInDatabaseSlot`
 *   is the Instagram database limiter (SN24).
 */
export async function runBroadcastStartDuty({
  context,
  sendQueue,
  runInDatabaseSlot,
}: {
  context: RepairDutyContext;
  sendQueue: BroadcastSendQueuePort | undefined;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
}): Promise<RepairDutyOutcome> {
  if (sendQueue === undefined) return { done: 0, backlog: 0 };
  return runRepairDutyPieces<number>({
    context,
    runPiece: async (cursor) => {
      const due = await runInDatabaseSlot(() =>
        runGlobalRetentionWorkerJob((databaseHandle) =>
          new BroadcastRepository(databaseHandle).listDueScheduled({
            now: context.now,
            afterBroadcastId: cursor ?? 0,
            limit: REPAIR_DUTY_PIECE_SIZE,
          }),
        ),
      );
      let started = 0;
      for (const broadcast of due) {
        const organizationPublicId = broadcast.organization_public_id;
        try {
          const isStarted = await runInDatabaseSlot(() =>
            runOrganizationScopedWorkerJob({
              job: { organizationPublicId },
              processor: (databaseHandle) =>
                new BroadcastRepository(databaseHandle).startScheduled({
                  organizationId: Number(broadcast.organization_id),
                  broadcastId: Number(broadcast.broadcast_id),
                  now: context.now,
                }),
            }),
          );
          if (!isStarted) continue;
          started += 1;
          await sendQueue.enqueueBroadcastAudience({
            organizationPublicId,
            broadcastPublicId: broadcast.broadcast_public_id,
            channelAccountPublicId: broadcast.channel_account_public_id,
          });
        } catch (error) {
          logger.warn(
            { error, organizationPublicId, broadcastPublicId: broadcast.broadcast_public_id },
            'app.broadcast.start_failed',
          );
        }
      }
      const last = due.at(-1);
      return {
        done: started,
        size: due.length,
        nextCursor:
          last === undefined || due.length < REPAIR_DUTY_PIECE_SIZE
            ? null
            : Number(last.broadcast_id),
      };
    },
  });
}
