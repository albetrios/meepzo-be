import i18next from 'i18next';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { isMailConfigured } from '@/infrastructure/mail/mail.service.js';
import { dispatchOutboxEmail, recordOutboxEmail } from '@/infrastructure/mail/queues/mail.queue.js';
import { env } from '@/shared/config/env.config.js';
import { DEFAULT_FRONTEND_URL } from '@/shared/constants/index.js';
import {
  findNotificationKindForType,
  type NotificationType,
} from '@/shared/constants/notification.constants.js';
import type { SupportedLanguage } from '@/shared/constants/i18n.constants.js';
import { ConfigurationError } from '@/shared/errors/index.js';
import { listGlobalAdminEmails } from '@/shared/utils/auth/global-admin-role.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { withoutTrailingSlashes } from '@/shared/utils/text/trailing-slash.util.js';
import {
  type NotificationDeliveryChannel,
  resolveNotificationRecipients,
} from './notification-dispatch.service.js';
import type {
  NotificationService,
  OrganizationNotificationsResult,
} from './notification.service.js';
import { enqueueNotificationContactDetails } from './queues/notification-contact-details.queue.js';
import { buildNotificationEmailHtml } from './workers/notification-email-content.js';

/**
 * The organization's language, read for a notice's copy — tenancy's `OrganizationSettingsService`,
 * supplied structurally by the notify container.
 *
 * @remarks
 * - **Algorithm:** cached read of the organization's default locale (`en` when unset).
 * - **Failure modes:** propagates the read's errors.
 * - **Side effects:** none — a read (and its cache fill).
 * - **Notes:** joins the caller's open unit of the same organization.
 */
export type NotificationNoticeLocalePort = {
  resolveDefaultLocaleForOrganization(organizationPublicId: string): Promise<SupportedLanguage>;
};

/**
 * One notice of a kind to an organization (feat-instagram-dm-sending UN2, UN9, UN11), as
 * {@link notifyOrganizationKind} takes it.
 *
 * @remarks
 * - **Algorithm:** `copy.key` names the copy pair `common:notifications.<key>Title` / `…Message`;
 *   `copy.values` fills both. `dedupeKey` is the emitter's once rule (P88). `subjectUserId` is the
 *   member the notice is about or who started the work (the kind's rule decides whether it counts).
 * - **Failure modes:** none — a value shape.
 * - **Side effects:** none.
 * - **Notes:** `actionPath` is a frontend path; the absolute link also becomes the email's button.
 */
export interface OrganizationKindNoticeInput {
  scope: OrganizationPrincipalDatabaseScope;
  type: NotificationType;
  copy: {
    key: string;
    values?: Readonly<Record<string, string | number>>;
    /**
     * Sentences translated one by one (`common:notifications.<key>`) and joined into the
     * `{{lines}}` value — the weekly summary's line per account.
     */
    lines?: readonly { key: string; values: Readonly<Record<string, string | number>> }[];
  };
  dedupeKey: string;
  actionPath?: string;
  subjectUserId?: number | null;
  data?: Readonly<Record<string, unknown>>;
  /** The channels offered (an upper bound; each person's choices narrow it). Default both. */
  channels?: readonly NotificationDeliveryChannel[];
}

/**
 * What {@link notifyOrganizationKind} did.
 *
 * @remarks
 * - **Algorithm:** the notification service's answer plus how many people the kind's rule named.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** `recipientCount` 0 → nothing was written.
 */
export interface OrganizationKindNoticeResult extends OrganizationNotificationsResult {
  recipientCount: number;
}

let noticeDependencies: {
  notificationService: Pick<NotificationService, 'createOrganizationNotifications'>;
  localePort: NotificationNoticeLocalePort;
} | null = null;

/**
 * Wire the notification service and the locale read {@link notifyOrganizationKind} uses. Called
 * once from the notify container during boot.
 *
 * @remarks
 * - **Algorithm:** stores both in a module-scoped slot, as `configureNotificationDispatch`.
 * - **Failure modes:** none — last writer wins.
 * - **Side effects:** mutates the module-level slot.
 * - **Notes:** an unwired notice throws `ConfigurationError` on use.
 */
export function configureNotificationNotices(dependencies: {
  notificationService: Pick<NotificationService, 'createOrganizationNotifications'>;
  localePort: NotificationNoticeLocalePort;
}): void {
  noticeDependencies = dependencies;
}

/** The absolute frontend link of a path (the email's button needs a full URL). */
function frontendLinkOf(path: string | undefined): string {
  return `${withoutTrailingSlashes(env.FRONTEND_URL ?? DEFAULT_FRONTEND_URL)}${path ?? ''}`;
}

/**
 * Sends one notice of a kind to the organization's people (feat-instagram-dm-sending UN2, UN9,
 * UN11): the kind's recipients rule names them, the check before send applies each person's
 * choices, the emitter's key keeps it once.
 *
 * @remarks
 * - **Algorithm:** the type's kind (`NOTIFICATION_KINDS`); the organization's language; the
 *   recipients through {@link resolveNotificationRecipients} (the kind's rule, plus `subjectUserId`
 *   where the rule adds it); the copy `common:notifications.<key>Title` / `…Message` as plain text;
 *   then `NotificationService.createOrganizationNotifications` — the key's lock, the in-app
 *   dedupe, the dispatch (in-app rows, email-only outbox rows) and the cache drops after commit.
 * - **Failure modes:** `ConfigurationError` for a type in no kind or an unwired notice; the reads'
 *   and the dispatch's errors propagate (the emitter's unit rolls back or its job retries — the key
 *   keeps the retry once).
 * - **Side effects:** notification rows, outbox rows, post-commit enqueues — in the caller's unit
 *   when one is open for the organization, else in its own.
 * - **Notes:** no recipient → nothing is written (`recipientCount` 0).
 */
