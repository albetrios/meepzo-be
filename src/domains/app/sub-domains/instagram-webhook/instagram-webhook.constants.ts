/**
 * The header Meta signs each Instagram webhook delivery in (route 61, WH4): `sha256=` and the hex
 * HMAC-SHA256 of the raw body with the app secret. Lower case, as Node delivers header names — the
 * raw-body registry keeps the body only when a request carries it (WH2).
 */
export const INSTAGRAM_WEBHOOK_SIGNATURE_HEADER = 'x-hub-signature-256';

/** The only `object` an Instagram delivery carries; any other is answered OK and stored nowhere (WH10). */
export const INSTAGRAM_WEBHOOK_OBJECT = 'instagram';

/** The only `hub.mode` Meta's subscription check may carry (route 60, WH4). */
export const INSTAGRAM_WEBHOOK_SUBSCRIBE_MODE = 'subscribe';

/**
 * The longest event key (4.A.10, `app.instagram_webhook_events.event_key` is `varchar(512)`): a
 * longer one is stored as `<prefix>:sha256:<64 hex>` of its parts.
 */
export const INSTAGRAM_WEBHOOK_EVENT_KEY_MAX_LENGTH = 512;

/** An Instagram id as the events table stores it (`^[0-9]{1,64}$`, WH9). */
export const INSTAGRAM_WEBHOOK_USER_ID_PATTERN = /^\d{1,64}$/;

/**
 * The BullMQ priority of each intake job (feat-instagram-dm-sending § 5 WH5, WH11; BullMQ runs a
 * lower number first): chat events and Live comments `1`, comments `5`, and
 * {@link INSTAGRAM_INTAKE_LOW_PRIORITY} for a flooded account's comments and past comments — so
 * taps and typed answers never wait behind comments.
 */
export const INSTAGRAM_INTAKE_PRIORITY = {
  messages: 1,
  live: 1,
  comments: 5,
} as const;

/**
 * The lowest intake priority (plan `INTAKE_LOW_PRIORITY`): an account's comments while more than
 * {@link INSTAGRAM_INTAKE_ACCOUNT_SOFT_LIMIT} of them wait, the comments a past-comments read added
 * (ROUTE row R41) and the tag events of a bulk change (WH15).
 */
export const INSTAGRAM_INTAKE_LOW_PRIORITY = 10;

/** The priority of a tag-intake job naming one contact (WH15); several contacts take the lowest. */
export const INSTAGRAM_TAG_EVENT_INTAKE_PRIORITY = 5;

/**
 * Waiting comment events of one account over which its comment intake runs at
 * {@link INSTAGRAM_INTAKE_LOW_PRIORITY} (plan `INTAKE_ACCOUNT_SOFT_LIMIT`, WH11) — a viral post
 * never slows other accounts.
 */
export const INSTAGRAM_INTAKE_ACCOUNT_SOFT_LIMIT = 500;

/**
 * How many comment-intake jobs one account may run side by side (scale review S11, P97): each claims
 * with `FOR UPDATE SKIP LOCKED`; her contact's lock keeps one person's comments in order.
 */
export const INSTAGRAM_COMMENT_INTAKE_JOBS_PER_ACCOUNT = 4;

/**
 * More than this many of her message events in the last minute are skipped `flood` (plan
 * `INBOUND_FLOOD_PER_MINUTE`, WH16, P63) — counted in Postgres from her saved events.
 */
export const INSTAGRAM_INBOUND_FLOOD_PER_MINUTE = 20;

/**
 * The owner's quiet time for one contact after she typed to her by hand (plan
 * `OWNER_CHAT_QUIET_HOURS`, WH10): "no other automation answered" waits this long.
 */
export const INSTAGRAM_OWNER_CHAT_QUIET_HOURS = 6;

/**
 * How far back an echo may match one of our own messages whose send was not saved with Meta's id
 * yet (WH10, WHQ1 / P62): exactly one such message of hers in this window → it is `sent`.
 */
export const INSTAGRAM_ECHO_MATCH_MINUTES = 10;

/**
 * A comment whose webhook came more than this many minutes after it was written has its own time
 * read from Meta (WH12 step 2, 3 s, failing open to the received time).
 */
export const INSTAGRAM_LATE_COMMENT_MINUTES = 60;

/** A deadlock or a lock timeout retries the event's transaction this many times (WH12). */
export const INSTAGRAM_INTAKE_LOCK_RETRIES = 3;

/**
 * A `failed` event is tried again this many minutes later (`next_attempt_at`, WH12) by the pick-up
 * (WH17, ROUTE row R39), while its comment or message is under 7 days old.
 */
export const INSTAGRAM_WEBHOOK_EVENT_RETRY_AFTER_MINUTES = 60;
