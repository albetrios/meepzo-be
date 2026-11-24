import { scheduleCommitDispatch } from '@/core/events/event-bus.js';
import type {
  NotificationChoiceRow,
  NotificationRecipientRow,
  NotificationRepository,
} from '@/domains/notify/sub-domains/notification/notification.repository.js';
import { buildNotificationEmailHtml } from '@/domains/notify/sub-domains/notification/workers/notification-email-content.js';
import { withSavepoint } from '@/infrastructure/database/transaction.js';
import { isMailConfigured } from '@/infrastructure/mail/mail.service.js';
import { recordOutboxEmail } from '@/infrastructure/mail/queues/mail.queue.js';
import type { SupportedLanguage } from '@/shared/constants/i18n.constants.js';
import {
  findNotificationKindForType,
  resolveNotificationKindChannel,
  type NotificationKindDefinition,
  type NotificationPreferenceChannel,
  type NotificationType,
} from '@/shared/constants/notification.constants.js';
import { ConfigurationError, NotFoundError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * A channel a notification is offered on: the inbox row, or an email.
 *
 * @remarks
 * Push (`WEB_PUSH`) is a saved choice only — nothing sends it yet (plan §49) — so an emitter cannot
 * offer it. The values ride in the row's `data.channels`, which the notification worker reads.
 */
export type NotificationDeliveryChannel = 'in_app' | 'email';

/**
 * The mail-outbox dedupe key of one notification email (feat-instagram-dm-sending UN11, P88).
 *
 * @remarks
 * - **Algorithm:** `notification:<type>:<dedupe_key>:<user_public_id>`.
 * - **Failure modes:** none — a pure string build.
 * - **Side effects:** none.
 * - **Notes:** the same key whether the email leaves with an inbox row (the notification worker) or
 *   without one (the dispatch), so a replay of the emitter's job sends nothing twice — the outbox's
 *   unique `dedupe_key` keeps one row.
 */
export function buildNotificationEmailDedupeKey({
  type,
  dedupeKey,
  userPublicId,
}: {
  type: string;
  dedupeKey: string;
  userPublicId: string;
}): string {
  return `notification:${type}:${dedupeKey}:${userPublicId}`;
}

/**
 * One notification for a set of recipients, as {@link createAndDispatchNotification} takes it.
 *
 * @remarks
 * - **Algorithm:** `channels` is what the emitter offers; the check before send narrows it per
 *   recipient (the kind's choices, the organization's mute). `dedupe_key` is the emitter's "once"
 *   key (once per stop, per month and line, per week, per invitation — UNQ2, P88): it rides in the
 *   row's `data.dedupe_key` and names the email's outbox key.
 * - **Failure modes:** none — a value shape.
 * - **Side effects:** none.
 * - **Notes:** `title` and `message` are plain text in `locale`; the inbox and the email escape
 *   them. Recipients are internal user ids resolved by the emitter — the kind's recipients rule
 *   (`NOTIFICATION_KINDS[].recipientsRule`) gets its resolver, `resolveNotificationRecipients`, in
 *   ROUTE R34.
 */
export interface DispatchNotificationInput {
  recipientUserIds: readonly number[];
  organization_id?: number;
  type: NotificationType;
  title: string;
  message: string;
  action_url?: string;
  channels: readonly NotificationDeliveryChannel[];
  locale: SupportedLanguage;
  dedupe_key: string;
}

/**
 * What {@link createAndDispatchNotification} did, per recipient.
 *
 * @remarks
 * - **Algorithm:** `inAppUserIds` / `inAppUserPublicIds` got an inbox row (and their email, when on,
 *   through the notification worker); `emailOnlyUserIds` got an email without a row; `skippedCount`
 *   had every offered channel off; `failedCount` failed and were logged.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** callers drop the cached unread counts of `inAppUserPublicIds` after the commit.
 */
export interface NotificationDispatchResult {
  inAppUserIds: number[];
  inAppUserPublicIds: string[];
  emailOnlyUserIds: number[];
  skippedCount: number;
  failedCount: number;
}

/**
 * Composition-root collaborator that hides the check-then-persist-then-enqueue choreography from
 * emitters, so a domain requests a notification for its recipients with a single call.
 *
 * @remarks
 * - **Algorithm:** see {@link createNotificationDispatch}.
 * - **Failure modes:** a missing organization fails before any write; one recipient's failure is
 *   logged and skipped; when every recipient failed the first error is rethrown.
 * - **Side effects:** `notify.notifications` rows, `auth.mail_outbox` rows, post-commit enqueues.
 * - **Notes:** producers must call {@link configureNotificationDispatch} during container boot.
 */
export type NotificationDispatch = {
  createAndDispatchNotification(options: {
    input: DispatchNotificationInput;
    options?: { requestId?: string } | undefined;
  }): Promise<NotificationDispatchResult>;
};

/** One recipient's decision: which of the offered channels go out. */
interface RecipientChannels {
  inApp: boolean;
  email: boolean;
}

/**
 * The channels one recipient gets (UN11): an offered channel goes out when the organization has
 * not muted it and the person's choice for the type's kind — stored rows, else the kind's default,
 * a locked channel always — is on. A type in no kind (`security.alert`, `system.*`) is not in the
 * grid and goes out on every offered channel the organization has not muted.
 */
function decideRecipientChannels({
  offered,
  definition,
  choices,
  mutedChannels,
}: {
  offered: readonly NotificationDeliveryChannel[];
  definition: NotificationKindDefinition | undefined;
  choices: readonly NotificationChoiceRow[];
  mutedChannels: ReadonlySet<string>;
}): RecipientChannels {
  const isOn = (channel: NotificationPreferenceChannel): boolean => {
    if (mutedChannels.has(channel)) return false;
    if (definition === undefined) return true;
    const storedValues = choices
      .filter((choice) => choice.channel === channel)
      .map((choice) => choice.is_enabled);
    return resolveNotificationKindChannel({ definition, channel, storedValues }).isEnabled;
  };
  return {
    inApp: offered.includes('in_app') && isOn('IN_APP'),
    email: offered.includes('email') && isOn('EMAIL'),
  };
}

/** The dispatch's reads, in one savepoint: organization, recipients, choices (one query), mutes. */
async function readDispatchContext({
  notificationRepository,
  input,
}: {
  notificationRepository: NotificationRepository;
  input: DispatchNotificationInput;
}) {
  const definition = findNotificationKindForType(input.type);
  return withSavepoint(async () => {
    const organizationPublicId =
      input.organization_id === undefined
        ? null
        : await notificationRepository.findOrganizationPublicIdByOrganizationId(
            input.organization_id,
          );
    if (input.organization_id !== undefined && organizationPublicId === null) {
      throw new NotFoundError('Organization');
    }
    const recipients = await notificationRepository.resolveRecipientsForDispatch(
      input.recipientUserIds,
    );
    const choices =
      definition === undefined
        ? []
        : await notificationRepository.listNotificationChoices({
            userInternalIds: input.recipientUserIds,
            types: definition.types,
          });
    const mutedChannels =
      input.organization_id === undefined
        ? []
        : await notificationRepository.listMutedNotificationChannels({
            organization_id: input.organization_id,
            type: input.type,
          });
    return {
      definition,
      organizationPublicId,
      recipientsById: new Map(recipients.map((recipient) => [recipient.id, recipient])),
      choices,
      mutedChannels: new Set(mutedChannels),
    };
  });
}

/** The inbox row of a recipient whose in-app channel is on, and its worker job on commit. */
async function writeInAppRow(options: {
  notificationRepository: NotificationRepository;
  input: DispatchNotificationInput;
  recipient: NotificationRecipientRow;
  withEmail: boolean;
  organizationPublicId: string | null;
  requestId: string | undefined;
}): Promise<void> {
  const { input, recipient } = options;
  const notification = await options.notificationRepository.create({
    user_id: recipient.id,
    ...(input.organization_id === undefined ? {} : { organization_id: input.organization_id }),
    type: input.type,
    title: input.title,
    message: input.message,
    ...(input.action_url === undefined ? {} : { action_url: input.action_url }),
    data: {
      channels: options.withEmail ? ['in_app', 'email'] : ['in_app'],
      locale: input.locale,
      dedupe_key: input.dedupe_key,
    },
  });
  await scheduleCommitDispatch({
    task: {
      type: 'notification',
      notificationPublicId: notification.publicId,
      organizationPublicId: options.organizationPublicId,
      userPublicId: recipient.publicId,
    },
    options: options.requestId === undefined ? undefined : { requestId: options.requestId },
  });
}

/** The email of a recipient whose in-app channel is off: the outbox row now, the send on commit. */
async function writeEmailOnly(options: {
  input: DispatchNotificationInput;
  recipient: NotificationRecipientRow;
  requestId: string | undefined;
}): Promise<boolean> {
  const { input, recipient } = options;
  if (!(isMailConfigured() && recipient.email)) {
    logger.warn(
      { channel: 'email', notificationType: input.type, userPublicId: recipient.publicId },
      'notify.dispatch.email_skipped',
    );
    return false;
  }
  const { subject, html } = buildNotificationEmailHtml({
    title: input.title,
    message: input.message,
    actionUrl: input.action_url ?? null,
    locale: input.locale,
  });
  const mailOutboxToken = await recordOutboxEmail({
    to: recipient.email,
    subject,
    html,
    tags: [{ name: 'category', value: `notification-${input.type}` }],
    dedupeKey: buildNotificationEmailDedupeKey({
      type: input.type,
      dedupeKey: input.dedupe_key,
      userPublicId: recipient.publicId,
    }),
  });
  await scheduleCommitDispatch({
    task: { type: 'mail_outbox', mailOutboxToken, lane: 'bulk' },
    options: options.requestId === undefined ? undefined : { requestId: options.requestId },
  });
  return true;
}

/**
 * Build the live {@link NotificationDispatch} bound to a repository handle (used by
 * {@link configureNotificationDispatch} in the notify container).
 *
 * @remarks
 * - **Algorithm:** inside the caller's database context (the notification's organization), in one
 *   savepoint: resolve the organization's public id, the recipients (public id, email), every
 *   recipient's stored choices for the kind's types (ONE query — UN11) and the organization's muted
 *   channels for the type. Then per recipient, in its own savepoint: in-app on → the inbox row
 *   (`data.channels` carries `email` too when it is on, `data.locale`, `data.dedupe_key`) and its
 *   `notification` job after the commit — the worker sends the email; in-app off and email on → no
 *   row (P88): the mail-outbox row with {@link buildNotificationEmailDedupeKey} in the same unit,
 *   its send enqueued after the commit (bulk lane); both off → nothing. Push is never sent yet.
 * - **Failure modes:** a missing organization → `NotFoundError('Organization')`; a recipient that
 *   does not resolve, or whose row or outbox write fails, is logged
 *   (`notify.dispatch.recipient_failed`) and skipped; when every recipient failed the first error
 *   is rethrown, so the emitter's retry sends them all (the dedupe keys keep it once).
 * - **Side effects:** Postgres inserts into `notify.notifications` and `auth.mail_outbox`; BullMQ
 *   enqueues on commit.
 * - **Notes:** an email without a mail configuration is skipped and logged, as the worker does; a
 *   locked channel (billing email) is sent whatever a stored row says, but the organization's mute
 *   still wins (plan:L8182).
 */
export function createNotificationDispatch(
  notificationRepository: NotificationRepository,
): NotificationDispatch {
  return {
    async createAndDispatchNotification({ input, options }) {
      const requestId = options?.requestId;
      const context = await readDispatchContext({ notificationRepository, input });
      const result: NotificationDispatchResult = {
        inAppUserIds: [],
        inAppUserPublicIds: [],
        emailOnlyUserIds: [],
        skippedCount: 0,
        failedCount: 0,
      };
      let firstError: unknown;
      for (const recipientUserId of input.recipientUserIds) {
        try {
          const recipient = context.recipientsById.get(recipientUserId);
          if (recipient === undefined) throw new NotFoundError('User');
          const channels = decideRecipientChannels({
            offered: input.channels,
            definition: context.definition,
            choices: context.choices.filter((choice) => choice.user_id === recipientUserId),
            mutedChannels: context.mutedChannels,
          });
          if (channels.inApp) {
            // A savepoint per recipient: a failed INSERT would otherwise abort the whole unit.
            await withSavepoint(() =>
              writeInAppRow({
                notificationRepository,
                input,
                recipient,
                withEmail: channels.email,
                organizationPublicId: context.organizationPublicId,
                requestId,
              }),
            );
            result.inAppUserIds.push(recipient.id);
            result.inAppUserPublicIds.push(recipient.publicId);
          } else if (
            channels.email &&
            (await withSavepoint(() => writeEmailOnly({ input, recipient, requestId })))
          ) {
            result.emailOnlyUserIds.push(recipient.id);
          } else {
            result.skippedCount += 1;
          }
        } catch (error) {
          firstError ??= error;
          result.failedCount += 1;
          logger.error(
            { err: error, recipientUserId, notificationType: input.type },
            'notify.dispatch.recipient_failed',
          );
        }
      }
      if (result.failedCount > 0 && result.failedCount === input.recipientUserIds.length) {
        throw firstError;
      }
      return result;
    },
  };
}

let notificationDispatch: NotificationDispatch | null = null;

/**
 * Wire the singleton {@link NotificationDispatch} used by module-level
 * {@link createAndDispatchNotification}. Called once from the notify container during boot.
 *
 * @remarks
 * - **Algorithm:** stores the provided dispatch in a module-scoped slot.
 * - **Failure modes:** none — last writer wins.
 * - **Side effects:** mutates the module-level `notificationDispatch` reference.
 * - **Notes:** must be invoked before any cross-domain handler calls
 *   {@link createAndDispatchNotification}, otherwise that call throws `ConfigurationError`.
 */
export function configureNotificationDispatch(dispatch: NotificationDispatch): void {
  notificationDispatch = dispatch;
}

/**
 * Checks each recipient's choices, then persists the inbox rows and records the emails of one
 * notification (feat-instagram-dm-sending UN11 — the check before send).
 *
 * @remarks
 * - **Algorithm:** delegates to the singleton wired by {@link configureNotificationDispatch}; see
 *   {@link createNotificationDispatch}.
 * - **Failure modes:** throws `ConfigurationError` when the dispatch is unset (boot order bug);
 *   rethrows the first recipient error when every recipient failed.
 * - **Side effects:** inbox rows and outbox rows in the caller's unit; BullMQ enqueues on commit.
 * - **Notes:** must run inside the notification's organization database context (an event handler
 *   inside the emitting write, or `NotificationService.createOrganizationNotifications`).
 */
export async function createAndDispatchNotification({
  input,
  options,
}: {
  input: DispatchNotificationInput;
  options?: { requestId?: string } | undefined;
}): Promise<NotificationDispatchResult> {
  if (!notificationDispatch) {
    throw new ConfigurationError(
      'Notification dispatch is not configured. Call configureNotificationDispatch from notify.container.',
    );
  }
  return notificationDispatch.createAndDispatchNotification({ input, options });
}
