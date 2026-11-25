import { z } from 'zod';
import { segmentConditionsSchema } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import { SEGMENT_COUNT_CACHE_TTL_SECONDS } from '@/shared/constants/ttl.constants.js';

/**
 * Job name of the background segment count (BC14, BC10, WC-39 — ROUTE row R46) on the
 * database-heavy task queue (S19).
 *
 * @remarks
 * Notes: the key of `instagramSendWork.taskHandlers` the app container registers the handler under.
 */
export const SEGMENT_COUNT_JOB_NAME = 'segment-count';

/**
 * The `taskInput` of one background count (WC-39): route 82's preview — the account, the
 * conditions and their hash, for the 60 s Redis copy — or a "when her chat opens" broadcast whose
 * `matched` it fills (read from its own copy of the conditions). Public ids and the conditions only.
 */
export const segmentCountTaskInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('preview'),
      channelAccountPublicId: z.string().regex(/^cha_[a-z0-9]{21}$/),
      conditionsHash: z.string().regex(/^[a-f0-9]{64}$/),
      conditions: segmentConditionsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('broadcast'),
      broadcastPublicId: z.string().regex(/^brc_[a-z0-9]{21}$/),
    })
    .strict(),
]);

/** Type inferred from {@link segmentCountTaskInputSchema}. */
export type SegmentCountTaskInput = z.infer<typeof segmentCountTaskInputSchema>;

/**
 * The job id of one background count: a preview's `segment-count-<cha_…>-<hash>-<window>` — one per
 * account, conditions and 60 s window, so asks while it counts add nothing and an ask after the
 * copy expired counts again; a broadcast's `segment-count-<brc_…>` (once per send).
 */
export function segmentCountJobId({
  input,
  now = Date.now(),
}: {
  input: SegmentCountTaskInput;
  now?: number;
}): string {
  if (input.kind === 'broadcast') return `segment-count-${input.broadcastPublicId}`;
  const window = Math.floor(now / (SEGMENT_COUNT_CACHE_TTL_SECONDS * 1000));
  return `segment-count-${input.channelAccountPublicId}-${input.conditionsHash}-${String(window)}`;
}
