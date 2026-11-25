import { z } from 'zod';
import { listSearchSortSchema } from '@/shared/utils/http/list-query.util.js';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import {
  expectedUpdatedAtSchema,
  valueListSchema,
} from '@/shared/utils/validation/record-fields.util.js';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';
import { automationMessageSchema } from '@/domains/app/sub-domains/automation/automation-steps.dto.js';
import { segmentConditionsSchema } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import {
  BROADCAST_MESSAGES_MAX_BYTES,
  BROADCAST_MESSAGES_MAX_COUNT,
  BROADCAST_MODES,
  BROADCAST_NAME_MAX_LENGTH,
  BROADCAST_OPEN_WAIT_MAX_DAYS,
  BROADCAST_OPEN_WAIT_MIN_DAYS,
  BROADCAST_SCHEDULE_MAX_DAYS_AHEAD,
  BROADCAST_SORT_FIELDS,
  BROADCAST_STATUSES,
} from './broadcast.constants.js';

/** A well-formed `cha_…` id (the channel account, BC5). */
const channelAccountIdSchema = z
  .string()
  .regex(publicIdPatternFor('channelAccount'), 'errors:validation.invalidPublicId');

/** A well-formed `seg_…` id — checked to be a live segment of the account in the service (BC8). */
const segmentIdSchema = z
  .string()
  .regex(publicIdPatternFor('segment'), 'errors:validation.invalidPublicId');

/** A well-formed `aut_…` id — checked to be a live automation of the account in the service (BC8). */
const automationIdSchema = z
  .string()
  .regex(publicIdPatternFor('automation'), 'errors:validation.invalidPublicId');

/** A broadcast name: 1–255 after trim; duplicates allowed (BC8). */
const broadcastNameSchema = trimmedStringMinMax({ min: 1, max: BROADCAST_NAME_MAX_LENGTH });

/**
 * The messages (BC8): the automation's message-list shape — its DTO schema reused, one schema
 * (BCC6) — 0–3 of them (a draft may hold 0), at most 64 KB of JSON. A message's own content checks
 * (lengths, links, counts) are the automation's, run by the service on every save (a `400`).
 */
export const broadcastMessagesSchema = z
  .array(automationMessageSchema)
  .max(BROADCAST_MESSAGES_MAX_COUNT)
  .refine(
    (messages) =>
      Buffer.byteLength(JSON.stringify(messages), 'utf8') <= BROADCAST_MESSAGES_MAX_BYTES,
    { message: 'errors:validation.broadcastMessagesTooLarge' },
  );

/** The parsed messages of a broadcast. */
export type BroadcastMessages = z.infer<typeof broadcastMessagesSchema>;

/**
 * Query of `GET /app/broadcasts` (route 70, 7.A.8): `channel_account_id` (required, BC5), `status`
 * (several, comma-separated), `mode`, `q` (the name), `sort` (`created_at` — the default, newest
 * first — or `name`), `order`, cursor paging. Strict.
 */
export const listBroadcastsQueryDto = listSearchSortSchema(BROADCAST_SORT_FIELDS)
  .extend({
    channel_account_id: channelAccountIdSchema,
    status: valueListSchema(BROADCAST_STATUSES).optional(),
    mode: z.enum(BROADCAST_MODES).optional(),
  })
  .strict();

/** The parsed query of {@link listBroadcastsQueryDto}. */
export type ListBroadcastsQueryInput = z.infer<typeof listBroadcastsQueryDto>;

/** Path of the routes on one broadcast (72–76). */
export const broadcastIdParamsDto = z
  .object({ broadcast_id: trimmedStringMinMax({ min: 1, max: 28 }) })
  .strict();

/** The audience of a body: a saved segment or one-off conditions, never both (BC8). */
function hasOneAudienceAtMost(value: {
  segment_id?: string | null | undefined;
  conditions?: unknown;
}): boolean {
  return !(
    value.segment_id !== undefined &&
    value.segment_id !== null &&
    value.conditions !== undefined &&
    value.conditions !== null
  );
}

