import { z } from 'zod';

/**
 * Job name of the owner's failed-message retry (WC-42, SN18 — ROUTE row R46) on the database-heavy
 * task queue (S19).
 *
 * @remarks
 * Notes: the key of `instagramSendWork.taskHandlers` the app container registers the handler under.
 */
export const INSTAGRAM_RETRY_FAILED_JOB_NAME = 'retry-failed';

/** How long one press's job id holds (SN18): a second press within the minute adds nothing. */
const RETRY_FAILED_JOB_WINDOW_MILLISECONDS = 60_000;

/** The `taskInput` of one retry (WC-42): whose failed messages — the automation or the contact by public id. */
export const instagramRetryFailedTaskInputSchema = z
  .object({
    by: z.enum(['automation', 'contact']),
    ownerPublicId: z.string().regex(/^(aut|con)_[a-z0-9]{21}$/),
  })
  .strict()
  .refine((input) => input.ownerPublicId.startsWith(input.by === 'automation' ? 'aut_' : 'con_'), {
    message: 'ownerPublicId must name the owner kind',
  });

/** Type inferred from {@link instagramRetryFailedTaskInputSchema}. */
export type InstagramRetryFailedTaskInput = z.infer<typeof instagramRetryFailedTaskInputSchema>;

/**
 * The job id of one retry: `retry-failed-<aut_… or con_…>-<minute>` (SN18's id plus the minute) — a
 * second press while it runs adds nothing, and a press days later is not dropped by the retained
 * id of the first (BullMQ keeps finished jobs for seven days).
 */
export function instagramRetryFailedJobId({
  ownerPublicId,
  now = Date.now(),
}: Pick<InstagramRetryFailedTaskInput, 'ownerPublicId'> & { now?: number }): string {
  return `retry-failed-${ownerPublicId}-${String(Math.floor(now / RETRY_FAILED_JOB_WINDOW_MILLISECONDS))}`;
}
