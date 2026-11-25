import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { runOrganizationScopedWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { notifyOrganizationKind } from '@/domains/notify/sub-domains/notification/notification-notice.service.js';
import type { NotificationContactDetailsJobData } from '@/domains/notify/sub-domains/notification/queues/notification-contact-details.job.schema.js';

/**
 * The app's count of an account's contacts who left details (feat-instagram-dm-sending UN1, UN13),
 * declared by its consumer — the app implements it (`ContactService.countContactsWithDetailsLeft`)
 * and the worker composition root passes it in.
 *
 * @remarks
 * - **Algorithm:** live contacts of the account whose email or phone was saved in
 *   `[since, until]`; the account's username for the copy.
 * - **Failure modes:** read errors propagate (the job retries).
 * - **Side effects:** none — reads in the given scope, joining the job's unit.
 * - **Notes:** `null` — the account is gone (revoked, or the organization's).
 */
export type NotificationContactDetailsPort = {
  countContactsWithDetailsLeft(input: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
    since: Date;
    until: Date;
  }): Promise<{ count: number; username: string } | null>;
};

/**
 * What one grouped note did.
 *
 * @remarks
 * `skipped` — the account is gone or no contact's details are left (all erased meanwhile); `sent`
 * — one `contact.details_left` notice of `count`.
 */
export type NotificationContactDetailsResult =
  | { outcome: 'skipped'; reason: 'account_gone' | 'none_left' }
  | { outcome: 'sent'; count: number; notifiedCount: number };

/**
 * The grouped "new contact details" note (feat-instagram-dm-sending UN13, WC-63, AC-14.9): one
 * in-app note per Instagram account and hour — "3 new contacts left details on @account_a".
 *
 * @remarks
 * - **Algorithm:** in the organization's job scope: the app's {@link NotificationContactDetailsPort}
 *   from the window's start to now; zero → nothing; else one `contact.details_left` notice through
 *   `notifyOrganizationKind` (Owner, Admin, Editor — UN2; in-app on, email off by default — D54),
 *   keyed `contact-details:<account>:<window start>`.
 * - **Failure modes:** a read or write error rolls the unit back and the job retries; the key keeps
 *   a retry once.
 * - **Side effects:** inbox rows (and outbox rows for people with email on).
 * - **Notes:** the job is removed when it finishes, so the account's next detail opens a new window.
 */
export async function processNotificationContactDetailsJob({
  jobData,
  port,
  now = new Date(),
}: {
  jobData: Pick<
    NotificationContactDetailsJobData,
    'organizationPublicId' | 'channelAccountPublicId' | 'windowStartedAt'
  >;
  port: NotificationContactDetailsPort;
  now?: Date;
}): Promise<NotificationContactDetailsResult> {
  const { organizationPublicId, channelAccountPublicId } = jobData;
  const windowStartedAt = new Date(jobData.windowStartedAt);
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  const result = await runOrganizationScopedWorkerJob({
    job: { organizationPublicId },
    processor: async (): Promise<NotificationContactDetailsResult> => {
      const counted = await port.countContactsWithDetailsLeft({
        scope,
        channelAccountPublicId,
        since: windowStartedAt,
        until: now,
      });
      if (counted === null) return { outcome: 'skipped', reason: 'account_gone' };
      if (counted.count === 0) return { outcome: 'skipped', reason: 'none_left' };
      const notified = await notifyOrganizationKind({
        scope,
        type: 'contact.details_left',
        copy: {
          key: 'contactDetailsLeft',
          values: { count: counted.count, username: counted.username },
        },
        dedupeKey: `contact-details:${channelAccountPublicId}:${String(windowStartedAt.getTime())}`,
        actionPath: '/contacts',
        data: { count: counted.count, channel_account_id: channelAccountPublicId },
      });
      return { outcome: 'sent', count: counted.count, notifiedCount: notified.createdCount };
    },
  });
  logger.info(
    { organizationPublicId, channelAccountPublicId, ...result },
    'notify.contact_details.completed',
  );
  return result;
}
