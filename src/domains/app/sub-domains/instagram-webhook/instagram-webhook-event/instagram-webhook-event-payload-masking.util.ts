/** How much of a message or comment text route 18 shows (WH17). */
export const INSTAGRAM_WEBHOOK_EVENT_PAYLOAD_TEXT_MAX_CHARACTERS = 40;

/** What a media or attachment link becomes in route 18's payload (WH17). */
export const INSTAGRAM_WEBHOOK_EVENT_PAYLOAD_LINK_PLACEHOLDER = '[link]';

/** What a value nested deeper than {@link MAX_DEPTH} becomes — Meta's items are a few levels deep. */
const TRUNCATED_PLACEHOLDER = '[truncated]';

/** Deepest object or array level walked. */
const MAX_DEPTH = 20;

/**
 * Longest string the patterns read: a longer one is cut first, which bounds their work. Meta's
 * strings are far shorter (a comment holds at most 2,200 characters, a DM 1,000).
 */
const MAX_SCANNED_STRING_LENGTH = 4096;

/** Fewest and most digits a number needs to be masked as a phone number (dates stay readable). */
const PHONE_MIN_DIGITS = 9;
const PHONE_MAX_DIGITS = 15;

/** Digits a masked phone number keeps at each end (`+91******34`). */
const PHONE_VISIBLE_DIGITS = 2;

/** An `http(s)` link anywhere in a string. */
const LINK_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

/** An email address anywhere in a string. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** A run that may be a phone number: digits with spaces, dots, dashes or brackets between. */
const PHONE_CANDIDATE_PATTERN = /\+?\d[\d\s().-]*\d/g;

/** Keys whose string value is kept as received: Instagram ids and usernames (WH17). */
const KEPT_KEYS = new Set(['id', 'mid', 'username']);

/** Keys whose string value is a link — replaced whole. */
const LINK_KEYS = new Set(['url', 'link', 'permalink']);

/** The key whose string value is message or comment text — cut to 40 characters. */
const TEXT_KEY = 'text';

/** Whether `key` names an Instagram id or a username, kept as received. */
function isKeptKey(key: string): boolean {
  return KEPT_KEYS.has(key) || key.endsWith('_id');
}

/** Whether `key` names a link (`url`, `media_url`, `link`, …). */
function isLinkKey(key: string): boolean {
  return LINK_KEYS.has(key) || key.endsWith('_url');
}

/** `rimeet@gmail.com` → `r***@g***.com`: the first character of each part and the top-level domain. */
function maskEmail(email: string): string {
  const atIndex = email.lastIndexOf('@');
  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const topLevelDomain = domain.slice(domain.lastIndexOf('.') + 1);
  return `${localPart.slice(0, 1)}***@${domain.slice(0, 1)}***.${topLevelDomain}`;
}

/**
 * A phone-number candidate masked when it holds 9–15 digits: `+91 98765 43234` → `+91********34`
 * (the leading `+`, the first and last two digits, a star for every other digit); shorter runs (a
 * date, a price) stay as they are.
 */
function maskPhoneCandidate(candidate: string): string {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) return candidate;
  const hiddenCount = digits.length - PHONE_VISIBLE_DIGITS * 2;
  return `${candidate.startsWith('+') ? '+' : ''}${digits.slice(0, PHONE_VISIBLE_DIGITS)}${'*'.repeat(hiddenCount)}${digits.slice(-PHONE_VISIBLE_DIGITS)}`;
}

/** Links → `[link]`, then every email, then every phone number masked. */
function maskPersonalDataInString(value: string): string {
  return value
    .slice(0, MAX_SCANNED_STRING_LENGTH)
    .replace(LINK_PATTERN, INSTAGRAM_WEBHOOK_EVENT_PAYLOAD_LINK_PLACEHOLDER)
    .replace(EMAIL_PATTERN, maskEmail)
    .replace(PHONE_CANDIDATE_PATTERN, maskPhoneCandidate);
}

/** The first 40 characters of a text, counted in code points so an emoji is never split. */
function cutText(value: string): string {
  return Array.from(value).slice(0, INSTAGRAM_WEBHOOK_EVENT_PAYLOAD_TEXT_MAX_CHARACTERS).join('');
}

/** One string under `key`, masked by what the key names. */
function maskString({ key, value }: { key: string | null; value: string }): string {
  if (key !== null && isKeptKey(key)) return value;
  if (key !== null && isLinkKey(key) && value.length > 0) {
    return INSTAGRAM_WEBHOOK_EVENT_PAYLOAD_LINK_PLACEHOLDER;
  }
  const masked = maskPersonalDataInString(value);
  return key === TEXT_KEY ? cutText(masked) : masked;
}

/** Walks one JSON value, masking every string by its key. */
function maskValue({
  key,
  value,
  depth,
}: {
  key: string | null;
  value: unknown;
  depth: number;
}): unknown {
  if (typeof value === 'string') return maskString({ key, value });
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return TRUNCATED_PLACEHOLDER;
  if (Array.isArray(value)) {
    // An array's items keep their parent's key (`attachments: [{ … }]`, a list of texts).
    return value.map((item) => maskValue({ key, value: item, depth: depth + 1 }));
  }
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      maskValue({ key: childKey, value: childValue, depth: depth + 1 }),
    ]),
  );
}

/**
 * Route 18's view of a stored event item (WH17, WQ2): the item keeps its shape, with personal data
 * masked — message and comment text cut to the first 40 characters, every email and phone number
 * inside masked (`r***@g***.com`, `+91******34`), quick-reply and attachment emails masked, media
 * and attachment links replaced by `[link]`; Instagram ids, kinds and usernames stay.
 *
 * @remarks
 * - **Algorithm:** walks the JSON value; for each string, by its key: an id (`id`, `mid`,
 *   `*_id`) or `username` is kept; a link key (`url`, `*_url`, `link`, `permalink`) becomes
 *   `[link]`; any other string has its links replaced, then its emails and 9–15-digit phone
 *   numbers masked, and a `text` value is then cut to 40 characters (code points). Numbers,
 *   booleans and `null` stay. Strings are cut to 4,096 characters before the patterns read them.
 * - **Failure modes:** none — a value that is not an object yields `{}`; anything nested deeper
 *   than 20 levels becomes `[truncated]`.
 * - **Side effects:** none; the stored payload is never changed — processing needs the real text
 *   (4.B.10).
 */
export function maskInstagramWebhookEventPayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return maskValue({ key: null, value: payload, depth: 0 }) as Record<string, unknown>;
}
