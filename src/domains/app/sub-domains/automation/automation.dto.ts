import { z } from 'zod';
import { INSTAGRAM_ID_REGEX } from '@/shared/constants/instagram.constants.js';
import { listSearchSortSchema } from '@/shared/utils/http/list-query.util.js';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import {
  expectedUpdatedAtSchema,
  recordDeleteQuerySchemaOf,
  valueListSchema,
} from '@/shared/utils/validation/record-fields.util.js';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';
import {
  RECORD_DELETE_REASON_VALUES,
  type RecordDeleteReason,
} from '@/shared/constants/record-fields.constants.js';
import {
  AUTOMATION_ALSO_START_FROM_VALUES,
  AUTOMATION_DEFAULT_REPLY_MODES,
  AUTOMATION_KEYWORD_MAX_LENGTH,
  AUTOMATION_KEYWORD_TEST_SOURCES,
  AUTOMATION_KEYWORD_TEST_TEXT_MAX_LENGTH,
  AUTOMATION_KEYWORDS_MAX_COUNT,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_PAUSE_MODES,
  AUTOMATION_PUBLIC_REPLY_HOUR_LIMITS,
  AUTOMATION_PUBLIC_REPLY_TEXT_MAX_LENGTH,
  AUTOMATION_PUBLIC_REPLY_TEXTS_MAX_COUNT,
  AUTOMATION_REF_CODE_PATTERN,
  AUTOMATION_SORT_FIELDS,
  AUTOMATION_STARTER_QUESTION_MAX_LENGTH,
  AUTOMATION_STARTER_QUESTIONS_MAX_COUNT,
  AUTOMATION_STATUSES,
  AUTOMATION_STEPS_MAX_BYTES,
  AUTOMATION_TAG_MAX_LENGTH,
  AUTOMATION_TARGET_SCOPES,
  AUTOMATION_TRIGGER_TYPES,
} from './automation.constants.js';
import { automationStepsSchema } from './automation-steps.dto.js';

/** An Instagram media, story or ad id: digits only, 1–64. */
const instagramIdSchema = z.string().regex(INSTAGRAM_ID_REGEX);

/** A `between` date: ISO 8601 with an offset. */
const targetInstantSchema = z.iso.datetime({ offset: true });

/** `steps` at the every-save level (AU9): the shape, and at most 64 KB of JSON. */
const stepsSchema = automationStepsSchema.refine(
  (steps) => Buffer.byteLength(JSON.stringify(steps), 'utf8') <= AUTOMATION_STEPS_MAX_BYTES,
  { message: 'errors:validation.automationStepsTooLarge' },
);

/**
 * Every field a person writes on an automation (routes 28 and 30, routes-final § 4.A.8), each
 * optional here, at the every-save level (AU9): value lists, lengths, counts, ranges. Never
 * `status` (actions only, AU3), the account, the counters, the stop or the next-post state — the
 * strict objects refuse them as unknown keys.
 */
const automationWritableShape = {
  name: trimmedStringMinMax({ min: 1, max: AUTOMATION_NAME_MAX_LENGTH }),
  trigger_type: z.enum(AUTOMATION_TRIGGER_TYPES),
  also_start_from: z.array(z.enum(AUTOMATION_ALSO_START_FROM_VALUES)).max(2),
  target_scope: z.enum(AUTOMATION_TARGET_SCOPES),
  target_instagram_media_id: instagramIdSchema.nullable(),
  target_instagram_story_id: instagramIdSchema.nullable(),
  target_starts_at: targetInstantSchema.nullable(),
  target_ends_at: targetInstantSchema.nullable(),
  keywords: z
    .array(trimmedStringMinMax({ min: 1, max: AUTOMATION_KEYWORD_MAX_LENGTH }))
    .max(AUTOMATION_KEYWORDS_MAX_COUNT),
  ref_code: z
    .string()
    .regex(new RegExp(AUTOMATION_REF_CODE_PATTERN), 'errors:validation.automationRefCodeInvalid')
    .nullable(),
  starter_questions: z
    .array(trimmedStringMinMax({ min: 1, max: AUTOMATION_STARTER_QUESTION_MAX_LENGTH }))
    .max(AUTOMATION_STARTER_QUESTIONS_MAX_COUNT),
  ad_id: instagramIdSchema.nullable(),
  trigger_tag: trimmedStringMinMax({ min: 1, max: AUTOMATION_TAG_MAX_LENGTH }).nullable(),
  default_reply_mode: z.enum(AUTOMATION_DEFAULT_REPLY_MODES).nullable(),
  is_public_reply_enabled: z.boolean(),
  public_reply_texts: z
    .array(trimmedStringMinMax({ min: 1, max: AUTOMATION_PUBLIC_REPLY_TEXT_MAX_LENGTH }))
    .max(AUTOMATION_PUBLIC_REPLY_TEXTS_MAX_COUNT),
  is_public_reply_mention_enabled: z.boolean(),
  is_reply_like_person_enabled: z.boolean(),
  public_reply_hour_limit: z
    .union(AUTOMATION_PUBLIC_REPLY_HOUR_LIMITS.map((limit) => z.literal(limit)))
    .nullable(),
  is_hide_comment_after_direct_message_enabled: z.boolean(),
  steps: stepsSchema,
};

