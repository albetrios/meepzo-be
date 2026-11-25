/**
 * A recipient's statuses (feat-instagram-dm-sending routes-final § 7.C, BC17; plan §20.10): made
 * `waiting`, then the result of her first message — `sent`, `skipped`, `failed` or `unknown`; a
 * `skipped` · `owner_chat` row goes back to `waiting` while its broadcast is active.
 */
export const BROADCAST_RECIPIENT_STATUSES = [
  'waiting',
  'sent',
  'skipped',
  'failed',
  'unknown',
] as const;

/** One of {@link BROADCAST_RECIPIENT_STATUSES}. */
export type BroadcastRecipientStatus = (typeof BROADCAST_RECIPIENT_STATUSES)[number];

/** The statuses that carry a reason (`chk_broadcast_recipients_reason`, 7.C.3). */
export const BROADCAST_RECIPIENT_STATUSES_WITH_REASON = [
  'skipped',
  'failed',
] as const satisfies readonly BroadcastRecipientStatus[];

/**
 * The recipient's own reasons (7.C.3): she got a broadcast lately, the owner typed to her, her chat
 * closed, her stop word or pause, the broadcast cancelled or switched off, her erasure. The message
 * reasons a channel reports (`person_error`, `tries_used_up`, …) are stored as they come, so the
 * column checks only the shape ({@link BROADCAST_RECIPIENT_REASON_PATTERN}) — broadcasts name no
 * channel's list (BC18).
 */
export const BROADCAST_RECIPIENT_REASONS = [
  'recent_broadcast',
  'owner_chat',
  'window_closed',
  'opted_out',
  'contact_excluded',
  'broadcast_cancelled',
  'plan_feature_off',
  'contact_deleted',
] as const;

/** One of {@link BROADCAST_RECIPIENT_REASONS}. */
export type BroadcastRecipientReason = (typeof BROADCAST_RECIPIENT_REASONS)[number];

/** The shape every stored reason has: lower-case words joined by `_`, at most 30 characters. */
export const BROADCAST_RECIPIENT_REASON_PATTERN = '^[a-z][a-z_]{0,29}$';

/** The highest version number picked for her (7.C.3: 1–3). */
export const BROADCAST_RECIPIENT_VERSION_MAX = 3;

/** How many contacts one piece of the audience build reads (WC-40, plan `BROADCAST_AUDIENCE_PIECE`). */
export const BROADCAST_AUDIENCE_PIECE_SIZE = 500;

/**
 * How long a recipient row is kept after it was made (BC16, plan `BROADCAST_RECIPIENT_KEEP_DAYS`) —
 * the hourly, time-budgeted clean-up (WC-53, ROUTE row R50) deletes older rows through
 * `idx_broadcast_recipients_created_at`, whatever the broadcast's state.
 */
export const BROADCAST_RECIPIENT_KEEP_DAYS = 90;

/** The step path of a broadcast's message `number` (1–3) — the sender reads its content there. */
export function broadcastMessageStepPath(messageNumber: number): string {
  return `messages.${messageNumber - 1}`;
}
