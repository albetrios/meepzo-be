import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type {
  InstagramWebhookEventKind,
  InstagramWebhookEventSkipReason,
  InstagramWebhookEventStatus,
} from './instagram-webhook-event.constants.js';

/**
 * The Instagram webhook event object (routes-final § 4.B.6) — route 18's list items.
 *
 * @remarks
 * Snake_case wire keys; `id` is the `iwe_…` public id; the value lists are typed as lists, never
 * `string` (D19); timestamps ISO 8601. `payload` is the event item with personal data masked
 * (WH17) — the stored row keeps it as received. Internal ids, `last_attempted_at` and
 * `request_id` are never returned.
 */
export interface InstagramWebhookEventOutput {
  /** `iwe_…`. */
  id: string;
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
  /** How many times processing claimed the event. */
  attempt_count: number;
  /** The event item as received, personal data masked (WH17). */
  payload: Record<string, unknown>;
  /** Meta's own time, or `null`. */
  occurred_at: string | null;
  /** When the delivery was stored. */
  received_at: string;
  /** When the status became final (`processed`, `skipped`, `failed`), else `null`. */
  processed_at: string | null;
}

/**
 * Route 18's filters and page (4.B.8), parsed: one status, one kind, a received window
 * (`receivedFrom` inclusive, `receivedTo` exclusive), the page size and cursor, the count opt-in.
 */
export interface InstagramWebhookEventListFilters {
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

/** One page of route 18: the serialized events and the keyset page facts. */
export interface InstagramWebhookEventListResult {
  items: InstagramWebhookEventOutput[];
  /** The capped count when asked for, else `null`. */
  total: number | null;
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}
