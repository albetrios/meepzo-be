import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  AUTOMATION_TOMBSTONE_RETENTION_DAYS,
  MESSAGE_MONTH_COUNT_KEEP_MONTHS,
} from '@/shared/constants/instagram.constants.js';
import { createRetentionInstagramAttachmentRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-attachment/instagram-attachment.repository.js';
import {
  runTimeBudgetedCleanUp,
  type TimeBudgetedCleanUpReport,
  type TimeBudgetedCleanUpTable,
} from '@/infrastructure/queue/worker-runtime/time-budgeted-clean-up.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { BROADCAST_TOMBSTONE_RETENTION_DAYS } from '@/domains/app/sub-domains/broadcast/broadcast.constants.js';
import { createRetentionBroadcastRepository } from '@/domains/app/sub-domains/broadcast/broadcast.repository.js';
import { createRetentionBroadcastSegmentRepository } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.repository.js';
import { BROADCAST_RECIPIENT_KEEP_DAYS } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.constants.js';
import { createRetentionBroadcastRecipientRepository } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.repository.js';
import { CONTACT_TAG_EVENT_KEEP_DAYS } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.constants.js';
import { createRetentionContactTagEventRepository } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.repository.js';
import { INSTAGRAM_SEND_STOP_KEEP_DAYS } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import { createRetentionInstagramSendStopRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-stop.repository.js';
import { createRetentionMessageMonthCountRepository } from '@/domains/app/sub-domains/instagram-sending/message-month-count.repository.js';
import {
  APP_TABLE_CLEAN_UP_FILE_LINK_LEAD_DAYS,
  APP_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN,
} from './app-table-clean-up.constants.js';

/** `now` minus whole days. */
function daysBefore({ now, days }: { now: Date; days: number }): Date {
  return new Date(now.getTime() - days * MILLISECONDS_PER_DAY);
}

/** `now` minus whole calendar months (UTC). */
function monthsBefore({ now, months }: { now: Date; months: number }): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

/**
 * The plain `app` tables the hourly clean-up empties, in its order, with each one's cutoff — the
 * broadcasts before the segments (a purged broadcast frees its segment) and before the recipients
 * (their cascade takes a purged broadcast's recipients first).
 *
 * @remarks
 * - **Algorithm:** the cutoffs from `now` (days, or calendar months in UTC for month counts), then
 *   one spec per table whose two steps each open their own `runGlobalRetentionWorkerJob` and call
 *   the table's retention-bound repository.
 * - **Failure modes:** none of its own — it only builds the specs.
 * - **Side effects:** none until a spec's step runs.
 * - **Notes:** exported so a test or a one-off run can see the order and the caps.
 */
export function buildAppTableCleanUpTables(now: Date): TimeBudgetedCleanUpTable[] {
  const broadcastCutoff = daysBefore({ now, days: BROADCAST_TOMBSTONE_RETENTION_DAYS });
  const recipientCutoff = daysBefore({ now, days: BROADCAST_RECIPIENT_KEEP_DAYS });
  const stopCutoff = daysBefore({ now, days: INSTAGRAM_SEND_STOP_KEEP_DAYS });
  const tagEventCutoff = daysBefore({ now, days: CONTACT_TAG_EVENT_KEEP_DAYS });
  const monthCutoff = monthsBefore({ now, months: MESSAGE_MONTH_COUNT_KEEP_MONTHS });
  return [
    {
      table: 'app.broadcasts',
      maxRowsPerRun: APP_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN.broadcasts,
      deleteUnit: ({ maxBatches }) =>
        runGlobalRetentionWorkerJob((handle) =>
          createRetentionBroadcastRepository(handle).deleteTombstonedBefore({
            cutoff: broadcastCutoff,
            maxBatches,
          }),
        ),
      readOldestOverdueSeconds: () =>
        runGlobalRetentionWorkerJob((handle) =>
          createRetentionBroadcastRepository(handle).readTombstonedOverdueSeconds(broadcastCutoff),
        ),
    },
    {
      table: 'app.segments',
      maxRowsPerRun: APP_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN.segments,
      deleteUnit: ({ maxBatches }) =>
        runGlobalRetentionWorkerJob((handle) =>
          createRetentionBroadcastSegmentRepository(handle).deleteTombstonedBefore({
            cutoff: broadcastCutoff,
            maxBatches,
          }),
        ),
      readOldestOverdueSeconds: () =>
        runGlobalRetentionWorkerJob((handle) =>
          createRetentionBroadcastSegmentRepository(handle).readTombstonedOverdueSeconds(
            broadcastCutoff,
          ),
        ),
    },
    {
      table: 'app.broadcast_recipients',
      maxRowsPerRun: APP_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN.broadcastRecipients,
      deleteUnit: ({ maxBatches }) =>
        runGlobalRetentionWorkerJob((handle) =>
          createRetentionBroadcastRecipientRepository(handle).deleteCreatedBefore({
            cutoff: recipientCutoff,
            maxBatches,
          }),
        ),
      readOldestOverdueSeconds: () =>
        runGlobalRetentionWorkerJob((handle) =>
          createRetentionBroadcastRecipientRepository(handle).readCreatedOverdueSeconds(
            recipientCutoff,
          ),
        ),
    },
    {
      table: 'app.instagram_send_stops',
      maxRowsPerRun: APP_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN.instagramSendStops,
      deleteUnit: ({ maxBatches }) =>
        runGlobalRetentionWorkerJob((handle) =>
          createRetentionInstagramSendStopRepository(handle).deleteEndedStartedBefore({
            cutoff: stopCutoff,
            maxBatches,
          }),
        ),
      readOldestOverdueSeconds: () =>
        runGlobalRetentionWorkerJob((handle) =>
          createRetentionInstagramSendStopRepository(handle).readEndedStartedOverdueSeconds(
            stopCutoff,
          ),
        ),
    },
    {
      table: 'app.contact_tag_events',
      maxRowsPerRun: APP_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN.contactTagEvents,
      deleteUnit: ({ maxBatches }) =>
        runGlobalRetentionWorkerJob((handle) =>
          createRetentionContactTagEventRepository(handle).deleteCreatedBefore({
            cutoff: tagEventCutoff,
            maxBatches,
          }),
        ),
      readOldestOverdueSeconds: () =>
        runGlobalRetentionWorkerJob((handle) =>
          createRetentionContactTagEventRepository(handle).readCreatedOverdueSeconds(
            tagEventCutoff,
          ),
        ),
    },
    {
      table: 'app.message_month_counts',
      maxRowsPerRun: APP_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN.messageMonthCounts,
      deleteUnit: ({ maxBatches }) =>
        runGlobalRetentionWorkerJob((handle) =>
          createRetentionMessageMonthCountRepository(handle).deleteMonthsBefore({
            cutoff: monthCutoff,
            maxBatches,
          }),
        ),
      readOldestOverdueSeconds: () =>
        runGlobalRetentionWorkerJob((handle) =>
          createRetentionMessageMonthCountRepository(handle).readMonthsOverdueSeconds(monthCutoff),
        ),
    },
  ];
}

/**
 * The hourly batch clean-up of the plain `app` tables (feat-instagram-dm-sending WC-53, WC-54,
 * WC-62; routes-final § 7 BCC3, § 7.C BCC9; P75, P92, P9): deleted broadcasts and segments 90
 * days after their delete, broadcast recipients and ended stops after 90 days, contact tag events
 * after 8 days, month counts after 13 months.
 *
 * @remarks
 * - **Algorithm:** first one retention unit of work deletes the account file links
 *   (`app.instagram_attachments`) that an automation deleted more than 179 days ago names and no
 *   live automation of its account does (WC-47, 6.C.10) — a day
 *   ({@link APP_TABLE_CLEAN_UP_FILE_LINK_LEAD_DAYS}) before the automation purge may remove the
 *   automation whose `steps` name them. Then {@link runTimeBudgetedCleanUp} over
 *   {@link buildAppTableCleanUpTables}: each
 *   table in units of capped batches, each unit its own `runGlobalRetentionWorkerJob`
 *   (`app.global_retention_cleanup`, the sweep arm every one of these policies carries in `USING`),
 *   until no due row is left, its cap ({@link APP_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN}) or its share
 *   of the 10-minute budget; then its "oldest row past its keep time" gauge.
 * - **Failure modes:** a failed table is logged and the others still run, then the run throws so
 *   BullMQ retries it (then the DLQ).
 * - **Side effects:** hard-deletes due rows and unused file links (one deleted early costs one
 *   upload again before the next send, SN20, never a send); a purged broadcast takes its recipients and messages by
 *   cascade, a purged segment sets a deleted broadcast's key null; the `retention_cleanup_*` gauges;
 *   counts-only logs; a warn log and Sentry message for a table over a day behind.
 * - **Notes:** contacts are never removed by age (AC-18.4) — no table here holds them. Idempotent
 *   and safe to skip — the next hour catches up. `now` is injectable for tests.
 */
export async function runAppTableCleanUpJob({
  now = new Date(),
}: {
  now?: Date | undefined;
} = {}): Promise<TimeBudgetedCleanUpReport[]> {
  const deletedFileLinks = await runGlobalRetentionWorkerJob((handle) =>
    createRetentionInstagramAttachmentRepository(handle).deleteUnusedByPurgedAutomations({
      deletedBefore: daysBefore({
        now,
        days: AUTOMATION_TOMBSTONE_RETENTION_DAYS - APP_TABLE_CLEAN_UP_FILE_LINK_LEAD_DAYS,
      }),
    }),
  );
  logger.info({ deletedFileLinks }, 'app-table-clean-up.file_links_deleted');

  return runTimeBudgetedCleanUp({
    logLabel: 'app-table-clean-up',
    tables: buildAppTableCleanUpTables(now),
  });
}
