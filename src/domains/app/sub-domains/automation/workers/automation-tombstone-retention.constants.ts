/**
 * BullMQ queue of the deleted-automation purge (routes-final § 3.B AU25, AQ7, AUC12; WC-15) —
 * repeatable schedule daily at 03:40 UTC: `src/infrastructure/queue/scheduler.ts`.
 */
export const AUTOMATION_TOMBSTONE_RETENTION_QUEUE_NAME = 'automation-tombstone-retention';
