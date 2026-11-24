import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MetaSignedRequestPayload } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-signature.js';
import { successResponse } from '@/shared/utils/http/response.util.js';
import { getRequestIdentifier } from '@/shared/utils/http/request.util.js';
import { recordScopedAuditEvent } from '@/shared/utils/infrastructure/audit-request-context.util.js';
import { CHANNEL_CONNECTION_AUDIT_RESOURCE_TYPE } from './channel-connection.constants.js';
import { instagramSignedRequestInvalidError } from './channel-connection-error.util.js';
import type { ChannelConnectionProvider } from './channel-connection-state.js';
import {
  META_CALLBACK_AUDIT_ACTIONS,
  META_CALLBACK_AUDIT_SOURCE,
} from './channel-connection-meta-callback.constants.js';
import type { ChannelConnectionMetaCallbackService } from './channel-connection-meta-callback.service.js';
import type {
  MetaCallbackMatchKind,
  MetaCallbackOrganizationChange,
} from './channel-connection-meta-callback.types.js';

/** The request of routes 16–17: the `{provider}` path segment, validated `meta` by the route schema. */
type MetaCallbackRequest = FastifyRequest<{ Params: { provider: ChannelConnectionProvider } }>;

/**
 * The signed request the ingress plugin verified; absent only on a wiring bug (the route
 * registered outside the plugin), which fails closed as the Stripe webhook's handler does.
 */
function requireMetaSignedRequest(request: FastifyRequest): MetaSignedRequestPayload {
  const signedRequest = request.metaSignedRequest;
  if (signedRequest === undefined) throw instagramSignedRequestInvalidError();
  return signedRequest;
}

/**
 * One audit entry per organization the callback changed (MC12): WARNING, no actor (Meta is not a
 * user — `anonymousActor`), `metadata.source = 'meta'`, how the id matched, the accounts' and the
 * revoked connections' public ids, and on a data deletion the confirmation code and how many stored
 * posts were erased. Best-effort, after the commits (D36).
 */
async function recordMetaCallbackAuditEvents({
  request,
  action,
  matchKind,
  changes,
  confirmationCode,
}: {
  request: FastifyRequest;
  action: (typeof META_CALLBACK_AUDIT_ACTIONS)[keyof typeof META_CALLBACK_AUDIT_ACTIONS];
  matchKind: MetaCallbackMatchKind;
  changes: MetaCallbackOrganizationChange[];
  confirmationCode?: string;
}): Promise<void> {
  for (const change of changes) {
    await recordScopedAuditEvent({
      request,
      input: {
        anonymousActor: true,
        action,
        resource_type: CHANNEL_CONNECTION_AUDIT_RESOURCE_TYPE,
        organizationPublicId: change.organizationPublicId,
        severity: 'WARNING',
        metadata: {
          source: META_CALLBACK_AUDIT_SOURCE,
          match: matchKind,
          channel_account_public_ids: change.channelAccountPublicIds,
          revoked_channel_connection_public_ids: change.revokedChannelConnectionPublicIds,
          ...(confirmationCode === undefined
            ? {}
            : { confirmation_code: confirmationCode, erased_post_count: change.erasedPostCount }),
        },
      },
    });
  }
}

/**
 * Builds the handler map for Meta's two callbacks (routes-final § 1 — routes 16 and 17, MC14–MC16):
 * reads the signed request the ingress plugin verified, calls
 * {@link ChannelConnectionMetaCallbackService}, writes the audit entries and answers Meta.
 *
 * @remarks
 * Route 16 answers `200 { data: null, meta }`; route 17 answers Meta's own shape
 * `{ url, confirmation_code }` outside the envelope (the route's `raw_response`). Both answer 200
 * once the signature verified — an id we never stored, or a repeat, too — so Meta does not retry
 * (1.10). Audit: `app.channel_connection.deauthorize` / `.data_deletion`, one per organization
 * changed, after the commits, best-effort — an audit failure never fails the request (D36).
 */
export function createChannelConnectionMetaCallbackController(
  service: ChannelConnectionMetaCallbackService,
) {
  return {
    deauthorizeChannelConnection: async (request: MetaCallbackRequest, _reply: FastifyReply) => {
      const { matchKind, changes } = await service.deauthorize({
        provider: request.params.provider,
        signedRequest: requireMetaSignedRequest(request),
        requestId: getRequestIdentifier(request),
      });
      await recordMetaCallbackAuditEvents({
        request,
        action: META_CALLBACK_AUDIT_ACTIONS.deauthorize,
        matchKind,
        changes,
      });
      return successResponse({ data: null, request_id: getRequestIdentifier(request) });
    },
    deleteChannelConnectionData: async (request: MetaCallbackRequest, reply: FastifyReply) => {
      const { matchKind, changes, answer } = await service.deleteData({
        provider: request.params.provider,
        signedRequest: requireMetaSignedRequest(request),
        requestId: getRequestIdentifier(request),
      });
      await recordMetaCallbackAuditEvents({
        request,
        action: META_CALLBACK_AUDIT_ACTIONS.dataDeletion,
        matchKind,
        changes,
        confirmationCode: answer.confirmation_code,
      });
      reply.status(200);
      return answer;
    },
  };
}
