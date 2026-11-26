import type { Redis } from 'ioredis';
import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { buildPlanRefusal } from '@/domains/billing/sub-domains/entitlement/entitlement-refusal.util.js';
import {
  type ChannelAccountEntitlementService,
  readChannelAccountsMax,
  readEntitlementSnapshot,
} from '@/domains/app/sub-domains/channel-account/channel-account-entitlement.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  assertTeamOrganization,
  assertTeamOrganizationForRead,
} from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import {
  type InstagramAccountProfile,
  type MetaAssignedInstagramAccount,
  type MetaConnectionReadOptions,
  listMetaAdAccountAds,
  listMetaAdAccounts,
  listMetaAssignedInstagramAccounts,
  readInstagramAccountProfile,
  readMetaAppSettings,
  readMetaPageConfigId,
  readMetaClientBusinessId,
  readMetaGrantedPermissions,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { describeMetaGraphError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import {
  buildMetaLoginUrl,
  exchangeMetaLoginCode,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-login.js';
import {
  CONNECT_STATE_MINUTES,
  PROFILE_READ_TIMEOUT_MILLISECONDS,
} from '@/shared/constants/instagram.constants.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  getPostgresConstraintName,
  isPostgresUniqueViolation,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import { CHANNEL_ACCOUNT_UNIQUE_INDEXES } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import { instagramReconnectRequiredError } from '@/domains/app/sub-domains/instagram-account/instagram-account-error.util.js';
import {
  CHANNEL_CONNECTION_AD_ACCESS,
  CHANNEL_CONNECTION_STATUS,
  META_ADS_PERMISSION,
  META_REQUIRED_PERMISSIONS,
} from './channel-connection.constants.js';
import {
  adAccountNotFoundError,
  channelAccountConnectedElsewhereError,
  channelConnectionBusinessMismatchError,
  channelConnectionNotConnectedError,
  channelConnectionNotFoundError,
  instagramPageLoginNotConfiguredError,
  providerPermissionsMissingError,
  isMetaAdPermissionMissing,
  isMetaTokenRefused,
  toChannelConnectRouteError,
  toChannelConnectionAdReadError,
  toChannelConnectionReadError,
} from './channel-connection-error.util.js';
import type {
  ChannelConnectionKey,
  ChannelConnectionRepository,
  ChannelConnectionRow,
} from './channel-connection.repository.js';
import {
  type ChannelConnectionProvider,
  consumeChannelConnectState,
  mintChannelConnectState,
} from './channel-connection-state.js';
import type { ChannelConnectionTokenService } from './channel-connection-token.service.js';
import type { ChannelConnectionUsageService } from './channel-connection-usage.service.js';
import {
  serializeChannelAccountPlanRoom,
  serializeChannelConnection,
  serializeChannelConnectionAccount,
  serializeMetaAd,
  serializeMetaAdAccount,
} from './channel-connection.serializer.js';
import type {
  ChannelAccountPickItemOutput,
  ChannelAccountPickResultOutput,
  ChannelConnectAccountOutput,
  ChannelConnectionAdAccountList,
  ChannelConnectionAdPage,
  ChannelConnectResultOutput,
  ChannelConnectStartOutput,
  ChannelConnectionAccount,
  ChannelConnectionAccountPort,
  ChannelConnectionLanePort,
  ChannelConnectionOutput,
  ChannelConnectionTrialPort,
} from './channel-connection.types.js';

/**
 * The caller of a channel connection route: its organization scope and user.
 *
 * @remarks
 * Notes: the scope is the verified `org` claim; the user public id is empty for an API key.
 */
export interface ChannelConnectionCaller {
  scope: OrganizationPrincipalDatabaseScope;
  /** `usr_…` of the signed-in user. */
  userPublicId: string;
  /** The request id, sent to Meta as `X-Request-Id`. */
  requestId: string;
}

/**
 * What "Disconnect business" did, for the controller's audit entry (MC12).
 *
 * @remarks
 * Notes: public ids and a count only — never a token.
 */
export interface ChannelConnectionDisconnectResult {
  channelConnectionPublicId: string;
  disconnectedAccountCount: number;
}

/**
 * What a callback did, for the controller's audit entry (MC12).
 *
 * @remarks
 * Notes: `data` is the route's answer; the audit reads its connection id and counts.
 */
export interface ChannelConnectResult {
  data: ChannelConnectResultOutput;
}

/**
 * What a pick did, for the controller's audit entries (MC12).
 *
 * @remarks
 * Notes: `connectedAccountPublicIds` lists only the accounts this pick connected now.
 */
export interface ChannelAccountPickResult {
  data: ChannelAccountPickResultOutput;
  /** The accounts this pick connected now (one `app.channel_account.connect` entry each). */
  connectedAccountPublicIds: string[];
}

/** What the ad picker's Meta reads need (routes 15 and 41): the connection and its encrypted token. */
interface AdPickerAccess {
  organizationId: number;
  connection: ChannelConnectionRow;
  encryptedAccessToken: string;
}

/** The organization, its internal id and the caller's internal id. */
interface CallerOrganization {
  organizationId: number;
  userId: number | null;
}

/** A Meta read that may take at most `milliseconds`; `null` when it failed or ran out (fails open). */
async function readWithinTime<TResult>({
  read,
  milliseconds,
}: {
  read: () => Promise<TResult>;
  milliseconds: number;
}): Promise<TResult | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A pick racing another organization for the same account → `409` (MC7); anything else unchanged. */
function toPickRaceError(error: unknown): unknown {
  if (
    isPostgresUniqueViolation(error) &&
    getPostgresConstraintName(error) === CHANNEL_ACCOUNT_UNIQUE_INDEXES.providerAccountLive
  ) {
    return channelAccountConnectedElsewhereError();
  }
  return error;
}

/**
 * The channel connection service (routes-final § 1 — routes 1–5, 15, 40–42): starts a provider
 * login and a reconnect, finishes it into one connection per business with its token and reconnects
 * the business's accounts, picks accounts under the plan's limit, lists and reads connections,
 * disconnects a business, reads the ad picker (its ad accounts, then one ad account's ads) and breaks
 * a connection whose token Meta refuses (MC11).
 *
 * @remarks
 * Algorithm:
 * - Every route works in three steps (1.10): read in the caller's organization scope, close that
 *   unit of work, call Meta, then write in one new unit of work — never a Meta call inside a
 *   database context (`rls-context-network-isolation.global.test.ts`).
 * - Team-only (K1): writes refuse a personal organization with `422` (`assertTeamOrganization`,
 *   capability `INSTAGRAM`), reads with `404 team_organization_required`; the permission gate
 *   (`channel-account:*`, P59) answers first.
 * - The accounts are written through {@link ChannelConnectionAccountPort} (1B and 2), the lanes
 *   through {@link ChannelConnectionLanePort} (6, ROUTE row R18) and a trial pick through
 *   {@link ChannelConnectionTrialPort} (8, ROUTE row R24) — both ports optional until their row.
 *
 * Failure modes:
 * - 1.9: `400 channel_connect_state_invalid`, `422 provider_code_invalid` /
 *   `provider_permissions_missing`, `409 instagram_connect_restart_required` /
 *   `channel_connection_business_mismatch` / `plan_account_limit` /
 *   `channel_connection_not_connected` / `instagram_account_connected_elsewhere` (a pick race),
 *   `404 channel_connection_not_found`, `503 instagram_unavailable` / `instagram_not_configured`.
 *   Nothing is saved when a step before the commit fails, and nothing stays when the commit fails.
 *
 * Side effects:
 * - Writes the connection, its token and its accounts; Redis (the one-use login state); Meta calls.
 *   Audit entries are the controller's, after commit (D36).
 *
 * Notes:
 * - The token stays ciphertext here: the Meta client takes and returns it encrypted (MC9).
 * - Every Meta call made with a stored connection's token hands its usage headers to the
 *   connection's recorder (MC19); the callback's reads run before the connection exists and keep none.
 */
export class ChannelConnectionService {
  constructor(
    private readonly connectionRepository: ChannelConnectionRepository,
    private readonly tokenService: ChannelConnectionTokenService,
    private readonly usageService: ChannelConnectionUsageService,
    private readonly accountPort: ChannelConnectionAccountPort,
    private readonly organizationService: OrganizationService,
    private readonly entitlementService: ChannelAccountEntitlementService,
    private readonly redis: Redis,
    private readonly lanePort?: ChannelConnectionLanePort | undefined,
    private readonly trialPort?: ChannelConnectionTrialPort | undefined,
  ) {}

  /**
   * Route 1 (MC4): mints the one-use login state and answers Meta's Unified Login address.
   *
   * @remarks
   * Algorithm: the team check; the Meta settings (503 when unset) and the login configuration —
   * `META_PAGE_CONFIG_ID` when `withPage` (P358), else `META_CONFIG_ID` — before any state is
   * stored; the state for this organization and user, then the address. Failure modes: `422`
   * personal organization; `503 instagram_not_configured`; `400 instagram_page_login_not_configured`
   * (`withPage` while the second configuration is unset). Side effects: one Redis key (10 minutes).
   */
  async startLogin({
    scope,
    userPublicId,
    provider,
    withPage = false,
  }: Omit<ChannelConnectionCaller, 'requestId'> & {
    provider: ChannelConnectionProvider;
    /** Ask for the account's linked Facebook Page too (the second configuration, P358). */
    withPage?: boolean | undefined;
  }): Promise<ChannelConnectStartOutput> {
    await this.requireWritableOrganization(scope);
    return this.mintLogin({
      scope,
      userPublicId,
      provider,
      channelConnectionPublicId: null,
      withPage,
    });
  }

  /**
   * Route 40 (MC17): a login bound to this connection — the same state with its public id.
   *
   * @remarks
   * Algorithm: the team check; the connection (`connected` or `error`); the state and address —
   * with the second login configuration when `withPage` (P358: the reconnect that shares the linked
   * Facebook Page). Failure modes: `404 channel_connection_not_found` (not this organization's, or
   * revoked); `503 instagram_not_configured`; `400 instagram_page_login_not_configured`. Side
   * effects: one Redis key.
   */
  async startReconnect({
    scope,
    userPublicId,
    channelConnectionPublicId,
    withPage = false,
  }: Omit<ChannelConnectionCaller, 'requestId'> & {
    channelConnectionPublicId: string;
    /** Ask for the account's linked Facebook Page too (the second configuration, P358). */
    withPage?: boolean | undefined;
  }): Promise<ChannelConnectStartOutput> {
    const connection = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const { organizationId } = await this.requireWritableOrganization(scope);
        return this.connectionRepository.findByPublicId({
          organizationId,
          channelConnectionPublicId,
        });
      },
    });
    if (connection === null || connection.status === CHANNEL_CONNECTION_STATUS.REVOKED) {
      throw channelConnectionNotFoundError();
    }
    return this.mintLogin({
      scope,
      userPublicId,
      provider: connection.provider as ChannelConnectionProvider,
      channelConnectionPublicId: connection.public_id,
      withPage,
    });
  }

  /**
   * Route 2 (MC5, MC6): finishes the login — or a reconnect — and answers the picker.
   *
   * @remarks
   * Algorithm: (1) read-and-delete the state (400 when it is not this caller's); (2) the code
   * exchange; (3) the business id, the assigned accounts and the granted permissions — a state of
   * route 40 for another business → 409; (4) a missing required permission → 422; (5) outside the
   * transaction, which assigned account is live in another organization and the plan's limit; (6)
   * one commit: the connection upserted `connected` with its scopes and the state's `config_id`
   * (P356), its token with its end (`expires_at` from Meta's `expires_in`, P355), every not-revoked
   * account of the organization in the assigned list attached and `connected` (their login stops
   * end — R18), a connection left with no account by a move revoked with its token; (7) after
   * commit, each reconnected account subscribed to the webhook fields (best effort; the account
   * set-up job at R40).
   * Failure modes: 1.9 for route 2; nothing is saved before step 6.
   * Side effects: the commit of step 6; Meta calls; Redis (the state is spent).
   */
  async finishLogin({
    scope,
    userPublicId,
    requestId,
    provider,
    code,
    state,
  }: ChannelConnectionCaller & {
    provider: ChannelConnectionProvider;
    code: string;
    state: string;
  }): Promise<ChannelConnectResult> {
    const caller = await this.requireWritableCaller({ scope, userPublicId });
    const payload = await consumeChannelConnectState({
      redis: this.redis,
      state,
      provider,
      organizationPublicId: scope.organizationPublicId,
      userPublicId,
    });
    const boundConnection =
      payload.channel_connection_public_id === null
        ? null
        : await this.findConnection({
            scope,
            organizationId: caller.organizationId,
            channelConnectionPublicId: payload.channel_connection_public_id,
          });
    if (
      payload.channel_connection_public_id !== null &&
      (boundConnection === null || boundConnection.status === CHANNEL_CONNECTION_STATUS.REVOKED)
    ) {
      throw channelConnectionNotFoundError();
    }

    const login = await this.readLogin({ code, requestId });
    if (boundConnection !== null && boundConnection.client_business_id !== login.clientBusinessId) {
      throw channelConnectionBusinessMismatchError();
    }
    const granted = new Set(login.grantedPermissions);
    if (META_REQUIRED_PERMISSIONS.some((permission) => !granted.has(permission))) {
      this.logFailedConnect({ requestId, step: 'permissions' });
      throw providerPermissionsMissingError();
    }
    const elsewhere = await this.findAccountsLiveElsewhere({
      scope,
      providerAccountIds: login.assignedAccounts.map((account) => account.instagramUserId),
    });
    const accountsMax = await this.readAccountsMax(scope);

    const committed = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const { connection, isReconnect } = await this.connectionRepository.upsertConnected({
          organizationId: caller.organizationId,
          provider,
          clientBusinessId: login.clientBusinessId,
          // P356: the configuration the login address carried, kept in its one-use state.
          configId: payload.config_id,
          scopes: [...new Set(login.grantedPermissions)].slice(0, 20),
          connectedByUserId: caller.userId,
        });
        const channelConnection = {
          organizationId: caller.organizationId,
          channelConnectionId: connection.id,
        };
        await this.tokenService.storeAccessToken({
          scope,
          channelConnection,
          token: {
            encryptedAccessToken: login.encryptedAccessToken,
            encryptedRefreshToken: null,
            tokenType: 'system_user',
            // P355: whether it ends depends on the login configuration — Meta's `expires_in`.
            expiresAt: login.tokenExpiresAt,
          },
        });
        const reconnected = await this.accountPort.reconnectAccounts({
          scope,
          organizationId: caller.organizationId,
          channelConnectionId: connection.id,
          providerAccountIds: login.assignedAccounts.map((account) => account.instagramUserId),
        });
        for (const { account } of reconnected) {
          await this.lanePort?.endLoginStops({
            scope,
            organizationId: caller.organizationId,
            channelAccountId: account.internalId,
          });
        }
        await this.releaseMovedFromConnections({
          scope,
          organizationId: caller.organizationId,
          previousChannelConnectionIds: reconnected
            .map(({ previousChannelConnectionId }) => previousChannelConnectionId)
            .filter((identifier) => identifier !== connection.id),
        });
        const here = await this.accountPort.findAccountsByProviderIds({
          scope,
          organizationId: caller.organizationId,
          providerAccountIds: login.assignedAccounts.map((account) => account.instagramUserId),
        });
        const accountsUsed = await this.accountPort.countLiveAccounts({
          scope,
          organizationId: caller.organizationId,
        });
        const output = await this.toConnectionOutput({
          scope,
          organizationId: caller.organizationId,
          connection,
        });
        return { connection, isReconnect, reconnected, here, accountsUsed, output };
      },
    });

    await this.accountPort.startAccountSetups({
      scope,
      accounts: committed.reconnected.map(({ account }) => account),
    });

    return {
      data: {
        is_reconnect: committed.isReconnect,
        channel_connection: committed.output,
        accounts: login.assignedAccounts.map((assigned) =>
          this.toConnectAccount({ assigned, here: committed.here, elsewhere }),
        ),
        reconnected_account_ids: committed.reconnected.map(({ account }) => account.publicId),
        plan_room: serializeChannelAccountPlanRoom({
          accounts_max: accountsMax,
          accounts_used: committed.accountsUsed,
        }),
      },
    };
  }

  /**
   * Route 3 (MC7): connects the picked accounts under the plan's limit.
   *
   * @remarks
   * Algorithm: (1) the connection (`connected`, else 409) and its token; (2) outside any unit, the
   * assigned accounts re-read from Meta (P55) — a pick not there is `not_assigned` — the account
   * live in another organization `connected_elsewhere`, and one profile read per pick (3 s, fails
   * open); the plan's limit, and during a trial the trial port; (3) one commit: the organization
   * lock, the not-revoked count, the picks over the limit → `409 plan_account_limit` (nothing
   * saved); each pick a new account with its settings — or the organization's revoked row back —
   * with its lanes (R18) and trial rows (R24); a pick already live here `already_connected`; (4)
   * after commit, each connected pick subscribed to the webhook fields (best effort).
   * Failure modes: 1.9 for route 3. Side effects: the commit of step 3; Meta calls.
   */
  async pickAccounts({
    scope,
    userPublicId,
    requestId,
    channelConnectionPublicId,
    providerAccountIds,
  }: ChannelConnectionCaller & {
    channelConnectionPublicId: string;
    providerAccountIds: readonly string[];
  }): Promise<ChannelAccountPickResult> {
    const caller = await this.requireWritableCaller({ scope, userPublicId });
    const connection = await this.findConnection({
      scope,
      organizationId: caller.organizationId,
      channelConnectionPublicId,
    });
    if (connection === null) throw channelConnectionNotFoundError();
    if (connection.status !== CHANNEL_CONNECTION_STATUS.CONNECTED) {
      throw channelConnectionNotConnectedError();
    }
    const token = await this.tokenService.findAccessToken({
      scope,
      channelConnection: {
        organizationId: caller.organizationId,
        channelConnectionId: connection.id,
      },
    });
    if (token === null) throw channelConnectionNotConnectedError();
    const recordUsage = this.usageService.buildUsageRecorder({
      scope,
      channelConnectionPublicId: connection.public_id,
    });

    let assigned: MetaAssignedInstagramAccount[];
    try {
      ({ accounts: assigned } = await listMetaAssignedInstagramAccounts({
        encryptedAccessToken: token.encryptedAccessToken,
        requestId,
        recordUsage,
      }));
    } catch (error) {
      throw toChannelConnectionReadError(error);
    }
    const assignedById = new Map(assigned.map((account) => [account.instagramUserId, account]));
    const elsewhere = await this.findAccountsLiveElsewhere({
      scope,
      providerAccountIds: providerAccountIds.filter((identifier) => assignedById.has(identifier)),
    });
    const candidates = providerAccountIds.filter(
      (identifier) => assignedById.has(identifier) && !elsewhere.has(identifier),
    );
    const profiles = new Map<string, InstagramAccountProfile | null>();
    for (const identifier of candidates) {
      profiles.set(
        identifier,
        await readWithinTime({
          read: () =>
            readInstagramAccountProfile({
              encryptedAccessToken: token.encryptedAccessToken,
              instagramUserId: identifier,
              requestId,
              recordUsage,
            }),
          milliseconds: PROFILE_READ_TIMEOUT_MILLISECONDS,
        }),
      );
    }
    // One plan read for the pick (change-plan-gates AP4, P24): the limit (Free's 1 when it reads
    // `null`, P39) and the trial end.
    const entitlement = await readEntitlementSnapshot({
      entitlementService: this.entitlementService,
      scope,
    });
    const accountsMax = readChannelAccountsMax(entitlement);
    const isTrialing = entitlement.trialEndsAt !== null && this.trialPort !== undefined;

    const committed = await this.commitPick({
      scope,
      caller,
      connection,
      candidates,
      assignedById,
      profiles,
      accountsMax,
      isTrialing,
    }).catch((error: unknown) => {
      throw toPickRaceError(error);
    });

    const connectedAccounts = [...committed.picked.values()]
      .filter(({ result }) => result === 'connected')
      .map(({ account }) => account);
    await this.accountPort.startAccountSetups({ scope, accounts: connectedAccounts });

    const results: ChannelAccountPickItemOutput[] = providerAccountIds.map((identifier) => {
      if (!assignedById.has(identifier)) {
        return { provider_account_id: identifier, result: 'not_assigned', channel_account: null };
      }
      if (elsewhere.has(identifier)) {
        return {
          provider_account_id: identifier,
          result: 'connected_elsewhere',
          channel_account: null,
        };
      }
      const picked = committed.picked.get(identifier);
      return {
        provider_account_id: identifier,
        result: picked?.result ?? 'not_assigned',
        channel_account:
          picked === undefined ? null : serializeChannelConnectionAccount(picked.account),
      };
    });
    return {
      data: {
        channel_connection_id: connection.public_id,
        results,
        plan_room: serializeChannelAccountPlanRoom({
          accounts_max: accountsMax,
          accounts_used: committed.accountsUsed,
        }),
      },
      connectedAccountPublicIds: connectedAccounts.map((account) => account.publicId),
    };
  }

  /**
   * Route 4 (MC8): the organization's connections with their accounts; revoked ones only on ask.
   *
   * @remarks
   * Algorithm: one unit — the team read check, the connections, their not-revoked accounts, the
   * connecting users' public ids. Failure modes: `404 team_organization_required`. Side effects:
   * none — the database only; never the token.
   */
  async listConnections({
    scope,
    includeRevoked,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    includeRevoked: boolean;
  }): Promise<ChannelConnectionOutput[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organizationId = await this.requireReadableOrganization(scope);
        const connections = await this.connectionRepository.listByOrganizationId({
          organizationId,
          includeRevoked,
        });
        return this.toConnectionOutputs({ scope, organizationId, connections });
      },
    });
  }

  /**
   * Route 42 (MC8): one connection as in the list, a revoked one included.
   *
   * @remarks
   * Algorithm: one unit — the team read check, the connection, its accounts. Failure modes:
   * `404 channel_connection_not_found`, `404 team_organization_required`. Side effects: none.
   */
  async getConnection({
    scope,
    channelConnectionPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelConnectionPublicId: string;
  }): Promise<ChannelConnectionOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organizationId = await this.requireReadableOrganization(scope);
        const connection = await this.connectionRepository.findByPublicId({
          organizationId,
          channelConnectionPublicId,
        });
        if (connection === null) throw channelConnectionNotFoundError();
        return this.toConnectionOutput({ scope, organizationId, connection });
      },
    });
  }

  /**
   * Route 41 (MC13, P57): the ad accounts the connection's login reaches, for the ad picker — read
   * live from Meta, never stored.
   *
   * @remarks
   * Algorithm: (1) one unit — the team read check, the connection (`connected`), and, when it holds
   * `ads_read`, its token; (2) outside any unit, `GET /me/adaccounts` (Meta's first 100, no paging)
   * with the connection's usage recorder. Without `ads_read` — on the connection, or as Meta answers
   * — the list is empty and `adAccess` is `missing` (the screen offers "Connect an ad account").
   * Failure modes: `404 channel_connection_not_found`, `404 team_organization_required`,
   * `404 instagram_reconnect_required` (the connection is not `connected`, or Meta refused its token
   * — then {@link ChannelConnectionService.markConnectionBroken} first), `503 instagram_unavailable` /
   * `instagram_not_configured`. Side effects: one Meta call; on a refused token, the break (MC11).
   */
  async listAdAccounts({
    scope,
    requestId,
    channelConnectionPublicId,
  }: Omit<ChannelConnectionCaller, 'userPublicId'> & {
    channelConnectionPublicId: string;
  }): Promise<ChannelConnectionAdAccountList> {
    const access = await this.readAdAccess({ scope, channelConnectionPublicId });
    if (access === null) return { adAccess: CHANNEL_CONNECTION_AD_ACCESS.MISSING, items: [] };
    const adAccounts = await this.readAdsFromMeta({
      scope,
      requestId,
      access,
      adAccountId: null,
      read: (options) => listMetaAdAccounts(options),
    });
    if (adAccounts === null) return { adAccess: CHANNEL_CONNECTION_AD_ACCESS.MISSING, items: [] };
    return {
      adAccess: CHANNEL_CONNECTION_AD_ACCESS.GRANTED,
      items: adAccounts.map(serializeMetaAdAccount),
    };
  }

  /**
   * Route 15 (MC13, P57): one page of the ads of **one** of the connection's ad accounts with their
   * Instagram post, for ad automations — read live from Meta, never stored.
   *
   * @remarks
   * Algorithm: (1) as route 41's step 1; (2) outside any unit, the connection's ad accounts — an
   * `ad_account_id` not among them → `404 ad_account_not_found`; (3) `GET /act_{id}/ads` with `limit`
   * and Meta's `after` passed through; (4) one unit — the organization's channel accounts whose
   * Instagram id is an ad's `instagram_user_id` (not revoked), so each ad names the account it runs
   * as. Without `ads_read` the page is empty and `adAccess` is `missing`.
   * Failure modes: as route 41, plus `404 ad_account_not_found` (not one of the connection's, or Meta
   * refused reading it). Side effects: two Meta calls; on a refused token, the break (MC11).
   */
  async listAds({
    scope,
    requestId,
    channelConnectionPublicId,
    adAccountId,
    limit,
    after,
  }: Omit<ChannelConnectionCaller, 'userPublicId'> & {
    channelConnectionPublicId: string;
    adAccountId: string;
    limit: number;
    after?: string | undefined;
  }): Promise<ChannelConnectionAdPage> {
    const missing: ChannelConnectionAdPage = {
      adAccess: CHANNEL_CONNECTION_AD_ACCESS.MISSING,
      items: [],
      limit,
      nextCursor: null,
    };
    const access = await this.readAdAccess({ scope, channelConnectionPublicId });
    if (access === null) return missing;
    const adAccounts = await this.readAdsFromMeta({
      scope,
      requestId,
      access,
      adAccountId: null,
      read: (options) => listMetaAdAccounts(options),
    });
    if (adAccounts === null) return missing;
    if (!adAccounts.some((adAccount) => adAccount.adAccountId === adAccountId)) {
      throw adAccountNotFoundError();
    }
    const page = await this.readAdsFromMeta({
      scope,
      requestId,
      access,
      adAccountId,
      read: (options) => listMetaAdAccountAds({ ...options, adAccountId, limit, after }),
    });
    if (page === null) return missing;
    const accountByInstagramId = await this.findAdChannelAccounts({
      scope,
      organizationId: access.organizationId,
      instagramUserIds: page.items.flatMap((ad) =>
        ad.instagramUserId === null ? [] : [ad.instagramUserId],
      ),
    });
    return {
      adAccess: CHANNEL_CONNECTION_AD_ACCESS.GRANTED,
      items: page.items.map((ad) =>
        serializeMetaAd({
          ad,
          ad_account_id: adAccountId,
          channel_account_public_id:
            ad.instagramUserId === null
              ? null
              : (accountByInstagramId.get(ad.instagramUserId) ?? null),
        }),
      ),
      limit,
      nextCursor: page.nextCursor,
    };
  }

  /**
   * MC11: a broken token breaks every account of its connection — the one guarded change
   * `connected → error` on the connection and, in the same commit, every `connected` account of it
   * → `error`, each with one reconnect notice after the commit (WC-46).
   *
   * @remarks
   * Algorithm: one unit in the caller's scope (joining an open one): the guarded change with
   * `last_check_error` (Meta's codes only); when it won, the accounts through
   * {@link ChannelConnectionAccountPort.markAccountsOfConnectionBroken}. Failure modes: none of its
   * own — `false` when the connection was not `connected` any more (another caller won, or it was
   * revoked), so only the winner breaks the accounts and enqueues notices. Side effects: the status
   * changes; one reconnect-notice job per account broken now.
   * Notes: called by routes 15 and 41 on Meta's code 190; the daily token check (WC-34, ROUTE row
   * R51) and the senders of sub-domains 2 and 6 call it too. Stopping the accounts' lanes (login, no
   * end) joins it with the lane port at ROUTE row R18.
   */
  async markConnectionBroken({
    scope,
    channelConnection,
    lastCheckError,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelConnection: ChannelConnectionKey;
    /** Meta's class, code, subcode and HTTP status (`describeMetaGraphError`) — never its text. */
    lastCheckError: string;
    /** The caller's request or job id, carried into the notice jobs. */
    requestId: string;
  }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const broken = await this.connectionRepository.markBroken({
          ...channelConnection,
          lastCheckError,
        });
        if (broken === null) return false;
        await this.accountPort.markAccountsOfConnectionBroken({
          scope,
          organizationId: channelConnection.organizationId,
          channelConnectionId: channelConnection.channelConnectionId,
          requestId,
        });
        return true;
      },
    });
  }

  /**
   * Route 5 (MC8): "Disconnect business" — every account of the connection revoked, then the
   * connection, its token deleted.
   *
   * @remarks
   * Algorithm: (1) the team check, the connection (not revoked), its token and accounts; (2) outside
   * any unit, each account unsubscribed (best effort, logged); (3) one commit: each account revoked
   * (its lanes stopped — R18), the connection `revoked` with `disconnected_at`, its token deleted.
   * Automations, contacts and history stay. Failure modes: `404 channel_connection_not_found` (a
   * repeat), `422` personal organization. Side effects: the commit; Meta calls.
   */
  async disconnectConnection({
    scope,
    requestId,
    channelConnectionPublicId,
  }: Omit<ChannelConnectionCaller, 'userPublicId'> & {
    channelConnectionPublicId: string;
  }): Promise<ChannelConnectionDisconnectResult> {
    const snapshot = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const { organizationId } = await this.requireWritableOrganization(scope);
        const connection = await this.connectionRepository.findByPublicId({
          organizationId,
          channelConnectionPublicId,
        });
        if (connection === null || connection.status === CHANNEL_CONNECTION_STATUS.REVOKED) {
          throw channelConnectionNotFoundError();
        }
        const channelConnection = { organizationId, channelConnectionId: connection.id };
        const token = await this.tokenService.findAccessToken({ scope, channelConnection });
        const accounts = await this.accountPort.listAccountsOfConnections({
          scope,
          organizationId,
          channelConnectionIds: [connection.id],
        });
        return { organizationId, connection, token, accounts };
      },
    });
    if (snapshot.token !== null) {
      await this.accountPort.unsubscribeAccountsBestEffort({
        scope,
        accounts: snapshot.accounts,
        encryptedAccessToken: snapshot.token.encryptedAccessToken,
        requestId,
      });
    }
    const disconnected = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const revoked = await this.accountPort.revokeAccountsOfConnection({
          scope,
          organizationId: snapshot.organizationId,
          channelConnectionId: snapshot.connection.id,
        });
        for (const account of revoked) {
          await this.lanePort?.stopLanes({
            scope,
            organizationId: snapshot.organizationId,
            channelAccountId: account.internalId,
          });
        }
        const wasLive = await this.tokenService.revokeConnection({
          scope,
          channelConnection: {
            organizationId: snapshot.organizationId,
            channelConnectionId: snapshot.connection.id,
          },
        });
        if (!wasLive) throw channelConnectionNotFoundError();
        return revoked;
      },
    });
    return {
      channelConnectionPublicId: snapshot.connection.public_id,
      disconnectedAccountCount: disconnected.length,
    };
  }

  /** The pick's one commit (MC7 step 3). */
  private async commitPick({
    scope,
    caller,
    connection,
    candidates,
    assignedById,
    profiles,
    accountsMax,
    isTrialing,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    caller: CallerOrganization;
    connection: ChannelConnectionRow;
    candidates: readonly string[];
    assignedById: ReadonlyMap<string, MetaAssignedInstagramAccount>;
    profiles: ReadonlyMap<string, InstagramAccountProfile | null>;
    accountsMax: number;
    isTrialing: boolean;
  }): Promise<{
    picked: Map<
      string,
      { result: 'connected' | 'already_connected'; account: ChannelConnectionAccount }
    >;
    accountsUsed: number;
  }> {
    const { organizationId } = caller;
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        await this.connectionRepository.lockOrganizationForAccountLimit(organizationId);
        const existing = await this.accountPort.findAccountsByProviderIds({
          scope,
          organizationId,
          providerAccountIds: candidates,
        });
        const liveHere = new Map(
          existing
            .filter((account) => account.connectionStatus !== 'revoked')
            .map((account) => [account.providerAccountId, account]),
        );
        const toConnect = candidates.filter((identifier) => !liveHere.has(identifier));
        const liveCount = await this.accountPort.countLiveAccounts({ scope, organizationId });
        if (liveCount + toConnect.length > accountsMax) {
          throw buildPlanRefusal({
            reason: 'plan_account_limit',
            limit: accountsMax,
            used: liveCount,
          });
        }
        if (isTrialing && toConnect.length > 0) {
          await this.trialPort?.assertAccountsMayTrial({ providerAccountIds: toConnect });
        }
        const picked = new Map<
          string,
          { result: 'connected' | 'already_connected'; account: ChannelConnectionAccount }
        >();
        for (const [identifier, account] of liveHere) {
          picked.set(identifier, { result: 'already_connected', account });
        }
        for (const identifier of toConnect) {
          const account = await this.accountPort.connectPickedAccount({
            scope,
            organizationId,
            channelConnectionId: connection.id,
            providerAccountId: identifier,
            profile: profiles.get(identifier) ?? null,
            username: assignedById.get(identifier)?.username ?? null,
            connectedByUserId: caller.userId,
          });
          await this.lanePort?.createLanesForAccount({
            scope,
            organizationId,
            channelAccountId: account.internalId,
          });
          picked.set(identifier, { result: 'connected', account });
        }
        if (isTrialing && toConnect.length > 0) {
          await this.trialPort?.recordTrialAccounts({
            scope,
            organizationId,
            providerAccountIds: toConnect,
          });
        }
        return { picked, accountsUsed: liveCount + toConnect.length };
      },
    });
  }

  /** MC5 steps 2–3: the code exchange, then the business, the assigned accounts and permissions. */
  private async readLogin({ code, requestId }: { code: string; requestId: string }): Promise<{
    encryptedAccessToken: string;
    /** The token's end from the exchange (P355), `null` when it never ends. */
    tokenExpiresAt: Date | null;
    clientBusinessId: string;
    assignedAccounts: MetaAssignedInstagramAccount[];
    grantedPermissions: string[];
  }> {
    let encryptedAccessToken: string;
    let tokenExpiresAt: Date | null;
    try {
      ({ encryptedAccessToken, expiresAt: tokenExpiresAt } = await exchangeMetaLoginCode({
        code,
        requestId,
      }));
    } catch (error) {
      this.logFailedConnect({ requestId, step: 'exchange', error });
      throw toChannelConnectRouteError({ error, isCodeSpent: false });
    }
    try {
      const clientBusinessId = await readMetaClientBusinessId({ encryptedAccessToken, requestId });
      const { accounts: assignedAccounts } = await listMetaAssignedInstagramAccounts({
        encryptedAccessToken,
        requestId,
      });
      const grantedPermissions = await readMetaGrantedPermissions({
        encryptedAccessToken,
        requestId,
      });
      return {
        encryptedAccessToken,
        tokenExpiresAt,
        clientBusinessId,
        assignedAccounts,
        grantedPermissions,
      };
    } catch (error) {
      this.logFailedConnect({ requestId, step: 'read', error });
      throw toChannelConnectRouteError({ error, isCodeSpent: true });
    }
  }

  /** The support record of a failed connect (MC12, plan:L4590) — never a token or the secret. */
  private logFailedConnect({
    requestId,
    step,
    error,
  }: {
    requestId: string;
    step: 'exchange' | 'read' | 'permissions';
    error?: unknown;
  }): void {
    const details =
      typeof error === 'object' && error !== null
        ? (error as {
            errorClass?: unknown;
            instagramErrorCode?: unknown;
            instagramErrorSubcode?: unknown;
            fbtraceId?: unknown;
          })
        : {};
    let configId: string | null = null;
    try {
      configId = readMetaAppSettings().configId;
    } catch {
      configId = null;
    }
    logger.warn(
      {
        requestId,
        step,
        configId,
        errorClass: details.errorClass,
        metaErrorCode: details.instagramErrorCode,
        metaErrorSubcode: details.instagramErrorSubcode,
        fbtraceId: details.fbtraceId,
      },
      'app.channel_connection.connect_failed',
    );
  }

  /** The provider ids live in another organization (resolver per id, outside any unit). */
  private async findAccountsLiveElsewhere({
    scope,
    providerAccountIds,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    providerAccountIds: readonly string[];
  }): Promise<Set<string>> {
    const elsewhere = new Set<string>();
    for (const identifier of providerAccountIds) {
      const holder =
        await this.accountPort.resolveLiveOrganizationPublicIdForProviderAccount(identifier);
      if (holder !== null && holder !== scope.organizationPublicId) elsewhere.add(identifier);
    }
    return elsewhere;
  }

  /**
   * The plan's `channel_accounts_max` — one entitlement resolve, `limit()` (change-plan-gates AP1),
   * Free's 1 when it reads `null` (no plan in the catalog, P39).
   */
  private async readAccountsMax(scope: OrganizationPrincipalDatabaseScope): Promise<number> {
    return readChannelAccountsMax(
      await readEntitlementSnapshot({ entitlementService: this.entitlementService, scope }),
    );
  }

  /** MC6: a connection a reconnect moved every account away from is revoked with its token. */
  private async releaseMovedFromConnections({
    scope,
    organizationId,
    previousChannelConnectionIds,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    previousChannelConnectionIds: readonly number[];
  }): Promise<void> {
    for (const channelConnectionId of new Set(previousChannelConnectionIds)) {
      const liveCount = await this.accountPort.countLiveAccountsOfConnection({
        scope,
        organizationId,
        channelConnectionId,
      });
      if (liveCount === 0) {
        await this.tokenService.revokeConnection({
          scope,
          channelConnection: { organizationId, channelConnectionId },
        });
      }
    }
  }

  /** One assigned account of the callback's answer. */
  private toConnectAccount({
    assigned,
    here,
    elsewhere,
  }: {
    assigned: MetaAssignedInstagramAccount;
    here: readonly ChannelConnectionAccount[];
    elsewhere: ReadonlySet<string>;
  }): ChannelConnectAccountOutput {
    const live = here.find(
      (account) =>
        account.providerAccountId === assigned.instagramUserId &&
        account.connectionStatus !== 'revoked',
    );
    let accountState: ChannelConnectAccountOutput['state'] = 'free';
    if (live !== undefined) accountState = 'connected_here';
    else if (elsewhere.has(assigned.instagramUserId)) accountState = 'connected_elsewhere';
    return {
      channel: 'instagram',
      provider_account_id: assigned.instagramUserId,
      username: assigned.username,
      profile_picture_url: live?.profilePictureUrl ?? null,
      state: accountState,
      channel_account_id: live?.publicId ?? null,
    };
  }

  /**
   * Mints the state (with the login configuration, P356 — the Page one when `withPage`, P358) and
   * answers the login address (routes 1 and 40).
   */
  private async mintLogin({
    scope,
    userPublicId,
    provider,
    channelConnectionPublicId,
    withPage,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    userPublicId: string;
    provider: ChannelConnectionProvider;
    channelConnectionPublicId: string | null;
    withPage: boolean;
  }): Promise<ChannelConnectStartOutput> {
    const { configId: defaultConfigId } = readMetaAppSettings();
    let configId = defaultConfigId;
    if (withPage) {
      const pageConfigId = readMetaPageConfigId();
      if (pageConfigId === null) throw instagramPageLoginNotConfiguredError();
      configId = pageConfigId;
    }
    const state = await mintChannelConnectState({
      redis: this.redis,
      payload: {
        provider,
        organization_public_id: scope.organizationPublicId,
        user_public_id: userPublicId,
        channel_connection_public_id: channelConnectionPublicId,
        config_id: configId,
      },
    });
    return {
      login_url: buildMetaLoginUrl({ state, configId }),
      state_expires_at: new Date(
        Date.now() + CONNECT_STATE_MINUTES * MILLISECONDS_PER_MINUTE,
      ).toISOString(),
    };
  }

  /** The team check of a write (`422` for a personal organization) — its internal id. */
  private async requireWritableOrganization(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<{ organizationId: number }> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        return { organizationId: organization.id };
      },
    });
  }

  /** The team check of a write and the caller's internal user id. */
  private async requireWritableCaller({
    scope,
    userPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    userPublicId: string;
  }): Promise<CallerOrganization> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const { organizationId } = await this.requireWritableOrganization(scope);
        const userId = await this.organizationService.resolveUserInternalIdByPublicId(userPublicId);
        return { organizationId, userId };
      },
    });
  }

  /**
   * The ad picker's first step (routes 15 and 41), in one unit: the team read check, the connection
   * (`connected`) and — when it holds `ads_read` — its token; `null` when it does not.
   */
  private async readAdAccess({
    scope,
    channelConnectionPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelConnectionPublicId: string;
  }): Promise<AdPickerAccess | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organizationId = await this.requireReadableOrganization(scope);
        const connection = await this.connectionRepository.findByPublicId({
          organizationId,
          channelConnectionPublicId,
        });
        if (connection === null) throw channelConnectionNotFoundError();
        if (connection.status !== CHANNEL_CONNECTION_STATUS.CONNECTED) {
          throw instagramReconnectRequiredError();
        }
        if (!connection.scopes.includes(META_ADS_PERMISSION)) return null;
        const token = await this.tokenService.findAccessToken({
          scope,
          channelConnection: { organizationId, channelConnectionId: connection.id },
        });
        if (token === null) throw instagramReconnectRequiredError();
        return { organizationId, connection, encryptedAccessToken: token.encryptedAccessToken };
      },
    });
  }

  /**
   * One ad picker read from Meta, outside any unit of work, with the connection's usage recorder:
   * `null` when Meta says the ad permission is missing; Meta refusing the token (190) breaks the
   * connection (MC11) before the route error.
   */
  private async readAdsFromMeta<TResult>({
    scope,
    requestId,
    access,
    adAccountId,
    read,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    requestId: string;
    access: AdPickerAccess;
    /** Route 15's ad account on its ads read (Meta refusing it → `404 ad_account_not_found`). */
    adAccountId: string | null;
    read: (options: MetaConnectionReadOptions) => Promise<TResult>;
  }): Promise<TResult | null> {
    try {
      return await read({
        encryptedAccessToken: access.encryptedAccessToken,
        requestId,
        recordUsage: this.usageService.buildUsageRecorder({
          scope,
          channelConnectionPublicId: access.connection.public_id,
        }),
      });
    } catch (error) {
      if (isMetaAdPermissionMissing(error)) return null;
      if (isMetaTokenRefused(error)) {
        await this.markConnectionBroken({
          scope,
          channelConnection: {
            organizationId: access.organizationId,
            channelConnectionId: access.connection.id,
          },
          lastCheckError: describeMetaGraphError(error),
          requestId,
        });
      }
      throw toChannelConnectionAdReadError({ error, adAccountId });
    }
  }

  /** The organization's not-revoked channel accounts by Instagram id → public id (route 15). */
  private async findAdChannelAccounts({
    scope,
    organizationId,
    instagramUserIds,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    instagramUserIds: readonly string[];
  }): Promise<Map<string, string>> {
    if (instagramUserIds.length === 0) return new Map();
    const accounts = await this.accountPort.findAccountsByProviderIds({
      scope,
      organizationId,
      providerAccountIds: [...new Set(instagramUserIds)],
    });
    return new Map(
      accounts
        .filter((account) => account.connectionStatus !== CHANNEL_CONNECTION_STATUS.REVOKED)
        .map((account) => [account.providerAccountId, account.publicId]),
    );
  }

  /** The team check of a read (`404 team_organization_required`) — its internal id. */
  private async requireReadableOrganization(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<number> {
    const organization = await this.organizationService.requireOrganizationByPublicId(
      scope.organizationPublicId,
    );
    assertTeamOrganizationForRead({ organization });
    return organization.id;
  }

  /** One connection of the organization by its public id, any status, or `null`. */
  private async findConnection({
    scope,
    organizationId,
    channelConnectionPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    channelConnectionPublicId: string;
  }): Promise<ChannelConnectionRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.connectionRepository.findByPublicId({ organizationId, channelConnectionPublicId }),
    });
  }

  /** The Channel connection object of one row, inside the caller's unit. */
  private async toConnectionOutput({
    scope,
    organizationId,
    connection,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    connection: ChannelConnectionRow;
  }): Promise<ChannelConnectionOutput> {
    const [output] = await this.toConnectionOutputs({
      scope,
      organizationId,
      connections: [connection],
    });
    if (output === undefined) throw new Error('channel connection output missing');
    return output;
  }

  /** The Channel connection objects of rows, with their accounts and users, inside the caller's unit. */
  private async toConnectionOutputs({
    scope,
    organizationId,
    connections,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    connections: readonly ChannelConnectionRow[];
  }): Promise<ChannelConnectionOutput[]> {
    const accounts = await this.accountPort.listAccountsOfConnections({
      scope,
      organizationId,
      channelConnectionIds: connections.map((connection) => connection.id),
    });
    const userPublicIds = await this.organizationService.resolveUserPublicIdsByInternalIds(
      connections
        .map((connection) => connection.connected_by_user_id)
        .filter((identifier): identifier is number => identifier !== null),
    );
    return connections.map((connection) =>
      serializeChannelConnection({
        connection,
        connected_by_user_public_id:
          connection.connected_by_user_id === null
            ? null
            : (userPublicIds.get(connection.connected_by_user_id) ?? null),
        accounts: accounts.filter((account) => account.channelConnectionId === connection.id),
      }),
    );
  }
}
