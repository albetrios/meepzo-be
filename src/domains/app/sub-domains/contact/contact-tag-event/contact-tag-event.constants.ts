/** `app.contact_tag_events.kind` (routes-final § 3.B.3): the tag was added to or removed from her. */
export const CONTACT_TAG_EVENT_KINDS = ['added', 'removed'] as const;

/** One value of {@link CONTACT_TAG_EVENT_KINDS}. */
export type ContactTagEventKind = (typeof CONTACT_TAG_EVENT_KINDS)[number];

/**
 * `app.contact_tag_events.source` (CT16): the tag step of a run (`automation`, with
 * `source_automation_id`) or the owner (routes 20 and 21, `owner`).
 */
export const CONTACT_TAG_EVENT_SOURCES = ['automation', 'owner'] as const;

/** One value of {@link CONTACT_TAG_EVENT_SOURCES}. */
export type ContactTagEventSource = (typeof CONTACT_TAG_EVENT_SOURCES)[number];

/**
 * How many contacts one tag-intake hand-over names at most (scale review S20, P97): the events of
 * one commit are handed to intake in one job per 500 contacts, never one job per contact.
 */
export const CONTACT_TAG_EVENT_INTAKE_CONTACTS_PER_JOB = 500;

/**
 * Days a contact tag event is kept before the hourly clean-up deletes it (WC-54, plan
 * `TAG_EVENT_KEEP_DAYS`): long enough for the pick-up (24 hours) and a week of support questions.
 */
export const CONTACT_TAG_EVENT_KEEP_DAYS = 8;
