/**
 * BullMQ queue of the 7-day wait check (routes-final § 3.B AU25, AUC12; WC-13, D8) — repeatable
 * schedule every hour: `src/infrastructure/queue/scheduler.ts`.
 */
export const AUTOMATION_RUN_WAIT_EXPIRY_QUEUE_NAME = 'automation-run-wait-expiry';

/** Most waiting runs one tick cancels (longest wait first); the next tick takes the rest (AUC12). */
export const AUTOMATION_RUN_WAIT_EXPIRY_BATCH = 500;
