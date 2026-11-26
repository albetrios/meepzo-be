import { z } from 'zod';
import { INSTAGRAM_ID_REGEX } from '@/shared/constants/instagram.constants.js';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';

/**
 * The `steps` object of an automation (feat-instagram-dm-sending routes-final § 4.A AU8, plan
 * §18.5): what it sends — the hello, the follow ask, the email and phone asks, the message list
 * (7 kinds) and the tags. One zod schema at the **every-save** level (AU9): types, kinds and the
 * object shape only, every part optional, so a draft may hold anything (D28); the completeness and
 * the limits (counts, lengths, bytes, waits, `https://`, files) are the go-live **content** checks
 * of `automation.validator.ts` (`listAutomationContentProblems`), each answered with its step path.
 *
 * @remarks
 * The JSON is at most `AUTOMATION_STEPS_MAX_BYTES` (64 KB) — the DTO's refine and
 * `chk_automations_steps`. Files are upload public ids (`upl_…`); the go-live check reads each
 * through the upload domain's usable-file read (P34, D58).
 */

/** A text field of a step: any string at save (the go-live check reads its length). */
const stepTextSchema = z.string();

/** An upload public id (`upl_…`). */
const uploadPublicIdSchema = z
  .string()
  .regex(publicIdPatternFor('upload'), 'errors:validation.invalidPublicId');

/** One hello button: a title and `next` (sends the next step) or `link` with its `url`. */
export const automationHelloButtonSchema = z
  .object({
    title: stepTextSchema,
    action: z.enum(['next', 'link']),
    url: z.string().optional(),
  })
  .strict();

/** One hello version: its text and its buttons. */
export const automationHelloVersionSchema = z
  .object({ text: stepTextSchema, buttons: z.array(automationHelloButtonSchema) })
  .strict();

/** `steps.hello` — "Say hello first" (D30): on, nudge, versions. */
export const automationHelloStepSchema = z
  .object({
    on: z.boolean(),
    nudge: z.boolean().optional(),
    versions: z.array(automationHelloVersionSchema),
  })
  .strict();

/** One follow-ask version: its text and the two button titles. */
export const automationFollowVersionSchema = z
  .object({
    text: stepTextSchema,
    profile_button_title: stepTextSchema,
    following_button_title: stepTextSchema,
  })
  .strict();

/** `steps.follow` — "Ask to follow" (D31). */
export const automationFollowStepSchema = z
  .object({ on: z.boolean(), versions: z.array(automationFollowVersionSchema) })
  .strict();

/** `steps.email` / `steps.phone` — the PRO asks (D31, D35): on, wordings. */
export const automationQuestionStepSchema = z
  .object({ on: z.boolean(), wordings: z.array(stepTextSchema) })
  .strict();

/** `steps.tags` — "Tag them" (D45). */
export const automationTagsStepSchema = z
  .object({ on: z.boolean(), list: z.array(stepTextSchema) })
  .strict();

/** The fields every message of the list has: its wait and its condition (`always` only now). */
const messageCommonShape = {
  wait_minutes: z.number().int().min(0),
  condition: z.enum(['always']).optional(),
};

/** One link button of a text message. */
const linkButtonSchema = z.object({ title: stepTextSchema, url: z.string() }).strict();

/** One card of a cards message. */
const cardSchema = z
  .object({
    image_upload_id: uploadPublicIdSchema.optional(),
    title: stepTextSchema,
    subtitle: stepTextSchema.optional(),
    url: z.string().optional(),
    button_title: stepTextSchema.optional(),
  })
  .strict();

/** One message of `steps.messages[]`, by its kind (plan §18.5). */
export const automationMessageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      ...messageCommonShape,
      text: stepTextSchema,
      image_upload_id: uploadPublicIdSchema.optional(),
      buttons: z.array(linkButtonSchema).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('image'), ...messageCommonShape, upload_id: uploadPublicIdSchema })
    .strict(),
  z
    .object({ kind: z.literal('cards'), ...messageCommonShape, cards: z.array(cardSchema) })
    .strict(),
  z
    .object({
      kind: z.literal('quick_replies'),
      ...messageCommonShape,
      text: stepTextSchema,
      replies: z.array(stepTextSchema),
    })
    .strict(),
  z
    .object({ kind: z.literal('audio'), ...messageCommonShape, upload_id: uploadPublicIdSchema })
    .strict(),
  z
    .object({ kind: z.literal('file'), ...messageCommonShape, upload_id: uploadPublicIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal('post'),
      ...messageCommonShape,
      media_id: z.union([z.literal('newest'), z.string().regex(INSTAGRAM_ID_REGEX)]),
    })
    .strict(),
]);

/**
 * `steps` — the automation's one object of what it sends (AU8). Every part optional (a draft, D28);
 * strict, so an unknown part is a `400`.
 */
export const automationStepsSchema = z
  .object({
    hello: automationHelloStepSchema.optional(),
    follow: automationFollowStepSchema.optional(),
    email: automationQuestionStepSchema.optional(),
    phone: automationQuestionStepSchema.optional(),
    messages: z.array(automationMessageSchema).optional(),
    tags: automationTagsStepSchema.optional(),
  })
  .strict();

/** The parsed `steps` object as stored in `app.automations.steps`. */
export type AutomationSteps = z.infer<typeof automationStepsSchema>;

/** One message of {@link AutomationSteps}. */
export type AutomationMessage = z.infer<typeof automationMessageSchema>;

/** The hello step of {@link AutomationSteps}. */
export type AutomationHelloStep = z.infer<typeof automationHelloStepSchema>;

/** The follow step of {@link AutomationSteps}. */
export type AutomationFollowStep = z.infer<typeof automationFollowStepSchema>;

/** The email or phone step of {@link AutomationSteps}. */
export type AutomationQuestionStep = z.infer<typeof automationQuestionStepSchema>;
