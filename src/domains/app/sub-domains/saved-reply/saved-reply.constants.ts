/**
 * The saved reply's limits (feat-instagram-inbox routes-final § 3.3, SR1–SR6): the organization's reusable
 * reply texts, shared across channels (I-D2).
 */

/** A title: 1 to this many characters; unique among the organization's live rows, any case (SR3). */
export const SAVED_REPLY_TITLE_MAX_CHARACTERS = 100;

/** A text: 1 to this many UTF-8 bytes (3.3) — Meta's DM limit is in bytes. */
export const SAVED_REPLY_TEXT_MAX_BYTES = 1000;
