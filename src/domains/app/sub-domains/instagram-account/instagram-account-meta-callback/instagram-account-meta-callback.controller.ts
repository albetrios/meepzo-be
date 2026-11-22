import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MetaSignedRequestPayload } from '@/infrastructure/social/meta-signature.util.js';
import { successResponse } from '@/shared/utils/http/response.util.js';
import { getRequestIdentifier } from '@/shared/utils/http/request.util.js';
import { recordScopedAuditEvent } from '@/shared/utils/infrastructure/audit-request-context.util.js';
import { INSTAGRAM_ACCOUNT_AUDIT_RESOURCE_TYPE } from '@/domains/app/sub-domains/instagram-account/instagram-account.constants.js';
import { instagramSignedRequestInvalidError } from '@/domains/app/sub-domains/instagram-account/instagram-account-error.util.js';
import {
  META_CALLBACK_AUDIT_ACTIONS,
  META_CALLBACK_AUDIT_SOURCE,
} from './instagram-account-meta-callback.constants.js';
import type { InstagramAccountMetaCallbackService } from './instagram-account-meta-callback.service.js';
import type { MetaCallbackOrganizationChange } from './instagram-account-meta-callback.types.js';

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
 * One audit entry per organization the callback changed (IA7): WARNING, no actor (Meta is not a
 * user — `anonymousActor`), `metadata.source = 'meta'`, the accounts' public ids, and on a data
 * deletion the confirmation code and how many stored posts were erased. Best-effort, after the
 * commits (D36).
 */
async function recordMetaCallbackAuditEvents({
  request,
  action,
  changes,
  confirmationCode,
}: {
  request: FastifyRequest;
  action: (typeof META_CALLBACK_AUDIT_ACTIONS)[keyof typeof META_CALLBACK_AUDIT_ACTIONS];
  changes: MetaCallbackOrganizationChange[];
  confirmationCode?: string;
}): Promise<void> {
  for (const change of changes) {
    await recordScopedAuditEvent({
      request,
      input: {
        anonymousActor: true,
        action,
        resource_type: INSTAGRAM_ACCOUNT_AUDIT_RESOURCE_TYPE,
        organizationPublicId: change.organizationPublicId,
        severity: 'WARNING',
        metadata: {
          source: META_CALLBACK_AUDIT_SOURCE,
          instagram_account_public_ids: change.instagramAccountPublicIds,
          ...(confirmationCode === undefined
            ? {}
            : { confirmation_code: confirmationCode, erased_post_count: change.erasedPostCount }),
        },
      },
    });
  }
}

/**
 * Builds the handler map for Meta's two callbacks (routes-final § 1.D — routes 7 and 8): reads the
 * signed request the ingress plugin verified, calls {@link InstagramAccountMetaCallbackService},
 * writes the audit entries and answers Meta.
 *
 * @remarks
 * Route 7 answers `200 { data: null, meta }`; route 8 answers Meta's own shape
 * `{ url, confirmation_code }` outside the envelope (the route's `raw_response`). Both answer 200
 * once the signature verified — a person we never stored, or a repeat, too — so Meta does not retry
 * (IA18, 1.D.10). Audit: `app.instagram_account.deauthorize` / `.data_deletion`, one per
 * organization changed, after the commits, best-effort — an audit failure never fails the request
 * (audit-emission, D36).
 */
export function createInstagramAccountMetaCallbackController(
  service: InstagramAccountMetaCallbackService,
) {
  return {
    deauthorizeInstagramAccount: async (request: FastifyRequest, _reply: FastifyReply) => {
      const { changes } = await service.deauthorize({
        signedRequest: requireMetaSignedRequest(request),
      });
      await recordMetaCallbackAuditEvents({
        request,
        action: META_CALLBACK_AUDIT_ACTIONS.deauthorize,
        changes,
      });
      return successResponse({ data: null, request_id: getRequestIdentifier(request) });
    },
    deleteInstagramAccountData: async (request: FastifyRequest, reply: FastifyReply) => {
      const { changes, answer } = await service.deleteData({
        signedRequest: requireMetaSignedRequest(request),
      });
      await recordMetaCallbackAuditEvents({
        request,
        action: META_CALLBACK_AUDIT_ACTIONS.dataDeletion,
        changes,
        confirmationCode: answer.confirmation_code,
      });
      reply.status(200);
      return answer;
    },
  };
}
