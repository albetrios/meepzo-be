import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  runGlobalRetentionWorkerJob,
  runOrganizationScopedWorkerJob,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { notifyOrganizationKind } from '@/domains/notify/sub-domains/notification/notification-notice.service.js';
import { createRetentionNotificationWeeklySummaryRepository } from '@/domains/notify/sub-domains/notification/notification-weekly-summary.repository.js';
import { enqueueNotificationWeeklySummary } from '@/domains/notify/sub-domains/notification/queues/notification-weekly-summary.queue.js';
import type { NotificationWeeklySummaryJobData } from '@/domains/notify/sub-domains/notification/queues/notification-weekly-summary.job.schema.js';
import {
  WEEKLY_SUMMARY_DAYS,
  WEEKLY_SUMMARY_HOUR,
  WEEKLY_SUMMARY_WEEKDAY,
} from './notification-weekly-summary.constants.js';

/**
 * One channel account's last 7 days, as the app's weekly-summary port answers it (UN1, UN12).
 *
 * @remarks
 * - **Algorithm:** counts over the window; `tappedPercent` is the share of the window's runs with a
 *   button tap, rounded (0 with no run).
 * - **Failure modes:** none — a value shape.
 * - **Side effects:** none.
 * - **Notes:** no personal data — counts, the account's username and an automation's name.
 */
export interface WeeklySummaryAccount {
  channelAccountPublicId: string;
  username: string;
  runsStarted: number;
  directMessagesSent: number;
  tappedPercent: number;
  newContacts: number;
  emailsCollected: number;
  phonesCollected: number;
  /** The automation with the most runs in the window, or `null` with none. */
  topAutomationName: string | null;
}

/**
 * The organization's week (UN12): one entry per live channel account, plus this month's DM count
 * and the plan's limit (`null` = no limit).
 *
 * @remarks
 * - **Algorithm:** a value shape.
 * - **Failure modes:** none.
 * - **Side effects:** none.
 * - **Notes:** the month is the organization's (its time zone), as the meter reads it.
 */
export interface WeeklySummary {
  accounts: readonly WeeklySummaryAccount[];
  monthUsed: number;
  monthLimit: number | null;
}

/**
 * The app's weekly-summary read (feat-instagram-dm-sending UN1), declared by its consumer — the
 * app implements it (`ChannelAccountService.readWeeklySummary`) and the worker composition root
 * passes it in, so notify never reads app tables and the containers keep no cycle.
 *
 * @remarks
 * - **Algorithm:** reads in the given organization scope, joining the job's open unit.
 * - **Failure modes:** the implementer's read errors propagate (the job retries).
 * - **Side effects:** none — reads.
 * - **Notes:** `since` inclusive, `until` exclusive.
 */
export type NotificationWeeklySummaryPort = {
  readWeeklySummary(input: {
    scope: OrganizationPrincipalDatabaseScope;
    since: Date;
    until: Date;
  }): Promise<WeeklySummary>;
};

/**
 * Whether nothing happened on any account in the week (UN12: then no email).
 *
 * @remarks
 * Pure; exported for the unit test. The month count alone does not make a week busy.
 */
export function isQuietWeek(summary: WeeklySummary): boolean {
  return summary.accounts.every(
    (account) =>
      account.runsStarted === 0 &&
      account.directMessagesSent === 0 &&
      account.newContacts === 0 &&
      account.emailsCollected === 0 &&
      account.phonesCollected === 0,
  );
}

/**
 * The hourly sweep of the weekly summary (feat-instagram-dm-sending UN12, WC-58): one job per team
 * organization where it is now Monday 09:00–09:59 in its own time zone.
 *
 * @remarks
 * - **Algorithm:** one read under the retention sweep arm
 *   (`NotificationWeeklySummaryRepository.listOrganizationsDueForWeeklySummary`), then per
 *   organization {@link enqueueNotificationWeeklySummary} (job id per organization and Monday) —
 *   outside the read's transaction.
 * - **Failure modes:** a database error propagates (the hourly job retries); a failed add is
 *   logged and the rest go on — a second run in the hour adds the missed one.
 * - **Side effects:** BullMQ jobs.
 * - **Notes:** safe to repeat (job ids) and to skip an hour (that hour's organizations get no
 *   summary that week — the plan accepts it).
 */
