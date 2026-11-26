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
 * The event kinds that only arrive with `instagram_manage_messages` (Meta's `messages`,
 * `messaging_postbacks`, `messaging_referral` and `message_reactions` fields) — what Meta's
 * Unified Login limit withholds from an account shared without its Facebook Page (P358). Comments,
 * Live comments and `unknown` items do not count.
 */
export const INSTAGRAM_MESSAGING_EVENT_KINDS: ReadonlySet<InstagramWebhookEventKind> = new Set([
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
]);

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
 * `received` (or already `skipped`), then one of the three final statuses. `queued` is no longer
 * written (S25, P97 — ROUTE row R38) and stays for rows saved before. Mirrors
 * `chk_instagram_webhook_events_status`.
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
