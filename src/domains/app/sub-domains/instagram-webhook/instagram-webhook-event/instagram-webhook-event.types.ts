import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type {
  InstagramWebhookEventKind,
  InstagramWebhookEventSkipReason,
  InstagramWebhookEventStatus,
} from './instagram-webhook-event.constants.js';

/**
 * The Instagram webhook event object (feat-instagram-dm-sending routes-final § 5.B.6) — route 62's
 * list items.
 *
 * @remarks
 * Snake_case wire keys; `id` is the `iwe_…` public id, `channel_account_id` the `cha_…` one; the
 * value lists are typed as lists, never `string` (D19); timestamps ISO 8601. `payload` is the event
 * item with personal data masked (WH17) while the event waits or failed, `null` once it is done
 * (WH22). Internal ids, `intake_group`, `last_attempted_at` and `request_id` are never returned.
 */
export interface InstagramWebhookEventOutput {
  /** `iwe_…`. */
  id: string;
  /** `cha_…` — the channel account the event was saved for. */
  channel_account_id: string;
  /** The delivery entry's `id` — the account's webhook user id. */
  instagram_user_id: string;
  /** The person on the other side (the sender; an echo's recipient), or `null`. */
  contact_instagram_user_id: string | null;
  event_kind: InstagramWebhookEventKind;
  /** The event's key, unique per account (WH9). */
  event_key: string;
  status: InstagramWebhookEventStatus;
  /** Set exactly when `status` is `skipped`. */
  skip_reason: InstagramWebhookEventSkipReason | null;
  /** A code and a short reason; set exactly when `status` is `failed`. */
  error_message: string | null;
  /** How many times intake claimed the event. */
  attempt_count: number;
  /** A failed event's next try (WH21), else `null`. */
  next_attempt_at: string | null;
  /** The event item as received, personal data masked (WH17); `null` once the event is done (WH22). */
  payload: Record<string, unknown> | null;
  /** Meta's own time, or `null`. */
  occurred_at: string | null;
  /** When the delivery was stored. */
  received_at: string;
  /** When the status became final (`processed`, `skipped`, `failed`), else `null`. */
  processed_at: string | null;
}

/**
 * Route 62's filters and page (5.B.8), parsed: one channel account, one status, one kind, a received
 * window (`receivedFrom` inclusive, `receivedTo` exclusive), the page size and cursor, the count
 * opt-in.
 */
export interface InstagramWebhookEventListFilters {
  /** `cha_…` — only this channel account's events (WH23). */
  channelAccountPublicId?: string | undefined;
  status?: InstagramWebhookEventStatus | undefined;
  eventKind?: InstagramWebhookEventKind | undefined;
  /** ISO 8601 with an offset; inclusive. */
  receivedFrom?: string | undefined;
  /** ISO 8601 with an offset; exclusive. */
  receivedTo?: string | undefined;
  /** 1–100. */
  limit: number;
  /** The opaque cursor of the previous page, minted under the same filters. */
  after?: string | undefined;
  /** Count the matching rows (capped) — opt-in. */
  includeTotal: boolean;
}

/** What {@link InstagramWebhookEventListFilters} asks of the service: the caller's scope too. */
export interface InstagramWebhookEventListInput {
  /** The caller's organization scope (team-only read, K1). */
  scope: OrganizationPrincipalDatabaseScope;
  filters: InstagramWebhookEventListFilters;
}

/** One page of route 62: the serialized events and the keyset page facts. */
export interface InstagramWebhookEventListResult {
  items: InstagramWebhookEventOutput[];
  /** The capped count when asked for, else `null`. */
  total: number | null;
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}
