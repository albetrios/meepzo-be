/**
 * Every value of `app.instagram_webhook_events.event_kind` (feat-instagram-dm-sending routes-final
 * § 5.B.3, WH18): what one `changes[]` or `messaging[]` item of a Meta delivery is — 13 values,
 * `read` gone (read receipts are never saved). Mirrors `chk_instagram_webhook_events_kind` and
 * route 62's `event_kind` filter.
 */
export const INSTAGRAM_WEBHOOK_EVENT_KINDS = [
  'comment',
  'live_comment',
  'message',
  'story_reply',
  'story_mention',
  'shared_post',
  'postback',
  'ice_breaker',
  'referral',
  'reaction',
  'echo',
  'edit',
  'unknown',
] as const;

/** One value of {@link INSTAGRAM_WEBHOOK_EVENT_KINDS}. */
export type InstagramWebhookEventKind = (typeof INSTAGRAM_WEBHOOK_EVENT_KINDS)[number];

/**
 * Every value of the generated `app.instagram_webhook_events.intake_group` (WH11): `comments` for a
 * `comment`, `live` for a `live_comment`, `messages` for every other kind — each intake job claims
 * only its own group.
 */
export const INSTAGRAM_WEBHOOK_EVENT_INTAKE_GROUPS = ['comments', 'live', 'messages'] as const;

/** One value of {@link INSTAGRAM_WEBHOOK_EVENT_INTAKE_GROUPS}. */
export type InstagramWebhookEventIntakeGroup =
  (typeof INSTAGRAM_WEBHOOK_EVENT_INTAKE_GROUPS)[number];

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
 * Every value of `app.instagram_webhook_events.skip_reason` (feat-instagram-dm-sending § 5.B.3,
 * WH18): the automation switch off, an account revoked before intake, the account's own comment
 * (P24), an edit, an unsupported item, or the inbound flood guard (WH16). `echo`, `read_receipt` and
 * `reaction` are gone. `unknown_account` is not one — an unknown or revoked account's events are
 * never stored (WH3). Mirrors `chk_instagram_webhook_events_skip_reason`.
 */
export const INSTAGRAM_WEBHOOK_EVENT_SKIP_REASONS = [
  'automation_disabled',
  'account_disconnected',
  'own_comment',
  'edit',
  'unsupported',
  'flood',
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
