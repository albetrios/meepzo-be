/**
 * BullMQ queue of the "next post" expiry (routes-final § 3.A AU15, WC-6, D9) — repeatable schedule
 * every 15 minutes: `src/infrastructure/queue/scheduler.ts`.
 */
export const AUTOMATION_NEXT_POST_EXPIRY_QUEUE_NAME = 'automation-next-post-expiry';

/** Most waiting automations one tick expires (oldest window end first); the next tick takes the rest (AUC8). */
export const AUTOMATION_NEXT_POST_EXPIRY_BATCH = 500;
