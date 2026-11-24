import { z } from 'zod';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import { instantSchema } from '@/shared/utils/validation/record-fields.util.js';
import { AUTOMATION_RUN_TRIGGER_TYPES } from './automation-run.constants.js';
import {
  AUTOMATION_RUN_INSTAGRAM_ID_PATTERN,
  AUTOMATION_RUN_QUEUED_AUTOMATIONS_MAX_COUNT,
} from './automation-run.constants.js';
import type { AutomationQueuedEntry } from './automation-run.types.js';

/** An Instagram media, comment or story id: digits only. */
const instagramIdSchema = z.string().regex(new RegExp(AUTOMATION_RUN_INSTAGRAM_ID_PATTERN));

/**
 * One queued automation (AU21, schema-routes § 10) — strict: an unknown key, a malformed public id
 * or Instagram id, or a trigger without the ids its type needs is refused.
 */
export const automationQueuedEntrySchema = z
  .object({
    automation_id: z.string().regex(publicIdPatternFor('automation')),
    queued_at: instantSchema,
    trigger: z
      .object({
        type: z.enum(AUTOMATION_RUN_TRIGGER_TYPES),
        instagram_media_id: instagramIdSchema.optional(),
        instagram_comment_id: instagramIdSchema.optional(),
        instagram_story_id: instagramIdSchema.optional(),
        text: z.string().nullable(),
      })
      .strict()
      .refine(
        (trigger) =>
          (trigger.type !== 'comment' ||
            (trigger.instagram_media_id !== undefined &&
              trigger.instagram_comment_id !== undefined)) &&
          (trigger.type !== 'story_reply' || trigger.instagram_story_id !== undefined),
      ),
  })
  .strict();

/** The whole `queued_automations` list (AU21): one entry per automation, at most 100. */
export const automationQueuedEntryListSchema = z
  .array(automationQueuedEntrySchema)
  .max(AUTOMATION_RUN_QUEUED_AUTOMATIONS_MAX_COUNT)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.automation_id)).size === entries.length,
  );

/**
 * Checks a `queued_automations` list before it is saved (AU21) and returns it — every save goes
 * through here.
 *
 * @remarks
 * Failure modes: throws a `ZodError` on a list that breaks the shape, holds two entries for one
 * automation or more than 100 — a programming error, since the engine builds every entry; the
 * database's `chk_automation_runs_queued_automations` is the backstop.
 */
export function assertQueuedAutomations(
  entries: readonly AutomationQueuedEntry[],
): AutomationQueuedEntry[] {
  return automationQueuedEntryListSchema.parse(entries) as AutomationQueuedEntry[];
}

/**
 * Reads a stored `queued_automations` list entry by entry (3.B.9): each entry that passes the
 * strict shape is kept in order; a malformed one is left out and counted, so the others still
 * start.
 *
 * @remarks
 * Failure modes: none — a value that is not a list reads as empty with nothing skipped counted.
 */
export function readQueuedAutomations(stored: unknown): {
  entries: AutomationQueuedEntry[];
  malformedCount: number;
} {
  if (!Array.isArray(stored)) return { entries: [], malformedCount: 0 };
  const entries: AutomationQueuedEntry[] = [];
  let malformedCount = 0;
  for (const value of stored) {
    const parsed = automationQueuedEntrySchema.safeParse(value);
    if (parsed.success) {
      entries.push(parsed.data as AutomationQueuedEntry);
    } else {
      malformedCount += 1;
    }
  }
  return { entries, malformedCount };
}
