import { z } from 'zod';
import { listSearchSortSchema } from '@/shared/utils/http/list-query.util.js';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import {
  expectedUpdatedAtSchema,
  httpsLinkSchema,
  recordDeleteQuerySchema,
} from '@/shared/utils/validation/record-fields.util.js';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';
import {
  AUTOMATION_BUTTON_TITLE_MAX_LENGTH,
  AUTOMATION_FINAL_MESSAGE_LINKS_MAX_COUNT,
  AUTOMATION_INSTAGRAM_ID_PATTERN,
  AUTOMATION_KEYWORD_MAX_LENGTH,
  AUTOMATION_KEYWORDS_MAX_COUNT,
  AUTOMATION_LINK_URL_MAX_LENGTH,
  AUTOMATION_MESSAGE_TEXT_MAX_LENGTH,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_NEXT_POST_STATUSES,
  AUTOMATION_PUBLIC_REPLY_TEXT_MAX_LENGTH,
  AUTOMATION_PUBLIC_REPLY_TEXTS_MAX_COUNT,
  AUTOMATION_SORT_FIELDS,
  AUTOMATION_STATUSES,
  AUTOMATION_TAG_MAX_LENGTH,
  AUTOMATION_TAGS_MAX_COUNT,
  AUTOMATION_TARGET_SCOPES,
  AUTOMATION_TRIGGER_TYPES,
} from './automation.constants.js';

/** A message's text: trimmed, 1–1000 characters (schema-routes § 10). */
const messageTextSchema = trimmedStringMinMax({ min: 1, max: AUTOMATION_MESSAGE_TEXT_MAX_LENGTH });

/** A button or link title: trimmed, 1–20 characters (schema-routes § 10). */
const buttonTitleSchema = trimmedStringMinMax({ min: 1, max: AUTOMATION_BUTTON_TITLE_MAX_LENGTH });

/**
 * `opening_message` (schema-routes § 10): `text` and an optional `button_title` (`null` or absent =
 * no button). Strict — an unknown key is a `400`.
 */
export const automationOpeningMessageSchema = z
  .object({
    text: messageTextSchema,
    button_title: buttonTitleSchema.nullable().optional(),
  })
  .strict();

/** `follow_request_message` (schema-routes § 10): the text and both button titles. Strict. */
export const automationFollowRequestMessageSchema = z
  .object({
    text: messageTextSchema,
    following_button_title: buttonTitleSchema,
    profile_button_title: buttonTitleSchema,
  })
  .strict();

/** `email_request_message` / `phone_request_message` (schema-routes § 10): the text only. Strict. */
export const automationTextMessageSchema = z.object({ text: messageTextSchema }).strict();

/** One link button of the final message: a title and an `https://` address. Strict. */
const automationFinalMessageLinkSchema = z
  .object({
    title: buttonTitleSchema,
    url: httpsLinkSchema(AUTOMATION_LINK_URL_MAX_LENGTH),
  })
  .strict();

/** `final_message` (schema-routes § 10): the text and 0–3 links (absent = none). Strict. */
export const automationFinalMessageSchema = z
  .object({
    text: messageTextSchema,
    links: z
      .array(automationFinalMessageLinkSchema)
      .max(AUTOMATION_FINAL_MESSAGE_LINKS_MAX_COUNT)
      .optional(),
  })
  .strict();

/** An Instagram media or story id: digits only, 1–64 (AU7). */
const instagramIdSchema = z.string().regex(new RegExp(AUTOMATION_INSTAGRAM_ID_PATTERN));

/** A "next post" window end: ISO 8601 with an offset (AU9). */
const nextPostInstantSchema = z.iso.datetime({
  offset: true,
  message: 'errors:validation.nextPostDatesInvalid',
});

/**
 * Every field a person writes on an automation (routes 12 and 14, routes-final § 3.A.8), each
 * optional — the create body requires three of them, the edit body none. The read-only fields
 * (`instagram_account_id`, the counters, `next_post_status`, `next_post_linked_at`, who and when)
 * are not here, so the strict objects refuse them as unknown keys (AU7, AU27).
 */
