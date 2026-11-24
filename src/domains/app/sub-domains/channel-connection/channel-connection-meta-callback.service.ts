import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { MetaSignedRequestPayload } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-signature.js';
import { readMetaAppSecret } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { getEnv } from '@/shared/config/env.config.js';
import { DEFAULT_FRONTEND_URL } from '@/shared/constants/index.js';
import { MILLISECONDS_PER_SECOND } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { InstagramAccountErasureService } from '@/domains/app/sub-domains/instagram-account/instagram-account-erasure.service.js';
import type { InstagramAccountMetaMatch } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import { deriveMetaDataDeletionConfirmationCode } from './channel-connection-meta-callback-confirmation-code.util.js';
import { serializeMetaDataDeletionAnswer } from './channel-connection-meta-callback.serializer.js';
import type {
  ChannelConnectionMetaCallbackTeamAlertPort,
  MetaCallbackInput,
  MetaCallbackMatchKind,
  MetaCallbackOrganizationChange,
  MetaCallbackUnmatchedAlert,
  MetaDataDeletionResult,
  MetaDeauthorizeResult,
} from './channel-connection-meta-callback.types.js';
import type {
  ChannelConnectionRepository,
  ChannelConnectionRow,
} from './channel-connection.repository.js';
import type {
  ChannelConnectionAccountPort,
  ChannelConnectionLanePort,
} from './channel-connection.types.js';
import type { ChannelConnectionTokenService } from './channel-connection-token.service.js';
import type { ChannelConnectionProvider } from './channel-connection-state.js';

/**
 * A connection connected — or connected again — after Meta signed the request is left alone (D53);
 * a request without `issued_at` reaches every connection.
 */
function isConnectedAfterRequest({
  connection,
  issuedAt,
}: {
  connection: ChannelConnectionRow;
  issuedAt: number | null;
}): boolean {
  if (issuedAt === null) return false;
  return Math.floor(connection.connected_at.getTime() / MILLISECONDS_PER_SECOND) > issuedAt;
}

/** The organizations a signed id names, and how it was matched (MC15). */
interface MetaCallbackResolution {
  matchKind: MetaCallbackMatchKind;
  organizationPublicIds: string[];
}

/**
 * Meta's two callbacks, with the connection (routes-final § 1 MC14–MC16, P46): deauthorize — the
 * app was removed (route 16) — and data deletion — the person asked for their data to be deleted
 * (route 17).
 *
 * @remarks
 * Algorithm:
 * - The caller is Meta, proved by the signed request the ingress plugin verified (MC14); no
 *   organization comes with it. Which id Meta signs on a Unified Login callback is still a §43 test,
 *   so the id is tried as an account id first, then as a business id (P56): the resolver
 *   `app.resolve_organization_public_ids_for_provider_account` names every organization with a
 *   channel account of that `provider_account_id`; only when it names none,
 *   `app.resolve_organization_public_ids_for_provider_business` names every organization with a
 *   connection of that `client_business_id`. Each organization is then changed inside its own
 *   `PRINCIPAL_SCOPE.VERIFIED` scope, one transaction per organization — no other organization's
 *   row is read (`verified-scope-usage.policy.unit.test.ts` ledgers this file).
 * - An account match reaches that account (any status); a business match reaches every not-revoked
 *   channel account of the organization's connections of that business, and then each such
 *   connection left with no account is revoked with its token.
 * - Deauthorize: each reached account disconnected as route 8 does (CA8) without the unsubscribe
 *   call (the app is already removed) — `revoked`, and the connection's token deleted (with the
 *   connection revoked) with its last account. Data deletion: the same, plus each account's profile
 *   erased and its stored posts deleted (MC16). Contacts are not touched (launch D22).
 * - Both through {@link InstagramAccountErasureService.eraseForMeta}, the erase an organization's
 *   delete shares (D54); in the same unit of work each account it revoked has its sending lanes
 *   stopped through {@link ChannelConnectionLanePort.stopLanes} (sub-domain 6's lane service, ROUTE
 *   row R18), exactly as route 8 does (CA8). An account or connection connected — or connected again — after Meta signed
 *   the request (`issued_at`) is left alone (D53).
 * - An id that matches neither is answered all the same (route 17 with its code), logged and the
 *   team alerted (MC16) through {@link ChannelConnectionMetaCallbackTeamAlertPort}.
 *
 * Failure modes:
 * - `503 instagram_not_configured` when the app secret is unset (the ingress plugin answers it first
 *   on both routes). A database failure fails the request and Meta retries it — safe, as below. A
 *   failed team alert is logged and never fails the request.
 *
 * Side effects:
 * - Writes `app.channel_accounts`, `app.instagram_accounts`, `app.channel_connections`,
 *   `app.instagram_send_lanes` (the revoked accounts' lanes stopped), deletes
 *   `app.channel_connection_tokens` and `app.instagram_media` rows through the owners' services. No
 *   Meta call. The audit entries are the controller's, after the commits (D36).
 *
 * Notes:
 * - Safe to repeat: a second call finds what the first changed already done, leaves a connection
 *   made since alone (D53), lists no change and still answers — data deletion with the same code.
 * - No run is cancelled and automations stay `live` (launch IQ1, D24).
 */
