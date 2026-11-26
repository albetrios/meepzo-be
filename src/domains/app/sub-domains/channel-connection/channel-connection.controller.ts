import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginatedResponse, successResponse } from '@/shared/utils/http/response.util.js';
import {
  getActingUserPublicId,
  getRequestIdentifier,
  requireOrganizationScope,
  requirePrincipal,
} from '@/shared/utils/http/request.util.js';
import {
  buildAuditActorFields,
  recordScopedAuditEvent,
} from '@/shared/utils/infrastructure/audit-request-context.util.js';
import { CHANNEL_ACCOUNT_AUDIT_RESOURCE_TYPE } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import { CHANNEL_CONNECTION_AUDIT_RESOURCE_TYPE } from './channel-connection.constants.js';
import type { ChannelConnectionService } from './channel-connection.service.js';
import {
  validateChannelAccountPick,
  validateChannelConnectCallback,
  validateChannelConnectionIdParam,
  validateChannelConnectionProvider,
  validateChannelConnectStartBody,
  validateListChannelConnectionAdAccountsQuery,
  validateListChannelConnectionAdsQuery,
  validateListChannelConnectionsQuery,
} from './channel-connection.validator.js';

/** A request with the `{provider}` path parameter (routes 1, 2). */
type ProviderRequest = FastifyRequest<{ Params: { provider: string } }>;
/** A request with the `{channel_connection_id}` path parameter (routes 3, 5, 15, 40–42). */
type ConnectionRequest = FastifyRequest<{ Params: { channel_connection_id: string } }>;

/**
 * One `app.channel_account.connect` entry per account a pick connected (MC12, WARNING), after the
 * pick's commit, best-effort.
 */
async function recordPickedAccountAudits({
  request,
  auth,
  organizationPublicId,
  channelConnectionPublicId,
  channelAccountPublicIds,
}: {
  request: FastifyRequest;
  auth: ReturnType<typeof requirePrincipal>;
  organizationPublicId: string;
  channelConnectionPublicId: string;
  channelAccountPublicIds: readonly string[];
}): Promise<void> {
  for (const channelAccountPublicId of channelAccountPublicIds) {
    await recordScopedAuditEvent({
      request,
      input: {
        ...buildAuditActorFields(auth),
        action: 'app.channel_account.connect',
        resource_type: CHANNEL_ACCOUNT_AUDIT_RESOURCE_TYPE,
        organizationPublicId,
        severity: 'WARNING',
        metadata: {
          channel_account_public_id: channelAccountPublicId,
          channel_connection_public_id: channelConnectionPublicId,
        },
      },
    });
  }
}

/**
 * The ad picker's handlers (routes 41 and 15, MC13): reads only — no audit entry; `meta.ad_access`
 * beside the list (and Meta's cursor as `meta.pagination` on route 15).
 */
function createAdPickerHandlers(service: ChannelConnectionService) {
  return {
    listChannelConnectionAdAccounts: async (request: ConnectionRequest, _reply: FastifyReply) => {
      validateListChannelConnectionAdAccountsQuery(request.query);
      const { adAccess, items } = await service.listAdAccounts({
        scope: requireOrganizationScope(request),
        requestId: getRequestIdentifier(request),
        channelConnectionPublicId: validateChannelConnectionIdParam(
          request.params.channel_connection_id,
        ),
      });
      return successResponse({
        data: items,
        request_id: getRequestIdentifier(request),
        extraMeta: { ad_access: adAccess },
      });
    },
    listChannelConnectionAds: async (request: ConnectionRequest, _reply: FastifyReply) => {
      const {
        ad_account_id: adAccountId,
        limit,
        after,
      } = validateListChannelConnectionAdsQuery(request.query);
      const page = await service.listAds({
        scope: requireOrganizationScope(request),
        requestId: getRequestIdentifier(request),
        channelConnectionPublicId: validateChannelConnectionIdParam(
          request.params.channel_connection_id,
        ),
        adAccountId,
        limit,
        after,
      });
      return paginatedResponse({
        data: page.items,
        request_id: getRequestIdentifier(request),
        pagination: {
          per_page: page.limit,
          next: page.nextCursor,
          has_more: page.nextCursor !== null,
        },
        extraMeta: { ad_access: page.adAccess },
      });
    },
  };
}

/**
 * The login starts (routes 1 and 40, MC4, MC17): the optional `{ with_page }` body picks the Page
 * login configuration (P358); no audit entry — nothing is saved but a one-use state.
 */
