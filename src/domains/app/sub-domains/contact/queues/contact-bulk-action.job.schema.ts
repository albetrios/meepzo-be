import { z } from 'zod';
import {
  CONTACT_BULK_ACTION_IDS_MAX_COUNT,
  CONTACT_BULK_ACTIONS,
} from '@/domains/app/sub-domains/contact/contact.constants.js';
import type { ContactBulkActionPieceInput } from '@/domains/app/sub-domains/contact/contact.types.js';
import { type PublicIdEntity, publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';

/**
 * Job name of one piece of a bulk contact change (WC-36, CT7 — ROUTE row R46) on the
 * database-heavy task queue (S19).
 *
 * @remarks
 * Notes: the key of `instagramSendWork.taskHandlers` the app container registers the handler under.
 */
export const CONTACT_BULK_ACTION_JOB_NAME = 'contact-bulk-action';

/** A public id of the given entity: its prefix, `_` and 21 lower-case letters or digits (P22). */
function publicIdSchema(entity: PublicIdEntity) {
  return z.string().regex(publicIdPatternFor(entity));
}

/**
 * The list filters as the job carries them (route 21's `filter`, validated at the route; dates as
 * text). Unknown keys are dropped, not refused.
 */
const contactBulkActionFilterJobSchema = z.object({
  q: z.string().max(200).optional(),
  tags: z.array(z.string().max(50)).max(10),
  hasEmail: z.boolean().optional(),
  hasPhone: z.boolean().optional(),
  isFollowingAccount: z.boolean().optional(),
  firstSeenFrom: z.coerce.date().optional(),
  firstSeenTo: z.coerce.date().optional(),
  automationPublicId: publicIdSchema('automation').optional(),
  isOptedOut: z.boolean().optional(),
  isAutomationsPaused: z.boolean().optional(),
  cameInVia: z.array(z.string().max(30)).max(20),
  firstAutomationPublicId: publicIdSchema('automation').optional(),
});

/**
 * The `taskInput` of one bulk piece (WC-36): route 21's action and selection, the acting user, the
 * bulk action's random token (its job ids), the piece number and the cursor — public ids only (K8,
 * be-workers-events).
 */
export const contactBulkActionTaskInputSchema = z
  .object({
    bulkActionToken: z.string().regex(/^[a-z0-9]{8,32}$/),
    pieceNumber: z.number().int().min(1),
    channelAccountPublicId: publicIdSchema('channelAccount'),
    action: z.enum(CONTACT_BULK_ACTIONS),
    tag: z.string().min(1).max(50).nullable(),
    contactPublicIds: z
      .array(publicIdSchema('contact'))
      .min(1)
      .max(CONTACT_BULK_ACTION_IDS_MAX_COUNT)
      .nullable(),
    filter: contactBulkActionFilterJobSchema.nullable(),
    actorUserPublicId: z.string().max(28),
    afterContactPublicId: publicIdSchema('contact').nullable(),
  })
  .strict();

/** Type inferred from {@link contactBulkActionTaskInputSchema}. */
export type ContactBulkActionTaskInput = z.infer<typeof contactBulkActionTaskInputSchema>;

/**
 * The job id of one bulk piece: `contact-bulk-<token>-<piece>` — one job per piece, so a re-added
 * piece is not added twice.
 */
export function contactBulkActionJobId({
  bulkActionToken,
  pieceNumber,
}: {
  bulkActionToken: string;
  pieceNumber: number;
}): string {
  return `contact-bulk-${bulkActionToken}-${String(pieceNumber)}`;
}

/** The contact service's piece input from the job's input (the filter's optional fields kept as given). */
export function toContactBulkActionPieceInput(
  taskInput: ContactBulkActionTaskInput,
): ContactBulkActionPieceInput {
  const { filter } = taskInput;
  return {
    channelAccountPublicId: taskInput.channelAccountPublicId,
    action: taskInput.action,
    tag: taskInput.tag,
    contactPublicIds: taskInput.contactPublicIds,
    filter:
      filter === null
        ? null
        : {
            q: filter.q,
            tags: filter.tags,
            hasEmail: filter.hasEmail,
            hasPhone: filter.hasPhone,
            isFollowingAccount: filter.isFollowingAccount,
            firstSeenFrom: filter.firstSeenFrom,
            firstSeenTo: filter.firstSeenTo,
            automationPublicId: filter.automationPublicId,
            isOptedOut: filter.isOptedOut,
            isAutomationsPaused: filter.isAutomationsPaused,
            cameInVia: filter.cameInVia,
            firstAutomationPublicId: filter.firstAutomationPublicId,
          },
    actorUserPublicId: taskInput.actorUserPublicId,
    afterContactPublicId: taskInput.afterContactPublicId,
  };
}
