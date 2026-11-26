import { META_PERMISSION_NAMES_MAX } from '@/domains/app/sub-domains/channel-connection/channel-connection.constants.js';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  runGlobalRetentionWorkerJob,
  runOrganizationScopedWorkerJob,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { reencryptFieldSecretToCurrentVersion } from '@/shared/utils/security/field-secret-encryption.util.js';
import {
  type InstagramAccountProfile,
  type MetaGraphUsageRecorder,
  listMetaAssignedInstagramAccounts,
  readInstagramAccountProfile,
  readMetaGrantedPermissions,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  MetaGraphApiError,
  describeMetaGraphError,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { isMetaTokenRefused } from '@/domains/app/sub-domains/channel-connection/channel-connection-error.util.js';
import {
  type ChannelConnectionKey,
  createRetentionChannelConnectionRepository,
  createWorkerChannelConnectionRepository,
} from '@/domains/app/sub-domains/channel-connection/channel-connection.repository.js';
import { createWorkerChannelConnectionTokenRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.repository.js';
import type { ChannelConnectionService } from '@/domains/app/sub-domains/channel-connection/channel-connection.service.js';
import type {
  ChannelConnectionAccount,
  ChannelConnectionAccountPort,
} from '@/domains/app/sub-domains/channel-connection/channel-connection.types.js';
import type { ChannelConnectionUsageService } from '@/domains/app/sub-domains/channel-connection/channel-connection-usage.service.js';
import {
  type ChannelConnectionTokenCheckJobData,
  enqueueChannelConnectionTokenChecks,
} from '@/domains/app/sub-domains/channel-connection/queues/channel-connection-token-check.queue.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import {
  CHANNEL_CONNECTION_TOKEN_CHECK_INTERVAL_MS,
  CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_MAX_PAGES,
  CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_PAGE_SIZE,
  CHANNEL_CONNECTION_TOKEN_EXPIRY_WARNING_DAYS,
  CHANNEL_CONNECTION_UNPICKED_KEEP_DAYS,
} from './channel-connection-token-check.constants.js';

/**
 * What a failed Meta call of the token check means (MC10, MC11): `break` — Meta refused the token
 * itself (code 190), every account of the connection leaves `connected`; `permission` — Meta
 * refused a permission (code 10 or 200–299: the account is not Business or Creator any more, or a
 * permission was not granted — P354), only what that call read is touched; `defer` — Meta is down
 * or busy, its circuit is open, or the call failed on the way, nothing changes and a later sweep
 * tries again; `refused` — Meta refused only this request.
 *
 * @remarks
 * - **Algorithm:** filled by {@link classifyChannelConnectionTokenCheckFailure}.
 * - **Failure modes:** none — a value.
 * - **Side effects:** none.
 * - **Notes:** a code-10 "outside the messaging window" answer is `refused` in the client (D32),
 *   so it never breaks anything here.
 */
export type ChannelConnectionTokenCheckFailureAction = 'break' | 'permission' | 'defer' | 'refused';

/**
 * Classes one failed Meta call of the token check (MC10): Meta's code 190 breaks the connection,
 * any other `auth` answer is a permission refusal, a `refused` answer is kept as this check's
 * error, anything else defers the check.
 *
 * @remarks
 * - **Algorithm:** code 190 (`isMetaTokenRefused`, the routes' own test) → `break`; any other
 *   `MetaGraphApiError` of class `auth` (codes 10, 200–299) → `permission` (P354); `refused` →
 *   `refused`; `throttled`, `outage` (an open `metaGraphCircuit`, a timeout, a 5xx) or a failure
 *   that is not Meta's answer → `defer`.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 * - **Notes:** exported for the unit test and for the Instagram account jobs (set-up, subscription
 *   check, starter-question sync — ROUTE row R40), which break the account alone on `break` and
 *   `permission`; the launch daily check's own classifier went with it at the R40 × R51 merge.
 */
export function classifyChannelConnectionTokenCheckFailure(
  error: unknown,
): ChannelConnectionTokenCheckFailureAction {
  if (!(error instanceof MetaGraphApiError)) return 'defer';
  if (isMetaTokenRefused(error)) return 'break';
  if (error.errorClass === 'auth') return 'permission';
  if (error.errorClass === 'refused') return 'refused';
  return 'defer';
}

/**
 * The service steps the token check drives — the connection's guarded break (MC11) and the
 * account port's single-account break, profile refresh and account list (1B, 2), plus the usage
 * recorder of every Meta call (MC19).
 *
 * @remarks
 * - **Algorithm:** structural picks, so the processor depends only on the methods it calls.
 * - **Failure modes:** none — type only.
 * - **Side effects:** none on this type.
 * - **Notes:** supplied by the worker composition root (`appDomain`'s channel connection service,
 *   channel account service and usage service), never built here.
 */
export interface ChannelConnectionTokenCheckServices {
  connectionService: Pick<ChannelConnectionService, 'markConnectionBroken'>;
  accountPort: Pick<
    ChannelConnectionAccountPort,
    'listAccountsOfConnections' | 'markAccountBroken' | 'refreshAccountProfile'
  >;
  usageService?: Pick<ChannelConnectionUsageService, 'buildUsageRecorder'> | undefined;
  /**
   * The 10-minute webhook subscription sweep (WC-25, ROUTE row R40) that rides this queue — the
   * Instagram account jobs' `runInstagramWebhookSubscriptionCheckSweep`, wired by the worker
   * registry so this sub-domain never imports the account jobs. Absent → the sweep job is logged
   * and skipped.
   */
  webhookSubscriptionSweep?: (() => Promise<unknown>) | undefined;
}

/**
 * What one connection's token check did.
 *
 * @remarks
 * - **Algorithm:** `skipped` — the connection is not `connected` any more (or has no token);
 *   `revoked_unpicked` — no account was picked from it within
 *   {@link CHANNEL_CONNECTION_UNPICKED_KEEP_DAYS} days of its last login, so it was revoked and its
 *   token deleted (feat-meta-connect-flow CN9);
 *   `deferred` — Meta was down or busy, nothing changed; `broken` — Meta refused the token at
 *   `step` and the connection was broken (`isWinner` false when another caller broke it first);
 *   `refused` — Meta refused the account-list read, its codes kept as `last_check_error`;
 *   `permission_missing` — Meta refused the account-list read for a permission (P354): its codes
 *   kept, the granted permissions re-read into `scopes` (`scopesRefreshed`);
 *   `checked` — the counts of accounts refreshed, found missing and refused for a permission
 *   (`permissionRefusedCount`), whether the list was read in full (`isListComplete`, P353) and
 *   whether the token ends soon (`isExpiringSoon`, P355). `reencrypted` tells whether the token
 *   moved off an old key version (S26).
 * - **Failure modes:** none — a return shape (Bull Board shows it as the job's return value).
 * - **Side effects:** none.
 * - **Notes:** logged as `app.channel_connection.token_check.completed`.
 */
export type ChannelConnectionTokenCheckResult =
  | { outcome: 'skipped'; reason: 'not_connected' | 'token_missing' }
  | { outcome: 'revoked_unpicked' }
  | { outcome: 'deferred'; step: 'assigned_accounts' | 'profile'; reencrypted: boolean }
  | {
      outcome: 'broken';
      step: 'assigned_accounts' | 'profile';
      isWinner: boolean;
      reencrypted: boolean;
    }
  | { outcome: 'refused'; reencrypted: boolean }
  | { outcome: 'permission_missing'; scopesRefreshed: boolean; reencrypted: boolean }
  | {
      outcome: 'checked';
      refreshedCount: number;
      missingCount: number;
      permissionRefusedCount: number;
      isListComplete: boolean;
      isExpiringSoon: boolean;
      reencrypted: boolean;
    };

/** The connection, its token and accounts, and what one check works with. */
interface TokenCheckTarget {
  organizationPublicId: string;
  connection: ChannelConnectionKey & { publicId: string };
  encryptedAccessToken: string;
  /** The token's end (`channel_connection_tokens.expires_at`), `null` when it never ends. */
  tokenExpiresAt: Date | null;
  accounts: ChannelConnectionAccount[];
  reencrypted: boolean;
  services: ChannelConnectionTokenCheckServices;
  recordUsage: MetaGraphUsageRecorder | undefined;
  requestId: string;
}

/** The snapshot of the first unit: the connection, its token (re-encrypted first) and accounts. */
async function readTarget({
  jobData,
  services,
}: {
  jobData: Pick<
    ChannelConnectionTokenCheckJobData,
    'organizationPublicId' | 'channelConnectionPublicId'
  >;
  services: ChannelConnectionTokenCheckServices;
}): Promise<
  | { outcome: 'skipped'; reason: 'not_connected' | 'token_missing' }
  | { outcome: 'revoked_unpicked' }
  | Omit<TokenCheckTarget, 'services' | 'recordUsage' | 'requestId'>
> {
  const { organizationPublicId, channelConnectionPublicId } = jobData;
  return runOrganizationScopedWorkerJob({
    job: { organizationPublicId },
    processor: async (databaseHandle) => {
      const connection = await createWorkerChannelConnectionRepository(
        databaseHandle,
      ).findByPublicIdInOrganization({ organizationPublicId, channelConnectionPublicId });
      if (connection === null || connection.status !== 'connected') {
        return { outcome: 'skipped' as const, reason: 'not_connected' as const };
      }
      const key: ChannelConnectionKey = {
        organizationId: connection.organization_id,
        channelConnectionId: connection.id,
      };
      const tokenRepository = createWorkerChannelConnectionTokenRepository(databaseHandle);
      // CN9: a login nobody picked from within the keep days is revoked, its token deleted.
      const unpickedBefore = new Date(
        Date.now() - CHANNEL_CONNECTION_UNPICKED_KEEP_DAYS * MILLISECONDS_PER_DAY,
      );
      if (connection.connected_at < unpickedBefore) {
        const connectionRepository = createWorkerChannelConnectionRepository(databaseHandle);
        // The pick's organization lock first, so a pick in flight commits before the guarded revoke.
        await connectionRepository.lockOrganizationForAccountLimit(connection.organization_id);
        const isRevoked = await connectionRepository.revokeUnpicked({
          ...key,
          connectedBefore: unpickedBefore,
        });
        if (isRevoked) {
          await tokenRepository.deleteByConnection(key);
          return { outcome: 'revoked_unpicked' as const };
        }
      }
      const token = await tokenRepository.findByConnection(key);
      if (token === null) return { outcome: 'skipped' as const, reason: 'token_missing' as const };
      // S26: a token still on an old key version moves to the current one; the plain token never
      // leaves the field-secret util. The guarded write leaves a token a reconnect replaced alone.
      let encryptedAccessToken = token.encryptedAccessToken;
      let reencrypted = false;
      const moved = reencryptFieldSecretToCurrentVersion(encryptedAccessToken);
      if (moved !== null) {
        reencrypted = await tokenRepository.replaceEncryptedAccessToken({
          ...key,
          previousEncryptedAccessToken: encryptedAccessToken,
          encryptedAccessToken: moved,
        });
        if (reencrypted) encryptedAccessToken = moved;
      }
      const accounts = await services.accountPort.listAccountsOfConnections({
        scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId }),
        organizationId: connection.organization_id,
        channelConnectionIds: [connection.id],
      });
      return {
        organizationPublicId,
        connection: { ...key, publicId: connection.public_id },
        encryptedAccessToken,
        tokenExpiresAt: token.expiresAt,
        accounts,
        reencrypted,
      };
    },
  });
}

