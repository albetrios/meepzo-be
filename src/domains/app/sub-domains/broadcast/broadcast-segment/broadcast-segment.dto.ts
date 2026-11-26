import { z } from 'zod';
import { listSearchSortSchema } from '@/shared/utils/http/list-query.util.js';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import { expectedUpdatedAtSchema } from '@/shared/utils/validation/record-fields.util.js';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';
import { CONTACT_TAG_MAX_LENGTH } from '@/domains/app/sub-domains/contact/contact.constants.js';
import {
  SEGMENT_AUTOMATION_STATES,
  SEGMENT_CAME_IN_REF_MAX_LENGTH,
  SEGMENT_CAME_IN_VIAS,
  SEGMENT_COMMENT_AT_LEAST_MAX,
  SEGMENT_COMMENT_KEYWORD_MAX_LENGTH,
  SEGMENT_CONDITIONS_MAX_COUNT,
  SEGMENT_DETAILS_HAS,
  SEGMENT_GROUP_OPERATORS,
  SEGMENT_LOOKBACK_MAX_DAYS,
  SEGMENT_LOOKBACK_MAX_HOURS,
  SEGMENT_MESSAGE_NUMBER_MAX,
  SEGMENT_NAME_MAX_LENGTH,
  SEGMENT_SORT_FIELDS,
  SEGMENT_TAG_MATCHES,
  SEGMENT_TAG_VALUES_MAX_COUNT,
} from './broadcast-segment.constants.js';
import { INSTAGRAM_ID_REGEX } from '@/shared/constants/instagram.constants.js';

/** A well-formed `cha_…` id (the channel account, BC5). */
const channelAccountIdSchema = z
  .string()
  .regex(publicIdPatternFor('channelAccount'), 'errors:validation.invalidPublicId');

/** A well-formed `aut_…` id — checked to be the account's in the service (BC12). */
const automationIdSchema = z
  .string()
  .regex(publicIdPatternFor('automation'), 'errors:validation.invalidPublicId');

/** A whole number of days a condition looks back: 1–365. */
const daysSchema = z.number().int().min(1).max(SEGMENT_LOOKBACK_MAX_DAYS);

/** `tags`: she holds any, all or none of the values (BC12). */
const tagsConditionSchema = z
  .object({
    field: z.literal('tags'),
    match: z.enum(SEGMENT_TAG_MATCHES),
    values: z
      .array(z.string().trim().min(1).max(CONTACT_TAG_MAX_LENGTH))
      .min(1)
      .max(SEGMENT_TAG_VALUES_MAX_COUNT),
  })
  .strict();

/**
 * `automation`: what she did with one of the account's automations over its runs of the last 90
 * days (BC12); `message_number` goes with `got_message` only, and is required there.
 */
const automationConditionSchema = z
  .object({
    field: z.literal('automation'),
    automation_id: automationIdSchema,
    state: z.enum(SEGMENT_AUTOMATION_STATES),
    message_number: z.number().int().min(1).max(SEGMENT_MESSAGE_NUMBER_MAX).optional(),
  })
  .strict()
  .refine((value) => (value.state === 'got_message') === (value.message_number !== undefined), {
    path: ['message_number'],
    message: 'errors:validation.segmentMessageNumber',
  });

/**
 * `came_in`: how she came in (BC12); `value` is the automation (`aut_…`, required) for
 * `first_automation`, the ref (optional) for `ref`, and absent otherwise.
 */
const cameInConditionSchema = z
  .object({
    field: z.literal('came_in'),
    via: z.enum(SEGMENT_CAME_IN_VIAS),
    value: z.string().trim().min(1).max(SEGMENT_CAME_IN_REF_MAX_LENGTH).optional(),
  })
  .strict()
  .refine(
    (value) => {
      if (value.via === 'first_automation') {
        return value.value !== undefined && publicIdPatternFor('automation').test(value.value);
      }
      return value.via === 'ref' || value.value === undefined;
    },
    { path: ['value'], message: 'errors:validation.segmentCameInValue' },
  );

/**
 * `commented`: she commented on one post (an Instagram media id) or any, within `days` (all time
 * when absent), with `keyword` in it, at least `at_least` times (default 1) (BC12).
 */
const commentedConditionSchema = z
  .object({
    field: z.literal('commented'),
    post: z.union([z.literal('any'), z.string().regex(INSTAGRAM_ID_REGEX)]),
    days: daysSchema.optional(),
    keyword: z.string().trim().min(1).max(SEGMENT_COMMENT_KEYWORD_MAX_LENGTH).optional(),
    at_least: z.number().int().min(1).max(SEGMENT_COMMENT_AT_LEAST_MAX).optional(),
  })
  .strict();

