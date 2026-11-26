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

/**
 * The pick-up hands a waiting event back to intake once it waited this many minutes (WH17, WC-12)
 * and no intake run holds its lease ({@link INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES}).
 */
export const INSTAGRAM_WEBHOOK_EVENT_PICK_UP_AFTER_MINUTES = 1;

/**
 * A `failed` event is tried again while its trigger (the comment or message, by Meta's own time) is
 * younger than this many days (WH17, WH21) — a private reply's window (D9).
 */
export const INSTAGRAM_WEBHOOK_EVENT_RETRY_MAX_AGE_DAYS = 7;

/** Most due `failed` events one pick-up sends back (WH21) — more wait for the next minute. */
export const INSTAGRAM_WEBHOOK_EVENT_RETRY_BATCH_SIZE = 500;

/**
 * The missed-comment look's round (WC-26, plan §34 rule 19 `MISSED_CHECK_MINUTES`): every this many
 * minutes, one job per watched account, spread over the round.
 */
export const INSTAGRAM_MISSED_COMMENT_ROUND_MINUTES = 30;

/**
 * The full pass after an outage is spread over this many minutes across accounts (plan §34 rule 20
 * `MISSED_FULL_PASS_SPREAD_MINUTES`).
 */
export const INSTAGRAM_MISSED_COMMENT_FULL_PASS_SPREAD_MINUTES = 10;

/**
 * An account whose watched posts were last read more than this many minutes ago missed rounds — a
 * server, Redis or Postgres was down — and gets the full pass (WH17, P93): two rounds.
 */
export const INSTAGRAM_MISSED_COMMENT_OUTAGE_AFTER_MINUTES =
  2 * INSTAGRAM_MISSED_COMMENT_ROUND_MINUTES;

/** Most posts one account's look reads, the ones read longest ago first (`MISSED_POSTS_PER_ROUND`, P93). */
export const INSTAGRAM_MISSED_COMMENT_POSTS_PER_ROUND = 25;

/** Only comments and posts of the last this many days are read (D9, P93) — the private reply's window. */
export const INSTAGRAM_MISSED_COMMENT_MAX_AGE_DAYS = 7;

/** A page reads back to the last seen comment minus this many minutes (WH17). */
export const INSTAGRAM_MISSED_COMMENT_OVERLAP_MINUTES = 10;

/** At most one Meta read a second per account (WH17). */
export const INSTAGRAM_MISSED_COMMENT_CALL_GAP_MILLISECONDS = 1000;

/**
 * Most comment pages one post's read takes in one look (50 a page — 2,000 comments, plan:L7429's
 * busy reel); the rest is read next round from the newest it reached.
 */
export const INSTAGRAM_MISSED_COMMENT_MAX_PAGES_PER_POST = 40;

/** The normal round is skipped while the connection's Meta usage is at this percentage or more (P51, MC19). */
export const INSTAGRAM_MISSED_COMMENT_ROUND_USAGE_STOP_PERCENT = 80;

/** The full pass stops while the connection's Meta usage is at this percentage or more (P93). */
export const INSTAGRAM_MISSED_COMMENT_FULL_PASS_USAGE_STOP_PERCENT = 60;

/** Most accounts one sweep hands a look to (the read is capped; more come next round). */
export const INSTAGRAM_MISSED_COMMENT_SWEEP_ACCOUNT_LIMIT = 5000;

/** The normal round's job priority on `instagram-tasks` — the low priority of every background read. */
export const INSTAGRAM_MISSED_COMMENT_ROUND_PRIORITY = INSTAGRAM_INTAKE_LOW_PRIORITY;

/**
 * The full pass's job priority — below every other task on the queue (P93: the lowest priority), so
 * sends, profile reads and account jobs go first.
 */
export const INSTAGRAM_MISSED_COMMENT_FULL_PASS_PRIORITY = 2 * INSTAGRAM_INTAKE_LOW_PRIORITY;