/** MC11: the connection and every `connected` account of it `error`, through the service. */
async function breakConnection({
  target,
  error,
  step,
}: {
  target: TokenCheckTarget;
  error: unknown;
  step: 'assigned_accounts' | 'profile';
}): Promise<ChannelConnectionTokenCheckResult> {
  const isWinner = await target.services.connectionService.markConnectionBroken({
    scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId: target.organizationPublicId }),
    channelConnection: {
      organizationId: target.connection.organizationId,
      channelConnectionId: target.connection.channelConnectionId,
    },
    lastCheckError: describeMetaGraphError(error),
    requestId: target.requestId,
  });
  logger.warn(
    {
      organizationPublicId: target.organizationPublicId,
      channelConnectionPublicId: target.connection.publicId,
      step,
      isWinner,
      failure: describeMetaGraphError(error),
    },
    'app.channel_connection.token_check.broken',
  );
  return { outcome: 'broken', step, isWinner, reencrypted: target.reencrypted };
}

/**
 * The check's stamp: `last_checked_at` now, `last_check_error` cleared, Meta's codes or the
 * expiry flag; `scopes` replaced when given (P354).
 */
async function recordCheck({
  target,
  lastCheckError,
  scopes,
}: {
  target: TokenCheckTarget;
  lastCheckError: string | null;
  scopes?: readonly string[] | undefined;
}): Promise<void> {
  await runOrganizationScopedWorkerJob({
    job: { organizationPublicId: target.organizationPublicId },
    processor: (databaseHandle) =>
      createWorkerChannelConnectionRepository(databaseHandle).recordTokenCheck({
        organizationId: target.connection.organizationId,
        channelConnectionId: target.connection.channelConnectionId,
        lastCheckError,
        scopes,
      }),
  });
}