/** The writable fields, every one optional. */
const optionalWritableShape = Object.fromEntries(
  Object.entries(automationWritableShape).map(([key, schema]) => [key, schema.optional()]),
) as {
  [K in keyof typeof automationWritableShape]: z.ZodOptional<(typeof automationWritableShape)[K]>;
};

/**
 * Body of `POST /app/automations` (route 28, AU11): `name`, `channel_account_id` and `trigger_type`
 * required (AUQ3, P70); every other writable field optional, checked for shape only. The draft is
 * saved `draft`; nothing is sent.
 */
export const createAutomationDto = z
  .object({
    ...optionalWritableShape,
    name: automationWritableShape.name,
    trigger_type: automationWritableShape.trigger_type,
    channel_account_id: z
      .string()
      .regex(publicIdPatternFor('channelAccount'), 'errors:validation.invalidPublicId'),
  })
  .strict();

/**
 * Body of `PATCH /app/automations/{automation_id}` (route 30, AU12): any writable field (never
 * `status` or `channel_account_id`), at least one besides `expected_updated_at`; `null` clears a
 * nullable field.
 */
export const updateAutomationDto = z
  .object({ ...optionalWritableShape, expected_updated_at: expectedUpdatedAtSchema })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expected_updated_at'), {
    message: 'errors:validation.sendAtLeastOneField',
  });

/**
 * Query of `GET /app/automations` (route 27, AU10): `channel_account_id` required (a well-formed
 * `cha_…`; unknown → an empty page), `status` and `trigger_type` comma-separated lists, `q` over the
 * name, `sort` (`created_at` default, `name`, `last_triggered_at`), `order`, cursor paging.
 */
export const listAutomationsQueryDto = listSearchSortSchema(AUTOMATION_SORT_FIELDS)
  .extend({
    channel_account_id: z
      .string()
      .regex(publicIdPatternFor('channelAccount'), 'errors:validation.invalidPublicId'),
    status: valueListSchema(AUTOMATION_STATUSES).optional(),
    trigger_type: valueListSchema(AUTOMATION_TRIGGER_TYPES).optional(),
  })
  .strict();

/** Path of the single-automation routes (29–35): `{automation_id}`. */
export const automationIdParamsDto = z
  .object({
    automation_id: trimmedStringMinMax({ min: 1, max: 28 }),
  })
  .strict();

/**
 * Query of `DELETE /app/automations/{automation_id}` (route 31, AU16, P11): `reason` optional —
 * `mistake`, `duplicate`, `not_needed` or `other` — and `note`, required for `other`.
 */
export const deleteAutomationQueryDto = recordDeleteQuerySchemaOf({
  reasons: RECORD_DELETE_REASON_VALUES as [RecordDeleteReason, ...RecordDeleteReason[]],
  isReasonOptional: true,
});

/** Body of routes 32 and 34 (go live, duplicate): strictly empty (4.A.8). */
export const emptyAutomationActionDto = z.object({}).strict().nullish();

/** Body of `POST /app/automations/{automation_id}/pause` (route 33, AU14): `mode` keep or cancel. */
export const pauseAutomationDto = z.object({ mode: z.enum(AUTOMATION_PAUSE_MODES) }).strict();

/**
 * Body of `POST /app/automations/{automation_id}/keyword-test` (route 35, AU17): `text` (1–1,000)
 * and an optional `source` (`comment`, `dm`, `story_reply`).
 */
export const keywordTestAutomationDto = z
  .object({
    text: trimmedStringMinMax({ min: 1, max: AUTOMATION_KEYWORD_TEST_TEXT_MAX_LENGTH }),
    source: z.enum(AUTOMATION_KEYWORD_TEST_SOURCES).optional(),
  })
  .strict();

/** The parsed body of {@link createAutomationDto}. */
export type CreateAutomationInput = z.infer<typeof createAutomationDto>;
/** The parsed body of {@link updateAutomationDto}. */
export type UpdateAutomationInput = z.infer<typeof updateAutomationDto>;
/** The parsed query of {@link listAutomationsQueryDto}. */
export type ListAutomationsQueryInput = z.infer<typeof listAutomationsQueryDto>;
/** The parsed query of {@link deleteAutomationQueryDto}. */
export type DeleteAutomationQueryInput = z.infer<typeof deleteAutomationQueryDto>;
