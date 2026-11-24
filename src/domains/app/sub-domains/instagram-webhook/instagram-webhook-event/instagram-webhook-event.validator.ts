import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import { ListInstagramWebhookEventsQueryDto } from './instagram-webhook-event.dto.js';
import type { InstagramWebhookEventListFilters } from './instagram-webhook-event.types.js';

/**
 * Parses route 62's query string (`GET /app/social/instagram/webhook-events`) with the strict
 * {@link ListInstagramWebhookEventsQueryDto} and returns the list filters the service takes.
 *
 * @remarks
 * Throws `ValidationError` (400) naming the field: a `channel_account_id` that is not a `cha_…` id,
 * a `status` or `event_kind` outside its list, a
 * `received_from` / `received_to` that is not ISO 8601 with an offset, a `received_from` not before
 * `received_to` (on `received_to`), a `limit` outside 1–100, an `include_total` other than
 * `true` / `false`, or an unknown parameter. A cursor minted under other filters is refused later,
 * by the repository (5.B.9).
 */
export function validateListInstagramWebhookEventsQuery(
  data: unknown,
): InstagramWebhookEventListFilters {
  const query = parseWithSchema({ schema: ListInstagramWebhookEventsQueryDto, data });
  return {
    channelAccountPublicId: query.channel_account_id,
    status: query.status,
    eventKind: query.event_kind,
    receivedFrom: query.received_from,
    receivedTo: query.received_to,
    limit: query.limit,
    after: query.after,
    includeTotal: query.include_total === 'true',
  };
}