/**
 * MC10 / P354: Meta refused the account-list read for a permission (code 10, 200–299) — the token
 * still works, so nothing breaks. The granted permissions are re-read (best effort) into the
 * connection's `scopes`, so the feature check (P50) answers `permission_not_granted` — reconnect to
 * allow it — and Meta's codes are kept as `last_check_error`.
 */
async function recordPermissionMissing({
  target,
  error,
}: {
  target: TokenCheckTarget;
  error: unknown;
}): Promise<ChannelConnectionTokenCheckResult> {
  let scopes: string[] | undefined;
  try {
    const granted = await readMetaGrantedPermissions({
      encryptedAccessToken: target.encryptedAccessToken,
      requestId: target.requestId,
      recordUsage: target.recordUsage,
    });
    scopes = [...new Set(granted)].slice(0, META_PERMISSION_NAMES_MAX);
  } catch (permissionError) {
    logger.warn(
      {
        organizationPublicId: target.organizationPublicId,
        channelConnectionPublicId: target.connection.publicId,
        failure: describeMetaGraphError(permissionError),
      },
      'app.channel_connection.token_check.permissions_unread',
    );
  }
  await recordCheck({ target, lastCheckError: describeMetaGraphError(error), scopes });
  logger.warn(
    {
      organizationPublicId: target.organizationPublicId,
      channelConnectionPublicId: target.connection.publicId,
      failure: describeMetaGraphError(error),
      scopesRefreshed: scopes !== undefined,
    },
    'app.channel_connection.token_check.permission_missing',
  );
  return {
    outcome: 'permission_missing',
    scopesRefreshed: scopes !== undefined,
    reencrypted: target.reencrypted,
  };
}

