import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import type { BroadcastService } from '@/domains/app/sub-domains/broadcast/broadcast.service.js';
import type { BroadcastSegmentService } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.service.js';
import { setCachedSegmentCount } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment-count.cache.js';
import type { SegmentCountTaskInput } from '@/domains/app/sub-domains/broadcast/broadcast-segment/queues/broadcast-segment-count.job.schema.js';

/**
 * Runs one background segment count (BC14, BC10, WC-39 — the `segment-count` task, ROUTE row R46).
 *
 * @remarks
 * - **Algorithm:** in the job's organization scope, each unit of work in a database slot: a preview
 *   counts the account's conditions under 30 s and writes the 60 s Redis copy route 82 reads
 *   (`segmentService.countAudienceInBackground`); a broadcast's sets `matched` of its "when her chat
 *   opens" broadcast (`broadcastService.countWaitingBroadcastMatched`). Read only for the contacts.
 * - **Failure modes:** a count past 30 s is logged and ends the task (the next ask counts again);
 *   other errors propagate (the task's one attempt, then the dead letter).
 * - **Side effects:** one Redis key, or `matched` on the broadcast.
 * - **Notes:** channel-neutral — the app container wraps it as an Instagram task handler (S19), so
 *   `broadcast/` imports no channel (BC18).
 */
export async function runSegmentCountTask({
  segmentService,
  broadcastService,
  organizationPublicId,
  taskInput,
  runInDatabaseSlot,
}: {
  segmentService: Pick<BroadcastSegmentService, 'countAudienceInBackground'>;
  broadcastService: Pick<BroadcastService, 'countWaitingBroadcastMatched'>;
  organizationPublicId: string;
  taskInput: SegmentCountTaskInput;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
}): Promise<void> {
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  if (taskInput.kind === 'broadcast') {
    await runInDatabaseSlot(() =>
      broadcastService.countWaitingBroadcastMatched({
        scope,
        broadcastPublicId: taskInput.broadcastPublicId,
      }),
    );
    return;
  }
  await runInDatabaseSlot(() =>
    segmentService.countAudienceInBackground({
      scope,
      channelAccountPublicId: taskInput.channelAccountPublicId,
      conditions: taskInput.conditions,
      store: (count) =>
        setCachedSegmentCount({
          key: {
            organizationPublicId,
            channelAccountPublicId: taskInput.channelAccountPublicId,
            conditionsHash: taskInput.conditionsHash,
          },
          count,
        }),
    }),
  );
}
