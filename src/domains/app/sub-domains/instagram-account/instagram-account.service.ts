import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  CircuitBreakerOpenError,
  INSTAGRAM_CIRCUIT_RESET_TIMEOUT_MS,
} from '@/infrastructure/resilience/circuit-breaker.js';
import {
  type InstagramAccountProfile,
  exchangeInstagramAuthorizationCode,
  exchangeInstagramLongLivedAccessToken,
  readInstagramAccountProfile,
  subscribeInstagramWebhookFields,
  unsubscribeInstagramWebhookFields,
} from '@/infrastructure/social/instagram.client.js';
import {
  InstagramApiError,
  buildInstagramMalformedAnswerError,
} from '@/infrastructure/social/instagram-error.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  assertTeamOrganization,
  assertTeamOrganizationForRead,
} from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableEntityError,
} from '@/shared/errors/index.js';
import { MILLISECONDS_PER_SECOND } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  getPostgresConstraintName,
  isPostgresUniqueViolation,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import type { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import { serializeInstagramAccountSettings } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.serializer.js';
import type { InstagramAccountSettingsRow } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import {
  INSTAGRAM_ACCOUNT_REQUIRED_SCOPES,
  INSTAGRAM_ACCOUNT_UNIQUE_INDEXES,
  INSTAGRAM_PROFESSIONAL_ACCOUNT_TYPES,
  type InstagramAccountBrokenConnectionStatus,
} from './instagram-account.constants.js';
import type {
  InstagramAccountKey,
  InstagramAccountRepository,
  InstagramAccountRow,
} from './instagram-account.repository.js';
import type { InstagramAccountTokenService } from './instagram-account-token.service.js';
import {
  serializeInstagramAccount,
  serializeInstagramConnectResult,
} from './instagram-account.serializer.js';
import type {
  InstagramAccountConnectInput,
  InstagramAccountDisconnectInput,
  InstagramAccountOutput,
  InstagramConnectResultOutput,
} from './instagram-account.types.js';

/** What the Instagram half of a connect (IA12 step 1) hands to the database half. */
interface InstagramConnection {
  profile: InstagramAccountProfile;
  /** The long-lived token, encrypted by the client (IA5). */
  encryptedAccessToken: string;
  expiresAt: Date;
  grantedPermissions: string[];
}

/** `Retry-After` (seconds) for an Instagram outage that named no wait: the circuit's reset window. */
const INSTAGRAM_OUTAGE_RETRY_AFTER_SECONDS = Math.ceil(
  INSTAGRAM_CIRCUIT_RESET_TIMEOUT_MS / MILLISECONDS_PER_SECOND,
);

/** `404 instagram_not_connected` — no account that is not revoked (routes 2, 4; IA13, IA14). */
function instagramNotConnectedError(): NotFoundError {
  return new NotFoundError('Instagram account').withReason('instagram_not_connected');
}

/**
 * `503 instagram_unavailable` with `Retry-After`: Instagram's own wait when it named one (a throttle,
 * an open circuit), else the circuit's reset window (IA4, IA10).
 */
function instagramUnavailableError(retryAfterSeconds: number | undefined): ServiceUnavailableError {
  return new ServiceUnavailableError('errors:instagramUnavailable')
    .withReason('instagram_unavailable')
    .withRetryAfter(retryAfterSeconds ?? INSTAGRAM_OUTAGE_RETRY_AFTER_SECONDS);
}

/**
 * A connect's Instagram failure as its route error (1.A.9): Instagram refusing the code or the
 * token it just issued → `422 instagram_code_invalid` (the same code never passes again — the
 * person restarts "Connect Instagram"); Instagram down, throttling or its circuit open →
 * `503 instagram_unavailable`. Anything else (our own failure, `instagram_not_configured`) passes
 * unchanged.
 */
function toConnectRouteError(error: unknown): unknown {
  if (error instanceof CircuitBreakerOpenError) {
    return instagramUnavailableError(
      Math.max(1, Math.ceil(error.retryAfterMs / MILLISECONDS_PER_SECOND)),
    );
  }
  if (!(error instanceof InstagramApiError)) return error;
  if (error.errorClass === 'refused' || error.errorClass === 'auth') {
    return new UnprocessableEntityError('errors:instagramCodeInvalid').withReason(
      'instagram_code_invalid',
    );
  }
  return instagramUnavailableError(error.retryAfterSeconds);
}

/**
 * The connect's unique-index race (IA12 step 4) as its `409`: another not-revoked account landed in
 * this organization, or this Instagram account went live in another one, between the checks and the
 * write. Anything else passes unchanged.
 */
function toConnectRaceError(error: unknown): unknown {
  if (!isPostgresUniqueViolation(error)) return error;
  const constraintName = getPostgresConstraintName(error);
  if (constraintName === INSTAGRAM_ACCOUNT_UNIQUE_INDEXES.organizationLive) {
    return organizationAlreadyHasAccountError();
  }
  if (constraintName === INSTAGRAM_ACCOUNT_UNIQUE_INDEXES.instagramUserLive) {
    return connectedElsewhereError();
  }
  return error;
}

/** `409 organization_already_has_instagram_account` (D5). */
function organizationAlreadyHasAccountError(): ConflictError {
  return new ConflictError('errors:organizationAlreadyHasInstagramAccount').withReason(
    'organization_already_has_instagram_account',
  );
}

/** `409 instagram_account_connected_elsewhere`. */
function connectedElsewhereError(): ConflictError {
  return new ConflictError('errors:instagramAccountConnectedElsewhere').withReason(
    'instagram_account_connected_elsewhere',
  );
}

/** What a failed Instagram call may say in a log line — its class and codes, never its text. */
function describeInstagramFailure(error: unknown): Record<string, unknown> {
  if (error instanceof InstagramApiError) {
    return {
      errorClass: error.errorClass,
      instagramErrorCode: error.instagramErrorCode,
      instagramErrorSubcode: error.instagramErrorSubcode,
      fbtraceId: error.fbtraceId,
    };
  }
  return { errorName: error instanceof Error ? error.name : typeof error };
}

/**
 * The Instagram account service (routes-final § 1.A): connect (route 1, IA12), read (route 2,
 * IA13), disconnect (route 4, IA14), and the one guarded status change every later caller uses
 * (IA9).
 *
 * @remarks
 * Algorithm:
 * - Every route works in three steps (1.10): read in the caller's organization scope, close that
 *   unit of work, call Instagram, then write in one new unit of work — never an Instagram call
 *   inside a database context (`rls-context-network-isolation.global.test.ts`).
 * - Team-only (K1, IA3): the writes refuse a personal organization with `422`
 *   (`assertTeamOrganization`, capability `INSTAGRAM`) and the read with
 *   `404 team_organization_required` (`assertTeamOrganizationForRead`) — the second line behind the
 *   permission gate, since a personal Owner never holds the codes.
 *
 * Failure modes:
 * - `404 instagram_not_connected` (read, disconnect); the connect's `422`
 *   (`instagram_code_invalid`, `instagram_account_not_professional`, `instagram_scopes_missing`),
 *   `409` (`organization_already_has_instagram_account`, `instagram_account_connected_elsewhere`)
 *   and `503` (`instagram_unavailable`, `instagram_not_configured`) — 1.A.9. Nothing is stored when
 *   a connect fails before its transaction.
 *
 * Side effects:
 * - Writes the account, its token (through {@link InstagramAccountTokenService}) and its default
 *   settings (through {@link InstagramAccountSettingsService}); calls Instagram (exchanges, `/me`,
 *   `subscribed_apps`). The audit entries are the controller's, after commit (D36).
 *
 * Notes:
 * - The token stays ciphertext here: the client takes and returns it encrypted (IA5).
 * - A disconnect cancels no automation run (IQ1, D24).
 */
export class InstagramAccountService {
  constructor(
    private readonly accountRepository: InstagramAccountRepository,
    private readonly tokenService: InstagramAccountTokenService,
    private readonly settingsService: InstagramAccountSettingsService,
    private readonly organizationService: OrganizationService,
  ) {}

  /**
   * Finishes "Connect Instagram" (route 1, IA12): swaps the code for a long-lived token, reads the
   * profile, refuses what may not connect, then writes the account, its default settings and its
   * token in one transaction, and subscribes the account to the webhook fields. The audit entry is
   * the controller's, after commit (D36).
   *
   * @remarks
   * Algorithm:
   * 1. Organization scope: the organization must be a team (`422`); resolve the connecting user.
   * 2. Instagram, outside any context: the code exchange, the long-lived exchange, `/me`.
   * 3. Refuse a personal Instagram account and a missing permission (`422`).
   * 4. The resolver (IA6): another organization holds this account live → `409`.
   * 5. One transaction: this organization has another live account → `409`; upsert the account
   *    (a reconnect reuses its row, revoked included); default settings when it has none; the
   *    encrypted token. A unique-index race → the matching `409`.
   * 6. After commit, when `webhook_subscribed_at` is empty: `subscribed_apps`; success stamps it,
   *    a failure is logged (`app.instagram_account.webhook_subscription_failed`) and never fails
   *    the connect — the next connect or the daily check retries.
   *
   * Failure modes: as the class lists for route 1; nothing is stored when steps 1–4 fail.
   * Side effects: the transaction of step 5; Instagram calls; one log line on a failed subscription.
   */
  async connect({
    scope,
    code,
    connectedByUserPublicId,
    requestId,
  }: InstagramAccountConnectInput): Promise<InstagramConnectResultOutput> {
    const { organizationId, connectedByUserId } = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const connectedByUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(connectedByUserPublicId);
        return { organizationId: organization.id, connectedByUserId };
      },
    });

    const connection = await this.readInstagramConnection({ code, requestId });
    this.assertConnectable(connection);
    const { profile } = connection;

    const holderOrganizationPublicId =
      await this.accountRepository.resolveOrganizationPublicIdForInstagramUser(
        profile.instagramUserId,
      );
    if (
      holderOrganizationPublicId !== null &&
      holderOrganizationPublicId !== scope.organizationPublicId
    ) {
      throw connectedElsewhereError();
    }

    const { account, settings, isNewConnection } = await this.writeConnection({
      scope,
      organizationId,
      connectedByUserId,
      connection,
    });

    const subscribedAccount = await this.subscribeWebhookFieldsBestEffort({
      scope,
      account,
      encryptedAccessToken: connection.encryptedAccessToken,
      requestId,
    });

    const instagramAccount = await this.serialize({
      account: subscribedAccount,
      settings,
    });
    return serializeInstagramConnectResult({
      is_new_connection: isNewConnection,
      instagram_account: instagramAccount,
    });
  }

  /**
   * The organization's not-revoked account with its settings (route 2, IA13) — `expired` and
   * `error` included, so a reload shows the reconnect card.
   *
   * @remarks
   * Algorithm: one unit of work — the team check (`404 team_organization_required` on a personal
   * organization), the live account, its settings, the two users' public ids. Failure modes:
   * `404 instagram_not_connected` when the organization has none (or only revoked rows). Side
   * effects: none — the database only, never Instagram; the token is never read.
   */
  async getAccount({
    scope,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
  }): Promise<InstagramAccountOutput> {
    const { account, settings } = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const account = await this.accountRepository.findLiveByOrganizationId(organization.id);
        if (account === null) throw instagramNotConnectedError();
        const settings = await this.settingsService.findSettings({
          scope,
          instagramAccount: { organizationId: organization.id, instagramAccountId: account.id },
        });
        return { account, settings };
      },
    });
    return this.serialize({ account, settings });
  }

  /**
   * Disconnects the organization's account (route 4, IA14): a best-effort unsubscribe, then one
   * transaction — `revoked`, `disconnected_at`, the token erased, the expiry copy and the webhook
   * stamp emptied. Settings and profile stay; no run is cancelled (IQ1). Returns the revoked
   * account's public id for the caller's audit entry.
   *
   * @remarks
   * Algorithm:
   * 1. Organization scope: the team check (`422`), the live account (`404 instagram_not_connected`)
   *    and its encrypted token.
   * 2. Outside any context, when a token is there: `DELETE subscribed_apps`; a failure is logged
   *    (`app.instagram_account.webhook_unsubscription_failed`) and never blocks.
   * 3. One transaction: revoke (a concurrent disconnect that won → `404 instagram_not_connected`),
   *    erase the token.
   *
   * Failure modes: as above. Side effects: the transaction of step 3; one Instagram call. The
   * audit entry is the controller's, after commit (the repository's audit-emission pattern).
   */
  async disconnect({
    scope,
    requestId,
  }: InstagramAccountDisconnectInput): Promise<{ instagramAccountPublicId: string }> {
    const { account, key, encryptedAccessToken } = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const account = await this.accountRepository.findLiveByOrganizationId(organization.id);
        if (account === null) throw instagramNotConnectedError();
        const key: InstagramAccountKey = {
          organizationId: organization.id,
          instagramAccountId: account.id,
        };
        const token = await this.tokenService.findAccessToken({ scope, instagramAccount: key });
        return { account, key, encryptedAccessToken: token?.encryptedAccessToken ?? null };
      },
    });

    if (encryptedAccessToken !== null) {
      try {
        await unsubscribeInstagramWebhookFields({
          encryptedAccessToken,
          instagramAppUserId: account.instagram_app_user_id,
          requestId,
        });
      } catch (error) {
        logger.warn(
          {
            requestId,
            organizationPublicId: scope.organizationPublicId,
            instagramAccountPublicId: account.public_id,
            ...describeInstagramFailure(error),
          },
          'app.instagram_account.webhook_unsubscription_failed',
        );
      }
    }

    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const revoked = await this.accountRepository.revoke(key);
        if (revoked === null) throw instagramNotConnectedError();
        await this.tokenService.eraseAccessToken({ scope, instagramAccount: key });
        return { instagramAccountPublicId: revoked.public_id };
      },
    });
  }

  /**
   * The one guarded way an account leaves `connected` (IA9): `connected` → `expired` | `error`,
   * stamping `connection_status_changed_at` — for routes 5–6, the daily check and sub-domains 3–4
   * on an Instagram token error.
   *
   * @remarks
   * Algorithm: one guarded update in the caller's organization scope. Failure modes: none of its
   * own — returns `null` when the account was not `connected` any more (another caller won the
   * race, or it was revoked), so only the winner acts on the break. Side effects: the status
   * change only; the reconnect notice that the winner enqueues after commit is R7's.
   */
  async markConnectionBroken({
    scope,
    instagramAccount,
    connectionStatus,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramAccount: InstagramAccountKey;
    connectionStatus: InstagramAccountBrokenConnectionStatus;
  }): Promise<InstagramAccountRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.accountRepository.markConnectionBroken({ ...instagramAccount, connectionStatus }),
    });
  }

  /** IA12 step 1 — the three Instagram calls, outside any database context, mapped to 1.A.9. */
  private async readInstagramConnection({
    code,
    requestId,
  }: {
    code: string;
    requestId: string;
  }): Promise<InstagramConnection> {
    try {
      const shortLivedToken = await exchangeInstagramAuthorizationCode({ code, requestId });
      const longLivedToken = await exchangeInstagramLongLivedAccessToken({
        encryptedShortLivedAccessToken: shortLivedToken.encryptedAccessToken,
        requestId,
      });
      const profile = await readInstagramAccountProfile({
        encryptedAccessToken: longLivedToken.encryptedAccessToken,
        requestId,
      });
      if (profile.username === null) {
        // A professional account always has one; an answer without it is Instagram misbehaving.
        throw buildInstagramMalformedAnswerError({ operation: '/me', missing: 'username' });
      }
      return {
        profile,
        encryptedAccessToken: longLivedToken.encryptedAccessToken,
        expiresAt: longLivedToken.expiresAt,
        grantedPermissions: shortLivedToken.grantedPermissions,
      };
    } catch (error) {
      throw toConnectRouteError(error);
    }
  }

  /** IA12 step 2 — a personal Instagram account, then a missing permission, each a `422`. */
  private assertConnectable({ profile, grantedPermissions }: InstagramConnection): void {
    const professionalTypes: readonly string[] = INSTAGRAM_PROFESSIONAL_ACCOUNT_TYPES;
    if (profile.accountType === null || !professionalTypes.includes(profile.accountType)) {
      throw new UnprocessableEntityError('errors:instagramAccountNotProfessional').withReason(
        'instagram_account_not_professional',
      );
    }
    const granted = new Set(grantedPermissions);
    if (INSTAGRAM_ACCOUNT_REQUIRED_SCOPES.some((scope) => !granted.has(scope))) {
      throw new UnprocessableEntityError('errors:instagramScopesMissing').withReason(
        'instagram_scopes_missing',
      );
    }
  }

  /** IA12 step 4 — the one connect transaction; a unique-index race becomes its `409`. */
  private async writeConnection({
    scope,
    organizationId,
    connectedByUserId,
    connection,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    connectedByUserId: number | null;
    connection: InstagramConnection;
  }): Promise<{
    account: InstagramAccountRow;
    settings: InstagramAccountSettingsRow;
    isNewConnection: boolean;
  }> {
    const { profile } = connection;
    try {
      return await withAppDatabaseContext({
        scope,
        callback: async () => {
          const live = await this.accountRepository.findLiveByOrganizationId(organizationId);
          if (live !== null && live.instagram_user_id !== profile.instagramUserId) {
            throw organizationAlreadyHasAccountError();
          }
          const { account, isNewConnection } = await this.accountRepository.upsertConnected({
            organizationId,
            instagramUserId: profile.instagramUserId,
            instagramAppUserId: profile.instagramAppUserId,
            username: profile.username as string,
            name: profile.name,
            biography: profile.biography,
            website: profile.website,
            profilePictureUrl: profile.profilePictureUrl,
            followersCount: profile.followersCount ?? 0,
            followsCount: profile.followsCount ?? 0,
            mediaCount: profile.mediaCount ?? 0,
            scopes: [...new Set(connection.grantedPermissions)],
            tokenExpiresAt: connection.expiresAt,
            connectedByUserId,
          });
          const key: InstagramAccountKey = { organizationId, instagramAccountId: account.id };
          const settings = await this.settingsService.createDefaultSettings({
            scope,
            instagramAccount: key,
          });
          await this.tokenService.storeAccessToken({
            scope,
            instagramAccount: key,
            encryptedAccessToken: connection.encryptedAccessToken,
            expiresAt: connection.expiresAt,
          });
          return { account, settings, isNewConnection };
        },
      });
    } catch (error) {
      throw toConnectRaceError(error);
    }
  }

  /**
   * IA12 step 5 — `subscribed_apps` after commit when the account is not subscribed yet; returns
   * the account as it now stands. Never throws: a failure is logged and the connect stands.
   */
  private async subscribeWebhookFieldsBestEffort({
    scope,
    account,
    encryptedAccessToken,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    account: InstagramAccountRow;
    encryptedAccessToken: string;
    requestId: string;
  }): Promise<InstagramAccountRow> {
    if (account.webhook_subscribed_at !== null) return account;
    try {
      await subscribeInstagramWebhookFields({
        encryptedAccessToken,
        instagramAppUserId: account.instagram_app_user_id,
        requestId,
      });
      const key: InstagramAccountKey = {
        organizationId: account.organization_id,
        instagramAccountId: account.id,
      };
      const stamped = await withAppDatabaseContext({
        scope,
        callback: async () => {
          const recorded = await this.accountRepository.recordWebhookSubscribed(key);
          return recorded ? this.accountRepository.findById(key) : null;
        },
      });
      return stamped ?? account;
    } catch (error) {
      logger.warn(
        {
          requestId,
          organizationPublicId: scope.organizationPublicId,
          instagramAccountPublicId: account.public_id,
          ...describeInstagramFailure(error),
        },
        'app.instagram_account.webhook_subscription_failed',
      );
      return account;
    }
  }

  /**
   * The account object: the settings and the two users resolved to their `usr_…` public ids (one
   * resolver call), then the serializers.
   */
  private async serialize({
    account,
    settings,
  }: {
    account: InstagramAccountRow;
    settings: InstagramAccountSettingsRow | null;
  }): Promise<InstagramAccountOutput> {
    if (settings === null) {
      // The connect transaction always writes the settings row with the account (1.B.10).
      throw new Error('instagram account has no settings row');
    }
    const userInternalIds = [account.connected_by_user_id, settings.updated_by_user_id].filter(
      (identifier): identifier is number => identifier !== null,
    );
    const userPublicIds =
      await this.organizationService.resolveUserPublicIdsByInternalIds(userInternalIds);
    const publicIdOf = (identifier: number | null): string | null =>
      identifier === null ? null : (userPublicIds.get(identifier) ?? null);
    return serializeInstagramAccount({
      account,
      settings: serializeInstagramAccountSettings({
        settings,
        updated_by_user_public_id: publicIdOf(settings.updated_by_user_id),
      }),
      connected_by_user_public_id: publicIdOf(account.connected_by_user_id),
    });
  }
}
