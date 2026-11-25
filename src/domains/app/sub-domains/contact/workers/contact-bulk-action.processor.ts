import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import {
  type ContactBulkActionTaskInput,
  toContactBulkActionPieceInput,
} from '@/domains/app/sub-domains/contact/queues/contact-bulk-action.job.schema.js';

/**
 * Works one piece of a bulk contact change (WC-36, CT7 — the `contact-bulk-action` task, ROUTE row
 * R46) and chains the next.
 *
 * @remarks
 * - **Algorithm:** the piece in one unit of work in a database slot, in the job's scope — the
 *   organization and the acting user (so the pause names her); a piece that was not the last adds
 *   the next piece (`pieceNumber + 1`, the cursor from this piece) after the commit.
 * - **Failure modes:** a database error propagates (the task's one attempt, then the dead letter —
 *   committed pieces stay, a replay re-runs this piece and writes nothing twice); an add error of
 *   the next piece propagates too, so the dead letter keeps the chain's place.
 * - **Side effects:** the piece's contacts, tag counts, tag events and pause steps; the next job.
 * - **Notes:** channel-neutral — the app container wraps it as an Instagram task handler (S19), so
 *   `contact/` imports no channel (CTC12).
 */
export async function runContactBulkActionPiece({
  contactService,
  organizationPublicId,
  taskInput,
  runInDatabaseSlot,
  enqueuePiece,
}: {
  contactService: Pick<ContactService, 'applyBulkActionPiece'>;
  organizationPublicId: string;
  taskInput: ContactBulkActionTaskInput;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
  enqueuePiece: (input: {
    organizationPublicId: string;
    taskInput: ContactBulkActionTaskInput;
  }) => Promise<void>;
}): Promise<void> {
  const scope = PRINCIPAL_SCOPE.JOB(
    taskInput.actorUserPublicId === ''
      ? { organizationPublicId }
      : { organizationPublicId, userPublicId: taskInput.actorUserPublicId },
  );
  const piece = await runInDatabaseSlot(() =>
    contactService.applyBulkActionPiece({
      scope,
      input: toContactBulkActionPieceInput(taskInput),
    }),
  );
  logger.info(
    {
      organizationPublicId,
      channelAccountPublicId: taskInput.channelAccountPublicId,
      action: taskInput.action,
      pieceNumber: taskInput.pieceNumber,
      changedCount: piece.changedCount,
      isLastPiece: piece.isLastPiece,
    },
    'app.contact.bulk_action.piece_done',
  );
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