/**
 * P355: the `last_check_error` of a passing check — `null`, or `token_expires_soon (expires_at …)`
 * when the token ends within {@link CHANNEL_CONNECTION_TOKEN_EXPIRY_WARNING_DAYS} days (a
 * configuration whose token ends — Meta refuses it with code 190 once it has).
 */
function readExpiryFlag({ target, now }: { target: TokenCheckTarget; now: Date }): string | null {
  if (target.tokenExpiresAt === null) return null;
  const warnFrom =
    target.tokenExpiresAt.getTime() -
    CHANNEL_CONNECTION_TOKEN_EXPIRY_WARNING_DAYS * MILLISECONDS_PER_DAY;
  return now.getTime() >= warnFrom
    ? `token_expires_soon (expires_at ${target.tokenExpiresAt.toISOString()})`
    : null;
}

/** The profile read of one present account, or the failure's action. */
async function readProfile({
  target,
  account,
}: {
  target: TokenCheckTarget;
  account: ChannelConnectionAccount;
}): Promise<
  InstagramAccountProfile | { failure: ChannelConnectionTokenCheckFailureAction; error: unknown }
> {
  try {
    return await readInstagramAccountProfile({
      encryptedAccessToken: target.encryptedAccessToken,
      instagramUserId: account.providerAccountId,
      requestId: target.requestId,
      recordUsage: target.recordUsage,
    });
  } catch (error) {
    return { failure: classifyChannelConnectionTokenCheckFailure(error), error };
  }
}

