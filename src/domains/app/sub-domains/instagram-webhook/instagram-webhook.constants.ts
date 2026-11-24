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