const automationWritableShape = {
  name: trimmedStringMinMax({ min: 1, max: AUTOMATION_NAME_MAX_LENGTH }),
  status: z.enum(AUTOMATION_STATUSES),
  trigger_type: z.enum(AUTOMATION_TRIGGER_TYPES),
  target_scope: z.enum(AUTOMATION_TARGET_SCOPES),
  target_instagram_media_id: instagramIdSchema.nullable(),
  target_instagram_story_id: instagramIdSchema.nullable(),
  next_post_starts_at: nextPostInstantSchema.nullable(),
  next_post_ends_at: nextPostInstantSchema.nullable(),
  is_dm_keyword_trigger_enabled: z.boolean(),
  keywords: z
    .array(trimmedStringMinMax({ min: 1, max: AUTOMATION_KEYWORD_MAX_LENGTH }))
    .max(AUTOMATION_KEYWORDS_MAX_COUNT),
  tags: z
    .array(trimmedStringMinMax({ min: 1, max: AUTOMATION_TAG_MAX_LENGTH }))
    .max(AUTOMATION_TAGS_MAX_COUNT),
  is_public_reply_enabled: z.boolean(),
  public_reply_texts: z
    .array(trimmedStringMinMax({ min: 1, max: AUTOMATION_PUBLIC_REPLY_TEXT_MAX_LENGTH }))
    .max(AUTOMATION_PUBLIC_REPLY_TEXTS_MAX_COUNT),
  is_opening_message_enabled: z.boolean(),
  opening_message: automationOpeningMessageSchema.nullable(),
  is_follow_required: z.boolean(),
  follow_request_message: automationFollowRequestMessageSchema.nullable(),
  is_email_collection_enabled: z.boolean(),
  email_request_message: automationTextMessageSchema.nullable(),
  is_phone_collection_enabled: z.boolean(),
  phone_request_message: automationTextMessageSchema.nullable(),
  final_message: automationFinalMessageSchema,
};

/**
 * Body of `POST /app/automations` (route 12, routes-final § 3.A.8): `name`, `trigger_type` and
 * `final_message` required; every other field optional with the defaults of 3.A.3 (`status`
 * `inactive`, `target_scope` `any`, `is_dm_keyword_trigger_enabled` and
 * `is_opening_message_enabled` on, the rest off or empty).
 *
 * @remarks
 * - Shape only: lengths, counts, the Instagram id digits, the `https://` links and the message
 *   objects (strict). The cross-field rules run on the merged automation in
 *   `validateAutomationFlow` (AU8).
 * - Strict: an unknown or read-only field — `instagram_account_id` included (AU27) — is a `400`.
 * - `final_message` may not be `null` (D19).
 */
export const createAutomationDto = z
  .object({
    ...automationWritableShape,
    status: automationWritableShape.status.optional(),
    target_scope: automationWritableShape.target_scope.optional(),
    target_instagram_media_id: automationWritableShape.target_instagram_media_id.optional(),
    target_instagram_story_id: automationWritableShape.target_instagram_story_id.optional(),
    next_post_starts_at: automationWritableShape.next_post_starts_at.optional(),
    next_post_ends_at: automationWritableShape.next_post_ends_at.optional(),
    is_dm_keyword_trigger_enabled: automationWritableShape.is_dm_keyword_trigger_enabled.optional(),
    keywords: automationWritableShape.keywords.optional(),
    tags: automationWritableShape.tags.optional(),
    is_public_reply_enabled: automationWritableShape.is_public_reply_enabled.optional(),
    public_reply_texts: automationWritableShape.public_reply_texts.optional(),
    is_opening_message_enabled: automationWritableShape.is_opening_message_enabled.optional(),
    opening_message: automationWritableShape.opening_message.optional(),
    is_follow_required: automationWritableShape.is_follow_required.optional(),
    follow_request_message: automationWritableShape.follow_request_message.optional(),
    is_email_collection_enabled: automationWritableShape.is_email_collection_enabled.optional(),
    email_request_message: automationWritableShape.email_request_message.optional(),
    is_phone_collection_enabled: automationWritableShape.is_phone_collection_enabled.optional(),
    phone_request_message: automationWritableShape.phone_request_message.optional(),
  })
  .strict();

/**
 * Body of `PATCH /app/automations/{automation_id}` (route 14, routes-final § 3.A.8): any field of
 * the create body, at least one besides `expected_updated_at`; `null` clears a nullable message
 * or id; `expected_updated_at` refuses a stale save with `409 record_changed` (AU11).
 *
 * @remarks
 * Strict, as the create body: a read-only field (`instagram_account_id`, the counters,
 * `next_post_status`, `next_post_linked_at`) is an unknown key — a `400` (AU7, AU27). An empty
 * body (or `expected_updated_at` alone) is a `400` (`errors:validation.sendAtLeastOneField`).
 * `final_message` may not be `null` (D19).
 */
