/**
 * Job name of the stuck-event pick-up (WH15, WC-2) — a repeatable job on the event-processing
 * queue (`src/infrastructure/queue/scheduler.ts`, every minute), run by the processing worker.
 */
export const INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME = 'reclaim-instagram-webhook-events';

/** Most Instagram accounts one pick-up hands back to processing (WH15) — more wait for the next minute. */
export const INSTAGRAM_WEBHOOK_RECLAIM_BATCH_SIZE = 100;
