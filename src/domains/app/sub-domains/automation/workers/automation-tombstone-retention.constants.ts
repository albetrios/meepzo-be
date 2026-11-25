import { SMALL_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN } from '@/shared/constants/limits.constants.js';

/**
 * BullMQ queue of the deleted-automation purge (routes-final § 3.B AU25, AQ7, AUC12; WC-15, now
 * WC-47) — repeatable schedule hourly at :47 (P92): `src/infrastructure/queue/scheduler.ts`.
 */
export const AUTOMATION_TOMBSTONE_RETENTION_QUEUE_NAME = 'automation-tombstone-retention';

/**
 * Most `app.automations` rows one hourly purge run deletes (feat-instagram-dm-sending WC-47, P92:
 * "capped per table at the rows a day × 2") — owners delete a few thousand automations a day at
 * the plan's scale; the small-table cap (50,000) leaves room for a catch-up.
 */
export const AUTOMATION_TOMBSTONE_RETENTION_MAX_ROWS_PER_RUN =
  SMALL_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN;
