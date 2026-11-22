/**
 * BullMQ queue of comment-log retention (routes-final § 3.B AU25, AUC12; WC-9, D8) — repeatable
 * schedule daily at 03:30 UTC: `src/infrastructure/queue/scheduler.ts`.
 */
export const AUTOMATION_COMMENT_LOG_RETENTION_QUEUE_NAME = 'automation-comment-log-retention';
