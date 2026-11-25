/**
 * Job name of the missed-comment sweep (WH17, WC-26) — a repeatable job on the intake queue
 * (`src/infrastructure/queue/scheduler.ts`, every 30 minutes), run by the intake worker; it adds one
 * look per watched account on `instagram-tasks`.
 */
export const INSTAGRAM_MISSED_COMMENT_SWEEP_JOB_NAME = 'sweep-instagram-missed-comments';

/**
 * Job name of one account's missed-comment look on `instagram-tasks` (WC-26) — the key of
 * `instagramSendWork.taskHandlers` the app container registers the handler under.
 */
export const INSTAGRAM_MISSED_COMMENT_CHECK_JOB_NAME = 'missed-comment-check';
