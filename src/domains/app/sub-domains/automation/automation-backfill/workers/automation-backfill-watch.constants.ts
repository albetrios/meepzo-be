/**
 * Job name of the past-comments watch (feat-instagram-dm-sending § 4.C AU32, AUC12; worker-changes
 * WC-41) — a repeatable job on the intake queue (`src/infrastructure/queue/scheduler.ts`, every 10
 * minutes), run by the intake worker; it wakes the read job of every account with a stuck read.
 */
export const AUTOMATION_BACKFILL_WATCH_JOB_NAME = 'watch-automation-backfill-reads';
