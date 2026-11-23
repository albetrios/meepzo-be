import i18next from 'i18next';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { runOrganizationScopedWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type { NotificationService } from '@/domains/notify/sub-domains/notification/notification.service.js';
import type { MembershipService } from '@/domains/tenancy/sub-domains/membership/membership.service.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import { env } from '@/shared/config/env.config.js';
import { DEFAULT_FRONTEND_URL } from '@/shared/constants/index.js';
import type { SupportedLanguage } from '@/shared/constants/i18n.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { withoutTrailingSlashes } from '@/shared/utils/text/trailing-slash.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { INSTAGRAM_ACCOUNT_FRONTEND_PATH } from '@/domains/app/sub-domains/instagram-account/instagram-account.constants.js';
import {
  type InstagramAccountRow,
  createWorkerInstagramAccountRepository,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import {
  type InstagramReconnectNoticeJobData,
  buildInstagramReconnectNoticeJobId,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.queue.js';

/** The notification type of the reconnect notice (`NOTIFICATION_TYPES`, IA9). */
const INSTAGRAM_RECONNECT_REQUIRED_NOTIFICATION_TYPE = 'instagram.reconnect_required';

/**
 * The three cross-domain services the reconnect notice uses (IA9) — each through its service,
 * never its repository.
 *
 * @remarks
 * - **Algorithm:** structural picks, so the processor depends only on the methods it calls.
 * - **Failure modes:** none — type only.
 * - **Side effects:** none on this type.
 * - **Notes:** supplied by the worker composition root: tenancy's membership and organization
 *   settings services, notify's notification service (`worker-registration.registry.ts`).
 */
export interface InstagramReconnectNoticeServices {
  membershipService: Pick<MembershipService, 'findActiveUserIdsWithPermission'>;
  organizationSettingsService: Pick<
    OrganizationSettingsService,
    'resolveDefaultLocaleForOrganization'
  >;
  notificationService: Pick<NotificationService, 'createOrganizationNotifications'>;
}

/**
 * What one reconnect notice did.
 *
 * @remarks
 * - **Algorithm:** `sent` — `recipientCount` notifications written (each also emailed by the
 *   notification worker); `deduplicated` — this break was already told; `skipped` — the break is
 *   over (the account was reconnected or disconnected since), or nobody holds
 *   `instagram-account:manage`.
 * - **Failure modes:** none — a return shape (the job's return value in Bull Board).
 * - **Side effects:** none.
 * - **Notes:** a skip completes the job; nothing is retried.
 */
export type InstagramReconnectNoticeResult =
  | { outcome: 'sent'; recipientCount: number }
  | { outcome: 'deduplicated' }
  | { outcome: 'skipped'; reason: 'break_over' | 'no_recipients' };

/**
 * Whether the account still stands at the break a notice is about: still `expired` or `error`, and
 * its `connection_status_changed_at` is the job's.
 *
 * @remarks
 * - **Algorithm:** a missing account, any other status, or another change time → `false`.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 * - **Notes:** a reconnect (`connected`) or a disconnect (`revoked`) ends a break, and a later
 *   break carries a later time — telling an old break after it ended would ask for a reconnect
 *   that already happened. Exported for the unit test.
 */
export function isSameConnectionBreak({
  account,
  connectionStatusChangedAt,
}: {
  account: Pick<InstagramAccountRow, 'connection_status' | 'connection_status_changed_at'> | null;
  connectionStatusChangedAt: Date;
}): boolean {
  if (account === null) return false;
  if (account.connection_status !== 'expired' && account.connection_status !== 'error') {
    return false;
  }
  return account.connection_status_changed_at.getTime() === connectionStatusChangedAt.getTime();
}

/**
 * The notice's link: the frontend's Instagram page, absolute so the email's button works too.
 *
 * @remarks
 * - **Algorithm:** `FRONTEND_URL` (or the local default) + {@link INSTAGRAM_ACCOUNT_FRONTEND_PATH},
 *   without a doubled slash.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 * - **Notes:** exported for the unit test.
 */
export function buildInstagramReconnectNoticeActionUrl(frontendUrl: string): string {
  return `${withoutTrailingSlashes(frontendUrl)}${INSTAGRAM_ACCOUNT_FRONTEND_PATH}`;
}

/**
 * The notice's title and message in the organization's language — plain text (the inbox and the
 * email escape them where they land in HTML).
 *
 * @remarks
 * - **Algorithm:** `common:notifications.instagramReconnectRequiredTitle` / `…Message` with the
 *   account's username, in `locale`.
 * - **Failure modes:** none — a missing key falls back to English (i18next).
 * - **Side effects:** none.
 * - **Notes:** exported for the unit test.
 */
export function translateInstagramReconnectNotice({
  locale,
  username,
}: {
  locale: SupportedLanguage;
  username: string;
}): { title: string; message: string } {
  const plainText = { lng: locale, interpolation: { escapeValue: false } };
  return {
    title: i18next.t('common:notifications.instagramReconnectRequiredTitle', plainText),
    message: i18next.t('common:notifications.instagramReconnectRequiredMessage', {
      ...plainText,
      username,
    }),
  };
}

/**
 * Tells the organization that its Instagram account must be connected again (IA9, D10): one
 * in-app notification and one email, in the organization's language, linking to the Instagram
 * page, to every active member holding `instagram-account:manage` — once per break.
 *
 * @remarks
 * - **Algorithm:** the organization's language first (cached); then one unit of work in the
 *   organization's job scope (`runOrganizationScopedWorkerJob`, K8): re-read the account — a
 *   break that is over is skipped ({@link isSameConnectionBreak}); the recipients through the
 *   membership service (`findActiveUserIdsWithPermission`); the notifications through the
 *   notification service (`createOrganizationNotifications`, type `instagram.reconnect_required`,
 *   channels in-app and email), keyed once-only by the break. The services join this unit; the
 *   notifications' dispatch jobs are enqueued after it commits, and the notification worker sends
 *   the email through the mail outbox.
 * - **Failure modes:** a database failure rolls the unit back and the job retries — nothing was
 *   sent. Every recipient's row failing rethrows (retry); one failing is logged and skipped.
 * - **Side effects:** `notify.notifications` rows (one per recipient), their dispatch jobs, the
 *   emails.
 * - **Notes:** one break, one notice: the job id is the account and the break's time, and the
 *   notifications carry the same key, so a job run again after its commit (a stalled job) sends
 *   nothing twice. A reconnect followed by a new break is a new key, told again.
 */
export async function processInstagramReconnectNoticeJob({
  jobData,
  services,
}: {
  jobData: Pick<
    InstagramReconnectNoticeJobData,
    'organizationPublicId' | 'instagramAccountPublicId' | 'connectionStatusChangedAt'
  >;
  services: InstagramReconnectNoticeServices;
}): Promise<InstagramReconnectNoticeResult> {
  const { organizationPublicId, instagramAccountPublicId } = jobData;
  const connectionStatusChangedAt = new Date(jobData.connectionStatusChangedAt);
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  const locale =
    await services.organizationSettingsService.resolveDefaultLocaleForOrganization(
      organizationPublicId,
    );

  const result = await runOrganizationScopedWorkerJob({
    job: { organizationPublicId },
    processor: async (databaseHandle): Promise<InstagramReconnectNoticeResult> => {
      const account = await createWorkerInstagramAccountRepository(
        databaseHandle,
      ).findByPublicIdInOrganization({ organizationPublicId, instagramAccountPublicId });
      if (account === null || !isSameConnectionBreak({ account, connectionStatusChangedAt })) {
        return { outcome: 'skipped', reason: 'break_over' };
      }
      const recipientUserIds = await services.membershipService.findActiveUserIdsWithPermission({
        scope,
        permissionCode: APP_PERMISSIONS.INSTAGRAM_ACCOUNT_MANAGE,
      });
      if (recipientUserIds.length === 0) return { outcome: 'skipped', reason: 'no_recipients' };

      const { title, message } = translateInstagramReconnectNotice({
        locale,
        username: account.username ?? '',
      });
      const notified = await services.notificationService.createOrganizationNotifications({
        scope,
        recipientUserIds,
        notification: {
          type: INSTAGRAM_RECONNECT_REQUIRED_NOTIFICATION_TYPE,
          title,
          message,
          actionUrl: buildInstagramReconnectNoticeActionUrl(
            env.FRONTEND_URL ?? DEFAULT_FRONTEND_URL,
          ),
          channels: ['in_app', 'email'],
          locale,
        },
        dedupeKey: buildInstagramReconnectNoticeJobId({
          instagramAccountPublicId,
          connectionStatusChangedAt,
        }),
      });
      if (notified.deduplicated) return { outcome: 'deduplicated' };
      return { outcome: 'sent', recipientCount: notified.createdCount };
    },
  });
  logger.info(
    { organizationPublicId, instagramAccountPublicId, ...result },
    'app.instagram_account.reconnect_notice.completed',
  );
  return result;
}
