import { z } from 'zod';
import { listSearchSortSchema } from '@/shared/utils/http/list-query.util.js';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import {
  expectedUpdatedAtSchema,
  instantSchema,
} from '@/shared/utils/validation/record-fields.util.js';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';
import {
  CONTACT_BULK_ACTIONS,
  CONTACT_BULK_ACTION_IDS_MAX_COUNT,
  CONTACT_CAME_IN_VIA_VALUES,
  CONTACT_LIST_TAGS_FILTER_MAX_COUNT,
  CONTACT_NOTE_MAX_CHARACTERS,
  CONTACT_SEARCH_MIN_LENGTH,
  CONTACT_SORT_FIELDS,
  CONTACT_TAG_CHANGE_MAX_COUNT,
  CONTACT_TAG_LIST_MAX_COUNT,
  CONTACT_TAG_MAX_LENGTH,
} from './contact.constants.js';

/** A yes/no query flag, as every list reads one (`true` / `false`). */
const queryFlagSchema = z.enum(['true', 'false']);

/** A well-formed `cha_…` id (the channel account, CT2). */
const channelAccountIdSchema = z
  .string()
  .regex(publicIdPatternFor('channelAccount'), 'errors:validation.invalidPublicId');

/** A well-formed `aut_…` id. */
const automationIdSchema = z
  .string()
  .regex(publicIdPatternFor('automation'), 'errors:validation.invalidPublicId');

/**
 * The `tags` filter: up to ten tags, comma-separated, each 1–50 characters once trimmed — the
 * contact holds every one (route 18).
 */
const contactTagsFilterSchema = z
  .string()
  .max(CONTACT_LIST_TAGS_FILTER_MAX_COUNT * (CONTACT_TAG_MAX_LENGTH + 1))
  .refine(
    (value) => {
      const tags = value.split(',').map((tag) => tag.trim());
      return (
        tags.length <= CONTACT_LIST_TAGS_FILTER_MAX_COUNT &&
        tags.every((tag) => tag.length >= 1 && tag.length <= CONTACT_TAG_MAX_LENGTH)
      );
    },
    { message: 'errors:validation.contactTagsFilter' },
  )
  .meta({
    description: `Up to ${CONTACT_LIST_TAGS_FILTER_MAX_COUNT} tags, comma-separated, each 1–${CONTACT_TAG_MAX_LENGTH} characters; a contact must hold every one.`,
    example: 'vip,giveaway',
  });

/** The `came_in_via` filter: one or more ways to start, comma-separated (CT12). */
const cameInViaFilterSchema = z
  .string()
  .max(CONTACT_CAME_IN_VIA_VALUES.length * 21)
  .refine(
    (value) =>
      value
        .split(',')
        .every((entry) => (CONTACT_CAME_IN_VIA_VALUES as readonly string[]).includes(entry.trim())),
    { message: 'errors:validation.contactCameInVia' },
  )
  .meta({
    description: `One or more ways to start, comma-separated: ${CONTACT_CAME_IN_VIA_VALUES.join(', ')}.`,
    example: 'comment,dm_keyword',
  });

/** The `q` search: 3–200 characters (S6, P97). */
const contactSearchSchema = z
  .string()
  .trim()
  .min(CONTACT_SEARCH_MIN_LENGTH, 'errors:validation.contactSearchTooShort')
  .max(200)
  .meta({
    description: `Username, full name, email or phone — at least ${CONTACT_SEARCH_MIN_LENGTH} characters, any case, every word anywhere.`,
  });

/** The filters route 18 and route 21's `filter` share (CT7, CT12). */
const contactFilterShape = {
  q: contactSearchSchema.optional(),
  tags: contactTagsFilterSchema.optional(),
  has_email: queryFlagSchema.optional(),
  has_phone: queryFlagSchema.optional(),
  is_following_account: queryFlagSchema.optional(),
  is_opted_out: queryFlagSchema.optional(),
  is_automations_paused: queryFlagSchema.optional(),
  came_in_via: cameInViaFilterSchema.optional(),
  first_automation_id: automationIdSchema.optional(),
  first_seen_from: instantSchema.optional(),
  first_seen_to: instantSchema.optional(),
  automation_id: automationIdSchema.optional(),
};

/** `first_seen_from` must come before `first_seen_to` (`to` is exclusive). */
function firstSeenRangeIsOrdered(value: {
  first_seen_from?: string | undefined;
  first_seen_to?: string | undefined;
}): boolean {
  return (
    value.first_seen_from === undefined ||
    value.first_seen_to === undefined ||
    new Date(value.first_seen_from).getTime() < new Date(value.first_seen_to).getTime()
  );
}

/**
 * Query of `GET /app/contacts` (route 18, routes-final § 3.A.8): `channel_account_id` (required,
 * CT2), cursor paging (`limit` 1–100, default 25; `after`), `q` (3–200, S6), `sort`
 * (`last_message_received_at` — the default — `first_seen_at`, `username`), `order`, and the filters
 * `tags`, `has_email`, `has_phone`, `is_following_account`, `is_opted_out`,
 * `is_automations_paused`, `came_in_via`, `first_automation_id`, `first_seen_from` /
 * `first_seen_to` and `automation_id`.
 *
 * @remarks
 * - `sort` and `order` stay optional (a defaulted param serializes as `required` in OpenAPI); the
 *   service picks the default order — newest first for the two times, A→Z for `username`.
 * - An unknown `channel_account_id`, `automation_id` or `first_automation_id` gives an empty page.
 * - Strict: an unknown parameter is a `400`.
 */
