import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import {
  runGlobalRetentionWorkerJob,
  runOrganizationScopedWorkerJob,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { ProviderOutageError } from '@/infrastructure/queue/worker-runtime/provider-outage-pause.util.js';
import {
  readInstagramAccountProfile,
  subscribeInstagramWebhookFields,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  MetaGraphApiError,
  describeMetaGraphError,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { InstagramAccountBrokenConnectionStatus } from '@/domains/app/sub-domains/instagram-account/instagram-account.constants.js';
import {
  type InstagramAccountKey,
  type InstagramAccountRow,
  createRetentionInstagramAccountRepository,
  createWorkerInstagramAccountRepository,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { createWorkerChannelConnectionTokenRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.repository.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import {
  type InstagramAccountDailyCheckJobData,
  enqueueInstagramAccountDailyChecks,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-account-daily-check.queue.js';
import {
  INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_MAX_PAGES,
  INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE,
} from './instagram-account-daily-check.constants.js';

/**
 * What a failed Instagram call of the daily check means (IA4, IA8): `break` — Instagram refused the
 * token, the account leaves `connected`; `wait` — Instagram is down or busy (or the call failed on
 * our side), the job is retried, waiting out an outage; `continue` — Instagram refused only this
 * request, the account stays `connected` and the next day tries again.
 *
 * @remarks
 * - **Algorithm:** filled by {@link classifyInstagramDailyCheckFailure}.
 * - **Failure modes:** none — a value.
 * - **Side effects:** none.
 * - **Notes:** a code-10 "outside the messaging window" answer is `refused` in the client (D32),
 *   so it is a `continue` here — never a break.
 */
export type InstagramDailyCheckFailureAction =
  | { action: 'break'; connectionStatus: InstagramAccountBrokenConnectionStatus }
  | { action: 'wait' }
  | { action: 'continue' };

/**
 * Classes one failed Instagram call of the daily check (IA8): a token refusal breaks the
 * connection at once, a refusal of the request is kept for tomorrow, anything else waits.
 *
 * @remarks
 * - **Algorithm:** an `MetaGraphApiError` of class `auth` → `break` with the status it means
 *   (`expired` for code 190 / subcode 463, else `error`); class `refused` → `continue`; class
 *   `throttled` or `outage`, an open circuit, or a failure that is not Instagram's → `wait`.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 * - **Notes:** exported for the unit test.
 */
export function classifyInstagramDailyCheckFailure(
  error: unknown,
): InstagramDailyCheckFailureAction {
  if (!(error instanceof MetaGraphApiError)) return { action: 'wait' };
  if (error.errorClass === 'auth') {
    return { action: 'break', connectionStatus: error.connectionStatus ?? 'error' };
  }
  if (error.errorClass === 'refused') return { action: 'continue' };
  return { action: 'wait' };
}

/**
 * The error a `wait` failure is rethrown as: a throttle becomes a {@link ProviderOutageError} with
 * Instagram's wait, so the queue pauses only that long; anything else passes unchanged, and the
 * provider-pausable worker parks it while the `instagram` circuit is open.
 */
function toDailyCheckRetryError(error: unknown): unknown {
  if (error instanceof MetaGraphApiError && error.errorClass === 'throttled') {
    return new ProviderOutageError({
      provider: 'meta',
      cause: error,
      retryAfterMs: error.retryAfterMs ?? null,
    });
  }
  return error;
}

/**
 * The one service step the daily check drives — the account service's guarded status change
 * (IA9), which enqueues the reconnect notice after the commit.
 *
 * @remarks
 * - **Algorithm:** structural, so the processor depends only on the one method it calls.
 * - **Failure modes:** none — type only.
 * - **Side effects:** none on this type.
 * - **Notes:** satisfied by `InstagramAccountService` from the worker composition root
 *   (`createDomainContainers` → `appDomain`).
 */
export type InstagramAccountDailyCheckService = Pick<
  InstagramAccountService,
  'markConnectionBroken'
>;

/**
 * What one account's daily check did.
 *
 * @remarks
 * - **Algorithm:** `skipped` — the account is not `connected` any more (or has no token);
 *   `broken` — the check moved it to `error` at `step`; `checked` — each step's outcome.
 * - **Failure modes:** none — a return shape (Bull Board shows it as the job's return value).
 * - **Side effects:** none.
 * - **Notes:** `broken` reports what this check found; when another caller broke the account first
 *   the guarded change did nothing, and only that caller's break is told.
 */
export type InstagramAccountDailyCheckResult =
  | { outcome: 'skipped'; reason: 'not_connected' | 'token_missing' }
  | {
      outcome: 'broken';
      connectionStatus: InstagramAccountBrokenConnectionStatus;
      step: 'profile' | 'subscription';
    }
  | {
      outcome: 'checked';
      profile: 'refreshed' | 'refused' | 'mismatch';
      subscription: 'subscribed' | 'already_subscribed' | 'refused';
    };

/** The account, its key and the organization one check works in. */
interface DailyCheckTarget {
  organizationPublicId: string;
  account: InstagramAccountRow;
  key: InstagramAccountKey;
  accountService: InstagramAccountDailyCheckService;
  requestId: string;
}

/**
 * Moves the account to `error` through the account service's guarded change. The service joins this
 * unit (same organization), so the reconnect notice is enqueued after this unit commits.
 */
async function breakConnection({
  target,
  connectionStatus,
}: {
  target: DailyCheckTarget;
  connectionStatus: InstagramAccountBrokenConnectionStatus;
}): Promise<void> {
  const { organizationPublicId, key, accountService, requestId } = target;
  await runOrganizationScopedWorkerJob({
    job: { organizationPublicId },
    processor: async () => {
      await accountService.markConnectionBroken({
        scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId }),
        instagramAccount: key,
        connectionStatus,
        requestId,
      });
    },
  });
}

/** A later step's failure: a break stops the check, a wait rethrows, a refusal is logged. */
async function handleStepFailure({
  target,
  error,
  step,
}: {
  target: DailyCheckTarget;
  error: unknown;
  step: 'profile' | 'subscription';
}): Promise<InstagramAccountDailyCheckResult | 'refused'> {
  const failure = classifyInstagramDailyCheckFailure(error);
  if (failure.action === 'break') {
    await breakConnection({ target, connectionStatus: failure.connectionStatus });
    return { outcome: 'broken', connectionStatus: failure.connectionStatus, step };
  }
  if (failure.action === 'wait') throw toDailyCheckRetryError(error);
  logger.warn(
    {
      organizationPublicId: target.organizationPublicId,
      instagramAccountPublicId: target.account.public_id,
      failure: describeMetaGraphError(error),
    },
    `app.instagram_account.daily_check.${step}_refused`,
  );
  return 'refused';
}

/** IA8 step 2 — read `/me` outside any context, then write the profile in its own unit of work. */
async function refreshProfile({
  target,
  encryptedAccessToken,
}: {
  target: DailyCheckTarget;
  encryptedAccessToken: string;
}): Promise<InstagramAccountDailyCheckResult | 'refreshed' | 'refused' | 'mismatch'> {
  let profile: Awaited<ReturnType<typeof readInstagramAccountProfile>>;
  try {
    profile = await readInstagramAccountProfile({
      encryptedAccessToken,
      instagramUserId: target.account.instagram_user_id,
      requestId: target.requestId,
    });
  } catch (error) {
    return handleStepFailure({ target, error, step: 'profile' });
  }
  if (profile.instagramUserId !== target.account.instagram_user_id) {
    logger.warn(
      {
        organizationPublicId: target.organizationPublicId,
        instagramAccountPublicId: target.account.public_id,
      },
      'app.instagram_account.daily_check.profile_mismatch',
    );
    return 'mismatch';
  }
  await runOrganizationScopedWorkerJob({
    job: { organizationPublicId: target.organizationPublicId },
    processor: (databaseHandle) =>
      createWorkerInstagramAccountRepository(databaseHandle).recordProfileRefresh({
        ...target.key,
        instagramUserId: profile.instagramUserId,
        profile,
      }),
  });
  return 'refreshed';
}

/**
 * IA8 step 3 — subscribe the account to the webhook fields again while `webhook_subscribed_at` is
 * empty (a connect whose subscription failed), then stamp it.
 */
async function subscribeWhenNotSubscribed({
  target,
  encryptedAccessToken,
}: {
  target: DailyCheckTarget;
  encryptedAccessToken: string;
}): Promise<InstagramAccountDailyCheckResult | 'subscribed' | 'already_subscribed' | 'refused'> {
  if (target.account.webhook_subscribed_at !== null) return 'already_subscribed';
  try {
    await subscribeInstagramWebhookFields({
      encryptedAccessToken,
      instagramAppUserId: target.account.instagram_app_user_id,
      requestId: target.requestId,
    });
  } catch (error) {
    return handleStepFailure({ target, error, step: 'subscription' });
  }
  await runOrganizationScopedWorkerJob({
    job: { organizationPublicId: target.organizationPublicId },
    processor: (databaseHandle) =>
      createWorkerInstagramAccountRepository(databaseHandle).recordWebhookSubscribed(target.key),
  });
  return 'subscribed';
}

/**
 * The daily account check of one organization's connected account (IA8, D9): refresh the profile
 * and subscribe the account to the webhook fields again when it is not subscribed. The launch's
 * token renewal is gone (feat-instagram-dm-sending WC-35): the account's channel connection holds
 * one token that never ends (D24); the connection's own token check replaces this job at ROUTE row
 * R51 (MC10).
 *
 * @remarks
 * - **Algorithm:** every database step runs in the organization's job scope
 *   (`runOrganizationScopedWorkerJob`, K8) and every Meta call outside any database context
 *   (1.10). (1) Read the account by its public id and its connection's encrypted token; an account
 *   no longer `connected` is skipped. (2) `GET /{instagram_user_id}` → the profile and
 *   `profile_synced_at`. (3) `subscribed_apps` when `webhook_subscribed_at` is empty, then the stamp.
 * - **Failure modes:** Meta refusing the token (`auth`) → the account service's guarded change to
 *   `error` at once; Meta down or busy (`outage`, `throttled`, an open circuit) → the account stays
 *   `connected` and the error is rethrown — a throttle as a `ProviderOutageError` with Meta's wait —
 *   so the provider-pausable worker waits the outage out without spending an attempt; a refusal of
 *   one request (`refused`) is logged and the next day tries again. Anything else (the database, a
 *   token that does not decrypt) is rethrown and takes the queue's attempts.
 * - **Side effects:** Meta calls (`/{instagram_user_id}`, `subscribed_apps`); writes the account
 *   row; a break enqueues the reconnect notice after its commit (IA9).
 * - **Notes:** safe to repeat — one job per account per day (the job id), the profile write is the
 *   same data, and a subscribed account is not subscribed again. Reads the token table through the
 *   worker token repository — a worker path `channel-connection-token-isolation.policy.unit.test.ts`
 *   allows (MC9).
 */
export async function processInstagramAccountDailyCheckJob({
  jobData,
  accountService,
  requestId,
}: {
  jobData: Pick<
    InstagramAccountDailyCheckJobData,
    'organizationPublicId' | 'instagramAccountPublicId'
  >;
  accountService: InstagramAccountDailyCheckService;
  /** The job's id, as the request id of the Instagram calls (`X-Request-Id`). */
  requestId: string;
}): Promise<InstagramAccountDailyCheckResult> {
  const { organizationPublicId, instagramAccountPublicId } = jobData;
  const snapshot = await runOrganizationScopedWorkerJob({
    job: { organizationPublicId },
    processor: async (databaseHandle) => {
      const account = await createWorkerInstagramAccountRepository(
        databaseHandle,
      ).findByPublicIdInOrganization({ organizationPublicId, instagramAccountPublicId });
      if (account === null || account.connection_status !== 'connected') return null;
      const key: InstagramAccountKey = {
        organizationId: account.organization_id,
        instagramAccountId: account.id,
      };
      // The token is the account's channel connection's (P111, MC9).
      const token = await createWorkerChannelConnectionTokenRepository(
        databaseHandle,
      ).findByConnection({
        organizationId: account.organization_id,
        channelConnectionId: account.channel_connection_id,
      });
      return { account, key, token };
    },
  });
  if (snapshot === null) return { outcome: 'skipped', reason: 'not_connected' };
  if (snapshot.token === null) {
    // A connected account's connection keeps its token until its last account goes (CA8).
    logger.error(
      { organizationPublicId, instagramAccountPublicId },
      'app.instagram_account.daily_check.token_missing',
    );
    return { outcome: 'skipped', reason: 'token_missing' };
  }
  const target: DailyCheckTarget = {
    organizationPublicId,
    account: snapshot.account,
    key: snapshot.key,
    accountService,
    requestId,
  };

  const { encryptedAccessToken } = snapshot.token;

  const profile = await refreshProfile({ target, encryptedAccessToken });
  if (typeof profile !== 'string') return profile;

  const subscription = await subscribeWhenNotSubscribed({ target, encryptedAccessToken });
  if (typeof subscription !== 'string') return subscription;

  const result: InstagramAccountDailyCheckResult = {
    outcome: 'checked',
    profile,
    subscription,
  };
  logger.info(
    { organizationPublicId, instagramAccountPublicId, ...result },
    'app.instagram_account.daily_check.completed',
  );
  return result;
}

/**
 * What one sweep did.
 *
 * @remarks
 * - **Algorithm:** `listedCount` connected accounts were read, `addedCount` checks were handed to
 *   the queue (BullMQ drops the add of an account already checked today), `capped` when the sweep
 *   stopped at {@link INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_MAX_PAGES} pages.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** logged as `app.instagram_account.daily_check.sweep_completed`.
 */
export interface InstagramAccountDailyCheckSweepResult {
  listedCount: number;
  addedCount: number;
  capped: boolean;
}

/**
 * The 04:00 UTC sweep of the daily account check (IA8): lists every `connected` account of every
 * live organization and hands one check per account — so per organization — to the queue.
 *
 * @remarks
 * - **Algorithm:** page by id ({@link INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE} a page): one
 *   short read under `runGlobalRetentionWorkerJob` (the account policy's sweep arm, `USING` only —
 *   it reads every organization's row and can change none), then, with the context closed, one
 *   `addBulk` of the page's checks keyed by account and UTC day.
 * - **Failure modes:** a failed read throws to BullMQ; a failed add is logged
 *   (`app.instagram_account.daily_check.enqueue_failed`) and those accounts are listed again by
 *   tomorrow's sweep — one missed day costs one profile refresh. Reaching
 *   {@link INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_MAX_PAGES} logs `…sweep_capped` at error.
 * - **Side effects:** jobs on the daily-check queue; no row is changed.
 * - **Notes:** a repeatable job on the daily-check queue, run by the daily-check worker
 *   (`scheduler.ts`); the sweep reads the account's `connection_status` only, never the token
 *   table (MC9). `now` is injectable for tests.
 */
export async function runInstagramAccountDailyCheckSweep(
  options: { now?: Date } = {},
): Promise<InstagramAccountDailyCheckSweepResult> {
  const checkedOn = options.now ?? new Date();
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
        addedCount += await enqueueInstagramAccountDailyChecks({
          targets: candidates.map(({ organizationPublicId, instagramAccountPublicId }) => ({
            organizationPublicId,
            instagramAccountPublicId,
          })),
          checkedOn,
        });
      } catch (error) {
        logger.warn(
          { error, pageSize: candidates.length },
          'app.instagram_account.daily_check.enqueue_failed',
        );
      }
    }
    if (candidates.length < INSTAGRAM_ACCOUNT_DAILY_CHECK_SWEEP_PAGE_SIZE) {
      const result = { listedCount, addedCount, capped: false };
      logger.info(result, 'app.instagram_account.daily_check.sweep_completed');
      return result;
    }
  }
  const result = { listedCount, addedCount, capped: true };
  logger.error(result, 'app.instagram_account.daily_check.sweep_capped');
  return result;
}
