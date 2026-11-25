import type { ChannelPortDatabaseHandle } from '@/domains/app/app.channel-ports.js';

/** A recipient's key: her broadcast and her contact (the once-per-person key, BC16). */
export interface BroadcastRecipientKey {
  /** The caller's transaction handle; absent on an HTTP path, which joins the request's unit. */
  databaseHandle?: ChannelPortDatabaseHandle | undefined;
  organizationId: number;
  broadcastId: number;
  contactId: number;
}

/** One piece of the audience build (WC-40): where it starts. */
export interface BroadcastAudiencePieceInput {
  /** The audience job's handle (its organization scope). */
  databaseHandle: ChannelPortDatabaseHandle;
  /** The broadcast the job names (`brc_…`). */
  broadcastPublicId: string;
  /** The last contact id the previous piece read; `0` for the first piece. */
  afterContactId: number;
}

/**
 * What one piece of the audience build did (WC-40): the recipients it made, the ones whose first
 * message could not be saved (`skipped`), where the next piece starts, and whether this was the last.
 */
export interface BroadcastAudiencePieceResult {
  createdCount: number;
  skippedCount: number;
  /** The last contact id this piece read — the next piece's `afterContactId`. */
  lastContactId: number;
  /** `true` when no contact is left after this piece, or the broadcast is no longer `sending`. */
  isLastPiece: boolean;
}

/** What a "when her chat opens" hook did with her (BC17): a new row, the `owner_chat` row put back, or nothing. */
export type BroadcastChatOpenedOutcome = 'created' | 'reopened' | 'unchanged';

/** A reason the recipients of a contact or a broadcast leave `waiting` with. */
export interface BroadcastRecipientSkipInput {
  databaseHandle?: ChannelPortDatabaseHandle | undefined;
  organizationId: number;
  reason: string;
}