function createLoginStartHandlers(service: ChannelConnectionService) {
  return {
    startChannelConnection: async (request: ProviderRequest, _reply: FastifyReply) => {
      const provider = validateChannelConnectionProvider(request.params.provider);
      const { withPage } = validateChannelConnectStartBody(request.body);
      const data = await service.startLogin({
        scope: requireOrganizationScope(request),
        userPublicId: getActingUserPublicId(requirePrincipal(request)) ?? '',
        provider,
        withPage,
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    startChannelReconnect: async (request: ConnectionRequest, _reply: FastifyReply) => {
      const { withPage } = validateChannelConnectStartBody(request.body);
      const data = await service.startReconnect({
        scope: requireOrganizationScope(request),
        userPublicId: getActingUserPublicId(requirePrincipal(request)) ?? '',
        channelConnectionPublicId: validateChannelConnectionIdParam(
          request.params.channel_connection_id,
        ),
        withPage,
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
  };
}

/**
 * Builds the handler map for the channel connection routes (routes-final § 1 — routes 1–5, 15,
 * 40–42):
 * reads the organization scope and the actor, validates the path, query and body, calls
 * {@link ChannelConnectionService} and shapes the answer.
 *
 * @remarks
 * Audit (MC12, WARNING, public ids only — never the token, the code or the state), recorded after
 * the write commits, best-effort (D36): `app.channel_connection.connect` (`provider`,
 * `is_reconnect`, `reconnected_account_count`), one `app.channel_account.connect` per picked
 * account, `app.channel_connection.disconnect` (`disconnected_account_count`).
 */
export function createChannelConnectionController(service: ChannelConnectionService) {
  return {
    ...createAdPickerHandlers(service),
    ...createLoginStartHandlers(service),
    finishChannelConnection: async (request: ProviderRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const scope = requireOrganizationScope(request);
      const provider = validateChannelConnectionProvider(request.params.provider);
      const { code, state } = validateChannelConnectCallback(request.body);
      const { data } = await service.finishLogin({
        scope,
        userPublicId: getActingUserPublicId(auth) ?? '',
        requestId: getRequestIdentifier(request),
        provider,
        code,
        state,
      });
      await recordScopedAuditEvent({
        request,
        input: {
          ...buildAuditActorFields(auth),
          action: 'app.channel_connection.connect',
          resource_type: CHANNEL_CONNECTION_AUDIT_RESOURCE_TYPE,
          organizationPublicId: scope.organizationPublicId,
          severity: 'WARNING',
          metadata: {
            channel_connection_public_id: data.channel_connection.id,
            provider,
            is_reconnect: data.is_reconnect,
            reconnected_account_count: data.reconnected_account_ids.length,
          },
        },
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    pickChannelAccounts: async (request: ConnectionRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const scope = requireOrganizationScope(request);
      const channelConnectionPublicId = validateChannelConnectionIdParam(
        request.params.channel_connection_id,
      );
      const { provider_account_ids: providerAccountIds } = validateChannelAccountPick(request.body);
      const { data, connectedAccountPublicIds } = await service.pickAccounts({
        scope,
        userPublicId: getActingUserPublicId(auth) ?? '',
        requestId: getRequestIdentifier(request),
        channelConnectionPublicId,
        providerAccountIds,
      });
      await recordPickedAccountAudits({
        request,
        auth,
        organizationPublicId: scope.organizationPublicId,
        channelConnectionPublicId: data.channel_connection_id,
        channelAccountPublicIds: connectedAccountPublicIds,
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    listChannelConnections: async (request: FastifyRequest, _reply: FastifyReply) => {
      const { includeRevoked } = validateListChannelConnectionsQuery(request.query);
      const data = await service.listConnections({
        scope: requireOrganizationScope(request),
        includeRevoked,
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    getChannelConnection: async (request: ConnectionRequest, _reply: FastifyReply) => {
      const data = await service.getConnection({
        scope: requireOrganizationScope(request),
        channelConnectionPublicId: validateChannelConnectionIdParam(
          request.params.channel_connection_id,
        ),
      });
      return successResponse({ data, request_id: getRequestIdentifier(request) });
    },
    disconnectChannelConnection: async (request: ConnectionRequest, reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const scope = requireOrganizationScope(request);
      const { channelConnectionPublicId, disconnectedAccountCount } =
        await service.disconnectConnection({
          scope,
          requestId: getRequestIdentifier(request),
          channelConnectionPublicId: validateChannelConnectionIdParam(
            request.params.channel_connection_id,
          ),
        });
      await recordScopedAuditEvent({
        request,
        input: {
          ...buildAuditActorFields(auth),
          action: 'app.channel_connection.disconnect',
          resource_type: CHANNEL_CONNECTION_AUDIT_RESOURCE_TYPE,
          organizationPublicId: scope.organizationPublicId,
          severity: 'WARNING',
          metadata: {
            channel_connection_public_id: channelConnectionPublicId,
            disconnected_account_count: disconnectedAccountCount,
          },
        },
      });
      return reply.code(204).send();
    },
  };
}
