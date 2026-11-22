/**
 * Every value of `app.instagram_webhook_events.event_kind` (routes-final § 4.B.3, WH9): what one
 * `changes[]` or `messaging[]` item of a Meta delivery is. Mirrors
 * `chk_instagram_webhook_events_kind` and route 18's `event_kind` filter.
 */
export const INSTAGRAM_WEBHOOK_EVENT_KINDS = [
  'comment',
  'message',
  'postback',
  'story_reply',
  'echo',
  'read',
  'reaction',
  'edit',
  'unknown',
] as const;

/** One value of {@link INSTAGRAM_WEBHOOK_EVENT_KINDS}. */
export type InstagramWebhookEventKind = (typeof INSTAGRAM_WEBHOOK_EVENT_KINDS)[number];

/**
 * Every value of `app.instagram_webhook_events.status`, in the order an event moves (WH12): born
 * `received` (or already `skipped`), `queued` once its account's processing job is added, then one
 * of the three final statuses. Mirrors `chk_instagram_webhook_events_status`.
 */
export const INSTAGRAM_WEBHOOK_EVENT_STATUSES = [
  'received',
  'queued',
  'processed',
  'skipped',
  'failed',
] as const;

/** One value of {@link INSTAGRAM_WEBHOOK_EVENT_STATUSES}. */
export type InstagramWebhookEventStatus = (typeof INSTAGRAM_WEBHOOK_EVENT_STATUSES)[number];

/** The two statuses of an event still waiting for processing — the claim and the pick-up read them. */
export const INSTAGRAM_WEBHOOK_EVENT_WAITING_STATUSES = [
  'received',
  'queued',
] as const satisfies readonly InstagramWebhookEventStatus[];

/**
 * Every value of `app.instagram_webhook_events.skip_reason` (WH16, D19): the kind's own reason
 * (WH9), the automation switch off, or an `expired` / `error` account. `unknown_account` is not one
 * — an unknown or revoked account's events are never stored (WH4). Mirrors
 * `chk_instagram_webhook_events_skip_reason`.
 */
export const INSTAGRAM_WEBHOOK_EVENT_SKIP_REASONS = [
  'automation_disabled',
  'account_disconnected',
  'echo',
  'read_receipt',
  'reaction',
  'edit',
  'unsupported',
] as const;

/** One value of {@link INSTAGRAM_WEBHOOK_EVENT_SKIP_REASONS}. */
export type InstagramWebhookEventSkipReason = (typeof INSTAGRAM_WEBHOOK_EVENT_SKIP_REASONS)[number];

/**
 * How long an event is kept: every event received more than 30 days ago is deleted, whatever its
 * status — `failed` ones too, since the list is only the debugging view (WH19, D8, D13).
 *
 * @remarks
 * - **Algorithm:** the daily clean-up's cutoff is `now - 30 days` on `created_at` (the received time).
 * - **Notes:** D8's number — a constant, not a setting (WH19).
 */
export const INSTAGRAM_WEBHOOK_EVENT_RETENTION_DAYS = 30;

/**
 * The unique index a repeat delivery hits (`ON CONFLICT DO NOTHING`, WH9, WH10): one row per
 * organization, account and event key. Shortened from the review's name to fit Postgres's
 * 63-byte identifier limit.
 */
export const INSTAGRAM_WEBHOOK_EVENT_KEY_UNIQUE_INDEX =
  'idx_instagram_webhook_events_organization_account_event_key';
