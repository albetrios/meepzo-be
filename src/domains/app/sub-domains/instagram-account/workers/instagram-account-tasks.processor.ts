import i18next from 'i18next';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  runGlobalRetentionWorkerJob,
  runOrganizationScopedWorkerJob,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { env } from '@/shared/config/env.config.js';
import { DEFAULT_FRONTEND_URL } from '@/shared/constants/index.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import {
  INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS,
  type InstagramIceBreaker,
  type InstagramMessageAccess,
  deleteInstagramIceBreakers,
  probeInstagramMessageAccess,
  readInstagramWebhookSubscribedFields,
  readMetaAppSettings,
  setInstagramIceBreakers,
  subscribeInstagramWebhookFields,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { describeMetaGraphError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { createWorkerChannelConnectionTokenRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.repository.js';
import type {
  InstagramSendTicketContext,
  InstagramTaskHandler,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import type { InstagramAccountExtensionService } from '@/domains/app/sub-domains/instagram-account/instagram-account-extension.service.js';
import {
  type InstagramAccountKey,
  type InstagramAccountRow,
  createRetentionInstagramAccountRepository,
  createWorkerInstagramAccountRepository,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import {
  INSTAGRAM_ACCOUNT_SETUP_JOB_NAME,
  INSTAGRAM_ACCOUNT_TASK_RETRY_MINUTES,
  INSTAGRAM_STARTER_QUESTION_SYNC_JOB_NAME,
  INSTAGRAM_WEBHOOK_SUBSCRIPTION_CHECK_JOB_NAME,
  INSTAGRAM_WEBHOOK_SUBSCRIPTION_CHECK_MINUTES,
  type InstagramAccountChainJobName,
  type InstagramAccountChainTaskInput,
  enqueueInstagramAccountChainTask,
  enqueueInstagramWebhookSubscriptionChecks,
  instagramAccountChainTaskInputSchema,
  instagramAccountTaskRetryDelayMilliseconds,
  instagramWebhookSubscriptionCheckInputSchema,
  startInstagramAccountChainBestEffort,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-account-tasks.queue.js';
import { buildInstagramReconnectNoticeActionUrl } from './instagram-reconnect-notice.processor.js';
import type { InstagramReconnectNoticeServices } from './instagram-reconnect-notice.processor.js';
import {
  type InstagramAccountDailyCheckService,
  classifyInstagramDailyCheckFailure,
} from './instagram-account-daily-check.processor.js';
import {
  INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_MAX_PAGES,
  INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE,
} from './instagram-account-daily-check.constants.js';

/** The notification type of the set-up failure email (the `automation_problem` kind, UN8). */
const INSTAGRAM_ACCOUNT_SETUP_FAILED_NOTIFICATION_TYPE = 'instagram.reconnect_required';

/** The payload prefix of a starter-question tap — the webhook's classifier reads it (WH8). */
const STARTER_QUESTION_PAYLOAD_PREFIX = 'starter:';

/** The most starter questions one account holds at Instagram (plan `STARTER_QUESTIONS_MAX`, D42). */
const INSTAGRAM_STARTER_QUESTIONS_PER_ACCOUNT_MAX = 4;

/**
 * The account's live starter-question automations — the automation service's read (sub-domain 4),
 * reached through this port so the account jobs never import the automation sub-domain's code.
 *
 * @remarks
 * Notes: `AutomationService.listLiveStarterQuestions` implements it (oldest automation first).
 */
export interface InstagramStarterQuestionSource {
  listLiveStarterQuestions(input: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    channelAccountId: number;
  }): Promise<Array<{ automationPublicId: string; questions: string[] }>>;
}

/**
 * The missed-comment look of one account after its subscription lost a field (WC-26, sub-domain 5 —
 * ROUTE row R39 builds it and passes it in); `null` until then, and the check logs that it skipped it.
 *
 * @remarks
 * Notes: set on `appDomain.instagramAccountTaskSlots.missedCommentPort`.
 */
export interface InstagramMissedCommentPort {
  lookForMissedComments(input: {
    organizationPublicId: string;
    channelAccountPublicId: string;
  }): Promise<void>;
}

/**
 * What the account jobs use (IA6): the guarded break (an `auth` refusal), the extension's one writer,
 * the starter questions, the missed-comment look (R39) and the email's services — late-wired by the
 * worker composition root, `null` in a process that runs no tasks.
 *
 * @remarks
 * Notes: built by `createAppContainer` and handed to {@link buildInstagramAccountTaskHandlers}.
 */
export interface InstagramAccountTaskServices {
  accountService: InstagramAccountDailyCheckService;
  extensionService: Pick<
    InstagramAccountExtensionService,
    'recordWebhookSubscribed' | 'recordWebhookSubscriptionLost' | 'recordStarterQuestionsSet'
  >;
  starterQuestionSource: InstagramStarterQuestionSource;
  readMissedCommentPort(): InstagramMissedCommentPort | null;
  readNoticeServices(): InstagramReconnectNoticeServices | null;
}

/** The account a job works on, its key and its connection's encrypted token. */
interface AccountTaskTarget {
  organizationPublicId: string;
  scope: OrganizationPrincipalDatabaseScope;
  account: InstagramAccountRow;
  key: InstagramAccountKey;
  encryptedAccessToken: string;
  requestId: string;
}

/** Why a job did nothing. */
type AccountTaskSkip = { outcome: 'skipped'; reason: 'not_connected' | 'token_missing' };

/** What a failed Meta call of a chain job led to. */
type AccountTaskFailure =
  | { outcome: 'broken' }
  | { outcome: 'retrying'; nextTryNumber: number; delayMinutes: number; notified: boolean };

/**
 * What one set-up did (WC-30) — the job's return value in Bull Board.
 *
 * @remarks
 * Algorithm: `set_up` — the six fields subscribed and stamped, `starterQuestions` `set` · `none`
 * (no live starter automation) · `retrying` (their own sync chain took over), `messageAccess` the
 * probe's answer. Failure modes: none — a value. Side effects: none.
 */
export type InstagramAccountSetupResult =
  | AccountTaskSkip
  | AccountTaskFailure
  | {
      outcome: 'set_up';
      starterQuestions: 'set' | 'none' | 'retrying';
      messageAccess: InstagramMessageAccess;
    };

/**
 * What one starter-question sync did (WC-31).
 *
 * @remarks
 * Algorithm: `synced` with how many questions Meta now holds (0 = removed). Failure modes: none — a
 * value. Side effects: none.
 */
export type InstagramStarterQuestionSyncResult =
  | AccountTaskSkip
  | AccountTaskFailure
  | { outcome: 'synced'; questionCount: number };

/**
 * What one subscription check did (WC-25).
 *
 * @remarks
 * Algorithm: `subscribed` — every field on (a not-stamped account is stamped: `recovered`);
 * `resubscribing` — a field was off on a stamped account: stamp emptied, set-up started, team told,
 * missed comments looked for; `setup_pending` — fields off on an account its set-up's tries still own;
 * `unavailable` — Meta did not answer (safe to skip, the next window checks again); `broken`.
 * Failure modes: none — a value. Side effects: none.
 */
export type InstagramWebhookSubscriptionCheckResult =
  | AccountTaskSkip
  | { outcome: 'broken' }
  | { outcome: 'unavailable' }
  | { outcome: 'subscribed'; recovered: boolean }
  | { outcome: 'setup_pending'; missingFields: string[] }
  | { outcome: 'resubscribing'; missingFields: string[] };

/** Reads the account (connected only) and its connection's token in one unit of the job's scope. */
async function readAccountTaskTarget({
  organizationPublicId,
  channelAccountPublicId,
  requestId,
  context,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  requestId: string;
  context: InstagramSendTicketContext;
}): Promise<AccountTaskTarget | AccountTaskSkip> {
  const snapshot = await context.runInDatabaseSlot(() =>
    runOrganizationScopedWorkerJob({
      job: { organizationPublicId },
      processor: async (databaseHandle) => {
        const account = await createWorkerInstagramAccountRepository(
          databaseHandle,
        ).findByPublicIdInOrganization({
          organizationPublicId,
          instagramAccountPublicId: channelAccountPublicId,
        });
        if (account === null || account.connection_status !== 'connected') return null;
        // The token is the account's channel connection's (P111, MC9).
        const token = await createWorkerChannelConnectionTokenRepository(
          databaseHandle,
        ).findByConnection({
          organizationId: account.organization_id,
          channelConnectionId: account.channel_connection_id,
        });
        return { account, token };
      },
    }),
  );
  if (snapshot === null) return { outcome: 'skipped', reason: 'not_connected' };
  if (snapshot.token === null) {
    logger.error(
      { organizationPublicId, channelAccountPublicId },
      'app.instagram_account.task.token_missing',
    );
    return { outcome: 'skipped', reason: 'token_missing' };
  }
  return {
    organizationPublicId,
    scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId }),
    account: snapshot.account,
    key: {
      organizationId: snapshot.account.organization_id,
      instagramAccountId: snapshot.account.id,
    },
    encryptedAccessToken: snapshot.token.encryptedAccessToken,
    requestId,
  };
}

/** Moves the account to `error` through the guarded change (its reconnect notice after commit). */
async function breakAccount({
  target,
  error,
  services,
  context,
}: {
  target: AccountTaskTarget;
  error: unknown;
  services: InstagramAccountTaskServices;
  context: InstagramSendTicketContext;
}): Promise<{ outcome: 'broken' }> {
  const failure = classifyInstagramDailyCheckFailure(error);
  const connectionStatus = failure.action === 'break' ? failure.connectionStatus : 'error';
  await context.runInDatabaseSlot(() =>
    services.accountService.markConnectionBroken({
      scope: target.scope,
      instagramAccount: target.key,
      connectionStatus,
      requestId: target.requestId,
    }),
  );
  return { outcome: 'broken' };
}

/**
 * The live starter questions as Instagram's ice breakers: oldest automation first, at most four.
 *
 * @remarks
 * - **Algorithm:** each question with the payload `starter:<aut_…>`, cut at
 *   {@link INSTAGRAM_STARTER_QUESTIONS_PER_ACCOUNT_MAX}.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 */
export function buildInstagramIceBreakers(
  automations: ReadonlyArray<{ automationPublicId: string; questions: readonly string[] }>,
): InstagramIceBreaker[] {
  return automations
    .flatMap(({ automationPublicId, questions }) =>
      questions.map((question) => ({
        question,
        payload: `${STARTER_QUESTION_PAYLOAD_PREFIX}${automationPublicId}`,
      })),
    )
    .slice(0, INSTAGRAM_STARTER_QUESTIONS_PER_ACCOUNT_MAX);
}

/**
 * Tells the account's owners and admins once that its set-up failed every quick try (WC-30): one
 * in-app notification and one email, keyed by the chain so it is never sent twice.
 */
async function notifySetupFailed({
  target,
  chainKey,
  services,
}: {
  target: AccountTaskTarget;
  chainKey: string;
  services: InstagramAccountTaskServices;
}): Promise<boolean> {
  const noticeServices = services.readNoticeServices();
  if (noticeServices === null) {
    logger.error(
      { organizationPublicId: target.organizationPublicId, chainKey },
      'app.instagram_account.setup.notice_unwired',
    );
    return false;
  }
  const locale =
    await noticeServices.organizationSettingsService.resolveDefaultLocaleForOrganization(
      target.organizationPublicId,
    );
  const plainText = { lng: locale, interpolation: { escapeValue: false } };
  return runOrganizationScopedWorkerJob({
    job: { organizationPublicId: target.organizationPublicId },
    processor: async () => {
      const recipientUserIds =
        await noticeServices.membershipService.findActiveUserIdsWithPermission({
          scope: target.scope,
          permissionCode: APP_PERMISSIONS.INSTAGRAM_ACCOUNT_MANAGE,
        });
      if (recipientUserIds.length === 0) return false;
      const notified = await noticeServices.notificationService.createOrganizationNotifications({
        scope: target.scope,
        recipientUserIds,
        notification: {
          type: INSTAGRAM_ACCOUNT_SETUP_FAILED_NOTIFICATION_TYPE,
          title: i18next.t('common:notifications.instagramAccountSetupFailedTitle', plainText),
          message: i18next.t('common:notifications.instagramAccountSetupFailedMessage', {
            ...plainText,
            username: target.account.username ?? '',
          }),
          actionUrl: buildInstagramReconnectNoticeActionUrl(
            env.FRONTEND_URL ?? DEFAULT_FRONTEND_URL,
          ),
          channels: ['in_app', 'email'],
          locale,
        },
        dedupeKey: `${chainKey}-failed`,
      });
      return !notified.deduplicated;
    },
  });
}

/**
 * A chain job's failed Meta call: a refused token breaks the account; anything else books the next
 * try on the ladder (1, 5, 15, 60 minutes, then hourly), and the set-up's last quick try tells the
 * owners once.
 */
async function handleChainFailure({
  target,
  error,
  jobName,
  input,
  services,
  context,
}: {
  target: AccountTaskTarget;
  error: unknown;
  jobName: InstagramAccountChainJobName;
  input: InstagramAccountChainTaskInput;
  services: InstagramAccountTaskServices;
  context: InstagramSendTicketContext;
}): Promise<AccountTaskFailure> {
  if (classifyInstagramDailyCheckFailure(error).action === 'break') {
    return breakAccount({ target, error, services, context });
  }
  const delayMilliseconds = instagramAccountTaskRetryDelayMilliseconds(input.tryNumber);
  const nextTryNumber = input.tryNumber + 1;
  logger.warn(
    {
      organizationPublicId: target.organizationPublicId,
      channelAccountPublicId: input.channelAccountPublicId,
      jobName,
      tryNumber: input.tryNumber,
      failure: describeMetaGraphError(error),
    },
    'app.instagram_account.task.try_failed',
  );
  await enqueueInstagramAccountChainTask({
    jobName,
    organizationPublicId: target.organizationPublicId,
    input: { ...input, tryNumber: nextTryNumber },
    delayMilliseconds,
  });
  // The set-up's banner is the account shown as not subscribed; its email goes once, when the last
  // quick try (the 60-minute one) failed too.
  const notified =
    jobName === INSTAGRAM_ACCOUNT_SETUP_JOB_NAME &&
    input.tryNumber === INSTAGRAM_ACCOUNT_TASK_RETRY_MINUTES.length
      ? await notifySetupFailed({ target, chainKey: input.chainKey, services })
      : false;
  return {
    outcome: 'retrying',
    nextTryNumber,
    delayMinutes: delayMilliseconds / MILLISECONDS_PER_MINUTE,
    notified,
  };
}

/** Writes the account's whole ice-breaker list (or removes it) and stamps it. */
async function writeStarterQuestions({
  target,
  services,
  context,
}: {
  target: AccountTaskTarget;
  services: InstagramAccountTaskServices;
  context: InstagramSendTicketContext;
}): Promise<{ questionCount: number; write: () => Promise<void> }> {
  const automations = await context.runInDatabaseSlot(() =>
    services.starterQuestionSource.listLiveStarterQuestions({
      scope: target.scope,
      organizationId: target.account.organization_id,
      channelAccountId: target.account.channel_account_id,
    }),
  );
  const iceBreakers = buildInstagramIceBreakers(automations);
  const access = {
    encryptedAccessToken: target.encryptedAccessToken,
    instagramUserId: target.account.instagram_user_id,
    requestId: target.requestId,
  };
  return {
    questionCount: iceBreakers.length,
    write: () =>
      iceBreakers.length > 0
        ? setInstagramIceBreakers({ ...access, iceBreakers })
        : deleteInstagramIceBreakers(access),
  };
}

/**
 * The account set-up (WC-30, IA6): subscribe the six webhook fields and stamp the account, write its
 * starter questions when it has live ones, probe message access once.
 *
 * @remarks
 * - **Algorithm:** every database step in the job's organization scope and a database slot; every
 *   Meta call outside any database context (2.10). (1) The account (`connected` only) and its
 *   connection's token. (2) `subscribed_apps` → `webhook_subscribed_at` through the extension service.
 *   (3) Live starter questions → `messenger_profile` → `starter_questions_set_at`; their failure
 *   starts the sync's own chain (a retry after 1 minute) and the set-up goes on. (4) The read-only
 *   message-access probe; `off` is logged (`app.instagram_account.setup.message_access_off`).
 * - **Failure modes:** a refused token → the guarded break (reconnect notice); any other Meta failure
 *   at step 2 → the next try on the ladder (1, 5, 15, 60 minutes, then hourly) and, after the last
 *   quick try, one email to the owners and admins; database errors propagate (one attempt, dead
 *   letter).
 * - **Side effects:** Meta calls; the account's stamps; at most one next-try job; the email once.
 * - **Notes:** safe to repeat — Meta takes the same subscription and list again, the stamps move.
 */
export async function processInstagramAccountSetupTask({
  organizationPublicId,
  input,
  context,
  services,
}: {
  organizationPublicId: string;
  input: InstagramAccountChainTaskInput;
  context: InstagramSendTicketContext;
  services: InstagramAccountTaskServices;
}): Promise<InstagramAccountSetupResult> {
  const target = await readAccountTaskTarget({
    organizationPublicId,
    channelAccountPublicId: input.channelAccountPublicId,
    requestId: context.jobId,
    context,
  });
  if ('outcome' in target) return target;
  try {
    await subscribeInstagramWebhookFields({
      encryptedAccessToken: target.encryptedAccessToken,
      instagramUserId: target.account.instagram_user_id,
      requestId: target.requestId,
    });
  } catch (error) {
    return handleChainFailure({
      target,
      error,
      jobName: INSTAGRAM_ACCOUNT_SETUP_JOB_NAME,
      input,
      services,
      context,
    });
  }
  await context.runInDatabaseSlot(() =>
    services.extensionService.recordWebhookSubscribed({
      scope: target.scope,
      instagramAccount: target.key,
    }),
  );

  let starterQuestions: 'set' | 'none' | 'retrying' = 'none';
  const starters = await writeStarterQuestions({ target, services, context });
  if (starters.questionCount > 0) {
    try {
      await starters.write();
      await context.runInDatabaseSlot(() =>
        services.extensionService.recordStarterQuestionsSet({
          scope: target.scope,
          instagramAccount: target.key,
          isSet: true,
        }),
      );
      starterQuestions = 'set';
    } catch (error) {
      if (classifyInstagramDailyCheckFailure(error).action === 'break') {
        return breakAccount({ target, error, services, context });
      }
      await startInstagramAccountChainBestEffort({
        jobName: INSTAGRAM_STARTER_QUESTION_SYNC_JOB_NAME,
        organizationPublicId,
        channelAccountPublicId: input.channelAccountPublicId,
        delayMilliseconds: instagramAccountTaskRetryDelayMilliseconds(0),
      });
      starterQuestions = 'retrying';
    }
  }

  let messageAccess: InstagramMessageAccess;
  try {
    messageAccess = await probeInstagramMessageAccess({
      encryptedAccessToken: target.encryptedAccessToken,
      instagramUserId: target.account.instagram_user_id,
      requestId: target.requestId,
    });
  } catch (error) {
    return breakAccount({ target, error, services, context });
  }
  if (messageAccess === 'off') {
    logger.warn(
      { organizationPublicId, channelAccountPublicId: input.channelAccountPublicId },
      'app.instagram_account.setup.message_access_off',
    );
  }
  const result: InstagramAccountSetupResult = {
    outcome: 'set_up',
    starterQuestions,
    messageAccess,
  };
  logger.info(
    { organizationPublicId, channelAccountPublicId: input.channelAccountPublicId, ...result },
    'app.instagram_account.setup.completed',
  );
  return result;
}

/**
 * The starter-question sync (WC-31, IA6): rewrite the account's whole ice-breaker list from its live
 * starter-question automations and stamp `starter_questions_set_at` (emptied when none is live).
 *
 * @remarks
 * - **Algorithm:** the account and token; the live automations' questions (oldest first, at most
 *   four — go-live refuses a fifth, AC-6.11); `messenger_profile` set, or removed for an empty list;
 *   then the stamp.
 * - **Failure modes:** a refused token → the guarded break; any other Meta failure → the next try on
 *   the ladder (no email — the banner is the empty `starter_questions_set_at`, WC-31).
 * - **Side effects:** one Meta write; the stamp; at most one next-try job.
 * - **Notes:** safe to repeat — every run writes the whole list, so two runs land in the same state.
 */
export async function processInstagramStarterQuestionSyncTask({
  organizationPublicId,
  input,
  context,
  services,
}: {
  organizationPublicId: string;
  input: InstagramAccountChainTaskInput;
  context: InstagramSendTicketContext;
  services: InstagramAccountTaskServices;
}): Promise<InstagramStarterQuestionSyncResult> {
  const target = await readAccountTaskTarget({
    organizationPublicId,
    channelAccountPublicId: input.channelAccountPublicId,
    requestId: context.jobId,
    context,
  });
  if ('outcome' in target) return target;
  const starters = await writeStarterQuestions({ target, services, context });
  try {
    await starters.write();
  } catch (error) {
    return handleChainFailure({
      target,
      error,
      jobName: INSTAGRAM_STARTER_QUESTION_SYNC_JOB_NAME,
      input,
      services,
      context,
    });
  }
  await context.runInDatabaseSlot(() =>
    services.extensionService.recordStarterQuestionsSet({
      scope: target.scope,
      instagramAccount: target.key,
      isSet: starters.questionCount > 0,
    }),
  );
  return { outcome: 'synced', questionCount: starters.questionCount };
}

/**
 * One account's webhook subscription check (WC-25, AC-16.22): are all six fields on for our app?
 *
 * @remarks
 * - **Algorithm:** the account and token; `GET subscribed_apps`. All on → `subscribed` (an account
 *   not stamped yet is stamped — the set-up's chain lost, or the daily check's subscribe). A field off
 *   on a **stamped** account → the stamp emptied (shown not subscribed), the team told (the
 *   error-level log line `app.instagram_account.webhook_subscription_lost` is the alert), a new set-up
 *   chain started and the missed-comment look asked for (WC-26, R39). A field off on a not-stamped
 *   account → nothing: its set-up's tries own it.
 * - **Failure modes:** a refused token → the guarded break; any other Meta failure → `unavailable`,
 *   logged (safe to skip — the next window checks again).
 * - **Side effects:** one Meta read; at most the stamp, a set-up job and the missed-comment look.
 */
export async function processInstagramWebhookSubscriptionCheckTask({
  organizationPublicId,
  channelAccountPublicId,
  context,
  services,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  context: InstagramSendTicketContext;
  services: InstagramAccountTaskServices;
}): Promise<InstagramWebhookSubscriptionCheckResult> {
  const target = await readAccountTaskTarget({
    organizationPublicId,
    channelAccountPublicId,
    requestId: context.jobId,
    context,
  });
  if ('outcome' in target) return target;
  let subscribedFields: string[];
  try {
    subscribedFields = await readInstagramWebhookSubscribedFields({
      encryptedAccessToken: target.encryptedAccessToken,
      instagramUserId: target.account.instagram_user_id,
      appId: readMetaAppSettings().appId,
      requestId: target.requestId,
    });
  } catch (error) {
    if (classifyInstagramDailyCheckFailure(error).action === 'break') {
      return breakAccount({ target, error, services, context });
    }
    logger.warn(
      { organizationPublicId, channelAccountPublicId, failure: describeMetaGraphError(error) },
      'app.instagram_account.webhook_subscription_check.unavailable',
    );
    return { outcome: 'unavailable' };
  }
  const missingFields = INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS.filter(
    (field) => !subscribedFields.includes(field),
  );
  const isStamped = target.account.webhook_subscribed_at !== null;
  if (missingFields.length === 0) {
    if (!isStamped) {
      await context.runInDatabaseSlot(() =>
        services.extensionService.recordWebhookSubscribed({
          scope: target.scope,
          instagramAccount: target.key,
        }),
      );
    }
    return { outcome: 'subscribed', recovered: !isStamped };
  }
  if (!isStamped) return { outcome: 'setup_pending', missingFields };

  await context.runInDatabaseSlot(() =>
    services.extensionService.recordWebhookSubscriptionLost({
      scope: target.scope,
      instagramAccount: target.key,
    }),
  );
  logger.error(
    { organizationPublicId, channelAccountPublicId, missingFields },
    'app.instagram_account.webhook_subscription_lost',
  );
  await startInstagramAccountChainBestEffort({
    jobName: INSTAGRAM_ACCOUNT_SETUP_JOB_NAME,
    organizationPublicId,
    channelAccountPublicId,
  });
  const missedCommentPort = services.readMissedCommentPort();
  if (missedCommentPort === null) {
    logger.info(
      { organizationPublicId, channelAccountPublicId },
      'app.instagram_account.webhook_subscription_check.missed_comment_look_unwired',
    );
  } else {
    await missedCommentPort.lookForMissedComments({ organizationPublicId, channelAccountPublicId });
  }
  return { outcome: 'resubscribing', missingFields };
}

/**
 * The account jobs' handlers on `instagram-tasks` (IA6, R37's `taskHandlers[jobName]`): the set-up,
 * the subscription check and the starter-question sync — each calls Meta, so each asks the sending
 * gate first (AC-17.21).
 *
 * @remarks
 * - **Algorithm:** one {@link InstagramTaskHandler} per job name, its input validated by its schema.
 * - **Failure modes:** none here — the handlers' own.
 * - **Side effects:** none until a handler runs.
 * - **Notes:** registered by `createAppContainer` into `instagramSendWork.taskHandlers`.
 */
export function buildInstagramAccountTaskHandlers(
  services: InstagramAccountTaskServices,
): Record<string, InstagramTaskHandler> {
  return {
    [INSTAGRAM_ACCOUNT_SETUP_JOB_NAME]: {
      callsMeta: true,
      inputSchema: instagramAccountChainTaskInputSchema,
      run: async ({ organizationPublicId, taskInput, context }) => {
        await processInstagramAccountSetupTask({
          organizationPublicId,
          input: instagramAccountChainTaskInputSchema.parse(taskInput),
          context,
          services,
        });
      },
    },
    [INSTAGRAM_STARTER_QUESTION_SYNC_JOB_NAME]: {
      callsMeta: true,
      inputSchema: instagramAccountChainTaskInputSchema,
      run: async ({ organizationPublicId, taskInput, context }) => {
        await processInstagramStarterQuestionSyncTask({
          organizationPublicId,
          input: instagramAccountChainTaskInputSchema.parse(taskInput),
          context,
          services,
        });
      },
    },
    [INSTAGRAM_WEBHOOK_SUBSCRIPTION_CHECK_JOB_NAME]: {
      callsMeta: true,
      inputSchema: instagramWebhookSubscriptionCheckInputSchema,
      run: async ({ organizationPublicId, taskInput, context }) => {
        const { channelAccountPublicId } =
          instagramWebhookSubscriptionCheckInputSchema.parse(taskInput);
        await processInstagramWebhookSubscriptionCheckTask({
          organizationPublicId,
          channelAccountPublicId,
          context,
          services,
        });
      },
    },
  };
}

/**
 * What one 10-minute sweep did (WC-25).
 *
 * @remarks
 * Algorithm: `skipped` while this deployment may not send (the task worker is off, so a check
 * would wait forever); else how many connected accounts were listed and handed a check. Failure
 * modes: none — a value. Side effects: none.
 */
export type InstagramWebhookSubscriptionSweepResult =
  | { outcome: 'skipped'; reason: 'sending_disabled' }
  | { outcome: 'swept'; listedCount: number; addedCount: number; capped: boolean };

/**
 * The 10-minute sweep of the webhook subscription check (WC-25): lists every connected Instagram
 * account of every live organization and hands each one check for this window, spread over it.
 *
 * @remarks
 * - **Algorithm:** off unless `env.SENDING_ENABLED` (the task worker runs only then). Pages of the
 *   connected accounts through the daily check's cross-organization read (`listConnectedForDailyCheck`
 *   under `runGlobalRetentionWorkerJob`, `USING`-only sweep arm), then, with the context closed, one
 *   check job per account keyed by the window's start.
 * - **Failure modes:** a failed read throws to BullMQ; a failed add is logged
 *   (`app.instagram_account.webhook_subscription_check.enqueue_failed`) and the next window adds the
 *   accounts again. Reaching the page cap logs `…sweep_capped` at error.
 * - **Side effects:** jobs on `instagram-tasks`; no row is changed.
 * - **Notes:** rides the daily-check queue's worker (`scheduler.ts`, every 10 minutes) until that
 *   queue's work moves to the channel connection's token check (ROUTE row R51). `now` is injectable.
 */
export async function runInstagramWebhookSubscriptionCheckSweep(
  options: { now?: Date } = {},
): Promise<InstagramWebhookSubscriptionSweepResult> {
  if (!env.SENDING_ENABLED) return { outcome: 'skipped', reason: 'sending_disabled' };
  const now = options.now ?? new Date();
  const windowMilliseconds = INSTAGRAM_WEBHOOK_SUBSCRIPTION_CHECK_MINUTES * MILLISECONDS_PER_MINUTE;
  const windowStart = new Date(now.getTime() - (now.getTime() % windowMilliseconds));
  let afterId = 0;
  let listedCount = 0;
  let addedCount = 0;
  for (let page = 0; page < INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_MAX_PAGES; page += 1) {
    const cursor = afterId;
    const candidates = await runGlobalRetentionWorkerJob((databaseHandle) =>
      createRetentionInstagramAccountRepository(databaseHandle).listConnectedForDailyCheck({
        afterId: cursor,
        limit: INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE,
      }),
    );
    listedCount += candidates.length;
    const lastCandidate = candidates.at(-1);
    if (lastCandidate !== undefined) {
      afterId = lastCandidate.id;
      try {
        addedCount += await enqueueInstagramWebhookSubscriptionChecks({
          targets: candidates.map((candidate) => ({
            id: candidate.id,
            organizationPublicId: candidate.organizationPublicId,
            channelAccountPublicId: candidate.instagramAccountPublicId,
          })),
          windowStart,
        });
      } catch (error) {
        logger.warn(
          { error, pageSize: candidates.length },
          'app.instagram_account.webhook_subscription_check.enqueue_failed',
        );
      }
    }
    if (candidates.length < INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE) {
      return { outcome: 'swept', listedCount, addedCount, capped: false };
    }
  }
  logger.error(
    { listedCount, addedCount },
    'app.instagram_account.webhook_subscription_check.sweep_capped',
  );
  return { outcome: 'swept', listedCount, addedCount, capped: true };
}
