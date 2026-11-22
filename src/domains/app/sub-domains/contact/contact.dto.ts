import { z } from 'zod';
import { listSearchSortSchema } from '@/shared/utils/http/list-query.util.js';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import { instantSchema } from '@/shared/utils/validation/record-fields.util.js';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';
import {
  CONTACT_LIST_TAGS_FILTER_MAX_COUNT,
  CONTACT_SORT_FIELDS,
  CONTACT_TAG_MAX_LENGTH,
} from './contact.constants.js';

/** A yes/no query flag, as every list reads one (`true` / `false`). */
const queryFlagSchema = z.enum(['true', 'false']);

/**
 * The `tags` filter: up to ten tags, comma-separated, each 1–255 characters once trimmed — the
 * contact holds every one (routes-final § 2.8).
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

/**
 * Query of `GET /app/contacts` (route 9, routes-final § 2.8): cursor paging (`limit` 1–100,
 * default 25; `after`), `q`, `sort` (`last_message_received_at` — the default — `first_seen_at`,
 * `username`), `order`, and the filters `tags`, `has_email`, `has_phone`, `is_following_account`,
 * `first_seen_from` / `first_seen_to`, `instagram_account_id` and `automation_id`.
 *
 * @remarks
 * - `sort` and `order` stay optional (a defaulted param serializes as `required` in OpenAPI); the
 *   service picks the default order — newest first for the two times, A→Z for `username`.
 * - `first_seen_from` must come before `first_seen_to` (`to` is exclusive).
 * - `instagram_account_id` must be a well-formed `iga_…` id; an unknown one gives an empty page.
 * - `automation_id` (CT5, landed with sub-domain 3) must be a well-formed `aut_…` id: the contacts
 *   that had a run of that automation — a deleted one's too; an unknown one gives an empty page.
 * - Strict: an unknown parameter is a `400`.
 */
export const listContactsQueryDto = listSearchSortSchema(CONTACT_SORT_FIELDS)
  .extend({
    tags: contactTagsFilterSchema.optional(),
    has_email: queryFlagSchema.optional(),
    has_phone: queryFlagSchema.optional(),
    is_following_account: queryFlagSchema.optional(),
    first_seen_from: instantSchema.optional(),
    first_seen_to: instantSchema.optional(),
    instagram_account_id: z
      .string()
      .regex(publicIdPatternFor('instagramAccount'), 'errors:validation.invalidPublicId')
      .optional(),
    automation_id: z
      .string()
      .regex(publicIdPatternFor('automation'), 'errors:validation.invalidPublicId')
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.first_seen_from === undefined ||
      value.first_seen_to === undefined ||
      new Date(value.first_seen_from).getTime() < new Date(value.first_seen_to).getTime(),
    { path: ['first_seen_from'], message: 'errors:validation.rangeStartBeforeEnd' },
  );

/** Path of `DELETE /app/contacts/{contact_id}` (route 10). */
export const contactIdParamsDto = z
  .object({
    contact_id: trimmedStringMinMax({ min: 1, max: 28 }),
  })
  .strict();

/** The parsed query of {@link listContactsQueryDto}. */
export type ListContactsQueryInput = z.infer<typeof listContactsQueryDto>;