export async function runNotificationWeeklySummarySweepJob({
  now = new Date(),
  enqueue = enqueueNotificationWeeklySummary,
}: {
  now?: Date;
  enqueue?: typeof enqueueNotificationWeeklySummary;
} = {}): Promise<{ dueCount: number; enqueuedCount: number }> {
  const due = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionNotificationWeeklySummaryRepository(
      databaseHandle,
    ).listOrganizationsDueForWeeklySummary({
      at: now,
      weekday: WEEKLY_SUMMARY_WEEKDAY,
      hour: WEEKLY_SUMMARY_HOUR,
    }),
  );
  let enqueuedCount = 0;
  for (const organization of due) {
    try {
      await enqueue(organization);
      enqueuedCount += 1;
    } catch (error) {
      logger.warn(
        {
          organizationPublicId: organization.organizationPublicId,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'notify.weekly_summary.enqueue_failed',
      );
    }
  }
  logger.info({ dueCount: due.length, enqueuedCount }, 'notify.weekly_summary.swept');
  return { dueCount: due.length, enqueuedCount };
}

/**
 * What one organization's weekly summary did.
 *
 * @remarks
 * `quiet` — nothing happened, no email; `sent` — the notice went to `recipientCount` members (each
 * by their choice); `deduplicated` — this week was already sent.
 */
export type NotificationWeeklySummaryResult =
  | { outcome: 'quiet' }
  | { outcome: 'sent'; recipientCount: number; notifiedCount: number }
  | { outcome: 'deduplicated' };

/**
 * One organization's weekly summary (feat-instagram-dm-sending UN12, WC-58, AC-14.8): the last 7
 * days per Instagram account, emailed to every member who has the weekly summary on.
 *
 * @remarks
 * - **Algorithm:** in the organization's job scope: the app's {@link NotificationWeeklySummaryPort}
 *   for `[now − 7 days, now)`; a quiet week ({@link isQuietWeek}) → nothing; else one
 *   `report.weekly_summary` notice through `notifyOrganizationKind` — every member (UN2), email on
 *   and in-app off by default (D54) — with a line per account (runs, DMs sent, % tapped, new
 *   contacts, emails and phones, the top automation) and the month's count, keyed
 *   `weekly:<organization>:<Monday>`, so the outbox key is `…:weekly:<organization>:<Monday>:<user>`.
 * - **Failure modes:** a read or write error rolls the unit back and the job retries; the key keeps
 *   a retry from sending twice.
 * - **Side effects:** outbox rows (and inbox rows for members with in-app on); mail jobs.
 * - **Notes:** a restart never sends twice — the job id per organization and week, then the key.
 */
export async function processNotificationWeeklySummaryJob({
  jobData,
  port,
  now = new Date(),
}: {
  jobData: Pick<NotificationWeeklySummaryJobData, 'organizationPublicId' | 'weekStart'>;
  port: NotificationWeeklySummaryPort;
  now?: Date;
}): Promise<NotificationWeeklySummaryResult> {
  const { organizationPublicId, weekStart } = jobData;
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  const result = await runOrganizationScopedWorkerJob({
    job: { organizationPublicId },
    processor: async (): Promise<NotificationWeeklySummaryResult> => {
      const summary = await port.readWeeklySummary({
        scope,
        since: new Date(now.getTime() - WEEKLY_SUMMARY_DAYS * MILLISECONDS_PER_DAY),
        until: now,
      });
      if (isQuietWeek(summary)) return { outcome: 'quiet' };
      const notified = await notifyOrganizationKind({
        scope,
        type: 'report.weekly_summary',
        copy: {
          key: 'weeklySummary',
          lines: [
            ...summary.accounts.map((account) => ({
              key: 'weeklySummaryAccountLine',
              values: {
                username: account.username,
                runsStarted: account.runsStarted,
                directMessagesSent: account.directMessagesSent,
                tappedPercent: account.tappedPercent,
                newContacts: account.newContacts,
                emailsCollected: account.emailsCollected,
                phonesCollected: account.phonesCollected,
                topAutomation: account.topAutomationName ?? '—',
              },
            })),
            summary.monthLimit === null
              ? { key: 'weeklySummaryMonthLine', values: { used: summary.monthUsed } }
              : {
                  key: 'weeklySummaryMonthLimitLine',
                  values: { used: summary.monthUsed, limit: summary.monthLimit },
                },
          ],
        },
        dedupeKey: `weekly:${organizationPublicId}:${weekStart}`,
        actionPath: '/instagram',
        data: { week_start: weekStart },
      });
      if (notified.deduplicated) return { outcome: 'deduplicated' };
      return {
        outcome: 'sent',
        recipientCount: notified.recipientCount,
        notifiedCount: notified.createdCount,
      };
    },
  });
  logger.info({ organizationPublicId, weekStart, ...result }, 'notify.weekly_summary.completed');
  return result;
}
