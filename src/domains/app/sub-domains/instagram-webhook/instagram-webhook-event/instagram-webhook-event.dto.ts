import { z } from 'zod';
import { cursorPaginationSchema } from '@/shared/utils/http/pagination.util.js';
import {
  INSTAGRAM_WEBHOOK_EVENT_KINDS,
  INSTAGRAM_WEBHOOK_EVENT_STATUSES,
} from './instagram-webhook-event.constants.js';

/** An ISO 8601 time with an offset (`Z` or `±hh:mm`) — a time without one is refused (4.B.8). */
const receivedTimeSchema = z
  .string()
  .trim()
  .pipe(z.iso.datetime({ offset: true }));

/** Adds an issue on `received_to` when both ends are given and `received_from` is not before it. */
function receivedFromBeforeTo({
  value,
  context,
}: {
  value: { received_from?: string | undefined; received_to?: string | undefined };
  context: z.RefinementCtx;
}): void {
  if (value.received_from === undefined || value.received_to === undefined) return;
  if (Date.parse(value.received_from) < Date.parse(value.received_to)) return;
  context.addIssue({
    code: 'custom',
    path: ['received_to'],
    message: 'errors:validation.receivedFromNotBeforeTo',
  });
}

/**
 * Query of `GET /app/social/instagram/webhook-events` (route 18, routes-final § 4.B.8): the shared
 * cursor page (`limit` 1–100, default 25; `after`), one `status` and one `event_kind` from their
 * lists, a received window — `received_from` inclusive, `received_to` exclusive, ISO 8601 with an
 * offset, `from` before `to` — and the `include_total` opt-in.
 *
 * @remarks
 * Strict: an unknown parameter is a `400`. `include_total` is a string enum (no transform) so the
 * schema renders to JSON Schema for OpenAPI; the controller reads it as a boolean.
 */
export const ListInstagramWebhookEventsQueryDto = cursorPaginationSchema
  .extend({
    status: z.enum(INSTAGRAM_WEBHOOK_EVENT_STATUSES).optional(),
    event_kind: z.enum(INSTAGRAM_WEBHOOK_EVENT_KINDS).optional(),
    received_from: receivedTimeSchema.optional(),
    received_to: receivedTimeSchema.optional(),
    include_total: z.enum(['true', 'false']).optional().default('false'),
  })
  .strict()
  .superRefine((value, context) => receivedFromBeforeTo({ value, context }));

/** The parsed query of {@link ListInstagramWebhookEventsQueryDto}. */
export type ListInstagramWebhookEventsQuery = z.infer<typeof ListInstagramWebhookEventsQueryDto>;
