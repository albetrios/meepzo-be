/**
 * One tag-intake hand-over (WC-4, scale review S20): the contacts of one organization whose new tag
 * events intake should work, at most {@link CONTACT_TAG_EVENT_INTAKE_CONTACTS_PER_JOB} of them —
 * public ids only, never a bigserial (K8). Intake reads each contact's undone events from Postgres,
 * oldest first, so the job never carries the events themselves.
 *
 * {@link CONTACT_TAG_EVENT_INTAKE_CONTACTS_PER_JOB}: `./contact-tag-event.constants.js`.
 */
export interface ContactTagEventIntakeJobInput {
  /** The organization whose job scope intake opens. */
  organizationPublicId: string;
  /** `con_…` — 1 to 500 contacts, no repeats. */
  contactPublicIds: readonly string[];
}

/**
 * The tag-intake port (WC-4): enqueues one tag-intake job (`intake-tag-events` on the
 * `instagram-webhook` queue, ROUTE row R38) — the app container passes it. Without it (a unit test)
 * the events stay `queued_at` null and wait for the pick-up (WC-27, ROUTE row R47).
 */
export interface ContactTagEventIntakeQueue {
  enqueueContactTagEventIntake(input: ContactTagEventIntakeJobInput): Promise<void>;
}

/**
 * The ports later ROUTE rows fill on {@link ContactTagEventService}.
 *
 * {@link ContactTagEventService}: `./contact-tag-event.service.js`.
 */
export interface ContactTagEventServicePorts {
  /** Intake's queue (wired since R38); absent → no hand-over, the events wait for the pick-up. */
  intakeQueue?: ContactTagEventIntakeQueue;
}

/** Where one commit's tag events go after it (the hand-over's targets). */
export interface ContactTagEventHandOverTarget {
  organizationPublicId: string;
  /** The live contacts among the events, in id order. */
  contactPublicIds: string[];
}
