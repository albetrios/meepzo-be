import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { BroadcastRecipientService } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.service.js';
import type { BroadcastAudienceTaskInput } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/queues/broadcast-audience.job.schema.js';

/**
 * The channel's lane wake after a piece committed.
 *
 * @remarks
 * Notes: the app container passes the account channel's (Instagram's `wakeLaneTurns`); it runs in
 * its own unit, after the piece's commit.
 */
export type BroadcastAudienceSendingWake = (input: {
  scope: OrganizationPrincipalDatabaseScope;
  organizationId: number;
  channelAccountId: number;
  channelAccountPublicId: string;
}) => Promise<void>;

/**
 * Builds one piece of a `sending` broadcast's audience (WC-40, BCC9 — the `broadcast-audience`
 * task, ROUTE row R46), wakes its sending lane and chains the next piece.
 *
 * @remarks
 * - **Algorithm:** one unit of work in a database slot, in the job's organization scope:
 *   `BroadcastRecipientService.buildAudiencePiece` (500 contacts after the cursor whose chat is open,
 *   recipients and message 1, the numbers; the last piece sets the "audience built" mark). After the
 *   commit: when it made recipients, the account's lane is woken (`wakeSending`, in its own slot);
 *   when it was not the last, the next piece is added (`pieceNumber + 1`, the cursor from this
 *   piece).
 * - **Failure modes:** a piece's database error propagates (one attempt, then the dead letter — a
 *   replay re-runs the piece and makes no second row, BC17); a failed wake is logged (the repair
 *   gives the lane its turn, R47); a failed add of the next piece propagates.
 * - **Side effects:** recipients, messages, the broadcast's numbers and mark; the lane; the next job.
 * - **Notes:** channel-neutral (BC18) — the app container wraps it as an Instagram task handler.
 */
export async function runBroadcastAudiencePiece({
  recipientService,
  organizationPublicId,
  taskInput,
  runInDatabaseSlot,
  wakeSending,
  enqueuePiece,
}: {
  recipientService: Pick<BroadcastRecipientService, 'buildAudiencePiece'>;
  organizationPublicId: string;
  taskInput: BroadcastAudienceTaskInput;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
  wakeSending: BroadcastAudienceSendingWake;
  enqueuePiece: (input: {
    organizationPublicId: string;
    taskInput: BroadcastAudienceTaskInput;
  }) => Promise<void>;
}): Promise<void> {
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  const piece = await runInDatabaseSlot(() =>
    withAppDatabaseContext({
      scope,
      callback: (databaseHandle) =>
        recipientService.buildAudiencePiece({
          databaseHandle,
          broadcastPublicId: taskInput.broadcastPublicId,
          afterContactPublicId: taskInput.afterContactPublicId,
        }),
    }),
  );
  logger.info(
    {
      organizationPublicId,
      broadcastPublicId: taskInput.broadcastPublicId,
      pieceNumber: taskInput.pieceNumber,
      createdCount: piece.createdCount,
      isLastPiece: piece.isLastPiece,
    },
    'app.broadcast.audience_piece_done',
  );
  if (piece.channelAccount !== null && piece.createdCount > piece.skippedCount) {
    const { organizationId, channelAccountId } = piece.channelAccount;
    try {
      await runInDatabaseSlot(() =>
        wakeSending({
          scope,
          organizationId,
          channelAccountId,
          channelAccountPublicId: taskInput.channelAccountPublicId,
        }),
      );
    } catch (error) {
      logger.warn(
        {
          error_name: (error as Error | null)?.name,
          broadcastPublicId: taskInput.broadcastPublicId,
        },
        'app.broadcast.audience_wake_failed',
      );
    }
  }
  if (piece.isLastPiece) return;
  await enqueuePiece({
    organizationPublicId,
    taskInput: {
      ...taskInput,
      pieceNumber: taskInput.pieceNumber + 1,
      afterContactPublicId: piece.lastContactPublicId,
    },
  });
}