export const updateAutomationDto = z
  .object({
    name: automationWritableShape.name.optional(),
    status: automationWritableShape.status.optional(),
    trigger_type: automationWritableShape.trigger_type.optional(),
    target_scope: automationWritableShape.target_scope.optional(),
    target_instagram_media_id: automationWritableShape.target_instagram_media_id.optional(),
    target_instagram_story_id: automationWritableShape.target_instagram_story_id.optional(),
    next_post_starts_at: automationWritableShape.next_post_starts_at.optional(),
    next_post_ends_at: automationWritableShape.next_post_ends_at.optional(),
    is_dm_keyword_trigger_enabled: automationWritableShape.is_dm_keyword_trigger_enabled.optional(),
    keywords: automationWritableShape.keywords.optional(),
    tags: automationWritableShape.tags.optional(),
    is_public_reply_enabled: automationWritableShape.is_public_reply_enabled.optional(),
    public_reply_texts: automationWritableShape.public_reply_texts.optional(),
    is_opening_message_enabled: automationWritableShape.is_opening_message_enabled.optional(),
    opening_message: automationWritableShape.opening_message.optional(),
    is_follow_required: automationWritableShape.is_follow_required.optional(),
    follow_request_message: automationWritableShape.follow_request_message.optional(),
    is_email_collection_enabled: automationWritableShape.is_email_collection_enabled.optional(),
    email_request_message: automationWritableShape.email_request_message.optional(),
    is_phone_collection_enabled: automationWritableShape.is_phone_collection_enabled.optional(),
    phone_request_message: automationWritableShape.phone_request_message.optional(),
    final_message: automationWritableShape.final_message.optional(),
    expected_updated_at: expectedUpdatedAtSchema,
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expected_updated_at'), {
    message: 'errors:validation.sendAtLeastOneField',
  });

/**
 * Query of `GET /app/automations` (route 11, routes-final § 3.A.8): cursor paging (`limit` 1–100,
 * default 25; `after`), `q` over the name, `sort` (`created_at` — the default — `name`,
 * `last_triggered_at`, `completed_run_count`), `order`, and the filters `status`,
 * `trigger_type`, `target_scope`, `next_post_status` and `instagram_account_id`.
 *
 * @remarks
 * - `sort` and `order` stay optional (a defaulted param serializes as `required` in OpenAPI); the
 *   service picks the default order — newest / most first, `name` A→Z (AU13).
 * - `instagram_account_id` must be a well-formed `iga_…` id; an unknown one gives an empty page
 *   (AU27).
 * - Strict: an unknown parameter is a `400`.
 */
export const listAutomationsQueryDto = listSearchSortSchema(AUTOMATION_SORT_FIELDS)
  .extend({
    status: z.enum(AUTOMATION_STATUSES).optional(),
    trigger_type: z.enum(AUTOMATION_TRIGGER_TYPES).optional(),
    target_scope: z.enum(AUTOMATION_TARGET_SCOPES).optional(),
    next_post_status: z.enum(AUTOMATION_NEXT_POST_STATUSES).optional(),
    instagram_account_id: z
      .string()
      .regex(publicIdPatternFor('instagramAccount'), 'errors:validation.invalidPublicId')
      .optional(),
  })
  .strict();

/** Path of the single-automation routes (13–15): `{automation_id}`. */
export const automationIdParamsDto = z
  .object({
    automation_id: trimmedStringMinMax({ min: 1, max: 28 }),
  })
  .strict();

/**
 * Query of `DELETE /app/automations/{automation_id}` (route 15, AU12, AQ6): `reason` required —
 * `mistake`, `duplicate`, `not_needed` or `other` — and `note` (1–280), required for `other`. A
 * `DELETE` has no body.
 */
export const deleteAutomationQueryDto = recordDeleteQuerySchema;

/** The parsed body of {@link createAutomationDto}. */
export type CreateAutomationInput = z.infer<typeof createAutomationDto>;
/** The parsed body of {@link updateAutomationDto}. */
export type UpdateAutomationInput = z.infer<typeof updateAutomationDto>;
/** The parsed query of {@link listAutomationsQueryDto}. */
export type ListAutomationsQueryInput = z.infer<typeof listAutomationsQueryDto>;
/** The parsed query of {@link deleteAutomationQueryDto}. */
export type DeleteAutomationQueryInput = z.infer<typeof deleteAutomationQueryDto>;