/** One account of {@link checkAccounts}: what its step did, or the check's end (a break, a defer). */
type AccountCheckOutcome =
  | 'missing'
  | 'permission_refused'
  | 'refreshed'
  | 'unchanged'
  | ChannelConnectionTokenCheckResult;

/** What the token check knows of the assigned list (P353). */
interface AssignedList {
  ids: ReadonlySet<string>;
  /** `false` when the read stopped at the page cap — an account missing from it is not marked. */
  isComplete: boolean;
}

/**
 * The profile read's refusal for one account ({@link checkOneAccount}): a token refusal breaks the
 * connection, a transient one defers, a permission refusal breaks the account alone (P354), any
 * other refusal is logged and leaves the account as it is.
 */
async function handleProfileFailure({
  target,
  account,
  scope,
  profile,
}: {
  target: TokenCheckTarget;
  account: TokenCheckTarget['accounts'][number];
  scope: OrganizationPrincipalDatabaseScope;
  profile: Extract<Awaited<ReturnType<typeof readProfile>>, { failure: unknown }>;
}): Promise<AccountCheckOutcome> {
  if (profile.failure === 'break') {
    return breakConnection({ target, error: profile.error, step: 'profile' });
  }
  if (profile.failure === 'defer') {
    return { outcome: 'deferred', step: 'profile', reencrypted: target.reencrypted };
  }
  if (profile.failure === 'permission') {
    // P354: Meta refused this account alone (code 10 — not Business or Creator any more, or a
    // permission not granted): it breaks alone, its reconnect notice and its lanes stopped.
    logger.warn(
      {
        organizationPublicId: target.organizationPublicId,
        channelAccountPublicId: account.publicId,
        failure: describeMetaGraphError(profile.error),
      },
      'app.channel_connection.token_check.profile_permission_refused',
    );
    const isBroken = await target.services.accountPort.markAccountBroken({
      scope,
      organizationId: target.connection.organizationId,
      channelAccountId: account.internalId,
      requestId: target.requestId,
      stopReason: 'wrong_permission',
    });
    return isBroken ? 'permission_refused' : 'unchanged';
  }
  logger.warn(
    {
      organizationPublicId: target.organizationPublicId,
      channelAccountPublicId: account.publicId,
      failure: describeMetaGraphError(profile.error),
    },
    'app.channel_connection.token_check.profile_refused',
  );
  return 'unchanged';
}

/**
 * MC10 for one connected Instagram account: missing from a list read in full → it breaks alone
 * (`account_not_shared`); present → its profile, a permission refusal of which breaks it alone
 * (`wrong_permission`, P354); missing from a capped list → left alone (P353).
 */
