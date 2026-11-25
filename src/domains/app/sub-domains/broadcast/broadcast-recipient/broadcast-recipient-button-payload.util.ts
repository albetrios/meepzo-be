import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import { AUTOMATION_BUTTON_PAYLOAD_SEPARATOR } from '@/domains/app/sub-domains/automation/automation-run/automation-run.constants.js';

/** The public ids a broadcast message's button carries back (routes-final § 7.A.10). */
export interface BroadcastButtonPayload {
  /** `brc_…`. */
  broadcastPublicId: string;
  /** `igm_…` — the broadcast message the button was on. */
  messagePublicId: string;
}

/**
 * `<brc_…>::<igm_…>` — the postback payload of a broadcast message's buttons and quick replies
 * (routes-final § 7.A.10: the broadcast's public id; the channel's sending sub-domain builds it at
 * send, ROUTE row R45). It never parses as an automation's payload (its first part is no `aut_…`).
 *
 * @remarks
 * Pure.
 */
export function buildBroadcastButtonPayload({
  broadcastPublicId,
  messagePublicId,
}: BroadcastButtonPayload): string {
  return [broadcastPublicId, messagePublicId].join(AUTOMATION_BUTTON_PAYLOAD_SEPARATOR);
}

/**
 * Reads a postback payload as `<brc_…>::<igm_…>` (intake's tap on a broadcast button — `taps` + 1
 * and the "start automation X" run, ROUTE row R38); `null` when it is anything else.
 *
 * @remarks
 * Pure.
 */
export function parseBroadcastButtonPayload(payload: string): BroadcastButtonPayload | null {
  const parts = payload.split(AUTOMATION_BUTTON_PAYLOAD_SEPARATOR);
  if (parts.length !== 2) return null;
  const [broadcastPublicId, messagePublicId] = parts as [string, string];
  if (!publicIdPatternFor('broadcast').test(broadcastPublicId)) return null;
  if (!publicIdPatternFor('instagramMessage').test(messagePublicId)) return null;
  return { broadcastPublicId, messagePublicId };
}