export async function notifyOrganizationKind(
  input: OrganizationKindNoticeInput,
): Promise<OrganizationKindNoticeResult> {
  if (noticeDependencies === null) {
    throw new ConfigurationError(
      'Notification notices are not configured. Call configureNotificationNotices from notify.container.',
    );
  }
  const definition = findNotificationKindForType(input.type);
  if (definition === undefined) {
    throw new ConfigurationError(`Notification type ${input.type} belongs to no kind.`);
  }
  const recipientUserIds = await resolveNotificationRecipients({
    scope: input.scope,
    rule: definition.recipientsRule,
    subjectUserId: input.subjectUserId ?? null,
  });
  if (recipientUserIds.length === 0) {
    return { createdCount: 0, failedCount: 0, deduplicated: false, recipientCount: 0 };
  }
  const locale = await noticeDependencies.localePort.resolveDefaultLocaleForOrganization(
    input.scope.organizationPublicId,
  );
  const lineOptions = { lng: locale, interpolation: { escapeValue: false } };
  const lines = (input.copy.lines ?? [])
    .map((line) =>
      i18next.t(`common:notifications.${line.key}`, { ...lineOptions, ...line.values }),
    )
    .join(' ');
  const plainText = { ...lineOptions, ...input.copy.values, lines };
  const result = await noticeDependencies.notificationService.createOrganizationNotifications({
    scope: input.scope,
    recipientUserIds,
    notification: {
      type: input.type,
      title: i18next.t(`common:notifications.${input.copy.key}Title`, plainText),
      message: i18next.t(`common:notifications.${input.copy.key}Message`, plainText),
      actionUrl: frontendLinkOf(input.actionPath),
      channels: input.channels ?? ['in_app', 'email'],
      locale,
      data: input.data,
    },
    dedupeKey: input.dedupeKey,
  });
  return { ...result, recipientCount: recipientUserIds.length };
}

/**
 * Notes that a contact of a channel account left her email or phone (feat-instagram-dm-sending
 * UN13, WC-63): the grouped "new contact details" note goes at most once an hour per account.
 *
 * @remarks
 * - **Algorithm:** adds the account's delayed `notification-contact-details` job, due
 *   `CONTACT_DETAILS_NOTICE_EVERY_MINUTES` after `at`, with job id `contact-details-<account>` —
 *   BullMQ keeps one pending job per id, so the 2nd and later details of the hour add nothing.
 * - **Failure modes:** a Redis failure propagates; callers run it after their commit and log it
 *   (the note is a convenience — Postgres keeps the contacts' times).
 * - **Side effects:** one BullMQ job, or none.
 * - **Notes:** call after the commit that saved the detail.
 */
export async function noteContactDetailsLeft(input: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  at: Date;
}): Promise<void> {
  await enqueueNotificationContactDetails(input);
}

/**
 * One alert for the team (the platform's operators — `GLOBAL_ADMIN_EMAILS`), as
 * {@link sendTeamAlertEmail} takes it.
 *
 * @remarks
 * - **Algorithm:** `key` names the copy pair `common:teamAlerts.<key>Subject` / `…Message`, filled
 *   with `values`; `dedupeKey` keeps one email per alert and address.
 * - **Failure modes:** none — a value shape.
 * - **Side effects:** none.
 * - **Notes:** English only — the team's language.
 */
export interface TeamAlertEmailInput {
  key: string;
  values: Readonly<Record<string, string | number>>;
  dedupeKey: string;
}

/**
 * Emails the team (feat-instagram-dm-sending WC-57's team part, MC16): one email per address of
 * `GLOBAL_ADMIN_EMAILS`, through the mail outbox, once per `dedupeKey`.
 *
 * @remarks
 * - **Algorithm:** the addresses; per address one outbox row (`team-alert:<dedupeKey>:<address>`)
 *   in the system-table context (no tenant — the alert is about no organization or many), then its
 *   send on the bulk lane.
 * - **Failure modes:** no address or no mail configuration → logged, `0`; an outbox write fails →
 *   propagates (the caller logs it); a lost send is re-enqueued by the outbox sweeper.
 * - **Side effects:** `auth.mail_outbox` rows; mail jobs.
 * - **Notes:** returns how many addresses were emailed.
 */
export async function sendTeamAlertEmail(input: TeamAlertEmailInput): Promise<number> {
  const addresses = listGlobalAdminEmails();
  if (addresses.length === 0 || !isMailConfigured()) {
    logger.warn({ alert: input.key, addressCount: addresses.length }, 'notify.team_alert.skipped');
    return 0;
  }
  const plainText = { lng: 'en', interpolation: { escapeValue: false }, ...input.values };
  const { subject, html } = buildNotificationEmailHtml({
    title: i18next.t(`common:teamAlerts.${input.key}Subject`, plainText),
    message: i18next.t(`common:teamAlerts.${input.key}Message`, plainText),
    actionUrl: null,
    locale: 'en',
  });
  for (const address of addresses) {
    const mailOutboxToken = await withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.SYSTEM_TABLE_WORKER,
      callback: () =>
        recordOutboxEmail({
          to: address,
          subject,
          html,
          tags: [{ name: 'category', value: `team-alert-${input.key}` }],
          dedupeKey: `team-alert:${input.dedupeKey}:${address}`,
        }),
    });
    await dispatchOutboxEmail({ mailOutboxToken, options: { lane: 'bulk' } });
  }
  logger.info({ alert: input.key, addressCount: addresses.length }, 'notify.team_alert.sent');
  return addresses.length;
}