/** `active`: exactly one of her last message within hours or days, or first seen within days. */
const activeConditionSchema = z
  .object({
    field: z.literal('active'),
    last_message_within_hours: z.number().int().min(1).max(SEGMENT_LOOKBACK_MAX_HOURS).optional(),
    last_message_within_days: daysSchema.optional(),
    first_seen_within_days: daysSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      [
        value.last_message_within_hours,
        value.last_message_within_days,
        value.first_seen_within_days,
      ].filter((entry) => entry !== undefined).length === 1,
    { message: 'errors:validation.segmentActiveOneWindow' },
  );

/** `details`: she shared her email, her phone, neither, or follows the account (BC12). */
const detailsConditionSchema = z
  .object({ field: z.literal('details'), has: z.enum(SEGMENT_DETAILS_HAS) })
  .strict();

/** `story_activity`: she replied to or mentioned a story within `days` (BC12). */
const storyActivityConditionSchema = z
  .object({ field: z.literal('story_activity'), days: daysSchema })
  .strict();

/** `no_broadcast`: she got no broadcast within `days` (BC12). */
const noBroadcastConditionSchema = z
  .object({ field: z.literal('no_broadcast'), days: daysSchema })
  .strict();

/** One condition of the tree — one of the eight fields (BC12). */
export const segmentConditionSchema = z.discriminatedUnion('field', [
  tagsConditionSchema,
  automationConditionSchema,
  cameInConditionSchema,
  commentedConditionSchema,
  activeConditionSchema,
  detailsConditionSchema,
  storyActivityConditionSchema,
  noBroadcastConditionSchema,
]);

/** A second-level group: conditions only — a group inside it would be a third level (BC12). */
const innerGroupSchema = z
  .object({
    op: z.enum(SEGMENT_GROUP_OPERATORS),
    items: z.array(segmentConditionSchema).min(1).max(SEGMENT_CONDITIONS_MAX_COUNT),
  })
  .strict();

/** How many conditions a tree holds, in all its groups. */
export function countSegmentConditions(tree: {
  items: readonly (object & { items?: readonly unknown[] })[];
}): number {
  return tree.items.reduce((total, item) => total + (item.items?.length ?? 1), 0);
}

/**
 * The audience conditions (BC12) — ONE schema for segments and broadcasts' one-off conditions: a
 * group `{ op: 'and' | 'or', items }` whose items are conditions or groups of conditions — at most 2
 * levels and at most 20 conditions in all. Keys are snake_case; ids inside are public ids
 * (`aut_…`) or Instagram media ids, checked to be the account's by the service (a `400`).
 */
export const segmentConditionsSchema = z
  .object({
    op: z.enum(SEGMENT_GROUP_OPERATORS),
    items: z
      .array(z.union([segmentConditionSchema, innerGroupSchema]))
      .min(1)
      .max(SEGMENT_CONDITIONS_MAX_COUNT),
  })
  .strict()
  .refine((tree) => countSegmentConditions(tree) <= SEGMENT_CONDITIONS_MAX_COUNT, {
    path: ['items'],
    message: 'errors:validation.segmentConditionsTooMany',
  })
  .meta({
    description: `A group { op: and | or, items } of conditions and groups of conditions — at most 2 levels and ${SEGMENT_CONDITIONS_MAX_COUNT} conditions in all.`,
  });

/** The parsed condition tree. */
export type SegmentConditions = z.infer<typeof segmentConditionsSchema>;

/** One parsed condition. */
export type SegmentCondition = z.infer<typeof segmentConditionSchema>;

/** A segment name: 1–255 after trim; duplicates allowed (BC12). */
const segmentNameSchema = trimmedStringMinMax({ min: 1, max: SEGMENT_NAME_MAX_LENGTH });

/**
 * Query of `GET /app/segments` (route 77, 7.B.8): `channel_account_id` (required, BC5), cursor
 * paging (`limit` 1–100, default 25; `after`), `q` (the name), `sort` (`name` — the default — or
 * `created_at`), `order`. Strict.
 */
export const listSegmentsQueryDto = listSearchSortSchema(SEGMENT_SORT_FIELDS)
  .extend({ channel_account_id: channelAccountIdSchema })
  .strict();

/** The parsed query of {@link listSegmentsQueryDto}. */
export type ListSegmentsQueryInput = z.infer<typeof listSegmentsQueryDto>;

/** Path of the routes on one segment (79–81). */
export const segmentIdParamsDto = z
  .object({ segment_id: trimmedStringMinMax({ min: 1, max: 28 }) })
  .strict();

/** Body of `POST /app/segments` (route 78): `channel_account_id`, `name`, `conditions`. Strict. */
export const createSegmentBodyDto = z
  .object({
    channel_account_id: channelAccountIdSchema,
    name: segmentNameSchema,
    conditions: segmentConditionsSchema,
  })
  .strict();

/** The parsed body of {@link createSegmentBodyDto}. */
export type CreateSegmentBodyInput = z.infer<typeof createSegmentBodyDto>;

/**
 * Body of `PATCH /app/segments/{segment_id}` (route 80, BC15): at least one of `name` and
 * `conditions`; optional `expected_updated_at` (→ `409 record_changed`). Strict.
 */
export const updateSegmentBodyDto = z
  .object({
    name: segmentNameSchema.optional(),
    conditions: segmentConditionsSchema.optional(),
    expected_updated_at: expectedUpdatedAtSchema,
  })
  .strict()
  .refine((value) => value.name !== undefined || value.conditions !== undefined, {
    message: 'errors:validation.sendAtLeastOneField',
  });

/** The parsed body of {@link updateSegmentBodyDto}. */
export type UpdateSegmentBodyInput = z.infer<typeof updateSegmentBodyDto>;

/**
 * Body of `POST /app/segments/audience-count` (route 82, BC14): `channel_account_id` and exactly
 * one of `segment_id` (a saved segment of that account) or `conditions` (unsaved). Strict.
 */
export const segmentAudienceCountBodyDto = z
  .object({
    channel_account_id: channelAccountIdSchema,
    segment_id: z
      .string()
      .regex(publicIdPatternFor('segment'), 'errors:validation.invalidPublicId')
      .optional(),
    conditions: segmentConditionsSchema.optional(),
  })
  .strict()
  .refine((value) => (value.segment_id === undefined) !== (value.conditions === undefined), {
    path: ['segment_id'],
    message: 'errors:validation.segmentAudienceSelection',
  });

/** The parsed body of {@link segmentAudienceCountBodyDto}. */
export type SegmentAudienceCountBodyInput = z.infer<typeof segmentAudienceCountBodyDto>;