async function checkOneAccount({
  target,
  account,
  assigned,
}: {
  target: TokenCheckTarget;
  account: TokenCheckTarget['accounts'][number];
  assigned: AssignedList;
}): Promise<AccountCheckOutcome> {
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId: target.organizationPublicId });
  if (!assigned.ids.has(account.providerAccountId)) {
    if (!assigned.isComplete) return 'unchanged';
    // §25.9: the business no longer shares this account — it breaks alone (CA4).
    const isBroken = await target.services.accountPort.markAccountBroken({
      scope,
      organizationId: target.connection.organizationId,
      channelAccountId: account.internalId,
      requestId: target.requestId,
      stopReason: 'account_not_shared',
    });
    return isBroken ? 'missing' : 'unchanged';
  }
  const profile = await readProfile({ target, account });
  if ('failure' in profile) return handleProfileFailure({ target, account, scope, profile });
  const isRefreshed = await target.services.accountPort.refreshAccountProfile({
    scope,
    organizationId: target.connection.organizationId,
    channelAccountId: account.internalId,
    profile,
  });
  return isRefreshed ? 'refreshed' : 'unchanged';
}

/** MC10 for the accounts: a missing one breaks alone; a present one gets its profile refreshed. */
async function checkAccounts({
  target,
  assigned,
}: {
  target: TokenCheckTarget;
  assigned: AssignedList;
}): Promise<
  | ChannelConnectionTokenCheckResult
  | { refreshedCount: number; missingCount: number; permissionRefusedCount: number }
> {
  let refreshedCount = 0;
  let missingCount = 0;
  let permissionRefusedCount = 0;
  for (const account of target.accounts) {
    if (account.connectionStatus !== 'connected' || account.channel !== 'instagram') continue;
    const outcome = await checkOneAccount({ target, account, assigned });
    if (outcome === 'missing') missingCount += 1;
    else if (outcome === 'permission_refused') permissionRefusedCount += 1;
    else if (outcome === 'refreshed') refreshedCount += 1;
    else if (outcome !== 'unchanged') return outcome;
  }
  return { refreshedCount, missingCount, permissionRefusedCount };
}

/**
 * The daily token check of one organization's channel connection (routes-final § 1 MC10, MC11;
 * WC-34; P17): the token and its list of accounts, each connected account's profile, the old-key
 * token moved (S26).
 *
 * @remarks
 * - **Algorithm:** every database step runs in the organization's job scope
 *   (`runOrganizationScopedWorkerJob`, K8) and every Meta call outside any database context.
 *   (1) Read the connection by its public id — not `connected` → skipped; last login older than
 *   {@link CHANNEL_CONNECTION_UNPICKED_KEEP_DAYS} days with no account that is not revoked → revoked
 *   and its token deleted, nothing else (feat-meta-connect-flow CN9, one guarded statement) — its
 *   token (none →
 *   skipped, logged) and its not-revoked accounts; a token on an old key version is re-encrypted
 *   onto the current one in the same unit (S26). (2) `GET /me/assigned_instagram_accounts`, every
 *   page (P353). (3) Each `connected` Instagram account: missing from a list read in full → that
 *   account `error` alone (`account_not_shared` stop, its reconnect notice — CA4; never from a list
 *   the page cap cut); present → `GET /{instagram_user_id}` and the profile written with the
 *   channel account's `display_name` (P17). (4) `last_checked_at` now, `last_check_error` cleared —
 *   or `token_expires_soon (expires_at …)` when a dated token ends within
 *   {@link CHANNEL_CONNECTION_TOKEN_EXPIRY_WARNING_DAYS} days (P355).
 * - **Failure modes:** Meta refusing the token itself (code 190) at any call →
 *   `ChannelConnectionService.markConnectionBroken` (the connection and every connected account
 *   `error`, their lanes stopped, one reconnect notice per account — MC11, WC-46); another `auth`
 *   answer (codes 10, 200–299 — P354) on the list → nothing breaks, the granted permissions re-read
 *   into `scopes` and the codes stamped (`permission_missing`), on a profile → that account `error`
 *   alone (`wrong_permission` stop, its reconnect notice); Meta down, busy or its circuit open →
 *   `deferred`, nothing changes and the next hourly sweep adds the connection again (F3: the worker
 *   is never paused); Meta refusing the account list (`refused`) → stamped with its codes; a refused
 *   profile read is logged and skipped. Our own failures (the database, a token that does not
 *   decrypt) are rethrown and take the queue's attempts.
 * - **Side effects:** Meta calls (their usage recorded per connection, MC19); writes the
 *   connection's check columns, the token's ciphertext (S26), profiles and display names; a break
 *   enqueues reconnect notices after its commit.
 * - **Notes:** safe to repeat — one job per connection per hour (the job id), a checked connection
 *   is not due for 24 hours, the breaks are guarded (only the winner tells), the profile write is
 *   the same data. Reads the token table through the worker token repository — a path
 *   `channel-connection-token-isolation.policy.unit.test.ts` allows (MC9); it hands the client the
 *   ciphertext only.
 */