export const listContactsQueryDto = listSearchSortSchema(CONTACT_SORT_FIELDS)
  .extend({
    channel_account_id: channelAccountIdSchema,
    ...contactFilterShape,
  })
  .strict()
  .refine(firstSeenRangeIsOrdered, {
    path: ['first_seen_from'],
    message: 'errors:validation.rangeStartBeforeEnd',
  });

/** Path of the routes on one contact (19, 20, 23). */
export const contactIdParamsDto = z
  .object({
    contact_id: trimmedStringMinMax({ min: 1, max: 28 }),
  })
  .strict();

/** One tag the owner adds or removes: 1–50 characters once trimmed, a comma read as a space (CT5). */
const contactTagSchema = z
  .string()
  .transform((value) => value.replaceAll(',', ' ').trim())
  .pipe(z.string().min(1).max(CONTACT_TAG_MAX_LENGTH))
  .meta({ description: `1–${CONTACT_TAG_MAX_LENGTH} characters; a comma becomes a space.` });

/** 1–20 tags of one change (CT5). */
const contactTagListSchema = z.array(contactTagSchema).min(1).max(CONTACT_TAG_CHANGE_MAX_COUNT);

/**
 * Body of `PATCH /app/contacts/{contact_id}` (route 20, CT5): at least one of `note` (1–2,000
 * characters, `null` clears), `add_tags` / `remove_tags` (1–20 each, no tag in both) and
 * `is_automations_paused`; optional `expected_updated_at` (→ `409 record_changed`). Strict.
 */
export const updateContactBodyDto = z
  .object({
    note: z.string().trim().min(1).max(CONTACT_NOTE_MAX_CHARACTERS).nullable().optional(),
    add_tags: contactTagListSchema.optional(),
    remove_tags: contactTagListSchema.optional(),
    is_automations_paused: z.boolean().optional(),
    expected_updated_at: expectedUpdatedAtSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.note !== undefined ||
      value.add_tags !== undefined ||
      value.remove_tags !== undefined ||
      value.is_automations_paused !== undefined,
    { message: 'errors:validation.sendAtLeastOneField' },
  )
  .refine(
    (value) =>
      value.add_tags === undefined ||
      value.remove_tags === undefined ||
      !value.add_tags.some((tag) => value.remove_tags?.includes(tag)),
    { path: ['remove_tags'], message: 'errors:validation.contactTagInBothLists' },
  );

/** The parsed body of {@link updateContactBodyDto}. */
export type UpdateContactBodyInput = z.infer<typeof updateContactBodyDto>;

/** Route 21's `filter`: route 18's filters without the account, sort and paging (CT7). */
const contactBulkFilterSchema = z
  .object(contactFilterShape)
  .strict()
  .refine(firstSeenRangeIsOrdered, {
    path: ['first_seen_from'],
    message: 'errors:validation.rangeStartBeforeEnd',
  });

/**
 * Body of `POST /app/contacts/bulk-actions` (route 21, CT7, P66): `channel_account_id`, `action`,
 * `tag` (required for the tag actions, absent for the pause ones) and exactly one of `contact_ids`
 * (1–500 distinct `con_…`) or `filter`. Strict.
 */
export const contactBulkActionBodyDto = z
  .object({
    channel_account_id: channelAccountIdSchema,
    action: z.enum(CONTACT_BULK_ACTIONS),
    tag: contactTagSchema.optional(),
    contact_ids: z
      .array(z.string().regex(publicIdPatternFor('contact'), 'errors:validation.invalidPublicId'))
      .min(1)
      .max(CONTACT_BULK_ACTION_IDS_MAX_COUNT)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'errors:validation.contactIdsRepeated',
      })
      .optional(),
    filter: contactBulkFilterSchema.optional(),
  })
  .strict()
  .refine((value) => (value.contact_ids === undefined) !== (value.filter === undefined), {
    path: ['contact_ids'],
    message: 'errors:validation.contactBulkSelection',
  })
  .refine(
    (value) =>
      (value.action === 'add_tag' || value.action === 'remove_tag') === (value.tag !== undefined),
    { path: ['tag'], message: 'errors:validation.contactBulkTag' },
  );

/** The parsed body of {@link contactBulkActionBodyDto}. */
export type ContactBulkActionBodyInput = z.infer<typeof contactBulkActionBodyDto>;

/** Query of `GET /app/contact-tags` (route 22, CT8): `channel_account_id` and `limit` (1–1,000). */
export const listContactTagsQueryDto = z
  .object({
    channel_account_id: channelAccountIdSchema,
    limit: z.coerce.number().int().min(1).max(CONTACT_TAG_LIST_MAX_COUNT).optional(),
  })
  .strict();

/** The parsed query of {@link listContactsQueryDto}. */
export type ListContactsQueryInput = z.infer<typeof listContactsQueryDto>;