export class ChannelConnectionMetaCallbackService {
  constructor(
    private readonly connectionRepository: ChannelConnectionRepository,
    private readonly tokenService: ChannelConnectionTokenService,
    private readonly accountPort: Pick<
      ChannelConnectionAccountPort,
      'countLiveAccountsOfConnection'
    >,
    private readonly erasureService: InstagramAccountErasureService,
    private readonly lanePort: Pick<ChannelConnectionLanePort, 'stopLanes'>,
    private readonly teamAlertPort?: ChannelConnectionMetaCallbackTeamAlertPort | undefined,
  ) {}

  /**
   * Meta's deauthorize (route 16, MC15): every account the signed id reaches — connected before
   * Meta signed (D53) — revoked, and each connection's token deleted with its last account.
   *
   * @remarks
   * Algorithm: the two resolvers (account, then business), then per organization one transaction in
   * its verified scope. Failure modes: as the class lists. Side effects: the revokes and token
   * deletes; an unmatched id alerts the team. Returns the match kind and the organizations where
   * something changed.
   */
  async deauthorize({
    provider,
    signedRequest,
    requestId,
  }: MetaCallbackInput): Promise<MetaDeauthorizeResult> {
    const { matchKind, changes } = await this.changeEveryOrganization({
      provider,
      signedRequest,
      shouldEraseData: false,
    });
    if (matchKind === 'none') {
      await this.alertTeam({
        callback: 'deauthorize',
        provider,
        providerId: signedRequest.userId,
        requestId,
      });
    }
    return { matchKind, changes };
  }

  /**
   * Meta's data deletion (route 17, MC16): as the deauthorize, plus each reached account's profile
   * and stored posts erased; returns Meta's answer — the confirmation code derived from the signed
   * request and the frontend's status page with it.
   *
   * @remarks
   * Algorithm: the code first (`503 instagram_not_configured` without an app secret, before any
   * write), then the resolvers, then per organization one transaction in its verified scope; the
   * answer's link is `FRONTEND_URL` (or the local default) + `/instagram/data-deletion?code=…`.
   * Failure modes: as the class lists. Side effects: the revokes, token, profile and post erases; an
   * unmatched id alerts the team with the code. Returns the match kind, the organizations where
   * something changed, and the answer (the same for the same signed request).
   */
  async deleteData({
    provider,
    signedRequest,
    requestId,
  }: MetaCallbackInput): Promise<MetaDataDeletionResult> {
    const confirmationCode = deriveMetaDataDeletionConfirmationCode({
      signedRequest,
      appSecret: readMetaAppSecret(),
    });
    const { matchKind, changes } = await this.changeEveryOrganization({
      provider,
      signedRequest,
      shouldEraseData: true,
    });
    if (matchKind === 'none') {
      await this.alertTeam({
        callback: 'data_deletion',
        provider,
        providerId: signedRequest.userId,
        confirmationCode,
        requestId,
      });
    }
    const answer = serializeMetaDataDeletionAnswer({
      confirmation_code: confirmationCode,
      frontend_url: getEnv().FRONTEND_URL ?? DEFAULT_FRONTEND_URL,
    });
    return { matchKind, changes, answer };
  }

  /** The account resolver, else the business resolver (MC15, P56). */
  private async resolveOrganizations({
    provider,
    providerId,
  }: {
    provider: ChannelConnectionProvider;
    providerId: string;
  }): Promise<MetaCallbackResolution> {
    const byAccount =
      await this.connectionRepository.resolveOrganizationPublicIdsForProviderAccount({
        provider,
        providerAccountId: providerId,
      });
    if (byAccount.length > 0) {
      return { matchKind: 'provider_account', organizationPublicIds: byAccount };
    }
    const byBusiness =
      await this.connectionRepository.resolveOrganizationPublicIdsForProviderBusiness({
        provider,
        clientBusinessId: providerId,
      });
    if (byBusiness.length > 0) {
      return { matchKind: 'provider_business', organizationPublicIds: byBusiness };
    }
    return { matchKind: 'none', organizationPublicIds: [] };
  }

