import type {
  InstagramWebhookEventKind,
  InstagramWebhookEventSkipReason,
  InstagramWebhookEventStatus,
} from './instagram-webhook-event.constants.js';
import { maskInstagramWebhookEventPayload } from './instagram-webhook-event-payload-masking.util.js';
import type { InstagramWebhookEventOutput } from './instagram-webhook-event.types.js';

/** The `app.instagram_webhook_events` columns the event object reads. */
interface InstagramWebhookEventSerializableRow {
  public_id: string;
  /** `app.channel_accounts.public_id` of the row's account (joined by the list). */
  channel_account_public_id: string;
  instagram_user_id: string;
  contact_instagram_user_id: string | null;
  event_kind: string;
  event_key: string;
  status: string;
  skip_reason: string | null;
  error_message: string | null;
  attempt_count: number;
  next_attempt_at: Date | null;
  payload: unknown;
  occurred_at: Date | null;
  processed_at: Date | null;
  created_at: Date;
}

/**
 * Maps one `app.instagram_webhook_events` row to the public Instagram webhook event object
 * (feat-instagram-dm-sending routes-final § 5.B.6) — route 62's list items.
 *
 * @remarks
 * - **Algorithm:** names every key (no row spread): `id` from `public_id`; `received_at` from
 *   `created_at` (one instant, one column — WH16); timestamps as ISO 8601; `payload` through
 *   {@link maskInstagramWebhookEventPayload} — message and comment text cut to 40 characters,
 *   emails and phone numbers masked, links replaced (WH17); a done event's body is already cleared
 *   (WH22), so its `payload` is `null`.
 * - **Failure modes:** none — a pure mapping. The value-list columns are typed as their lists: the
 *   table's CHECKs admit nothing else (D19).
 * - **Side effects:** none; the stored payload is never changed — the masking runs here only
 *   (4.B.10).
 * - **Notes:** the internal ids, `last_attempted_at` (the claim's lease) and `request_id` stay
 *   inside.
 */
export function serializeInstagramWebhookEvent(
  row: InstagramWebhookEventSerializableRow,
): InstagramWebhookEventOutput {
  return {
    id: row.public_id,
    channel_account_id: row.channel_account_public_id,
    instagram_user_id: row.instagram_user_id,
    contact_instagram_user_id: row.contact_instagram_user_id,
    event_kind: row.event_kind as InstagramWebhookEventKind,
    event_key: row.event_key,
    status: row.status as InstagramWebhookEventStatus,
    skip_reason: row.skip_reason as InstagramWebhookEventSkipReason | null,
    error_message: row.error_message,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at?.toISOString() ?? null,
    payload: row.payload === null ? null : maskInstagramWebhookEventPayload(row.payload),
    occurred_at: row.occurred_at?.toISOString() ?? null,
    received_at: row.created_at.toISOString(),
    processed_at: row.processed_at?.toISOString() ?? null,
  };
}
