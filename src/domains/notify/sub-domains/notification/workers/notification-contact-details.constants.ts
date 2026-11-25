/**
 * Job name of one account's grouped "new contact details" note (feat-instagram-dm-sending UN13,
 * WC-63) — delayed to the end of its hour window, on the `notification` queue (its worker routes
 * it; no queue or pool of its own — the worker pool budget, P317).
 */
export const NOTIFICATION_CONTACT_DETAILS_JOB_NAME = 'notification-contact-details';

/** At most one note per Instagram account this often, in minutes (UN13, plan:L8157). */
export const CONTACT_DETAILS_NOTICE_EVERY_MINUTES = 60;
