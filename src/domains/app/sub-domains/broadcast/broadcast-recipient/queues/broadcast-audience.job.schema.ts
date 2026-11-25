import { z } from 'zod';

/**
 * Job name of one piece of a broadcast's audience build (WC-40, BCC9 — ROUTE row R46) on the
 * database-heavy task queue (S19).
 *
 * @remarks
 * Notes: the key of `instagramSendWork.taskHandlers` the app container registers the handler under.
 */
export const BROADCAST_AUDIENCE_JOB_NAME = 'broadcast-audience';

/**
 * The `taskInput` of one audience piece (WC-40): the broadcast, its account (the lane to wake), the
 * piece number and the cursor — the contact the previous piece ended on (public ids only, K8).
 */
export const broadcastAudienceTaskInputSchema = z
  .object({
    broadcastPublicId: z.string().regex(/^brc_[a-z0-9]{21}$/),
    channelAccountPublicId: z.string().regex(/^cha_[a-z0-9]{21}$/),
    pieceNumber: z.number().int().min(1),
    afterContactPublicId: z
      .string()
      .regex(/^con_[a-z0-9]{21}$/)
      .nullable(),
  })
  .strict();

/** Type inferred from {@link broadcastAudienceTaskInputSchema}. */
export type BroadcastAudienceTaskInput = z.infer<typeof broadcastAudienceTaskInputSchema>;

/** The job id of one audience piece: `bcaud-<brc_…>-<piece>` (P214) — one job per piece. */
export function broadcastAudienceJobId({
  broadcastPublicId,
  pieceNumber,
}: {
  broadcastPublicId: string;
  pieceNumber: number;
}): string {
  return `bcaud-${broadcastPublicId}-${String(pieceNumber)}`;
}