export async function processChannelConnectionTokenCheckJob({
  jobData,
  services,
  requestId,
}: {
  jobData: Pick<
    ChannelConnectionTokenCheckJobData,
    'organizationPublicId' | 'channelConnectionPublicId'
  >;
  services: ChannelConnectionTokenCheckServices;
  /** The job's id, as the request id of the Meta calls (`X-Request-Id`). */
  requestId: string;
}): Promise<ChannelConnectionTokenCheckResult> {
  const { organizationPublicId, channelConnectionPublicId } = jobData;
  const snapshot = await readTarget({ jobData, services });
  if ('outcome' in snapshot && snapshot.outcome === 'revoked_unpicked') {
    logger.info(
      { organizationPublicId, channelConnectionPublicId },
      'app.channel_connection.token_check.revoked_unpicked',
    );
    return snapshot;
  }
  if ('outcome' in snapshot) {
    if (snapshot.reason === 'token_missing') {
      // A connected connection keeps its token until it is revoked (MC8).
      logger.error(
        { organizationPublicId, channelConnectionPublicId },
        'app.channel_connection.token_check.token_missing',
      );
    }
    return snapshot;
  }
  const target: TokenCheckTarget = {
    ...snapshot,
    services,
    requestId,
    recordUsage: services.usageService?.buildUsageRecorder({
      scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId }),
      channelConnectionPublicId,
    }),
  };

  let assigned: AssignedList;
  try {
    const list = await listMetaAssignedInstagramAccounts({
      encryptedAccessToken: target.encryptedAccessToken,
      requestId,
      recordUsage: target.recordUsage,
    });
    assigned = {
      ids: new Set(list.accounts.map((account) => account.instagramUserId)),
      isComplete: list.isComplete,
    };
    if (!list.isComplete) {
      logger.warn(
        { organizationPublicId, channelConnectionPublicId, listedCount: list.accounts.length },
        'app.channel_connection.token_check.assigned_list_capped',
      );
    }
  } catch (error) {
    const failure = classifyChannelConnectionTokenCheckFailure(error);
    if (failure === 'break') return breakConnection({ target, error, step: 'assigned_accounts' });
    if (failure === 'permission') return recordPermissionMissing({ target, error });
    if (failure === 'defer') {
      logger.warn(
        { organizationPublicId, channelConnectionPublicId, failure: describeMetaGraphError(error) },
        'app.channel_connection.token_check.deferred',
      );
      return { outcome: 'deferred', step: 'assigned_accounts', reencrypted: target.reencrypted };
    }
    await recordCheck({ target, lastCheckError: describeMetaGraphError(error) });
    return { outcome: 'refused', reencrypted: target.reencrypted };
  }

  const accounts = await checkAccounts({ target, assigned });
  if ('outcome' in accounts) return accounts;
  const expiryFlag = readExpiryFlag({ target, now: new Date() });
  await recordCheck({ target, lastCheckError: expiryFlag });
  if (expiryFlag !== null) {
    logger.warn(
      { organizationPublicId, channelConnectionPublicId, expiresAt: target.tokenExpiresAt },
      'app.channel_connection.token_check.token_expires_soon',
    );
  }
  const result: ChannelConnectionTokenCheckResult = {
    outcome: 'checked',
    ...accounts,
    isListComplete: assigned.isComplete,
    isExpiringSoon: expiryFlag !== null,
    reencrypted: target.reencrypted,
  };
  logger.info(
    { organizationPublicId, channelConnectionPublicId, ...result },
    'app.channel_connection.token_check.completed',
  );
  return result;
}