  /**
   * The resolvers, then one transaction per organization they name, each in that organization's
   * verified scope; keeps the organizations where something changed.
   */
  private async changeEveryOrganization({
    provider,
    signedRequest,
    shouldEraseData,
  }: {
    provider: ChannelConnectionProvider;
    signedRequest: MetaSignedRequestPayload;
    shouldEraseData: boolean;
  }): Promise<{ matchKind: MetaCallbackMatchKind; changes: MetaCallbackOrganizationChange[] }> {
    const { matchKind, organizationPublicIds } = await this.resolveOrganizations({
      provider,
      providerId: signedRequest.userId,
    });
    const changes: MetaCallbackOrganizationChange[] = [];
    for (const organizationPublicId of organizationPublicIds) {
      // The organization was named by a SECURITY DEFINER resolver for the id Meta signed (MC14,
      // MC15) — this flow proved it, so the scope is VERIFIED (ledgered).
      const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId });
      const change =
        matchKind === 'provider_business'
          ? await this.changeByBusiness({
              scope,
              provider,
              clientBusinessId: signedRequest.userId,
              issuedAt: signedRequest.issuedAt,
              shouldEraseData,
            })
          : await this.erase({
              scope,
              match: { kind: 'provider_account', providerAccountId: signedRequest.userId },
              issuedAt: signedRequest.issuedAt,
              shouldEraseData,
            });
      if (change !== null) changes.push(change);
    }
    return { matchKind, changes };
  }

  /**
   * One organization's erase for an account match (or a business match's accounts), and the lanes
   * of each account it revoked stopped — one unit of work, as route 8's revoke and lane stop (CA8).
   */
  private async erase({
    scope,
    match,
    issuedAt,
    shouldEraseData,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    match: InstagramAccountMetaMatch;
    issuedAt: number | null;
    shouldEraseData: boolean;
  }): Promise<MetaCallbackOrganizationChange | null> {
    const erasure = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const erased = await this.erasureService.eraseForMeta({
          scope,
          match,
          issuedAt,
          shouldEraseData,
        });
        for (const channelAccount of erased?.revokedChannelAccounts ?? []) {
          await this.lanePort.stopLanes({ scope, ...channelAccount });
        }
        return erased;
      },
    });
    if (erasure === null) return null;
    return {
      organizationPublicId: scope.organizationPublicId,
      channelAccountPublicIds: erasure.instagramAccountPublicIds,
      revokedChannelConnectionPublicIds: [],
      erasedPostCount: erasure.erasedPostCount,
    };
  }

  /**
   * A business match in one organization, one transaction: its connections of that business, the
   * erase of their not-revoked accounts, then each such connection left with no account — and
   * connected before Meta signed (D53) — revoked with its token (a login never picked holds one too).
   */
  private async changeByBusiness({
    scope,
    provider,
    clientBusinessId,
    issuedAt,
    shouldEraseData,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    provider: ChannelConnectionProvider;
    clientBusinessId: string;
    issuedAt: number | null;
    shouldEraseData: boolean;
  }): Promise<MetaCallbackOrganizationChange | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const connections = await this.connectionRepository.listByBusiness({
          organizationPublicId: scope.organizationPublicId,
          provider,
          clientBusinessId,
        });
        if (connections.length === 0) return null;
        const accountChange = await this.erase({
          scope,
          match: {
            kind: 'provider_business',
            channelConnectionIds: connections.map((connection) => connection.id),
          },
          issuedAt,
          shouldEraseData,
        });
        const revokedChannelConnectionPublicIds: string[] = [];
        for (const connection of connections) {
          if (
            connection.status === 'revoked' ||
            isConnectedAfterRequest({ connection, issuedAt })
          ) {
            continue;
          }
          const channelConnection = {
            organizationId: connection.organization_id,
            channelConnectionId: connection.id,
          };
          const liveCount = await this.accountPort.countLiveAccountsOfConnection({
            scope,
            ...channelConnection,
          });
          if (liveCount > 0) continue;
          // Revoked by its last account in the erase above (`false` then), or still live with no
          // account (a login never picked) — revoked now; either way it was live before this request.
          await this.tokenService.revokeConnection({ scope, channelConnection });
          revokedChannelConnectionPublicIds.push(connection.public_id);
        }
        if (accountChange === null && revokedChannelConnectionPublicIds.length === 0) return null;
        return {
          organizationPublicId: scope.organizationPublicId,
          channelAccountPublicIds: accountChange?.channelAccountPublicIds ?? [],
          revokedChannelConnectionPublicIds,
          erasedPostCount: accountChange?.erasedPostCount ?? 0,
        };
      },
    });
  }

  /**
   * MC16: an id that matched neither — one error-level log line (the alert until the team email
   * lands), then the team-alert port when one is wired. Never throws.
   */
  private async alertTeam(alert: MetaCallbackUnmatchedAlert): Promise<void> {
    logger.error(
      {
        requestId: alert.requestId,
        callback: alert.callback,
        provider: alert.provider,
        providerId: alert.providerId,
        confirmationCode: alert.confirmationCode,
      },
      'app.channel_connection.meta_callback.unmatched',
    );
    if (this.teamAlertPort === undefined) return;
    try {
      await this.teamAlertPort.alertUnmatchedMetaCallback(alert);
    } catch (error) {
      logger.warn(
        {
          requestId: alert.requestId,
          callback: alert.callback,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'app.channel_connection.meta_callback.team_alert_failed',
      );
    }
  }
}
