/**
 * The settings-file values an Instagram account's settings fall back to (feat-instagram-dm-sending
 * routes-final § 2.B, IA12, D5, D11, D22, D49, D67, D68): what an empty owner value means, and the
 * ranges route 12 accepts.
 *
 * @remarks
 * Code constants, not env (P4): they do not vary by environment. Sub-domain 6 reads the same values
 * for its lanes; its settings file (ROUTE row R18, beside `APP_UNTESTED_META_FEATURES`) takes them
 * over and this file then re-exports from there, so there is one source.
 */

/** Opening DMs an hour when the owner set none (D5, `OPENING_HOUR_LIMIT_DEFAULT`). */
export const OPENING_HOUR_LIMIT_DEFAULT = 600;

/** The highest opening hour limit the API accepts (D5, `OPENING_HOUR_LIMIT_MAX`); Meta allows 750. */
export const OPENING_HOUR_LIMIT_MAX = 700;

/**
 * Opening DMs an hour of a newly connected account for its first days (D5, `NEW_ACCOUNT_HOUR_LIMIT`)
 * — any owner `opening_hour_limit` replaces it. The window is `CHANNEL_ACCOUNT_NEW_ACCOUNT_LIMIT_DAYS`.
 */
export const NEW_ACCOUNT_HOUR_LIMIT = 150;

/** Whether the opening day limit is read at all (D5, `DAY_LIMIT_ENABLED`) — off. */
export const DAY_LIMIT_ENABLED = false;

/** An empty day limit is the hour limit times this (D5, `DAY_LIMIT_DEFAULT_FACTOR`). */
export const DAY_LIMIT_DEFAULT_FACTOR = 10;

/** The owner's day limit may be at most the hour limit times this (plan:L1957). */
export const DAY_LIMIT_MAX_FACTOR = 24;

/** Fast messages an hour when the owner set none (D11, `FAST_HOUR_LIMIT_DEFAULT`). */
export const FAST_HOUR_LIMIT_DEFAULT = 10_000;

/** The highest fast hour limit the API accepts (D11, `FAST_HOUR_LIMIT_MAX`). */
export const FAST_HOUR_LIMIT_MAX = 20_000;

/** Automatic messages to one person an hour when the owner set none (D11, `PERSON_HOUR_LIMIT_DEFAULT`). */
export const PERSON_HOUR_LIMIT_DEFAULT = 60;

/** The range of the owner's person hour limit (plan:L1960). */
export const PERSON_HOUR_LIMIT_RANGE = { min: 5, max: 100 } as const;

/** Broadcast messages an hour when the owner set none (D68, `BROADCAST_HOUR_LIMIT_DEFAULT`). */
export const BROADCAST_HOUR_LIMIT_DEFAULT = 600;

/** The highest broadcast hour limit (D68, `BROADCAST_HOUR_LIMIT_MAX`). */
export const BROADCAST_HOUR_LIMIT_MAX = 2000;

/** The highest end of the extra delay before each message, in seconds (D67, `EXTRA_DELAY_MAX_SECONDS`). */
export const EXTRA_DELAY_MAX_SECONDS = 20;

/** The stop words every account has (D49, `STOP_WORDS`); the owner's `extra_stop_words` add to them. */
export const STOP_WORDS: readonly string[] = ['stop', 'unsubscribe'];

/** At most this many owner stop words (plan:L2906). */
export const EXTRA_STOP_WORDS_MAX = 50;

/** Each owner stop word is at most this many characters (IA12). */
export const EXTRA_STOP_WORD_MAX_LENGTH = 50;