/**
 * What one sweep did.
 *
 * @remarks
 * - **Algorithm:** `listedCount` due connections were read, `addedCount` checks were handed to the
 *   queue (BullMQ drops the add of a connection already added this hour), `capped` when the sweep
 *   stopped at {@link CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_MAX_PAGES} pages.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** logged as `app.channel_connection.token_check.sweep_completed`.
 */
export interface ChannelConnectionTokenCheckSweepResult {
  listedCount: number;
  addedCount: number;
  capped: boolean;
}

/**
 * The hourly sweep of the token check (MC10): lists every `connected` connection of every live
 * organization whose last check is 24 hours old (or never ran) and hands one check per connection
 * — so per organization — to the queue.
 *
 * @remarks
 * - **Algorithm:** page by id ({@link CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_PAGE_SIZE} a page): one
 *   short read under `runGlobalRetentionWorkerJob` (the connection policy's sweep arm, `USING`
 *   only — it reads every organization's row and can change none; `idx_channel_connections_check_due`),
 *   then, with the context closed, one `addBulk` of the page's checks keyed by connection and UTC
 *   hour. The checks spread over the day by themselves: each connection is due 24 hours after it
 *   was connected or last checked.
 * - **Failure modes:** a failed read throws to BullMQ; a failed add is logged
 *   (`app.channel_connection.token_check.enqueue_failed`) and those connections stay due for the
 *   next sweep. Reaching {@link CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_MAX_PAGES} logs
 *   `…sweep_capped` at error.
 * - **Side effects:** jobs on the token-check queue; no row is changed.
 * - **Notes:** a repeatable job on the token-check queue (`scheduler.ts`), run by the token-check
 *   worker; it never reads the token table (MC9). `now` is injectable for tests.
 */
export async function runChannelConnectionTokenCheckSweep(
  options: { now?: Date } = {},
): Promise<ChannelConnectionTokenCheckSweepResult> {
  const sweptAt = options.now ?? new Date();
  const dueBefore = new Date(sweptAt.getTime() - CHANNEL_CONNECTION_TOKEN_CHECK_INTERVAL_MS);
  let afterId = 0;
  let listedCount = 0;
  let addedCount = 0;
  for (let page = 0; page < CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_MAX_PAGES; page += 1) {
    const cursor = afterId;
    const candidates = await runGlobalRetentionWorkerJob((databaseHandle) =>
      createRetentionChannelConnectionRepository(databaseHandle).listDueForTokenCheck({
        dueBefore,
        afterId: cursor,
        limit: CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_PAGE_SIZE,
      }),
    );
    listedCount += candidates.length;
    const lastCandidate = candidates.at(-1);
    if (lastCandidate !== undefined) {
      afterId = lastCandidate.id;
      try {
        addedCount += await enqueueChannelConnectionTokenChecks({
          targets: candidates.map(({ organizationPublicId, channelConnectionPublicId }) => ({
            organizationPublicId,
            channelConnectionPublicId,
          })),
          sweptAt,
        });
      } catch (error) {
        logger.warn(
          { error, pageSize: candidates.length },
          'app.channel_connection.token_check.enqueue_failed',
        );
      }
    }
    if (candidates.length < CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_PAGE_SIZE) {
      const result = { listedCount, addedCount, capped: false };
      logger.info(result, 'app.channel_connection.token_check.sweep_completed');
      return result;
    }
  }
  const result = { listedCount, addedCount, capped: true };
  logger.error(result, 'app.channel_connection.token_check.sweep_capped');
  return result;
}