/**
 * Body of `POST /app/broadcasts` (route 71, 7.A.8): `channel_account_id` and `name`; optional
 * `segment_id` or `conditions` (never both), `messages` (0–3) and `start_automation_id`. Strict.
 */
export const createBroadcastBodyDto = z
  .object({
    channel_account_id: channelAccountIdSchema,
    name: broadcastNameSchema,
    segment_id: segmentIdSchema.nullish(),
    conditions: segmentConditionsSchema.nullish(),
    messages: broadcastMessagesSchema.optional(),
    start_automation_id: automationIdSchema.nullish(),
  })
  .strict()
  .refine(hasOneAudienceAtMost, {
    path: ['conditions'],
    message: 'errors:validation.broadcastAudienceBoth',
  });

/** The parsed body of {@link createBroadcastBodyDto}. */
export type CreateBroadcastBodyInput = z.infer<typeof createBroadcastBodyDto>;

/**
 * Body of `PATCH /app/broadcasts/{broadcast_id}` (route 73, 7.A.8): at least one of `name`,
 * `segment_id`, `conditions`, `messages`, `start_automation_id` — sending one audience clears the
 * other, `null` clears it; optional `expected_updated_at` (→ `409 record_changed`). Strict.
 */
export const updateBroadcastBodyDto = z
  .object({
    name: broadcastNameSchema.optional(),
    segment_id: segmentIdSchema.nullish(),
    conditions: segmentConditionsSchema.nullish(),
    messages: broadcastMessagesSchema.optional(),
    start_automation_id: automationIdSchema.nullish(),
    expected_updated_at: expectedUpdatedAtSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.segment_id !== undefined ||
      value.conditions !== undefined ||
      value.messages !== undefined ||
      value.start_automation_id !== undefined,
    { message: 'errors:validation.sendAtLeastOneField' },
  )
  .refine(hasOneAudienceAtMost, {
    path: ['conditions'],
    message: 'errors:validation.broadcastAudienceBoth',
  });

/** The parsed body of {@link updateBroadcastBodyDto}. */
export type UpdateBroadcastBodyInput = z.infer<typeof updateBroadcastBodyDto>;

/**
 * Body of `POST /app/broadcasts/{broadcast_id}/send` (route 75, BC10): `mode` — `now`; `scheduled`
 * with `scheduled_at` (in the future, at most 30 days ahead); `when_chat_opens` with
 * `open_wait_days` (1–7). A field of another mode is refused. Strict.
 */
export const sendBroadcastBodyDto = z
  .object({
    mode: z.enum(BROADCAST_MODES),
    scheduled_at: z.iso.datetime({ offset: true }).optional(),
    open_wait_days: z
      .number()
      .int()
      .min(BROADCAST_OPEN_WAIT_MIN_DAYS)
      .max(BROADCAST_OPEN_WAIT_MAX_DAYS)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.mode === 'scheduled') !== (value.scheduled_at !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['scheduled_at'],
        message: 'errors:validation.broadcastScheduledAtForMode',
      });
    }
    if ((value.mode === 'when_chat_opens') !== (value.open_wait_days !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['open_wait_days'],
        message: 'errors:validation.broadcastOpenWaitDaysForMode',
      });
    }
    if (value.scheduled_at !== undefined) {
      const at = new Date(value.scheduled_at).getTime();
      const latest = Date.now() + BROADCAST_SCHEDULE_MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000;
      if (at <= Date.now() || at > latest) {
        context.addIssue({
          code: 'custom',
          path: ['scheduled_at'],
          message: 'errors:validation.broadcastScheduledAtRange',
        });
      }
    }
  });

/** The parsed body of {@link sendBroadcastBodyDto}. */
export type SendBroadcastBodyInput = z.infer<typeof sendBroadcastBodyDto>;

/** Body of `POST /app/broadcasts/{broadcast_id}/cancel` (route 76): strictly empty (7.A.8). */
export const emptyBroadcastActionBodyDto = z.object({}).strict().nullish();
