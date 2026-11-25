/**
 * Job name of the "next post" linking sweep (feat-instagram-dm-sending § 4 AU6, AUC3; worker-changes
 * WC-43) — a repeatable job on the intake queue (`src/infrastructure/queue/scheduler.ts`, every 15
 * minutes), run by the intake worker; it adds one linking task per account on its channel's task
 * queue.
 */
export const AUTOMATION_NEXT_POST_LINKING_SWEEP_JOB_NAME = 'sweep-next-post-linking';

/** How often the sweep runs (WC-43): every 15 minutes — Meta sends no new-post event. */
export const AUTOMATION_NEXT_POST_LINKING_MINUTES = 15;

/** The most accounts one sweep reads — the rest wait for the next round (logged when reached). */
export const AUTOMATION_NEXT_POST_LINKING_ACCOUNT_LIMIT = 5000;
