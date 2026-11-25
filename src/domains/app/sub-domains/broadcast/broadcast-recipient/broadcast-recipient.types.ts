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
  /**
   * The contact the previous piece ended on (`con_…`, the chained job's cursor); `null` for the
   * first piece. One no longer found starts over (the inserts are once per person).
   */
  afterContactPublicId: string | null;
}

/**
 * What one piece of the audience build did (WC-40): the recipients it made, the ones whose first
 * message could not be saved (`skipped`), where the next piece starts, and whether this was the last.
 */
export interface BroadcastAudiencePieceResult {
  createdCount: number;
  skippedCount: number;
  /** The last contact this piece read (`con_…`) — the next piece's `afterContactPublicId`. */
  lastContactPublicId: string | null;
  /**
   * `true` when no contact is left after this piece (the broadcast's "audience built" mark is set
   * in this commit), or the broadcast is no longer `sending`.
   */
  isLastPiece: boolean;
  /** The broadcast's account — the sending lane to wake after commit; `null` when not `sending`. */
  channelAccount: { organizationId: number; channelAccountId: number } | null;
}

/** What a "when her chat opens" hook did with her (BC17): a new row, the `owner_chat` row put back, or nothing. */
export type BroadcastChatOpenedOutcome = 'created' | 'reopened' | 'unchanged';

/** A reason the recipients of a contact or a broadcast leave `waiting` with. */
export interface BroadcastRecipientSkipInput {
  databaseHandle?: ChannelPortDatabaseHandle | undefined;
  organizationId: number;
  reason: string;
}
