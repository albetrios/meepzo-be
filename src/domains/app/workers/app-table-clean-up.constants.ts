import { SMALL_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN } from '@/shared/constants/limits.constants.js';

/**
 * Job name of the hourly batch clean-up of the plain `app` tables (feat-instagram-dm-sending WC-53,
 * WC-54, WC-62; P92) — it rides the partition upkeep's queue (`APP_PARTITION_UPKEEP_QUEUE_NAME`), so
 * no queue or pool place is added (P140); schedule: `src/infrastructure/queue/scheduler.ts`.
 */
export const APP_TABLE_CLEAN_UP_JOB_NAME = 'clean-up-app-tables';

/**
 * Per-table caps of one run — the plan's rows a day × 2 (P92; plan §42.4 and the size table,
 * plan:L4147–L4167, L7464), rounded up to whole 5,000-row batches.
 *
 * @remarks
 * Recipients about 1.0 million a day at target → 2,000,000; tag events up to about 1 million over 8
 * days (bulk tags) → 250,000; month counts 16 slots per organization, all of one month due on one
 * day → 500,000; stop history, deleted broadcasts and deleted segments are small → the small-table cap (50,000) each.
 */
export const APP_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN = {
  broadcasts: SMALL_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN,
  segments: SMALL_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN,
  broadcastRecipients: 2_000_000,
  instagramSendStops: SMALL_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN,
  contactTagEvents: 250_000,
  messageMonthCounts: 500_000,
} as const;

/**
 * Days before an automation's purge is due (180 days after its delete) that the clean-up deletes the
 * account file links it alone names (WC-47, 6.C.10): the links are found through the automation's
 * `steps`, so they must go while it still exists — the automation code imports no channel folder
 * (AUC13), so the links go here and the automation purge (hourly at :47) follows.
 */
export const APP_TABLE_CLEAN_UP_FILE_LINK_LEAD_DAYS = 1;
