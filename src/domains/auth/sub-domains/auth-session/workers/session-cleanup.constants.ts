import { SMALL_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN } from '@/shared/constants/limits.constants.js';

/** BullMQ queue name — repeatable schedule: `src/infrastructure/queue/scheduler.ts`. */
export const SESSION_CLEANUP_QUEUE_NAME = 'session-cleanup';

/**
 * Most `auth.sessions` rows one hourly clean-up run deletes (feat-instagram-dm-sending WC-64, P92:
 * "capped per table at the rows a day × 2") — about 250,000 sign-ins a day at the plan's scale,
 * so 500,000; a larger backlog continues the next hour and the overdue gauge shows it.
 */
export const SESSION_CLEANUP_MAX_ROWS_PER_RUN = 500_000;

/**
 * Most `auth.trusted_devices` rows one hourly clean-up run deletes (WC-64, P92) — at most one
 * trusted browser per 2FA sign-in, a small share of the sessions; the small-table cap (50,000).
 */
export const TRUSTED_DEVICE_CLEANUP_MAX_ROWS_PER_RUN = SMALL_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN;
