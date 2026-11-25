/**
 * The hourly sweep of the weekly summary (feat-instagram-dm-sending UN12, WC-58): it finds the
 * organizations whose Monday 09:00 hour it is (no payload). It and the per-organization jobs ride
 * the `notification` queue — its worker routes both; no queue or pool of their own (the worker
 * pool budget, P317).
 */
export const NOTIFICATION_WEEKLY_SUMMARY_SWEEP_JOB_NAME = 'sweep-weekly-summaries';

/** One organization's summary of its last 7 days. */
export const NOTIFICATION_WEEKLY_SUMMARY_JOB_NAME = 'send-weekly-summary';

/** The day the summary goes, ISO (1 = Monday), in the organization's time zone (UN12). */
export const WEEKLY_SUMMARY_WEEKDAY = 1;

/** The hour the summary goes (09:00–09:59), in the organization's time zone (UN12). */
export const WEEKLY_SUMMARY_HOUR = 9;

/** The days a summary covers (UN12, plan:L8184). */
export const WEEKLY_SUMMARY_DAYS = 7;
